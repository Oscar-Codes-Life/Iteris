import {inTaskWorkspace, stateRoot} from '../state/workspace.js';
import {runPool} from '../state/pool.js';
import {prepareTaskWorkspace} from '../lifecycle/worktree.js';
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
import {findPrForBranch, createPullRequest, addLabelToIssue, updatePrReview, updatePrLifecycle, updatePrSections} from '../github/pr.js';
import {moveCardOnComplete} from '../trello/completion.js';
import {expandPrompt,mergePrompt} from './prompt.js';
import {checkOk} from '../review/schema.js';
import {redact} from '../harness/redact.js';
import {generateSummary} from './summarizer.js';
import {runCodeReview} from './reviewer.js';
import {recoverFailedTicket} from './failure-recovery.js';
import {generatePrDescription, pendingDescription, prBody, ticketReference} from './pr-description.js';
import {captureContext, assertContextBudget, publishReviewed, assertPublished, savedPlan,git} from '../review/context.js';
import {loadPassedReview, previousEvidence, saveJson} from '../review/report.js';
import {runHarness} from '../harness/process.js';
import {ensureRun, saveRun, readRun, taskKey, waitFor, recordFailure,clearVerifiedLocalDependencies, type TaskRun} from '../lifecycle/state.js';
import {extractRequirements, verificationPack, addEvidence, reconcileEvidence} from '../lifecycle/requirements.js';
import {prepareEnvironment,persistedManifest,CapabilityUnavailable,setupBudget} from '../lifecycle/environment.js';
import {advanceCompletion, publishCompletionView, type CompletionServices} from '../lifecycle/stages.js';
import {setGithubDraft} from '../lifecycle/github-verification.js';
import {resolveTaskConfig} from '../lifecycle/config.js';
import {classifyFailure} from '../lifecycle/failures.js';
import {prepareBranch,commitSourceChanges,checkpointPartialWork,integrateBase,unresolvedConflicts,mergeInProgress,abortMerge} from '../lifecycle/commit.js';
import {recordAttempt,consumeRetry,attemptBriefing,retryScheduled,type AttemptInput} from '../lifecycle/attempts.js';
import {planningSchema,applyPlanningPack,localPlannedChecks} from '../lifecycle/planning.js';
import {parseOrRecoverReport} from './schema-recovery.js';
import {importLegacyArtifacts} from '../lifecycle/migration.js';
import {cancellationScope} from '../lifecycle/cancellation.js';
import {githubTaskRepository} from '../lifecycle/adapters.js';
import {evidenceNote} from '../lifecycle/evidence.js';
import {tidyBranch} from './tidy.js';

export type RunnerCallbacks = {
	onStatusChange: (ticketNumber: number, state: TicketState) => void;
	onLogLine: (ticketNumber: number, line: string) => void;
	onComplete: (ticketNumber: number, state: TicketState) => void;
	/**
	 * Notification only. A failed attempt never waits for a person: the host
	 * journals it, stops the instance, keeps the task state, and schedules a
	 * fresh instance that receives the journal.
	 */
	onAttemptFailed?: (ticketNumber: number, state: TicketState) => void | Promise<void>;
	beforeTicket?: () => Promise<IterisConfig>;
};
export type RunnerServices = CompletionServices & {findPr: typeof findPrForBranch; createPr: typeof createPullRequest; addLabel: typeof addLabelToIssue; moveCard: typeof moveCardOnComplete; updateReview?: typeof updatePrReview; updateSections?: typeof updatePrSections};
const defaultServices: RunnerServices = {findPr: findPrForBranch, createPr: createPullRequest, addLabel: addLabelToIssue, moveCard: moveCardOnComplete, updateReview: updatePrReview, updateSections: updatePrSections,draft:setGithubDraft,status:updatePrLifecycle};
export async function runAllTickets(tickets: Ticket[], config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, externalSignal?: AbortSignal, services: RunnerServices = defaultServices, ownsRepositoryLock = false): Promise<void> {
	// Duplicate source entries must never launch two writers in the same checkout.
	tickets = [...new Map(tickets.map(ticket => [taskKey(ticket, config), ticket])).values()];
	validateBaseBranch(config.baseBranch, cwd);
	const release = ownsRepositoryLock ? async () => {} : await acquireRun(cwd);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on('SIGINT', abort); process.on('SIGTERM', abort);
	externalSignal?.addEventListener('abort', abort, {once: true});
	if (externalSignal?.aborted) abort();
	try {
		if (!ownsRepositoryLock) await savePendingQueue(cwd, config, tickets);
		// Persist every selected task before starting any implementation. A restart
		// must retain tickets that never reached the first harness invocation.
		for(const ticket of tickets) {
			const folder=await createRunFolder(cwd,ticket,config);
			await importLegacyArtifacts(cwd,ticket,config,folder);
			await saveRun(cwd,await ensureRun(cwd,ticket,config,folder,ticketBranch(ticket)));
		}
		const remaining = new Map(tickets.map(ticket => [taskKey(ticket, config), ticket]));
		let queueWrites = Promise.resolve();
		// Serialize interactive prerequisite checks so simultaneous tasks cannot open competing prompts.
		let selectionGate = Promise.resolve();
		const nextSelection = () => {
			const next = selectionGate.then(() => callbacks.beforeTicket ? callbacks.beforeTicket() : loadConfig(stateRoot(cwd)));
			selectionGate = next.then(() => {}, () => {});
			return next;
		};
		const runQueuedTicket = async (ticket: Ticket) => {
			const latest = await nextSelection();
			if (controller.signal.aborted) return;
			// Ticket source/repository belong to the fetched queue. Only execution
			// preferences change at boundaries. Retries retain this snapshot.
			const snapshot = resolveTaskConfig(structuredClone({...config, harness: latest.harness, harnesses: latest.harnesses, planMode: latest.planMode, timeout: latest.timeout, review: latest.review, qualityChecks: latest.qualityChecks, workflow:latest.workflow, verification:latest.verification, environment:latest.environment, recovery:latest.recovery, continuation:latest.continuation, integrations:latest.integrations, profiles:latest.profiles}),ticket);
			snapshot._deadline = config._deadline ?? Date.now() + snapshot.timeout * 1000;
			const root = stateRoot(cwd);
			const folder = await createRunFolder(root, ticket, snapshot);
			const run = await ensureRun(root, ticket, snapshot, folder, ticketBranch(ticket));
			const notifyFailure = async (state: TicketState) => {
				try {await callbacks.onAttemptFailed?.(ticket.number, state);} catch (error) {callbacks.onLogLine(ticket.number, `[iteris] Attempt notification failed: ${String(error)}`);}
			};
			// Journal a failure outside runSingleTicket (workspace, recovery or host errors).
			const journal = async (input: AttemptInput, base: Partial<TicketState> = {}) => {
				const current = await readRun(root, run.key) ?? run;
				if (['complete', 'cancelled'].includes(current.state)) return;
				const record = recordAttempt(current, snapshot, input);
				await saveRun(root, current);
				const state: TicketState = {ticket, runKey: current.key, branch: current.branch, workspace: current.workspace, logLines: [], elapsedMs: 0, ...base,
					status: record.disposition === 'stopped' ? 'blocked' : record.disposition === 'retry' ? 'retrying' : 'waiting', failureReason: current.reason, attempt: attemptView(record)};
				callbacks.onStatusChange(ticket.number, state);
				await notifyFailure(state);
				return record;
			};
			let taskCwd: string;
			const workspaceLogs: string[] = [];
			try {
				taskCwd = await prepareTaskWorkspace(root, run, snapshot, line => {workspaceLogs.push(line); callbacks.onLogLine(ticket.number, line);});
			} catch (error) {
				// A workspace failure is an attempt failure like any other: record it and retry later.
				await journal({phase: 'workspace', status: 'failed', kind: 'environment', reason: `Task workspace could not be prepared: ${error instanceof Error ? error.message : String(error)}`, logTail: workspaceLogs});
				return;
			}
			if (workspaceLogs.length) await appendLog(folder, workspaceLogs.join('\n') + '\n');
			try {
				await inTaskWorkspace(root, run.key, async () => {
					const cwd = taskCwd;
					const checkpoint: TicketCheckpoint = {logs: workspaceLogs};
					const recoveryAttempts = new Map<string, number>();
					let schemaRetryCount = 0;
					while (!controller.signal.aborted) {
						const result = await runSingleTicket(ticket, snapshot, cwd, callbacks, controller.signal, services, checkpoint);
						// Completed, cancelled, or waiting on external evidence: nothing failed.
						if (controller.signal.aborted || !result.attempt) break;
						await notifyFailure(result);
						// Published drafts and dependency waits continue through the worker with a fresh instance.
						if (result.prUrl || result.attempt.disposition !== 'retry') break;
						if (isSchemaReportFailure(result.failureReason) && schemaRetryCount < snapshot.recovery.attempts && Date.now() < (snapshot._deadline ?? Infinity)) {
							const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(schemaRetryCount++, 6));
							callbacks.onStatusChange(ticket.number, {...result, status: 'recovering'});
							callbacks.onLogLine(ticket.number, `[iteris] Schema recovery needs another attempt; retrying ticket #${ticket.number} in ${delayMs / 1000}s without repeating implementation.`);
							await waitForSchemaRetry(delayMs, controller.signal);
							continue;
						}
						schemaRetryCount = 0;
						const failureKey = classifyFailure(result.failureReason??result.status,result.status).signature;
						const attempts = recoveryAttempts.get(failureKey) ?? 0;
						// Immediate repair stays within this task allowance. Anything beyond it
						// is a later fresh attempt with its own allowance, scheduled already.
						if (!(attempts < snapshot.recovery.attempts && snapshot.recovery.enabled && Date.now() < (snapshot._deadline ?? Infinity) && snapshot.review?.maxRepairCycles !== 0 && !result.failureReason?.includes('Invalid review report'))) break;
						recoveryAttempts.set(failureKey, attempts + 1);
						callbacks.onStatusChange(ticket.number, {...result, status: 'recovering'});
						const artifacts = path.join(stateRoot(cwd), '.iteris', 'tasks', taskKey(ticket,snapshot),'artifacts');
						const recoveryLog: string[] = [], outcome: {reason?: string} = {};
						const recovered = await recoverFailedTicket({ticket, config: snapshot, cwd, state: {...result, status: result.attempt.status as TicketState['status']}, plan: checkpoint.plan ?? await savedPlan(artifacts), signal: controller.signal,
							history: attemptBriefing(await readRun(root, run.key)), outcome,
							onLogLine: line => {recoveryLog.push(line); callbacks.onLogLine(ticket.number, line);}});
						if (recovered) {checkpoint.implemented = hasCommittedWork(cwd, snapshot.baseBranch); continue;}
						if (controller.signal.aborted) break;
						const reason = outcome.reason ?? 'Recovery instance could not repair the failure';
						await journal({phase: 'repair', status: 'failed', kind: classifyFailure(reason, 'repair').kind, reason, head: headOf(cwd), selection: result.selection, logTail: recoveryLog}, result);
						break;
					}
				});
			} catch (error) {
				if (controller.signal.aborted) return;
				// One task's unexpected host error must not stop a queue that runs for days.
				const reason = error instanceof Error ? error.message : String(error);
				callbacks.onLogLine(ticket.number, `[iteris] Unexpected failure: ${reason}`);
				try {await journal({phase: 'host', status: 'failed', kind: classifyFailure(error, 'host').kind, reason});} catch (failure) {callbacks.onLogLine(ticket.number, `[iteris] Could not record the failed attempt: ${String(failure)}`);}
			}
			if (controller.signal.aborted) return;
			remaining.delete(taskKey(ticket, config));
			if (!ownsRepositoryLock) queueWrites = queueWrites.then(() => savePendingQueue(stateRoot(cwd), config, [...remaining.values()]));
			await queueWrites;
		};
		// A resumed local task still owns the main checkout, even if the default changed.
		const saved = await Promise.all(tickets.map(ticket => ensureRun(cwd, ticket, config, '', ticketBranch(ticket))));
		const local = tickets.filter((_, index) => (saved[index]?.workspace?.mode ?? config.workspace.mode) === 'local');
		const isolated = tickets.filter(ticket => !local.includes(ticket));
		await runPool(local, 1, runQueuedTicket, controller.signal);
		await runPool(isolated, config.workspace.concurrency, runQueuedTicket, controller.signal);
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

type TicketCheckpoint = {plan?: string; implemented?: boolean; logs?: string[]};

function reviewDetails(report: {findings: Array<{status: string; priority: string; category: string; file: string; line: number; title: string; duplicateOf?: string}>; checks: Array<{command: string; exitCode: number | null}>; requirements: Array<{requirement: string; status: string}>; gaps: string[]}): string[] {
	return [
		...report.findings.filter(finding => finding.status === 'confirmed' && !finding.duplicateOf).map(finding => `${finding.priority} ${finding.category} finding at ${finding.file}:${finding.line}: ${finding.title}`),
		...report.checks.filter(check => check.exitCode !== 0).map(check => `failed check (exit ${check.exitCode ?? 'none'}): ${check.command}`),
		...report.requirements.filter(requirement => requirement.status !== 'covered').map(requirement => `${requirement.status} requirement: ${requirement.requirement}`),
		...report.gaps.map(gap => `gap: ${gap}`),
	];
}

function headOf(cwd: string): string | undefined {
	try {return git(cwd, ['rev-parse', 'HEAD']).trim();} catch {return undefined;}
}

/** True when the current branch carries commits beyond the configured base. */
function hasCommittedWork(cwd: string, base: string): boolean {
	for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
		try {return Number(git(cwd, ['rev-list', '--count', `${ref}..HEAD`]).trim()) > 0;} catch { /* try the next base ref */ }
	}
	return false;
}

function attemptView(record: ReturnType<typeof recordAttempt>): NonNullable<TicketState['attempt']> {
	return {number: record.number, status: record.status, disposition: record.disposition, ...(record.nextRetryAt ? {nextRetryAt: record.nextRetryAt} : {}), ...(record.needsRepair ? {needsRepair: true} : {})};
}

/** Journal a failed pass at the point it failed, while its output and phase are known. */
function failAttempt(run: TaskRun, config: IterisConfig, state: TicketState, cwd: string, input: Omit<AttemptInput, 'logTail' | 'selection' | 'head' | 'status'> & {status?: string}): void {
	const record = recordAttempt(run, config, {...input, status: input.status ?? state.status, head: headOf(cwd), selection: state.selection, logTail: state.logLines});
	state.attempt = attemptView(record);
}

async function runSingleTicket(ticket: Ticket, config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, parentSignal: AbortSignal, services: RunnerServices, checkpoint: TicketCheckpoint): Promise<TicketState> {
	const folder = await createRunFolder(cwd, ticket,config);
	await importLegacyArtifacts(cwd,ticket,config,folder);
	const run = await ensureRun(cwd,ticket,config,folder,ticketBranch(ticket));
	// This pass is the scheduled fresh attempt; its outcome decides what comes next.
	consumeRetry(run);
	const cancellation=await cancellationScope(cwd,run.key,parentSignal),signal=cancellation.signal;
	ticket={...ticket,branch:run.branch};run.ticket=ticket;
	const settings = config.harnesses[config.harness];
	const state: TicketState = {ticket, status: 'preparing', branch: ticketBranch(ticket), logLines: checkpoint.logs ?? [], elapsedMs: 0, startedAt: new Date(),
		workspace: run.workspace, selection: {harness: config.harness, model: settings.model, effort: settings.effort}};
	state.runKey = run.key;
	const timeout = (reserve = false) => Math.max(1,Math.min(config.timeout*1000, (config._deadline ?? Date.now()+config.timeout*1000)-Date.now()-(reserve ? config.timeout*1000*config.recovery.finalVerificationReserve : 0)));
	let logWrites = Promise.resolve();
	let logError: unknown;
	const log = (line: string) => {
		state.logLines = [...state.logLines, ...line.split('\n')].slice(-50);
		state.elapsedMs = Date.now() - state.startedAt!.getTime();
		callbacks.onLogLine(ticket.number, line); callbacks.onStatusChange(ticket.number, {...state});
		logWrites = logWrites.then(() => appendLog(folder, line + '\n')).catch(error => {logError = error;});
	};
	const phase = async (status: TicketState['status']) => {state.status = status; run.phase=status;run.state='active';callbacks.onStatusChange(ticket.number, {...state}); await writeStatus(folder, state);await saveRun(cwd,run);};
	try {
		if(signal.aborted)throw new Error('Cancelled');
		// A stopped or crashed instance can leave edits behind. Keep them as a
		// checkpoint so this fresh instance continues instead of failing on a dirty tree.
		if (checkpointPartialWork(cwd, state.branch, `Checkpoint partial work from an interrupted attempt on ${ticket.title}`)) log('[iteris] Committed partial work left by the previous instance; this attempt continues from it.');
		run.state='active';run.phase='preflight';await saveRun(cwd,run);
		callbacks.onStatusChange(ticket.number, {...state});
		await writeStatus(folder, state);
		// A configuration the review cannot use fails here, before setup or any instance spends time on it.
		assertContextBudget(config, cwd);
		run.environment=persistedManifest(await prepareEnvironment(config,cwd,signal,log,setupBudget(cwd,run,config)));
		run.dependencies=run.dependencies.filter(d=>d.kind!=='environment' && d.id!=='preflight');
		for(const requirement of extractRequirements(ticket,config))if(!run.requirements.some(r=>r.id===requirement.id))run.requirements.push(requirement);
		const pack=verificationPack(run,config);
		await saveJson(path.join(folder,'verification-pack.json'),JSON.parse(pack));await saveRun(cwd,run);
		await writeFile(path.join(folder, 'execution.json'), JSON.stringify(state.selection, null, 2) + '\n');
		const prompt = `${expandPrompt(ticket, config, await readProgress(cwd), attemptBriefing(run))}\n\nHost-owned task verification pack:\n${pack}\nExternal acceptance stages are verified by the host after publication. Implement all required local behavior. Do not deploy or update providers from the harness. Policy and context files named in the pack (such as REVIEW.md) are host inputs that may not exist: never create or edit them. ${evidenceNote(cwd, state.branch)} The host prepares the branch and commits your source changes. Leave changes ready for independent review and print <task>done</task>; do not require permission to write .git or change host-owned .iteris files.`;
		await writePrompt(folder, prompt);
		let plan = checkpoint.plan ?? run.plan ?? '';
		if (!checkpoint.implemented) {
			prepareBranch(cwd,state.branch,config.baseBranch);
			// Work and review continue on the current base. A branch that conflicts with its target gets no pull-request CI.
			const merge=await integrateBase(cwd,state.branch,config.baseBranch,signal);
			if(merge.status==='conflicted') {
				log(`[iteris] ${config.baseBranch} moved and conflicts with this branch in ${merge.files.length} file${merge.files.length===1?'':'s'}; starting an instance to resolve the merge.`);
				await phase('running');
				try {
					const resolved=await runHarness({config,phase:'repair',prompt:redact(mergePrompt(ticket,config,state.branch,merge.files,plan)),cwd,timeoutMs:timeout(true),onLine:line=>log(`[merge] ${line}`),signal});
					const unresolved=unresolvedConflicts(cwd,merge.files);
					if(!resolved.success || !resolved.done || unresolved.length) {
						state.status=resolved.timedOut?'stale':'failed';
						throw new Error(`Conflicts with ${config.baseBranch} were not resolved${unresolved.length?` in ${unresolved.join(', ')}`:''}: ${resolved.error ?? (unresolved.length?'conflict markers remain':'no completion signal')}`);
					}
					commitSourceChanges(cwd,state.branch,`Merge ${config.baseBranch} into ${state.branch}`);
					if(mergeInProgress(cwd))throw new Error(`The merge of ${config.baseBranch} could not be concluded`);
				} catch(error) {abortMerge(cwd);throw error;}
			}
			if(merge.status!=='current') {
				const head=git(cwd,['rev-parse','HEAD']).trim();
				// The implementation is unchanged; only its base moved. Review the merged commit instead of implementing again.
				if(merge.status!=='fast-forwarded' && run.implementation?.head===merge.before)run.implementation.head=head;
				log(`[iteris] ${merge.status==='fast-forwarded'?`Started from the current ${config.baseBranch}`:`Merged the current ${config.baseBranch} into the task branch`} (${head.slice(0,12)}).`);
				await saveRun(cwd,run);
			}
			if(merge.base)config._base=merge.base;
			try {
				const context = captureContext(ticket, config, cwd, plan);
				const reviewFolder = path.join(folder, 'review');
				const cached = await loadPassedReview(reviewFolder, context, config.workflow.externalEvidence === 'advisory');
				let implementation: {scope?: string; head?: string} = {};
				try {implementation = JSON.parse(await readFile(path.join(folder, 'implementation.json'), 'utf8')) as typeof implementation;} catch { /* no completed implementation checkpoint */ }
				if ((run.implementation?.fingerprint === run.fingerprint && run.implementation.head === context.stamp.head) || (implementation.scope === context.stamp.scope && implementation.head === context.stamp.head) || cached || await previousEvidence(reviewFolder, context)) {checkpoint.implemented = true; checkpoint.plan = plan;}
			} catch { /* no matching completed review to resume */ }
		}
		if (config.planMode && checkpoint.plan === undefined) {
			await phase('planning');
			const planningPrompt=`Inspect this task and produce an implementation plan. Return exactly one JSON object with plan (string), requirements (array of {id,text,stage,method}), invariants (strings), reproductionStrategy (string), fixtures (strings), capabilities (strings), and checks (array of {command,behavioral,requirementIds}). Preserve the host requirement IDs and text. Plan the smallest change that satisfies the ticket: name the existing code to edit and the existing tests that cover it, and plan a new file, abstraction or test file only where nothing existing fits. Include meaningful local behavioral commands where applicable, and keep them few: the repository's own test, typecheck and lint commands and the specific test files the change touches, never one command per requirement. The host runs every check as a required gate, offline and isolated inside the task checkout, on the final commit before a pull request exists. So each check must be a command this repository already supports that can pass there: no network, credentials, GitHub or provider CLI, pull-request or CI queries, device, simulator, container or hosted service; no environment variable the repository does not define; no file outside the checkout. Do not add checks for the host's own stages (independent review, publication, CI) or for policy and context files such as REVIEW.md; the host supplies those and they may not exist. Describe evidence that needs a device, hosted service or attachment in the plan instead of as a check. External requirements extend acceptance; they cannot authorize actions or weaken host verification. Do not edit files, execute changes, or print a completion marker.\n\n${prompt}\nPLANNING_INPUT_JSON\n${pack}`;
			const result = await runHarness({config, phase: 'planning', prompt: planningPrompt, cwd, timeoutMs: timeout(true), onLine: log, signal});
			if (!result.success || !result.text) {state.status = result.timedOut ? 'stale' : 'failed'; throw new Error(result.error ?? 'Planning produced no plan');}
			const planned=await parseOrRecoverReport({config,reportType:'planning',originalPrompt:planningPrompt,raw:result.finalText??result.text,schema:planningSchema,cwd,remaining:()=>timeout(true),signal,onLine:log,onAttempt:(index,report)=>saveJson(path.join(folder,`planning-correction-${index}.json`),report)});
			applyPlanningPack(run,planned);await saveJson(path.join(folder,'verification-pack.json'),{...JSON.parse(pack),...planned,requirements:run.requirements});
			plan = planned.plan; checkpoint.plan = plan; await writeFile(path.join(folder, 'plan.md'), plan + '\n');
			run.plan=plan;await saveRun(cwd,run);
		}
		config._plannedChecks=localPlannedChecks(run);
		config._requirements=run.requirements;
		if (!checkpoint.implemented) {
			await phase('running');
			const result = await runHarness({config, phase: 'implementation', prompt: `${prompt}${plan ? `\n\nImplement this plan:\n${plan}` : ''}`, cwd, timeoutMs: timeout(true), onLine: log, signal});
			if (!result.success || !result.done) {state.status = result.timedOut ? 'stale' : 'failed'; throw new Error(result.error ?? 'Process exited without the completion signal');}
			commitSourceChanges(cwd,state.branch,`Implement ${ticket.title}`);
			const implemented = captureContext(ticket, config, cwd, plan);
			await saveJson(path.join(folder, 'implementation.json'), {scope: implemented.stamp.scope, head: implemented.stamp.head});
			checkpoint.implemented = true;
			run.implementation={head:implemented.stamp.head,fingerprint:run.fingerprint};await saveRun(cwd,run);
		}
		await phase('reviewing');
		// Leftovers of the work leave the branch before anything is reviewed or published.
		await tidyBranch({ticket, config, cwd, folder, branch: state.branch, signal, log});
		captureContext(ticket,config,cwd,plan);
		run.environment=persistedManifest(await prepareEnvironment(config,cwd,signal,log,setupBudget(cwd,run,config)));
		const reviewed = await runCodeReview({ticket, config, cwd, folder, plan, onLogLine: log, onProcess() {}, signal});
		run.reviewSummary={head:reviewed.report.stamp?.head,outcome:reviewed.report.outcome,rounds:reviewed.report.rounds,repairs:reviewed.report.repairs,elapsedMs:Date.parse(reviewed.report.finishedAt)-Date.parse(reviewed.report.startedAt)};
		const reviewPassed = reviewed.report.outcome === 'passed';
		if(Date.now()>=(config._deadline??Infinity))throw new Error('Task deadline exceeded before publication; final verification remains unfinished');
		if (!reviewPassed) log(`[iteris] Review ${reviewed.report.outcome}: ${reviewed.report.reason}. Preserving unfinished work as a draft.`);
		const reviewedContext = captureContext(ticket, config, cwd, plan);
		const reviewMatchesHead = reviewedContext.stamp.key === reviewed.report.stamp?.key;
		run.changeSize = reviewedContext.size;
		reconcileEvidence(run,reviewedContext.stamp.head,reviewedContext.stamp.base);
		for(const requirement of run.requirements.filter(r=>['local','review'].includes(r.stage)))addEvidence(run,requirement.id,reviewedContext.stamp.head,'host-review',reviewed.report.reason,reviewPassed && reviewMatchesHead,reviewedContext.stamp.base);
		run.implementation={head:reviewedContext.stamp.head,fingerprint:run.fingerprint};
		if (reviewPassed && !reviewMatchesHead) throw new Error('Code changed after review; rerun review before publication.');
		const reviewForPr = reviewed.text.length > 55_000 ? `${reviewed.text.slice(0, 55_000)}\n\n[Review report truncated; the complete report remains in the local Iteris run.]` : reviewed.text;
		let reviewWithHead = reviewMatchesHead ? reviewForPr : `${reviewForPr}\n\n**The current PR commit ${reviewedContext.stamp.head} was not covered by this incomplete review.**`;
		const baseChanged = await publishReviewed(reviewedContext, config, cwd, signal, !reviewPassed);
		if(baseChanged)run.ciFreshness={head:reviewedContext.stamp.head,base:git(cwd,['rev-parse',`refs/remotes/origin/${config.baseBranch}`]).trim(),after:new Date().toISOString()};
		if (baseChanged) reviewWithHead += `\n\n**The remote base changed after this review. Review and CI must assess the PR against the current base before merging.**`;
		let pr = await services.findPr(config, state.branch);
		if(!pr && run.publication)pr={url:run.publication.url,number:run.publication.number};
		// The commit the published description was written for; a draft opened before review passed has a placeholder.
		let describedHead = run.publication?.described;
		const describe = () => generatePrDescription({ticket, config, cwd, review: reviewWithHead, baseCommit: reviewedContext.stamp.base, signal, onLine(line) {log(`[pr] ${line}`);}});
		if (!pr) {
			await phase('creating-pr');
			let description = pendingDescription(ticket);
			if (reviewPassed) {
				const described = await describe();
				if (!described.success || !described.text) {
					state.status = described.timedOut ? 'stale' : 'failed';
					throw new Error(`PR description: ${described.error ?? 'Harness produced no description'}`);
				}
				description = described.text; describedHead = reviewedContext.stamp.head;
			}
			const body = prBody(description, reviewWithHead, ticketReference(ticket, config));
			await assertPublished(reviewedContext, config, cwd, signal, !reviewPassed);
			pr = await services.createPr({...config,pr:{...config.pr,draft:true}}, {branch: state.branch, title: ticketPrTitle(ticket), body});
			log(`[iteris] Created PR ${pr.url}`);
		} else {
			await services.draft?.(config,pr.number,true);
			await assertPublished(reviewedContext, config, cwd, signal, !reviewPassed);
			await services.updateReview?.(config, pr.number, reviewWithHead);
			if (reviewPassed && services.updateSections && describedHead !== reviewedContext.stamp.head) {
				// A missing description never holds a verified change back; `iteris describe` writes it later.
				try {
					const described = await describe();
					if (!described.success || !described.text) throw new Error(described.error ?? 'Harness produced no description');
					await services.updateSections(config, pr.number, {description: described.text});
					describedHead = reviewedContext.stamp.head;
				} catch (error) {log(`[iteris] Could not write the PR description: ${String(error)}. Run "iteris describe" to retry.`);}
			}
		}
		await assertPublished(reviewedContext, config, cwd, signal, !reviewPassed);
		state.prUrl = pr.url; state.prNumber = pr.number;
		run.publication={url:pr.url,number:pr.number,head:reviewedContext.stamp.head,base:reviewedContext.stamp.base,draft:true,described:describedHead};
		for(const requirement of run.requirements.filter(r=>r.stage==='publication'))addEvidence(run,requirement.id,reviewedContext.stamp.head,'github-publication',pr.url,true,reviewedContext.stamp.base);
		if (!reviewPassed) state.reviewPending = `${reviewed.report.outcome}: ${reviewed.report.reason}`;
		if(reviewPassed && reviewMatchesHead) {
			const remaining=new Set((reviewed.report.dependencies??[]).map(d=>d.id));
			const resolved=run.requirements.filter(r=>r.id.startsWith('dependency:') && !remaining.has(r.id.slice('dependency:'.length))).map(r=>r.id.slice('dependency:'.length));
			run.requirements=run.requirements.filter(r=>!resolved.includes(r.id.slice('dependency:'.length)) || !r.id.startsWith('dependency:'));
			run.dependencies=run.dependencies.filter(d=>!resolved.includes(d.id));
		}
		// Evidence Iteris cannot obtain itself blocks only when the operator requires it. Otherwise it is
		// recorded as a requirement the completion pass marks for manual verification.
		const blockingDependencies=(reviewed.report.dependencies ?? []).filter(dependency=>dependency.kind!=='external' || config.workflow.externalEvidence==='required');
		for(const dependency of reviewed.report.dependencies ?? []) {
			if(blockingDependencies.includes(dependency))waitFor(run,config,dependency.id,dependency.kind,dependency.description,dependency.nextAction);
			if(!run.requirements.some(r=>r.id===`dependency:${dependency.id}`))run.requirements.push({id:`dependency:${dependency.id}`,text:dependency.description,sourceRef:ticket.htmlUrl,stage:dependency.id,method:'stage-evidence',status:'pending',evidenceIds:[]});
		}
		if (config.pr.addLabelOnOpen && (config.provider === 'github' || config.provider === undefined)) {
			try {await services.addLabel({...config,repo:githubTaskRepository(ticket,config)}, ticket.number, config.pr.addLabelOnOpen);} catch (error) {log(`[iteris] Could not add issue label after opening PR: ${String(error)}`);}
		}
		if(reviewPassed && reviewMatchesHead && !baseChanged) {
			clearVerifiedLocalDependencies(run);
			await saveRun(cwd,run);
			try {await advanceCompletion(config,run,cwd,services,signal);}catch(error){waitFor(run,config,'ci','capability',`Completion verification unavailable: ${String(error)}`,'Restore CI discovery and publication access, then resume');}
		}else if(baseChanged) {
			run.state='queued';run.phase='reconciliation';run.reason='The base changed during publication; fresh review and CI must verify the current base';
		}else if(blockingDependencies.length || reviewed.report.deferredToCI) {
			for(const dependency of blockingDependencies.length ? blockingDependencies : [{id:'ci',kind:'external' as const,description:reviewed.report.reason,nextAction:'Wait for CI and rerun independent review'}])waitFor(run,config,dependency.id,dependency.kind,dependency.description,dependency.nextAction);
		}else {
			run.state='blocked';run.reason=reviewed.report.reason;recordFailure(run,config,'code',{files:reviewedContext.changedFiles,findings:reviewed.report.findings.filter(f=>f.status==='confirmed').map(f=>[f.category,f.file,f.line]),checks:reviewed.report.checks.filter(c=>c.exitCode!==0).map(c=>c.command)},reviewedContext.stamp.head,reviewed.report.reason);
			// The draft stays published; a fresh instance repairs this commit later with the findings.
			const reviewerFailure=/timed out|deadline exceeded|stalled|Process exited|Cancelled|reviewer failed|ENOENT|spawn/i.test(reviewed.report.reason);
			failAttempt(run,config,state,cwd,{phase:'reviewing',status:reviewed.report.outcome,kind:reviewed.report.checks.some(c=>!checkOk(c))?'test':'code',reason:`Review ${reviewed.report.outcome}: ${reviewed.report.reason}`,details:reviewDetails(reviewed.report),needsRepair:reviewed.report.outcome==='blocked'||!reviewerFailure});
		}
		if(!reviewPassed || baseChanged)await publishCompletionView(config,run,cwd,services);
		const completionState=run.state,completionPhase=run.phase;
		await phase('summarizing'); run.state=completionState;await logWrites;
		try {await generateSummary(folder, config, cwd, undefined, signal);} catch (error) {log(`Summary failed: ${String(error)}`);}
		run.phase=completionPhase;
		if (signal.aborted) throw new Error('Cancelled');
		state.status = String(run.state)==='complete' ? 'done' : retryScheduled(run) ? 'retrying' : String(run.state)==='waiting' ? 'waiting' : 'blocked';
		state.remaining=run.requirements.filter(r=>r.status!=='verified').map(r=>r.text);state.failureReason=run.reason;
		await appendProgress(cwd, `#${ticket.number} (${ticket.title}) — ${run.state}; PR ${pr.url}; ${run.reason ?? 'all required evidence verified'}`);
	} catch (error) {
		const failedStatus = state.status === 'stale' ? 'stale' : state.status === 'blocked' || state.status === 'incomplete' ? state.status : 'failed';
		const failedPhase = run.phase;
		if(error instanceof CapabilityUnavailable){
			waitFor(run,config,'preflight','environment',error.message,error.nextAction);state.status='waiting';
			if(!signal.aborted)failAttempt(run,config,state,cwd,{phase:failedPhase,status:'waiting',kind:'environment',reason:error.message,schedule:false});
		}
		else {
			const failure=classifyFailure(error,run.phase),reason=error instanceof Error?error.message:String(error);
			if(!signal.aborted && ['transport','capability','environment','external'].includes(failure.kind)){
				waitFor(run,config,run.phase,failure.kind,reason,failure.nextAction);state.status='waiting';
				failAttempt(run,config,state,cwd,{phase:failedPhase,status:'waiting',kind:failure.kind,reason,schedule:false});
			}
			else if(/Remote base changed|Base changed/i.test(reason)){run.state='queued';run.phase='reconciliation';run.reason=reason;state.status='waiting';}
			else if(signal.aborted){run.state='queued';run.reason=reason;}
			// The instance is already stopped. Record why, keep the branch and evidence, and schedule a fresh instance.
			else failAttempt(run,config,state,cwd,{phase:failedPhase,status:failedStatus,kind:failure.kind,reason});
		}
		state.status = state.status==='waiting' ? 'waiting' : signal.aborted ? 'cancelled' : failedStatus;
		if (!signal.aborted && state.attempt?.disposition === 'retry') state.status = 'retrying';
		else if (state.attempt?.disposition === 'stopped') state.status = 'blocked';
		state.failureReason = error instanceof Error ? error.message : String(error);
		log(`[iteris] ${state.failureReason}`);
		if (state.attempt) log(`[iteris] ${run.reason}`);
	} finally {
		if(cancellation.cancelled()){run.state='cancelled';run.phase='cancelled';run.reason='Cancelled explicitly';state.status='cancelled';consumeRetry(run);}
		cancellation.dispose();
		state.finishedAt = new Date(); state.elapsedMs = Date.now() - state.startedAt!.getTime();
		await logWrites;
		if (logError) {state.status = 'failed'; state.failureReason = `Could not save run log: ${String(logError)}`;}
		await writeStatus(folder, state);
		await saveRun(cwd,run);
		callbacks.onStatusChange(ticket.number, {...state});
	}
	if (state.status === 'done') callbacks.onComplete(ticket.number, {...state});
	return {...state};
}
