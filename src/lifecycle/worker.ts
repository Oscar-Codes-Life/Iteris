import {inTaskWorkspace} from '../state/workspace.js';
import {runPool} from '../state/pool.js';
import {prepareTaskWorkspace} from './worktree.js';
import type { IterisConfig, Ticket } from '../types.js';
import { runAllTickets, type RunnerCallbacks, type RunnerServices } from '../agent/runner.js';
import { loadConfig } from '../config.js';
import { listRuns, saveRun, waitFor, taskFingerprint, recordFailure, rebindLegacyIdentity, type TaskRun } from './state.js';
import { sourceAdapter, type TaskSourceAdapter } from './adapters.js';
import { assertClean, git, captureContext } from '../review/context.js';
import { loadPassedReview } from '../review/report.js';
import { prepareEnvironment, setupBudget } from './environment.js';
import { advanceCompletion } from './stages.js';
import { acquireRun, claimQueue } from '../state/active.js';
import path from 'node:path';
import { recoverFailedTicket } from '../agent/failure-recovery.js';
import { classifyFailure } from './failures.js';
import { loadPendingQueue } from '../state/queue.js';
import { createRunFolder, appendLog } from '../state/manager.js';
import { ensureRun, taskKey, readRun, clearVerifiedLocalDependencies } from './state.js';
import { ticketBranch } from '../types.js';
import { importLegacyArtifacts } from './migration.js';
import { cancellationScope, cancellationRequested } from './cancellation.js';
import { checkpointPartialWork } from './commit.js';
import { localPlannedChecks } from './planning.js';
import { recordAttempt, consumeRetry, latestAttempt, attemptBriefing, resumableBlocked, type AttemptInput } from './attempts.js';
import type { TicketState } from '../types.js';
export type WorkerOptions = {
    config: IterisConfig;
    cwd: string;
    callbacks: RunnerCallbacks;
    signal?: AbortSignal;
    once?: boolean;
    force?: boolean;
    services?: RunnerServices;
    adapter?: (config: IterisConfig) => TaskSourceAdapter;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
export function schedulingOrder(runs: TaskRun[], now = Date.now(), force = false): TaskRun[] {
    return runs.filter(run => ['queued', 'active'].includes(run.state) || (run.state === 'waiting' && (force || !run.dependencies.length || run.dependencies.some(d => Date.parse(d.nextRetryAt) <= now))) || (run.state === 'blocked' && (force || resumableBlocked(run)))).sort((a, b) => Number(a.state === 'waiting') - Number(b.state === 'waiting') || a.createdAt.localeCompare(b.createdAt));
}
async function pause(ms: number, signal?: AbortSignal) {
    if (signal?.aborted)
        return;
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true }); });
}
export async function runWorker(options: WorkerOptions): Promise<void> {
    // Held across the waits between passes, where the run lock is free for short commands.
    const release = await claimQueue(options.cwd);
    try { await workQueue(options); }
    finally { await release(); }
}
async function workQueue(options: WorkerOptions): Promise<void> {
    const { cwd, callbacks, signal } = options;
    const now = options.now ?? Date.now;
    let force = options.force ?? false;
    const pending = await loadPendingQueue(cwd, options.config);
    if (pending?.length) {
        const release = await acquireRun(cwd);
        try {
            for (const ticket of pending)
                if (!await readRun(cwd, taskKey(ticket, options.config))) {
                    const folder = await createRunFolder(cwd, ticket, options.config);
                    await importLegacyArtifacts(cwd, ticket, options.config, folder);
                    await saveRun(cwd, await ensureRun(cwd, ticket, options.config, folder, ticketBranch(ticket)));
                }
        }
        finally {
            await release();
        }
    }
    do {
        const config = options.services ? options.config : await loadConfig(cwd);
        const release = await acquireRun(cwd);
        try {
            const runs = await listRuns(cwd, config.repo);
            for (const run of runs.filter(r => !['complete', 'cancelled'].includes(r.state)))
                if (await cancellationRequested(cwd, run.key)) {
                    run.state = 'cancelled';
                    run.phase = 'cancelled';
                    run.reason = 'Cancelled explicitly';
                    await saveRun(cwd, run);
                }
            const resumeRun = async (run: TaskRun) => {
                if (signal?.aborted)
                    return;
                const cancellation = await cancellationScope(cwd, run.key, signal), taskSignal = cancellation.signal;
                const snapshot = { ...config, provider: run.source.provider, _requirements: run.requirements, _plannedChecks: localPlannedChecks(run) };
                const root = cwd;
                const notify = async (state: TicketState) => {
                    callbacks.onStatusChange(state.ticket.number, state);
                    try { await callbacks.onAttemptFailed?.(state.ticket.number, state); }
                    catch (error) { callbacks.onLogLine(state.ticket.number, `[continuation] Attempt notification failed: ${String(error)}`); }
                };
                // Journal a failure and report it. Returns false when the attempt cap stopped the task.
                const fail = async (input: AttemptInput, target: TaskRun = run): Promise<boolean> => {
                    const record = recordAttempt(target, snapshot, input);
                    await saveRun(cwd, target);
                    callbacks.onLogLine(target.ticket.number, `[continuation] ${target.reason}`);
                    await notify({ ticket: target.ticket, runKey: target.key, status: record.disposition === 'stopped' ? 'blocked' : record.disposition === 'retry' ? 'retrying' : 'waiting', branch: target.branch, workspace: target.workspace, failureReason: target.reason, logLines: input.logTail ?? [], elapsedMs: 0, attempt: { number: record.number, status: record.status, disposition: record.disposition, ...(record.nextRetryAt ? { nextRetryAt: record.nextRetryAt } : {}) } });
                    return record.disposition !== 'stopped';
                };
                const head = (cwd: string) => { try { return git(cwd, ['rev-parse', 'HEAD']).trim(); } catch { return undefined; } };
                // A blocked task selected here re-enters the attempt loop (legacy abandonment or an explicit resume).
                if (run.state === 'blocked') {
                    run.state = 'queued';
                    await saveRun(cwd, run);
                }
                try {
                    const adapter = options.adapter?.(snapshot) ?? sourceAdapter(snapshot, cwd);
                    const ticket = { ...await adapter.refresh({ ...run.ticket, source: run.source }), branch: run.branch };
                    await rebindLegacyIdentity(cwd, run, ticket, snapshot);
                    if (taskFingerprint(ticket) !== run.fingerprint) {
                        run.state = 'queued';
                        run.reason = 'Task content changed';
                        await saveRun(cwd, run);
                    }
                    const workspaceLogs: string[] = [];
                    const taskCwd = await prepareTaskWorkspace(root, run, snapshot, message => {workspaceLogs.push(message); callbacks.onLogLine(ticket.number, message);});
                    if (workspaceLogs.length) await appendLog(run.artifacts, workspaceLogs.join('\n') + '\n');
                    await inTaskWorkspace(root, run.key, async () => {
                        const cwd = taskCwd;
                        let branchExists = false;
                        try {
                            git(cwd, ['rev-parse', '--verify', `refs/heads/${run.branch}`]);
                            branchExists = true;
                        }
                        catch { /* implementation may not have created the branch yet */ }
                        // Edits left by a stopped instance become a checkpoint, never a permanent dirty-tree failure.
                        if (branchExists && checkpointPartialWork(cwd, run.branch, `Checkpoint partial work from an interrupted attempt on ${ticket.title}`))
                            callbacks.onLogLine(ticket.number, '[continuation] Committed partial work left by the previous instance.');
                        if (branchExists && run.branch !== git(cwd, ['branch', '--show-current']).trim()) {
                            assertClean(cwd);
                            git(cwd, ['checkout', run.branch]);
                        }
                        if (run.phase === 'reconciliation') {
                            git(cwd, ['fetch', 'origin', snapshot.baseBranch]);
                            if (run.publication) {
                                assertClean(cwd);
                                git(cwd, ['fetch', 'origin', run.branch]);
                                git(cwd, ['merge', '--ff-only', 'FETCH_HEAD']);
                                run.implementation = { head: git(cwd, ['rev-parse', 'HEAD']).trim(), fingerprint: run.fingerprint };
                                await saveRun(cwd, run);
                            }
                        }
                        // A successful review may be reused only with the same environment,
                        // current HEAD, base, task content and configured verification policy.
                        snapshot._execution = await prepareEnvironment(snapshot, cwd, taskSignal, message => callbacks.onLogLine(ticket.number, message), setupBudget(cwd, run, snapshot));
                        // This pass is the scheduled fresh attempt; a new failure schedules the next one.
                        const retrying = consumeRetry(run);
                        run.dependencies = run.dependencies.filter(d => d.id !== 'continuation' && d.id !== 'preflight' && d.kind !== 'environment');
                        await saveRun(cwd, run);
                        // A fresh repair instance runs before review whenever the last verdict concerned this exact commit.
                        const repairFirst = async (reason: string, failure: Pick<AttemptInput, 'phase' | 'kind'>): Promise<boolean> => {
                            snapshot._deadline = now() + snapshot.timeout * 1000;
                            const before = head(cwd), logLines: string[] = [], outcome: { reason?: string } = {};
                            const repaired = await recoverFailedTicket({ ticket, config: snapshot, cwd, state: { ticket, status: 'blocked', branch: run.branch, logLines: [], elapsedMs: 0, failureReason: reason }, plan: run.plan ?? '', signal: taskSignal, history: attemptBriefing(run), outcome, onLogLine: line => { logLines.push(line); callbacks.onLogLine(ticket.number, line); } });
                            if (taskSignal.aborted)
                                return false;
                            if (!repaired) {
                                // No change: the next fresh attempt re-runs the full pass for a new verdict
                                // instead of repeating the same repair. Failed CI always repairs first.
                                await fail({ ...failure, status: 'failed', reason: outcome.reason ?? 'Repair produced no new commit', head: before, logTail: logLines });
                                return false;
                            }
                            consumeRetry(run);
                            run.implementation = { head: git(cwd, ['rev-parse', 'HEAD']).trim(), fingerprint: run.fingerprint };
                            await saveRun(cwd, run);
                            return true;
                        };
                        const failedCi = run.dependencies.find(d => d.kind === 'test');
                        if (failedCi) {
                            const current = git(cwd, ['rev-parse', 'HEAD']).trim();
                            recordFailure(run, snapshot, 'test', { stage: failedCi.id, checks: snapshot.verification.requiredCiChecks ?? 'discovered' }, current, 'CI invariant remains failed');
                            if (!await fail({ phase: 'ci', status: 'failed', kind: 'test', reason: `Required CI failed on ${current.slice(0, 12)}: ${failedCi.description}`, head: current, needsRepair: true }))
                                return;
                            if (!await repairFirst(failedCi.description, { phase: 'repair', kind: 'test' }))
                                return;
                            run.dependencies = run.dependencies.filter(d => d.id !== failedCi.id);
                            await saveRun(cwd, run);
                        }
                        else if (retrying) {
                            const last = latestAttempt(run), current = head(cwd);
                            if (last?.needsRepair && current && last.head === current && run.implementation?.head === current) {
                                callbacks.onLogLine(ticket.number, `[continuation] Starting a fresh repair instance for attempt ${last.number}: ${last.reason}`);
                                if (!await repairFirst(last.reason, { phase: 'repair', kind: last.kind }))
                                    return;
                            }
                        }
                        let passed = false;
                        if (run.publication && run.fingerprint === taskFingerprint(ticket)) {
                            // The published commit was reviewed against its published base. A base that moved on
                            // since then is judged by the completion pass (still mergeable or not), not by re-reviewing.
                            const pinned = snapshot as typeof snapshot & { _base?: string };
                            try {
                                git(cwd, ['cat-file', '-e', `${run.publication.base}^{commit}`]);
                                pinned._base = run.publication.base;
                            }
                            catch { /* unknown base object: fall back to the tracking ref */ }
                            try {
                                const context = captureContext(ticket, snapshot, cwd, run.plan ?? await import('../review/context.js').then(m => m.savedPlan(run.artifacts)), run.branch);
                                passed = !!await loadPassedReview(path.join(run.artifacts, 'review'), context, snapshot.workflow.externalEvidence === 'advisory');
                            }
                            finally {
                                delete pinned._base;
                            }
                        }
                        if (passed && !run.dependencies.some(d => d.kind === 'test')) {
                            clearVerifiedLocalDependencies(run);
                            await advanceCompletion(snapshot, run, cwd, options.services, taskSignal);
                            const state = { ticket, status: run.state === 'complete' ? 'done' as const : run.state === 'queued' ? 'pending' as const : 'waiting' as const, branch: run.branch, prUrl: run.publication?.url, prNumber: run.publication?.number, logLines: [], elapsedMs: 0, runKey: run.key, remaining: run.requirements.filter(r => r.status !== 'verified').map(r => r.text), failureReason: run.reason };
                            callbacks.onStatusChange(ticket.number, {...state, workspace: run.workspace});
                            if (run.state === 'complete')
                                callbacks.onComplete(ticket.number, {...state, workspace: run.workspace});
                        }
                        else {
                            // Refresh the base before obtaining new independent evidence.
                            git(cwd, ['fetch', 'origin', snapshot.baseBranch]);
                            await runAllTickets([ticket], snapshot, cwd, callbacks, taskSignal, options.services, true);
                        }
                    });
                }
                catch (error) {
                    if (taskSignal.aborted)
                        return;
                    const failure = classifyFailure(error, run.phase), reason = error instanceof Error ? error.message : String(error);
                    // Nested passes may have journaled attempts since this pass began; build on the saved record.
                    const latest = await readRun(cwd, run.key).catch(() => undefined) ?? run;
                    if (['complete', 'cancelled'].includes(latest.state))
                        return;
                    // Keep probing: setup exhaustion, provider outages and host errors resolve
                    // later without a person restarting the queue. The journal records why.
                    waitFor(latest, snapshot, 'continuation', failure.kind, reason, failure.nextAction);
                    await fail({ phase: 'continuation', status: 'waiting', kind: failure.kind, reason, schedule: false }, latest);
                }
                finally {
                    if (cancellation.cancelled()) {
                        const current = await readRun(cwd, run.key) ?? run;
                        current.state = 'cancelled';
                        current.phase = 'cancelled';
                        current.reason = 'Cancelled explicitly';
                        await saveRun(cwd, current);
                    }
                    cancellation.dispose();
                }
            };
            const eligible = schedulingOrder(runs, now(), force).filter(run => run.state !== 'cancelled');
            const local = eligible.filter(run => (run.workspace?.mode ?? config.workspace.mode) === 'local');
            await runPool(local, 1, resumeRun, signal);
            await runPool(eligible.filter(run => !local.includes(run)), config.workspace.concurrency, resumeRun, signal);
        } finally {await release();}
        force = false;
        if (options.once || !config.continuation.watch || signal?.aborted)
            return;
        const waiting = (await listRuns(cwd, config.repo)).filter(run => ['queued', 'active', 'waiting'].includes(run.state) || resumableBlocked(run));
        if (!waiting.length)
            return;
        const next = Math.min(...waiting.flatMap(run => run.dependencies.map(d => Date.parse(d.nextRetryAt))));
        await (options.sleep ?? pause)(Math.max(1, Math.min(60000, Number.isFinite(next) ? next - now() : config.continuation.initialSeconds * 1000)), signal);
    } while (!signal?.aborted);
}
export async function unfinishedTickets(cwd: string, config: IterisConfig): Promise<Ticket[]> {
    return (await listRuns(cwd, config.repo)).filter(run => ['queued', 'active', 'waiting'].includes(run.state) || resumableBlocked(run)).map(run => ({ ...run.ticket, source: run.source }));
}
