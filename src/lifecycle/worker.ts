import type { IterisConfig, Ticket } from '../types.js';
import { runAllTickets, type RunnerCallbacks, type RunnerServices } from '../agent/runner.js';
import { loadConfig } from '../config.js';
import { listRuns, saveRun, waitFor, taskFingerprint, recordFailure, rebindLegacyIdentity, type TaskRun } from './state.js';
import { sourceAdapter, type TaskSourceAdapter } from './adapters.js';
import { assertClean, git, captureContext } from '../review/context.js';
import { loadPassedReview } from '../review/report.js';
import { prepareEnvironment, setupBudget, SetupBudgetExhausted } from './environment.js';
import { advanceCompletion } from './stages.js';
import { acquireRun } from '../state/active.js';
import path from 'node:path';
import { recoverFailedTicket } from '../agent/failure-recovery.js';
import { classifyFailure } from './failures.js';
import { loadPendingQueue } from '../state/queue.js';
import { createRunFolder } from '../state/manager.js';
import { ensureRun, taskKey, readRun, clearVerifiedLocalDependencies } from './state.js';
import { ticketBranch } from '../types.js';
import { importLegacyArtifacts } from './migration.js';
import { cancellationScope, cancellationRequested } from './cancellation.js';
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
    return runs.filter(run => ['queued', 'active'].includes(run.state) || (run.state === 'waiting' && (force || !run.dependencies.length || run.dependencies.some(d => Date.parse(d.nextRetryAt) <= now))) || (force && run.state === 'blocked')).sort((a, b) => Number(a.state === 'waiting') - Number(b.state === 'waiting') || a.createdAt.localeCompare(b.createdAt));
}
async function pause(ms: number, signal?: AbortSignal) {
    if (signal?.aborted)
        return;
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true }); });
}
export async function runWorker(options: WorkerOptions): Promise<void> {
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
        const runs = await listRuns(cwd, config.repo);
        for (const run of runs.filter(r => !['complete', 'cancelled'].includes(r.state)))
            if (await cancellationRequested(cwd, run.key)) {
                const release = await acquireRun(cwd);
                try {
                    run.state = 'cancelled';
                    run.phase = 'cancelled';
                    run.reason = 'Cancelled explicitly';
                    await saveRun(cwd, run);
                }
                finally {
                    await release();
                }
            }
        for (const run of schedulingOrder(runs, now(), force)) {
            if (signal?.aborted)
                return;
            const cancellation = await cancellationScope(cwd, run.key, signal), taskSignal = cancellation.signal;
            const snapshot = { ...config, provider: run.source.provider, _requirements: run.requirements, _plannedChecks: run.planning?.checks.map(check => check.command) ?? [] };
            let release: (() => Promise<void>) | undefined;
            try {
                const adapter = options.adapter?.(snapshot) ?? sourceAdapter(snapshot, cwd);
                const ticket = { ...await adapter.refresh({ ...run.ticket, source: run.source }), branch: run.branch };
                release = await acquireRun(cwd);
                await rebindLegacyIdentity(cwd, run, ticket, snapshot);
                if (taskFingerprint(ticket) !== run.fingerprint) {
                    run.state = 'queued';
                    run.reason = 'Task content changed';
                    await saveRun(cwd, run);
                }
                let branchExists = false;
                try {
                    git(cwd, ['rev-parse', '--verify', `refs/heads/${run.branch}`]);
                    branchExists = true;
                }
                catch { /* implementation may not have created the branch yet */ }
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
                run.dependencies = run.dependencies.filter(d => d.id !== 'continuation' && d.id !== 'preflight' && d.kind !== 'environment');
                await saveRun(cwd, run);
                const failedCi = run.dependencies.find(d => d.kind === 'test');
                if (failedCi) {
                    const head = git(cwd, ['rev-parse', 'HEAD']).trim();
                    if (!recordFailure(run, snapshot, 'test', { stage: failedCi.id, checks: snapshot.verification.requiredCiChecks ?? 'discovered' }, head, 'CI invariant remains failed')) {
                        run.state = 'blocked';
                        run.reason = 'CI repair budget exhausted';
                        await saveRun(cwd, run);
                        continue;
                    }
                    snapshot._deadline = now() + snapshot.timeout * 1000;
                    await saveRun(cwd, run);
                    const repaired = await recoverFailedTicket({ ticket, config: snapshot, cwd, state: { ticket, status: 'blocked', branch: run.branch, logLines: [], elapsedMs: 0, failureReason: failedCi.description }, plan: run.plan ?? '', signal: taskSignal, onLogLine: line => callbacks.onLogLine(ticket.number, line) });
                    if (!repaired) {
                        run.state = 'blocked';
                        run.reason = 'CI repair produced no new verified commit';
                        await saveRun(cwd, run);
                        continue;
                    }
                    run.implementation = { head: git(cwd, ['rev-parse', 'HEAD']).trim(), fingerprint: run.fingerprint };
                    run.dependencies = run.dependencies.filter(d => d.id !== failedCi.id);
                    await saveRun(cwd, run);
                }
                let passed = false;
                if (run.publication && run.fingerprint === taskFingerprint(ticket)) {
                    const context = captureContext(ticket, snapshot, cwd, run.plan ?? await import('../review/context.js').then(m => m.savedPlan(run.artifacts)), run.branch);
                    passed = !!await loadPassedReview(path.join(run.artifacts, 'review'), context);
                }
                if (passed && !run.dependencies.some(d => d.kind === 'test')) {
                    clearVerifiedLocalDependencies(run);
                    await advanceCompletion(snapshot, run, cwd, options.services, taskSignal);
                    const state = { ticket, status: run.state === 'complete' ? 'done' as const : run.state === 'queued' ? 'pending' as const : 'waiting' as const, branch: run.branch, prUrl: run.publication?.url, prNumber: run.publication?.number, logLines: [], elapsedMs: 0, runKey: run.key, remaining: run.requirements.filter(r => r.status !== 'verified').map(r => r.text), failureReason: run.reason };
                    callbacks.onStatusChange(ticket.number, state);
                    if (run.state === 'complete')
                        callbacks.onComplete(ticket.number, state);
                }
                else {
                    // Refresh the base before obtaining new independent evidence.
                    git(cwd, ['fetch', 'origin', snapshot.baseBranch]);
                    await runAllTickets([ticket], snapshot, cwd, callbacks, taskSignal, options.services, true);
                }
            }
            catch (error) {
                if (/An Iteris queue is already running/.test(String(error)))
                    continue;
                const failure = classifyFailure(error, run.phase);
                waitFor(run, snapshot, 'continuation', failure.kind, error instanceof Error ? error.message : String(error), failure.nextAction);
                if (error instanceof SetupBudgetExhausted)
                    run.state = 'blocked';
                await saveRun(cwd, run);
                callbacks.onLogLine(run.ticket.number, `[continuation] ${run.reason}`);
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
                await release?.();
            }
        }
        force = false;
        if (options.once || !config.continuation.watch || signal?.aborted)
            return;
        const waiting = (await listRuns(cwd, config.repo)).filter(run => ['queued', 'active', 'waiting'].includes(run.state));
        if (!waiting.length)
            return;
        const next = Math.min(...waiting.flatMap(run => run.dependencies.map(d => Date.parse(d.nextRetryAt))));
        await (options.sleep ?? pause)(Math.max(1, Math.min(60000, Number.isFinite(next) ? next - now() : config.continuation.initialSeconds * 1000)), signal);
    } while (!signal?.aborted);
}
export async function unfinishedTickets(cwd: string, config: IterisConfig): Promise<Ticket[]> {
    return (await listRuns(cwd, config.repo)).filter(run => ['queued', 'active', 'waiting'].includes(run.state)).map(run => ({ ...run.ticket, source: run.source }));
}
