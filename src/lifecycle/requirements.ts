import type { IterisConfig, Ticket } from '../types.js';
import { globMatch } from './config.js';
import { hash, notRequirement, type TaskRun, type Requirement, type Evidence } from './state.js';
export function extractRequirements(ticket: Ticket, config: IterisConfig): Requirement[] {
    const sourceRef = ticket.htmlUrl || `${ticket.source?.provider ?? config.provider}:${ticket.source?.id ?? ticket.number}`;
    const make = (id: string, text: string, stage: string, method: string): Requirement => ({ id, text, stage, method, sourceRef, status: 'pending', evidenceIds: [] });
    const requirements = [make('local-checks', 'Required local checks pass on the final commit', 'local', 'host-checks'), make('independent-review', 'Independent review covers the final commit', 'review', 'independent-review'), make('publication', 'A verified pull request is published', 'publication', 'github'), make('required-ci', 'Repository-required CI checks pass', 'ci', 'github')];
    // Conservative extraction retains all acceptance lines. The planner may add
    // structure, but cannot remove these obligations or enable host actions.
    const lines = ticket.body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^#{1,6}\s/.test(line) && !notRequirement(line));
    for (const text of lines.length ? lines : [ticket.title]) {
        let stage = 'local';
        if (/\b(?:deploy|deployment|release to|production rollout)\b/i.test(text))
            stage = 'deployment';
        else if (/\b(?:physical device|real device|hardware|on-device|device testing|device verification)\b/i.test(text))
            stage = 'device';
        else if (/\b(?:monitor|monitoring|observe for|observation window)\b/i.test(text))
            stage = 'monitoring';
        else if (/\b(?:after merge|must be merged|merge the (?:PR|pull request))\b/i.test(text))
            stage = 'merge';
        else if (/\b(?:CI|pipeline)\b.*\b(?:pass|green|verify|check|gate)\b/i.test(text))
            stage = 'ci';
        else if (/\b(?:provider console|provider receipt|external service verification)\b/i.test(text))
            stage = 'provider';
        requirements.push(make(`acceptance-${hash(text).slice(0, 16)}`, text, stage, stage === 'local' ? 'independent-review' : 'stage-evidence'));
    }
    for (const stage of config.verification.stages.filter(stage => stage.required))
        requirements.push(make(`stage:${stage.id}`, `Required ${stage.kind} stage: ${stage.id}`, stage.id, 'configured-probe'));
    return [...new Map(requirements.map(requirement => [requirement.id, requirement])).values()];
}
export function verificationPack(run: TaskRun, config: IterisConfig): string {
    return JSON.stringify({ version: 1, requirements: run.requirements, invariants: config.verification.policyFiles, contextFiles: config.verification.contextFiles, fixtures: config.verification.fixtures, reproduction: 'Reproduce each acceptance invariant before repairing it; keep the behavioral commands and their output in the task evidence folder, never in the repository.', capabilities: [...new Set(run.requirements.map(r => r.stage))], behavioralChecks: config.verification.checks.filter(c => c.behavioral), checks: config.verification.checks }, null, 2);
}
export function applicableChecks(config: IterisConfig, files: string[]) {
    return config.verification.checks.filter(check => !check.paths.length || files.some(file => check.paths.some(pattern => globMatch(pattern, file))));
}
export function addEvidence(run: TaskRun, requirementId: string, commit: string, provenance: string, details: string, success: boolean, base?: string, observedAt = new Date().toISOString(), build?: string): Evidence {
    const evidence: Evidence = { id: hash([requirementId, commit, base, provenance, details, observedAt]), requirementId, commit, base, provenance, details, success, observedAt, build };
    run.evidence.push(evidence);
    const requirement = run.requirements.find(r => r.id === requirementId);
    if (!requirement)
        throw new Error(`Unknown requirement ${requirementId}`);
    requirement.evidenceIds.push(evidence.id);
    requirement.status = success ? 'verified' : 'pending';
    return evidence;
}
export function reconcileEvidence(run: TaskRun, head: string, base: string, now = Date.now()): void {
    for (const requirement of run.requirements) {
        const latest = [...run.evidence].reverse().find(e => e.requirementId === requirement.id && e.commit === head && (!e.base || e.base === base));
        requirement.status = latest?.success && (!latest.expiresAt || Date.parse(latest.expiresAt) > now) ? 'verified' : 'pending';
    }
}
export function readyToComplete(run: TaskRun): boolean {
    return !!run.publication && run.requirements.length > 0 && run.requirements.every(r => r.status === 'verified') && run.actions.every(a => a.status === 'verified') && !run.dependencies.length;
}
