import { randomUUID } from 'node:crypto';
import type { IterisConfig } from '../types.js';
import { saveRun, waitFor, renderRun, MANUAL_FOLLOW_UP, type TaskRun, type ExternalAction } from './state.js';
import { addEvidence, reconcileEvidence, readyToComplete, extractRequirements } from './requirements.js';
import { executeCommand } from './environment.js';
import { sourceAdapter } from './adapters.js';
import { verifyGithubCi, setGithubDraft, type CiResult } from './github-verification.js';
import { updatePrLifecycle } from '../github/pr.js';
export type CompletionServices = {
    ci?: (config: IterisConfig, run: TaskRun) => Promise<CiResult>;
    draft?: (config: IterisConfig, number: number, draft: boolean) => Promise<void>;
    synchronize?: (run: TaskRun) => Promise<void>;
    status?: typeof updatePrLifecycle;
};
export function sourceUpdateRequired(config: IterisConfig, run: TaskRun): boolean { return !!config.integrations.status[run.source.provider] || (run.source.provider === 'trello' && !!config.trello?.moveOnComplete); }
export function enqueueAction(run: TaskRun, kind: ExternalAction['kind'], stage: string | undefined, head: string, idempotent: boolean): ExternalAction {
    let action = run.actions.find(a => a.kind === kind && a.stage === stage && a.commit === head);
    if (!action) {
        action = { id: randomUUID(), operationId: randomUUID(), target: structuredClone(run.source), kind, stage, commit: head, idempotent, status: 'pending', intent: `${kind}:${stage ?? run.source.id}` };
        run.actions.push(action);
    }
    return action;
}
async function probeStage(config: IterisConfig, run: TaskRun, cwd: string, stageId: string, signal?: AbortSignal): Promise<boolean> {
    const stage = config.verification.stages.find(s => s.id === stageId || s.kind === stageId);
    const requirements = run.requirements.filter(r => r.stage === stageId);
    if (!stage?.verify) {
        waitFor(run, config, `stage:${stageId}`, 'capability', `Evidence unavailable for ${stageId}`, 'Configure a verification command or submit iteris evidence with requirement, commit/build and observation time');
        return false;
    }
    const head = run.publication!.head, base = run.publication!.base;
    const action = stage.execute ? enqueueAction(run, 'stage', stage.id, head, stage.idempotent) : undefined;
    const input = () => ({ version: 1, operation: 'verify', operationId: action?.operationId, runKey: run.key, requirements: requirements.map(r => r.id), commit: head, base, publication: run.publication });
    const resetObservation = () => { if (stage.observationSeconds)
        for (const requirement of requirements)
            addEvidence(run, requirement.id, head, `command:${stage.id}:failure`, 'Observation probe failed; a new successful window is required', false, base); };
    const verify = async () => {
        const result = await executeCommand(stage.verify!, cwd, config, signal, input());
        if (result.error || result.truncated) {
            resetObservation();
            throw new Error(result.error ?? 'Stage output truncated');
        }
        if (result.exitCode !== 0) {
            resetObservation();
            return undefined;
        }
        const receipt = JSON.parse(result.stdout ?? result.output) as {
            version?: number;
            verified?: boolean;
            commit?: string;
            observedAt?: string;
            build?: string;
            details?: string;
        };
        if (receipt.verified === false) {
            resetObservation();
            return undefined;
        }
        if (receipt.version !== 1 || receipt.verified !== true || receipt.commit !== head || !receipt.observedAt || !Number.isFinite(Date.parse(receipt.observedAt)) || Date.parse(receipt.observedAt) > Date.now() + 60000)
            throw new Error('Stage evidence must identify the current commit and observation time');
        return receipt;
    };
    let receipt = await verify();
    if (!receipt && action && action.status !== 'verified') {
        if (run.requirements.some(requirement => ['local', 'review', 'publication', 'ci'].includes(requirement.stage) && requirement.status !== 'verified')) {
            waitFor(run, config, stage.id, 'external', `Required verification must pass before executing ${stage.id}`, 'Finish local review, publication and required CI before the external action');
            return false;
        }
        if (!config.integrations.externalActions.includes(stage.id)) {
            waitFor(run, config, stage.id, 'capability', `Action ${stage.id} is not enabled`, 'Enable this stage in integrations.externalActions');
            return false;
        }
        if ((action.status === 'executing' || action.status === 'waiting') && !action.idempotent) {
            action.status = 'waiting';
            waitFor(run, config, stage.id, 'external', 'Interrupted non-idempotent action has no verified outcome', 'Supply reliable outcome evidence before repeating the action');
            return false;
        }
        action.status = 'executing';
        action.startedAt = new Date().toISOString();
        await saveRun(cwd, run);
        const result = await executeCommand(stage.execute!, cwd, config, signal, { ...input(), operation: 'execute' });
        action.result = result.output;
        // Verify after both success and failure; a lost response may hide success.
        receipt = await verify();
        if (!receipt) {
            action.status = 'waiting';
            waitFor(run, config, stage.id, 'external', `Action ${stage.id} awaits verified outcome`, result.error ?? 'Wait for the configured outcome probe');
            return false;
        }
    }
    if (!receipt) {
        waitFor(run, config, stageId, 'external', `${stageId} evidence pending`, 'Wait for the configured probe to report success');
        return false;
    }
    const reset = run.evidence.filter(e => e.provenance === `command:${stage.id}:failure` && e.commit === head && e.base === base).at(-1);
    const first = run.evidence.filter(e => e.provenance === `command:${stage.id}` && requirements.some(r => r.id === e.requirementId) && e.commit === head && e.base === base && (!reset || Date.parse(e.observedAt) > Date.parse(reset.observedAt))).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
    const since = first?.observedAt ?? receipt.observedAt;
    const observed = Date.parse(receipt.observedAt!) - Date.parse(since!) >= stage.observationSeconds * 1000;
    for (const requirement of requirements)
        addEvidence(run, requirement.id, head, `command:${stage.id}`, receipt.details ?? JSON.stringify(receipt), observed, base, receipt.observedAt!, receipt.build);
    if (!observed) {
        for (const requirement of requirements)
            requirement.status = 'pending';
        waitFor(run, config, stageId, 'external', `Observation window for ${stageId} is still open`, 'Continue successful probes for the configured observation window');
        return false;
    }
    if (action)
        action.status = 'verified';
    run.dependencies = run.dependencies.filter(d => d.id !== stage.id && d.id !== stageId && d.id !== `stage:${stageId}` && d.id !== `stage:${stage.id}`);
    return true;
}
async function reconcilePriorActions(config: IterisConfig, run: TaskRun, cwd: string, signal?: AbortSignal): Promise<Set<string>> {
    const unresolved = new Set<string>();
    for (const action of run.actions.filter(a => a.status !== 'verified' && a.commit !== run.publication!.head)) {
        if (action.status === 'pending' && !action.startedAt) {
            action.status = 'verified';
            action.result = 'Superseded before execution by a new task revision';
            continue;
        }
        const verifier = action.kind === 'source-status' ? config.integrations.status[run.source.provider]?.verify : config.verification.stages.find(s => s.id === action.stage)?.verify;
        let verified = false;
        if (verifier)
            try {
                const result = await executeCommand(verifier, cwd, config, signal, { version: 1, operation: 'verify', operationId: action.operationId, runKey: run.key, source: run.source, commit: action.commit, publication: run.publication });
                const receipt = JSON.parse(result.stdout ?? result.output);
                verified = result.exitCode === 0 && !result.error && !result.truncated && receipt.version === 1 && receipt.verified === true && (action.kind === 'source-status' || receipt.commit === action.commit);
            }
            catch { /* Keep intent when outcome cannot be established. */ }
        if (verified) {
            action.status = 'verified';
            run.dependencies = run.dependencies.filter(d => d.id !== `action:${action.id}`);
        }
        else {
            unresolved.add(action.stage ?? 'source-status');
            waitFor(run, config, `action:${action.id}`, 'external', `Earlier ${action.intent} at ${action.commit} has an unresolved outcome`, 'Restore an outcome probe for the persisted operation before executing a replacement');
        }
    }
    return unresolved;
}
export async function publishCompletionView(config: IterisConfig, run: TaskRun, cwd: string, services: CompletionServices = {}): Promise<void> {
    if (!run.publication)
        return;
    const publish = services.status ?? (Object.keys(services).length === 0 ? updatePrLifecycle : undefined);
    if (!publish)
        return;
    try {
        await publish(config, run.publication.number, renderRun(run).slice(0, 50000));
        run.dependencies = run.dependencies.filter(d => d.id !== 'publication-status');
    }
    catch (error) {
        const wasBlocked = run.state === 'blocked';
        waitFor(run, config, 'publication-status', 'transport', `PR completion report update failed: ${String(error)}`, 'Restore publication access and retry the completion report update');
        if (wasBlocked)
            run.state = 'blocked';
    }
    await saveRun(cwd, run);
}
export async function advanceCompletion(config: IterisConfig, run: TaskRun, cwd: string, services: CompletionServices = {}, signal?: AbortSignal): Promise<void> {
    if (!run.publication || signal?.aborted)
        return;
    for (const requirement of extractRequirements(run.ticket, config))
        if (!run.requirements.some(r => r.id === requirement.id))
            run.requirements.push(requirement);
    const { head, base } = run.publication;
    reconcileEvidence(run, head, base);
    const priorActions = await reconcilePriorActions(config, run, cwd, signal);
    run.dependencies = run.dependencies.filter(d => d.id !== 'publication-status' && d.id !== 'deadline');
    // Dependencies from earlier probes are rebuilt while preserving backoff.
    const ci = await (services.ci ?? verifyGithubCi)(config, run);
    if (ci.state === 'changed') {
        for (const requirement of run.requirements)
            requirement.status = 'pending';
        run.state = 'queued';
        run.phase = 'reconciliation';
        run.reason = ci.details;
        if (ci.base !== base)
            run.ciFreshness = { head: ci.head, base: ci.base, after: new Date().toISOString() };
        await (services.draft ?? setGithubDraft)(config, run.publication.number, true);
        run.publication.draft = true;
        await saveRun(cwd, run);
        await publishCompletionView(config, run, cwd, services);
        return;
    }
    if (ci.state !== 'passed') {
        for (const requirement of run.requirements.filter(r => r.stage === 'ci'))
            addEvidence(run, requirement.id, head, 'github-required-checks', ci.details, false, base);
        waitFor(run, config, 'ci', ci.state === 'failed' ? 'test' : 'external', ci.details, ci.state === 'failed' ? 'Repair failed CI, then verify the new commit' : 'Wait for checks on the published commit');
    }
    else {
        for (const requirement of run.requirements.filter(r => r.stage === 'ci'))
            addEvidence(run, requirement.id, head, 'github-required-checks', ci.details, true, base);
        run.dependencies = run.dependencies.filter(d => d.id !== 'ci');
    }
    for (const stage of new Set(run.requirements.filter(r => !['local', 'review', 'publication', 'ci'].includes(r.stage) && r.status !== 'verified').map(r => r.stage))) {
        const configured = config.verification.stages.find(s => s.id === stage || s.kind === stage);
        if (!configured && config.workflow.externalEvidence === 'advisory') {
            // Nothing configured can observe this stage. It is listed for a person to verify and does not hold the task.
            for (const requirement of run.requirements.filter(r => r.stage === stage && r.status !== 'verified'))
                addEvidence(run, requirement.id, head, MANUAL_FOLLOW_UP, 'Not verified by Iteris; listed for manual verification', true, base);
            run.dependencies = run.dependencies.filter(d => d.id !== stage && d.id !== `stage:${stage}`);
            continue;
        }
        if (priorActions.has(configured?.id ?? stage))
            continue;
        try {
            await probeStage(config, run, cwd, stage, signal);
        }
        catch (error) {
            waitFor(run, config, `stage:${stage}`, 'external', String(error), 'Correct the configured probe or supply valid evidence');
        }
    }
    const acceptanceReady = run.requirements.every(r => r.status === 'verified');
    if (acceptanceReady && run.dependencies.every(dependency => dependency.id === 'source-status' || dependency.id === 'publication-status') && !priorActions.has('source-status') && sourceUpdateRequired(config, run)) {
        const mapping = config.integrations.status[run.source.provider];
        const action = enqueueAction(run, 'source-status', undefined, head, mapping?.idempotent ?? true);
        if (action.status !== 'verified') {
            try {
                const input = { version: 1, operation: 'synchronize', source: run.source, runKey: run.key, operationId: action.operationId, publication: run.publication, status: 'complete' };
                let already = false;
                if (mapping?.verify) {
                    const result = await executeCommand(mapping.verify, cwd, config, signal, { ...input, operation: 'verify' });
                    const receipt = JSON.parse(result.stdout ?? result.output);
                    already = result.exitCode === 0 && !result.error && !result.truncated && receipt.verified === true;
                }
                if (!already && ['executing', 'waiting'].includes(action.status) && !action.idempotent)
                    throw new Error('Interrupted source update requires reliable outcome evidence');
                if (!already) {
                    action.status = 'executing';
                    await saveRun(cwd, run);
                    if (services.synchronize)
                        await services.synchronize(run);
                    else if (mapping) {
                        const result = await executeCommand(mapping.command, cwd, config, signal, input);
                        if (result.error || result.truncated || result.exitCode !== 0 || JSON.parse(result.stdout ?? result.output).verified !== true)
                            throw new Error(result.error ?? 'Source update did not verify success');
                    }
                    else
                        await sourceAdapter({ ...config, provider: run.source.provider }, cwd).synchronize!(run);
                }
                action.status = 'verified';
                run.dependencies = run.dependencies.filter(d => d.id !== 'source-status');
            }
            catch (error) {
                action.status = 'waiting';
                waitFor(run, config, 'source-status', 'transport', String(error), 'Retry the persisted source update after resolving provider access');
            }
        }
    }
    if (readyToComplete(run)) {
        if (Date.now() >= (config._deadline ?? Infinity)) {
            // Out of time is not a verdict on the work: the next pass verifies again with a fresh allowance.
            waitFor(run, config, 'deadline', 'external', 'Task deadline exhausted before final readiness verification', 'Verify readiness again with a fresh allowance');
            await saveRun(cwd, run);
            return;
        }
        await (services.draft ?? setGithubDraft)(config, run.publication.number, config.pr.draft);
        run.publication.draft = config.pr.draft;
        run.state = 'complete';
        run.phase = 'complete';
        run.reason = undefined;
    }
    else if (run.state !== 'blocked')
        run.state = 'waiting';
    await saveRun(cwd, run);
    await publishCompletionView(config, run, cwd, services);
}
