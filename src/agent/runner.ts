import {ticketBranch} from '../types.js';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {IterisConfig, Ticket, TicketState} from '../types.js';
import {validateBaseBranch} from '../github/repo.js';
import {acquireRun} from '../state/active.js';
import {loadConfig} from '../config.js';
import {createRunFolder, writeStatus, writePrompt, appendLog} from '../state/manager.js';
import {readProgress, appendProgress} from '../state/progress.js';
import {findPrForBranch, createPullRequest, addLabelToIssue} from '../github/pr.js';
import {moveCardOnComplete} from '../trello/completion.js';
import {expandPrompt} from './prompt.js';
import {generateSummary} from './summarizer.js';
import {runCodeReview} from './reviewer.js';
import {generatePrDescription} from './pr-description.js';
import {runHarness} from '../harness/process.js';

export type RunnerCallbacks = {
	onStatusChange: (ticketNumber: number, state: TicketState) => void;
	onLogLine: (ticketNumber: number, line: string) => void;
	onComplete: (ticketNumber: number, state: TicketState) => void;
	onFailure: (ticketNumber: number, state: TicketState) => Promise<'retry' | 'skip'>;
	beforeTicket?: () => Promise<IterisConfig>;
};
export type RunnerServices = {findPr: typeof findPrForBranch; createPr: typeof createPullRequest; addLabel: typeof addLabelToIssue; moveCard: typeof moveCardOnComplete};
const defaultServices: RunnerServices = {findPr: findPrForBranch, createPr: createPullRequest, addLabel: addLabelToIssue, moveCard: moveCardOnComplete};
export async function runAllTickets(tickets: Ticket[], config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, externalSignal?: AbortSignal, services: RunnerServices = defaultServices): Promise<void> {
	validateBaseBranch(config.baseBranch, cwd);
	const release = await acquireRun(cwd);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on('SIGINT', abort); process.on('SIGTERM', abort);
	externalSignal?.addEventListener('abort', abort, {once: true});
	if (externalSignal?.aborted) abort();
	try {
		for (const ticket of tickets) {
			if (controller.signal.aborted) break;
			const latest = callbacks.beforeTicket ? await callbacks.beforeTicket() : await loadConfig(cwd);
			// Ticket source/repository belong to the fetched queue. Only execution
			// preferences change at boundaries. Retries retain this snapshot.
			const snapshot = structuredClone({...config, harness: latest.harness, harnesses: latest.harnesses, planMode: latest.planMode, timeout: latest.timeout});
			const checkpoint: TicketCheckpoint = {};
			let retry = true;
			while (retry && !controller.signal.aborted) {
				const result = await runSingleTicket(ticket, snapshot, cwd, callbacks, controller.signal, services, checkpoint);
				retry = !controller.signal.aborted && (result.status === 'failed' || result.status === 'stale') && await callbacks.onFailure(ticket.number, result) === 'retry';
			}
		}
	} finally {
		process.off('SIGINT', abort); process.off('SIGTERM', abort);
		externalSignal?.removeEventListener('abort', abort);
		await release();
	}
}

type TicketCheckpoint = {plan?: string; implemented?: boolean; reviewed?: boolean; review?: string};

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
		let plan = checkpoint.plan ?? '';
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
			checkpoint.implemented = true;
		}
		if (!checkpoint.reviewed) {
			await phase('reviewing');
			const reviewed = await runCodeReview({ticket, config, cwd, folder, onLogLine: log, onProcess() {}, signal});
			if (!reviewed.success || !reviewed.done) {
				state.status = reviewed.timedOut ? 'stale' : 'failed';
				throw new Error(`Code review: ${reviewed.error ?? 'Process exited without the completion signal'}`);
			}
			checkpoint.reviewed = true; checkpoint.review = reviewed.text;
		}
		let pr = await services.findPr(config, state.branch);
		if (!pr) {
			await phase('creating-pr');
			const described = await generatePrDescription({ticket, config, cwd, review: checkpoint.review ?? '', signal,
				onLine(line) {log(`[pr] ${line}`);},
			});
			if (!described.success || !described.text) {
				state.status = described.timedOut ? 'stale' : 'failed';
				throw new Error(`PR description: ${described.error ?? 'Harness produced no description'}`);
			}
			pr = await services.createPr(config, {branch: state.branch, title: ticket.title, body: described.text});
			log(`[iteris] Created PR ${pr.url}`);
		}
		state.prUrl = pr.url; state.prNumber = pr.number;
		if (config.pr.addLabelOnOpen && (config.provider === 'github' || config.provider === undefined)) await services.addLabel(config, ticket.number, config.pr.addLabelOnOpen);
		if (config.provider === 'trello') await services.moveCard(config, ticket.number);
		await phase('summarizing'); await logWrites;
		try {await generateSummary(folder, config, cwd, undefined, signal);} catch (error) {log(`Summary failed: ${String(error)}`);}
		if (signal.aborted) throw new Error('Cancelled');
		state.status = 'done';
		await appendProgress(cwd, `#${ticket.number} (${ticket.title}) — completed successfully`);
	} catch (error) {
		state.status = signal.aborted || state.status === 'stale' ? 'stale' : 'failed';
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
