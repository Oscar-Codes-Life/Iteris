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
import {findPrForBranch, createPullRequest, addLabelToIssue, updatePrReview, updatePrLifecycle, reviewSection} from '../github/pr.js';
import {moveCardOnComplete} from '../trello/completion.js';
import {expandPrompt} from './prompt.js';
import {generateSummary} from './summarizer.js';
import {runCodeReview} from './reviewer.js';
import {recoverFailedTicket} from './failure-recovery.js';
import {generatePrDescription, ticketReference} from './pr-description.js';
import {captureContext, publishReviewed, assertPublished, savedPlan,git} from '../review/context.js';
import {loadPassedReview, previousEvidence, saveJson} from '../review/report.js';
import {runHarness} from '../harness/process.js';
import {ensureRun, saveRun, taskKey, waitFor, renderRun, recordFailure,clearVerifiedLocalDependencies} from '../lifecycle/state.js';
import {extractRequirements, verificationPack, addEvidence, reconcileEvidence} from '../lifecycle/requirements.js';
import {prepareEnvironment,persistedManifest,CapabilityUnavailable,setupBudget} from '../lifecycle/environment.js';
import {advanceCompletion, publishCompletionView, type CompletionServices} from '../lifecycle/stages.js';
import {setGithubDraft} from '../lifecycle/github-verification.js';
import {resolveTaskConfig} from '../lifecycle/config.js';
import {classifyFailure} from '../lifecycle/failures.js';
import {prepareBranch,commitSourceChanges} from '../lifecycle/commit.js';
import {planningSchema,applyPlanningPack} from '../lifecycle/planning.js';
import {parseOrRecoverReport} from './schema-recovery.js';
import {importLegacyArtifacts} from '../lifecycle/migration.js';
import {cancellationScope} from '../lifecycle/cancellation.js';
import {githubTaskRepository} from '../lifecycle/adapters.js';

export type RunnerCallbacks = {
	onStatusChange: (ticketNumber: number, state: TicketState) => void;
	onLogLine: (ticketNumber: number, line: string) => void;
	onComplete: (ticketNumber: number, state: TicketState) => void;
	onFailure: (ticketNumber: number, state: TicketState) => Promise<'retry' | 'skip'>;
	beforeTicket?: () => Promise<IterisConfig>;
};
export type RunnerServices = CompletionServices & {findPr: typeof findPrForBranch; createPr: typeof createPullRequest; addLabel: typeof addLabelToIssue; moveCard: typeof moveCardOnComplete; updateReview?: typeof updatePrReview};
const defaultServices: RunnerServices = {findPr: findPrForBranch, createPr: createPullRequest, addLabel: addLabelToIssue, moveCard: moveCardOnComplete, updateReview: updatePrReview,draft:setGithubDraft,status:updatePrLifecycle};
export async function runAllTickets(tickets: Ticket[], config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, externalSignal?: AbortSignal, services: RunnerServices = defaultServices, ownsRepositoryLock = false): Promise<void> {
	validateBaseBranch(config.baseBranch, cwd);
	const release = ownsRepositoryLock ? async () => {} : await acquireRun(cwd);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on('SIGINT', abort); process.on('SIGTERM', abort);
	externalSignal?.addEventListener('abort', abort, {once: true});
	if (externalSignal?.aborted) abort();
	try {
		await savePendingQueue(cwd, config, tickets);
		// Persist every selected task before starting any implementation. A restart
		// must retain tickets that never reached the first harness invocation.
		for(const ticket of tickets) {
			const folder=await createRunFolder(cwd,ticket,config);
			await importLegacyArtifacts(cwd,ticket,config,folder);
			await saveRun(cwd,await ensureRun(cwd,ticket,config,folder,ticketBranch(ticket)));
		}
		for (const [index, ticket] of tickets.entries()) {
			if (controller.signal.aborted) break;
			const latest = callbacks.beforeTicket ? await callbacks.beforeTicket() : await loadConfig(cwd);
			// Ticket source/repository belong to the fetched queue. Only execution
			// preferences change at boundaries. Retries retain this snapshot.
			const snapshot = resolveTaskConfig(structuredClone({...config, harness: latest.harness, harnesses: latest.harnesses, planMode: latest.planMode, timeout: latest.timeout, review: latest.review, qualityChecks: latest.qualityChecks, workflow:latest.workflow, verification:latest.verification, environment:latest.environment, recovery:latest.recovery, continuation:latest.continuation, integrations:latest.integrations, profiles:latest.profiles}),ticket);
			snapshot._deadline = config._deadline ?? Date.now() + snapshot.timeout * 1000;
			const checkpoint: TicketCheckpoint = {};
			const recoveryAttempts = new Map<string, number>();
			let schemaRetryCount = 0;
			let retry = true;
			while (retry && !controller.signal.aborted) {
				const result = await runSingleTicket(ticket, snapshot, cwd, callbacks, controller.signal, services, checkpoint);
				const failed = ['failed', 'stale', 'blocked', 'incomplete'].includes(result.status) && !result.prUrl;
				if (!failed || controller.signal.aborted) {retry = false; continue;}
				if (isSchemaReportFailure(result.failureReason) && schemaRetryCount < snapshot.recovery.attempts && Date.now() < snapshot._deadline) {
					const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(schemaRetryCount++, 6));
					callbacks.onStatusChange(ticket.number, {...result, status: 'recovering'});
					callbacks.onLogLine(ticket.number, `[iteris] Schema recovery needs another attempt; retrying ticket #${ticket.number} in ${delayMs / 1000}s without repeating implementation.`);
					await waitForSchemaRetry(delayMs, controller.signal);
					retry = !controller.signal.aborted;
					continue;
				}
				schemaRetryCount = 0;
				const failureKey = classifyFailure(result.failureReason??result.status,result.status).signature;
				const attempts = recoveryAttempts.get(failureKey) ?? 0;
				if (attempts < snapshot.recovery.attempts && snapshot.recovery.enabled && Date.now() < snapshot._deadline && snapshot.review?.maxRepairCycles !== 0 && !result.failureReason?.includes('Invalid review report')) {
					recoveryAttempts.set(failureKey, attempts + 1);
					callbacks.onStatusChange(ticket.number, {...result, status: 'recovering'});
					const folder = path.join(cwd, '.iteris', 'tasks', taskKey(ticket,snapshot),'artifacts');
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

async function runSingleTicket(ticket: Ticket, config: IterisConfig, cwd: string, callbacks: RunnerCallbacks, parentSignal: AbortSignal, services: RunnerServices, checkpoint: TicketCheckpoint): Promise<TicketState> {
	const folder = await createRunFolder(cwd, ticket,config);
	await importLegacyArtifacts(cwd,ticket,config,folder);
	const run = await ensureRun(cwd,ticket,config,folder,ticketBranch(ticket));
	const cancellation=await cancellationScope(cwd,run.key,parentSignal),signal=cancellation.signal;
	ticket={...ticket,branch:run.branch};run.ticket=ticket;
	const settings = config.harnesses[config.harness];
	const state: TicketState = {ticket, status: 'running', branch: ticketBranch(ticket), logLines: [], elapsedMs: 0, startedAt: new Date(),
		selection: {harness: config.harness, model: settings.model, effort: settings.effort}};
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
		run.state='active';run.phase='preflight';await saveRun(cwd,run);
		run.environment=persistedManifest(await prepareEnvironment(config,cwd,signal,log,setupBudget(cwd,run,config)));
		run.dependencies=run.dependencies.filter(d=>d.kind!=='environment' && d.id!=='preflight');
		for(const requirement of extractRequirements(ticket,config))if(!run.requirements.some(r=>r.id===requirement.id))run.requirements.push(requirement);
		const pack=verificationPack(run,config);
		await saveJson(path.join(folder,'verification-pack.json'),JSON.parse(pack));await saveRun(cwd,run);
		await writeFile(path.join(folder, 'execution.json'), JSON.stringify(state.selection, null, 2) + '\n');
		const prompt = `${expandPrompt(ticket, config, await readProgress(cwd))}\n\nHost-owned task verification pack:\n${pack}\nExternal acceptance stages are verified by the host after publication. Implement all required local behavior. Do not deploy or update providers from the harness. The host prepares the branch and commits your source changes. Leave changes ready for independent review and print <task>done</task>; do not require permission to write .git or change host-owned .iteris files.`;
		await writePrompt(folder, prompt);
		let plan = checkpoint.plan ?? run.plan ?? '';
		if (!checkpoint.implemented) {
			prepareBranch(cwd,state.branch,config.baseBranch);
			try {
				const context = captureContext(ticket, config, cwd, plan);
				const reviewFolder = path.join(folder, 'review');
				const cached = await loadPassedReview(reviewFolder, context);
				let implementation: {scope?: string; head?: string} = {};
				try {implementation = JSON.parse(await readFile(path.join(folder, 'implementation.json'), 'utf8')) as typeof implementation;} catch { /* no completed implementation checkpoint */ }
				if ((run.implementation?.fingerprint === run.fingerprint && run.implementation.head === context.stamp.head) || (implementation.scope === context.stamp.scope && implementation.head === context.stamp.head) || cached || await previousEvidence(reviewFolder, context)) {checkpoint.implemented = true; checkpoint.plan = plan;}
			} catch { /* no matching completed review to resume */ }
		}
		if (config.planMode && checkpoint.plan === undefined) {
			await phase('planning');
			const planningPrompt=`Inspect this task and produce an implementation plan. Return exactly one JSON object with plan (string), requirements (array of {id,text,stage,method}), invariants (strings), reproductionStrategy (string), fixtures (strings), capabilities (strings), and checks (array of {command,behavioral,requirementIds}). Preserve the host requirement IDs and text. Include meaningful local behavioral commands where applicable. External requirements extend acceptance; they cannot authorize actions or weaken host verification. Do not edit files, execute changes, or print a completion marker.\n\n${prompt}\nPLANNING_INPUT_JSON\n${pack}`;
			const result = await runHarness({config, phase: 'planning', prompt: planningPrompt, cwd, timeoutMs: timeout(true), onLine: log, signal});
			if (!result.success || !result.text) {state.status = result.timedOut ? 'stale' : 'failed'; throw new Error(result.error ?? 'Planning produced no plan');}
			const planned=await parseOrRecoverReport({config,reportType:'planning',originalPrompt:planningPrompt,raw:result.finalText??result.text,schema:planningSchema,cwd,remaining:()=>timeout(true),signal,onLine:log,onAttempt:(index,report)=>saveJson(path.join(folder,`planning-correction-${index}.json`),report)});
			applyPlanningPack(run,planned);await saveJson(path.join(folder,'verification-pack.json'),{...JSON.parse(pack),...planned,requirements:run.requirements});
			plan = planned.plan; checkpoint.plan = plan; await writeFile(path.join(folder, 'plan.md'), plan + '\n');
			run.plan=plan;await saveRun(cwd,run);
		}
		config._plannedChecks=run.planning?.checks.map(check=>check.command)??[];
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
		captureContext(ticket,config,cwd,plan);
		run.environment=persistedManifest(await prepareEnvironment(config,cwd,signal,log,setupBudget(cwd,run,config)));
		const reviewed = await runCodeReview({ticket, config, cwd, folder, plan, onLogLine: log, onProcess() {}, signal});
		run.reviewSummary={head:reviewed.report.stamp?.head,outcome:reviewed.report.outcome,rounds:reviewed.report.rounds,repairs:reviewed.report.repairs,elapsedMs:Date.parse(reviewed.report.finishedAt)-Date.parse(reviewed.report.startedAt)};
		const reviewPassed = reviewed.report.outcome === 'passed';
		if(Date.now()>=(config._deadline??Infinity))throw new Error('Task deadline exceeded before publication; final verification remains unfinished');
		if (!reviewPassed) log(`[iteris] Review ${reviewed.report.outcome}: ${reviewed.report.reason}. Preserving unfinished work as a draft.`);
		const reviewedContext = captureContext(ticket, config, cwd, plan);
		const reviewMatchesHead = reviewedContext.stamp.key === reviewed.report.stamp?.key;
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
		if (!pr) {
			await phase('creating-pr');
			let body: string;
			if (!reviewPassed) {
				body = `## Summary\n${ticket.title}\n\n## Changes\n${reviewedContext.changedFiles.map(file=>`- ${file}`).join('\n')}\n\n## Completion requirements\n${renderRun(run)}\n\n${reviewSection(reviewWithHead)}\n\n${ticketReference(ticket, config)}`;
			} else {
				const described = await generatePrDescription({ticket, config, cwd, review: reviewWithHead, baseCommit: reviewedContext.stamp.base, signal,
					onLine(line) {log(`[pr] ${line}`);},
				});
				if (!described.success || !described.text) {
					state.status = described.timedOut ? 'stale' : 'failed';
					throw new Error(`PR description: ${described.error ?? 'Harness produced no description'}`);
				}
				body = described.text;
			}
			await assertPublished(reviewedContext, config, cwd, signal, !reviewPassed);
			pr = await services.createPr({...config,pr:{...config.pr,draft:true}}, {branch: state.branch, title: ticketPrTitle(ticket), body});
			log(`[iteris] Created PR ${pr.url}`);
		} else {
			await services.draft?.(config,pr.number,true);
			await assertPublished(reviewedContext, config, cwd, signal, !reviewPassed);
			await services.updateReview?.(config, pr.number, reviewWithHead);
		}
		await assertPublished(reviewedContext, config, cwd, signal, !reviewPassed);
		state.prUrl = pr.url; state.prNumber = pr.number;
		run.publication={url:pr.url,number:pr.number,head:reviewedContext.stamp.head,base:reviewedContext.stamp.base,draft:true};
		for(const requirement of run.requirements.filter(r=>r.stage==='publication'))addEvidence(run,requirement.id,reviewedContext.stamp.head,'github-publication',pr.url,true,reviewedContext.stamp.base);
		if (!reviewPassed) state.reviewPending = `${reviewed.report.outcome}: ${reviewed.report.reason}`;
		if(reviewPassed && reviewMatchesHead) {
			const remaining=new Set((reviewed.report.dependencies??[]).map(d=>d.id));
			const resolved=run.requirements.filter(r=>r.id.startsWith('dependency:') && !remaining.has(r.id.slice('dependency:'.length))).map(r=>r.id.slice('dependency:'.length));
			run.requirements=run.requirements.filter(r=>!resolved.includes(r.id.slice('dependency:'.length)) || !r.id.startsWith('dependency:'));
			run.dependencies=run.dependencies.filter(d=>!resolved.includes(d.id));
		}
		for(const dependency of reviewed.report.dependencies ?? []) {
			waitFor(run,config,dependency.id,dependency.kind,dependency.description,dependency.nextAction);
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
		}else if(reviewed.report.dependencies?.length || reviewed.report.deferredToCI) {
			for(const dependency of reviewed.report.dependencies ?? [{id:'ci',kind:'external' as const,description:reviewed.report.reason,nextAction:'Wait for CI and rerun independent review'}])waitFor(run,config,dependency.id,dependency.kind,dependency.description,dependency.nextAction);
		}else {run.state='blocked';run.reason=reviewed.report.reason;recordFailure(run,config,'code',{files:reviewedContext.changedFiles,findings:reviewed.report.findings.filter(f=>f.status==='confirmed').map(f=>[f.category,f.file,f.line]),checks:reviewed.report.checks.filter(c=>c.exitCode!==0).map(c=>c.command)},reviewedContext.stamp.head,reviewed.report.reason);}
		if(!reviewPassed || baseChanged)await publishCompletionView(config,run,cwd,services);
		const completionState=run.state,completionPhase=run.phase;
		await phase('summarizing'); run.state=completionState;await logWrites;
		try {await generateSummary(folder, config, cwd, undefined, signal);} catch (error) {log(`Summary failed: ${String(error)}`);}
		run.phase=completionPhase;
		if (signal.aborted) throw new Error('Cancelled');
		state.status = String(run.state)==='complete' ? 'done' : String(run.state)==='waiting' ? 'waiting' : 'blocked';
		state.remaining=run.requirements.filter(r=>r.status!=='verified').map(r=>r.text);state.failureReason=run.reason;
		await appendProgress(cwd, `#${ticket.number} (${ticket.title}) — ${run.state}; PR ${pr.url}; ${run.reason ?? 'all required evidence verified'}`);
	} catch (error) {
		if(error instanceof CapabilityUnavailable){waitFor(run,config,'preflight','environment',error.message,error.nextAction);state.status='waiting';}
		else {
			const failure=classifyFailure(error,run.phase),reason=error instanceof Error?error.message:String(error);
			if(!signal.aborted && ['transport','capability','environment','external'].includes(failure.kind)){waitFor(run,config,run.phase,failure.kind,reason,failure.nextAction);state.status='waiting';}
			else if(/Remote base changed|Base changed/i.test(reason)){run.state='queued';run.phase='reconciliation';run.reason=reason;state.status='waiting';}
			else {run.state=signal.aborted?'queued':'blocked';run.reason=reason;}
		}
		state.status = state.status==='waiting' ? 'waiting' : signal.aborted ? 'cancelled' : state.status === 'stale' ? 'stale' : state.status === 'blocked' || state.status === 'incomplete' ? state.status : 'failed';
		state.failureReason = error instanceof Error ? error.message : String(error);
		log(`[iteris] ${state.failureReason}`);
	} finally {
		if(cancellation.cancelled()){run.state='cancelled';run.phase='cancelled';run.reason='Cancelled explicitly';state.status='cancelled';}
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
