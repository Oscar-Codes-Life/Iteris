import {ticketBranch, ticketPrTitle} from '../types.js';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {IterisConfig, Ticket, TicketState} from '../types.js';
import {validateBaseBranch} from '../github/repo.js';
import {acquireRun} from '../state/active.js';
import {savePendingQueue} from '../state/queue.js';
import {loadConfig} from '../config.js';
import {createRunFolder, writeStatus, writePrompt, appendLog} from '../state/manager.js';
import {readProgress, appendProgress} from '../state/progress.js';
import {findPrForBranch, createPullRequest, addLabelToIssue, updatePrReview} from '../github/pr.js';
import {moveCardOnComplete} from '../trello/completion.js';
import {expandPrompt} from './prompt.js';
import {generateSummary} from './summarizer.js';
import {runCodeReview} from './reviewer.js';
import {recoverFailedTicket} from './failure-recovery.js';
import {generatePrDescription} from './pr-description.js';
import {captureContext, publishReviewed, assertPublished, savedPlan} from '../review/context.js';
import {loadPassedReview, previousEvidence, saveJson} from '../review/report.js';
import {runHarness} from '../harness/process.js';

export type RunnerCallbacks = {
	onStatusChange: (ticketNumber: number, state: TicketState) => void;
	onLogLine: (ticketNumber: number, line: string) => void;
	onComplete: (ticketNumber: number, state: TicketState) => void;
	onFailure: (ticketNumber: number, state: TicketState) => Promise<'retry' | 'skip'>;
	beforeTicket?: () => Promise<IterisConfig>;
};
export type RunnerServices = {findPr: typeof findPrForBranch; createPr: typeof createPullRequest; addLabel: typeof addLabelToIssue; moveCard: typeof moveCardOnComplete; updateReview?: typeof updatePrReview};
const defaultServices: RunnerServices = {findPr: findPrForBranch, createPr: createPullRequest, addLabel: addLabelToIssue, moveCard: moveCardOnComplete, updateReview: updatePrReview};
export async function runAllTickets(tickets: Ticket[], config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, externalSignal?: AbortSignal, services: RunnerServices = defaultServices): Promise<void> {
	validateBaseBranch(config.baseBranch, cwd);
	const release = await acquireRun(cwd);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on('SIGINT', abort); process.on('SIGTERM', abort);
	externalSignal?.addEventListener('abort', abort, {once: true});
	if (externalSignal?.aborted) abort();
	try {
		await savePendingQueue(cwd, config, tickets);
		for (const [index, ticket] of tickets.entries()) {
			if (controller.signal.aborted) break;
			const latest = callbacks.beforeTicket ? await callbacks.beforeTicket() : await loadConfig(cwd);
			// Ticket source/repository belong to the fetched queue. Only execution
			// preferences change at boundaries. Retries retain this snapshot.
			const snapshot = structuredClone({...config, harness: latest.harness, harnesses: latest.harnesses, planMode: latest.planMode, timeout: latest.timeout, review: latest.review, qualityChecks: latest.qualityChecks});
			const checkpoint: TicketCheckpoint = {};
			const recoveryAttempts = new Map<string, number>();
			let schemaRetryCount = 0;
			let retry = true;
			while (retry && !controller.signal.aborted) {
				const result = await runSingleTicket(ticket, snapshot, cwd, callbacks, controller.signal, services, checkpoint);
				const failed = ['failed', 'stale', 'blocked', 'incomplete'].includes(result.status);
				if (!failed || controller.signal.aborted) {retry = false; continue;}
				if (isSchemaReportFailure(result.failureReason)) {
					const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(schemaRetryCount++, 6));
					callbacks.onStatusChange(ticket.number, {...result, status: 'recovering'});
					callbacks.onLogLine(ticket.number, `[iteris] Schema recovery needs another attempt; retrying ticket #${ticket.number} in ${delayMs / 1000}s without repeating implementation.`);
					await waitForSchemaRetry(delayMs, controller.signal);
					retry = !controller.signal.aborted;
					continue;
				}
				schemaRetryCount = 0;
				const failureKey = `${result.status}:${result.failureReason ?? ''}`;
				const attempts = recoveryAttempts.get(failureKey) ?? 0;
				if (attempts < 2 && snapshot.review?.maxRepairCycles !== 0 && !result.failureReason?.includes('Invalid review report')) {
					recoveryAttempts.set(failureKey, attempts + 1);
					callbacks.onStatusChange(ticket.number, {...result, status: 'recovering'});
					const folder = path.join(cwd, '.iteris', 'runs', ticket.custom ? `custom-${ticket.custom.identity}` : `${ticket.number}-${ticket.slug}`);
					const recovered = await recoverFailedTicket({ticket, config: snapshot, cwd, state: result, plan: checkpoint.plan ?? await savedPlan(folder), signal: controller.signal,
						onLogLine: line => callbacks.onLogLine(ticket.number, line)});
					if (recovered) {checkpoint.implemented = true; retry = true; continue;}
				}
				retry = !controller.signal.aborted && await callbacks.onFailure(ticket.number, result) === 'retry';
			}
			if (controller.signal.aborted) break;
			await savePendingQueue(cwd, config, tickets.slice(index + 1));
		}
	} finally {
		process.off('SIGINT', abort); process.off('SIGTERM', abort);
		externalSignal?.removeEventListener('abort', abort);
		await release();
	}
}

function isSchemaReportFailure(reason?: string): boolean {
	return Boolean(reason && (reason.includes('Invalid review report:') || reason.includes('Schema recovery')));
}

async function waitForSchemaRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>(resolve => {
		const finish = () => {clearTimeout(timer); signal.removeEventListener('abort', finish); resolve();};
		const timer = setTimeout(finish, delayMs);
		signal.addEventListener('abort', finish, {once: true});
		if (signal.aborted) finish();
	});
}

type TicketCheckpoint = {plan?: string; implemented?: boolean};

async function runSingleTicket(ticket: Ticket, config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, signal: AbortSignal, services: RunnerServices, checkpoint: TicketCheckpoint): Promise<TicketState> {
	const folder = await createRunFolder(cwd, ticket);
	const settings = config.harnesses[config.harness];
	const state: TicketState = {ticket, status: 'running', branch: ticketBranch(ticket), logLines: [], elapsedMs: 0, startedAt: new Date(),
		selection: {harness: config.harness, model: settings.model, effort: settings.effort}};
	let logWrites = Promise.resolve();
	let logError: unknown;
	const log = (line: string) => {
		state.logLines = [...state.logLines, ...line.split('\n')].slice(-50);
		state.elapsedMs = Date.now() - state.startedAt!.getTime();
		callbacks.onLogLine(ticket.number, line); callbacks.onStatusChange(ticket.number, {...state});
		logWrites = logWrites.then(() => appendLog(folder, line + '\n')).catch(error => {logError = error;});
	};
	const phase = async (status: TicketState['status']) => {state.status = status; callbacks.onStatusChange(ticket.number, {...state}); await writeStatus(folder, state);};
	try {
		await writeFile(path.join(folder, 'execution.json'), JSON.stringify(state.selection, null, 2) + '\n');
		const prompt = expandPrompt(ticket, config, await readProgress(cwd));
		await writePrompt(folder, prompt);
		let plan = checkpoint.plan ?? await savedPlan(folder);
		if (!checkpoint.implemented) {
			try {
				const context = captureContext(ticket, config, cwd, plan);
				const reviewFolder = path.join(folder, 'review');
				const cached = await loadPassedReview(reviewFolder, context);
				let implementation: {scope?: string; head?: string} = {};
				try {implementation = JSON.parse(await readFile(path.join(folder, 'implementation.json'), 'utf8')) as typeof implementation;} catch { /* no completed implementation checkpoint */ }
				if ((implementation.scope === context.stamp.scope && implementation.head === context.stamp.head) || cached || await previousEvidence(reviewFolder, context)) {checkpoint.implemented = true; checkpoint.plan = plan;}
			} catch { /* no matching completed review to resume */ }
		}
		if (config.planMode && checkpoint.plan === undefined) {
			await phase('planning');
			const result = await runHarness({config, phase: 'planning', prompt: `Inspect this task and produce an implementation plan. Do not edit files, execute changes, or print a completion marker.\n\n${prompt}`, cwd, timeoutMs: config.timeout * 1000, onLine: log, signal});
			if (!result.success || !result.text) {state.status = result.timedOut ? 'stale' : 'failed'; throw new Error(result.error ?? 'Planning produced no plan');}
			plan = result.text; checkpoint.plan = plan; await writeFile(path.join(folder, 'plan.md'), plan + '\n');
		}
		if (!checkpoint.implemented) {
			await phase('running');
			const result = await runHarness({config, phase: 'implementation', prompt: `${prompt}${plan ? `\n\nImplement this plan:\n${plan}` : ''}`, cwd, timeoutMs: config.timeout * 1000, onLine: log, signal});
			if (!result.success || !result.done) {state.status = result.timedOut ? 'stale' : 'failed'; throw new Error(result.error ?? 'Process exited without the completion signal');}
			const implemented = captureContext(ticket, config, cwd, plan);
			await saveJson(path.join(folder, 'implementation.json'), {scope: implemented.stamp.scope, head: implemented.stamp.head});
			checkpoint.implemented = true;
		}
		await phase('reviewing');
		const reviewed = await runCodeReview({ticket, config, cwd, folder, plan, onLogLine: log, onProcess() {}, signal});
		if (reviewed.report.outcome !== 'passed') {
			state.status = reviewed.report.outcome;
			throw new Error(`Code review ${reviewed.report.outcome}: ${reviewed.error}`);
		}
		const reviewedContext = captureContext(ticket, config, cwd, plan);
		if (reviewedContext.stamp.key !== reviewed.report.stamp?.key) throw new Error('Code changed after review; rerun review before publication.');
		await publishReviewed(reviewedContext, config, cwd, signal);
		let pr = await services.findPr(config, state.branch);
		if (!pr) {
			await phase('creating-pr');
			const described = await generatePrDescription({ticket, config, cwd, review: reviewed.text, baseCommit: reviewedContext.stamp.base, signal,
				onLine(line) {log(`[pr] ${line}`);},
			});
			if (!described.success || !described.text) {
				state.status = described.timedOut ? 'stale' : 'failed';
				throw new Error(`PR description: ${described.error ?? 'Harness produced no description'}`);
			}
			await assertPublished(reviewedContext, config, cwd, signal);
			pr = await services.createPr(config, {branch: state.branch, title: ticketPrTitle(ticket), body: described.text});
			log(`[iteris] Created PR ${pr.url}`);
		} else {
			await assertPublished(reviewedContext, config, cwd, signal);
			await services.updateReview?.(config, pr.number, reviewed.text);
		}
		await assertPublished(reviewedContext, config, cwd, signal);
		state.prUrl = pr.url; state.prNumber = pr.number;
		if (config.pr.addLabelOnOpen && (config.provider === 'github' || config.provider === undefined)) await services.addLabel(config, ticket.number, config.pr.addLabelOnOpen);
		if (config.provider === 'trello') await services.moveCard(config, ticket.number);
		await phase('summarizing'); await logWrites;
		try {await generateSummary(folder, config, cwd, undefined, signal);} catch (error) {log(`Summary failed: ${String(error)}`);}
		if (signal.aborted) throw new Error('Cancelled');
		state.status = 'done';
		await appendProgress(cwd, `#${ticket.number} (${ticket.title}) — completed successfully`);
	} catch (error) {
		state.status = signal.aborted || state.status === 'stale' ? 'stale' : state.status === 'blocked' || state.status === 'incomplete' ? state.status : 'failed';
		state.failureReason = error instanceof Error ? error.message : String(error);
		log(`[iteris] ${state.failureReason}`);
	} finally {
		state.finishedAt = new Date(); state.elapsedMs = Date.now() - state.startedAt!.getTime();
		await logWrites;
		if (logError) {state.status = 'failed'; state.failureReason = `Could not save run log: ${String(logError)}`;}
		await writeStatus(folder, state);
		callbacks.onStatusChange(ticket.number, {...state});
	}
	if (state.status === 'done') callbacks.onComplete(ticket.number, {...state});
	return {...state};
}
