import { z } from 'zod';
import type { TaskRun } from './state.js';
import { hash } from './state.js';
export const planningSchema = z.object({ plan: z.string().min(1), requirements: z.array(z.object({ id: z.string(), text: z.string().min(1), stage: z.string().min(1), method: z.string().min(1) }).strict()), invariants: z.array(z.string()), reproductionStrategy: z.string().min(1), fixtures: z.array(z.string()), capabilities: z.array(z.string()), checks: z.array(z.object({ command: z.string().min(1), behavioral: z.boolean(), requirementIds: z.array(z.string()) }).strict()).max(20) }).strict();
export type PlanningPack = z.infer<typeof planningSchema>;
/**
 * Planned commands the host runs as local gates. A command that only serves a host-owned later
 * stage (review, publication, CI, deployment, device) cannot pass before that stage exists and is not local evidence.
 */
export function localPlannedChecks(run: Pick<TaskRun, 'requirements' | 'planning'>): string[] {
    const local = new Set(run.requirements.filter(requirement => requirement.stage === 'local').map(requirement => requirement.id));
    return (run.planning?.checks ?? []).filter(check => !check.requirementIds.length || check.requirementIds.some(id => local.has(id))).map(check => check.command);
}
export function applyPlanningPack(run: TaskRun, pack: PlanningPack): void {
    const aliases = new Map<string, string>();
    for (const requirement of pack.requirements) {
        const existing = run.requirements.find(r => r.id === requirement.id);
        if (existing) {
            aliases.set(requirement.id, existing.id);
            if (existing.text !== requirement.text)
                throw new Error(`Planner changed requirement ${existing.id}`);
            if (existing.stage === 'local' && requirement.stage !== 'local')
                existing.stage = requirement.stage;
        }
        else {
            const id = `plan-${hash([run.source, requirement.text]).slice(0, 16)}`;
            aliases.set(requirement.id, id);
            if (!run.requirements.some(r => r.id === id))
                run.requirements.push({ id, text: requirement.text, stage: requirement.stage, method: requirement.method, sourceRef: run.ticket.htmlUrl, status: 'pending', evidenceIds: [] });
        }
    }
    for (const check of pack.checks)
        check.requirementIds = check.requirementIds.map(id => { const resolved = aliases.get(id) ?? id; if (!run.requirements.some(r => r.id === resolved))
            throw new Error(`Planning check references unknown requirement ${id}`); return resolved; });
    // Baseline host gates cannot be reclassified by a planner.
    for (const [id, stage] of [['local-checks', 'local'], ['independent-review', 'review'], ['publication', 'publication'], ['required-ci', 'ci']] as const) {
        const requirement = run.requirements.find(r => r.id === id);
        if (requirement)
            requirement.stage = stage;
    }
    run.planning = pack;
}
