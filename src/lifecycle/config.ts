import { z } from 'zod';
import type { IterisConfig, Ticket } from '../types.js';
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const commandVariant = z.object({ executable: z.string().min(1), args: z.array(z.string()).default([]), shell: z.string().min(1).optional() }).strict();
export const commandSchema = commandVariant.extend({ cwd: z.string().default('.'), timeout: z.number().positive().default(300), env: z.record(z.string()).default({}), platforms: z.record(commandVariant).default({}) }).strict();
export type Command = z.infer<typeof commandSchema>;
export const checkSchema = z.object({ id, command: commandSchema, paths: z.array(z.string()).default([]), behavioral: z.boolean().default(false) }).strict();
export const stageSchema = z.object({ id, kind: z.enum(['ci', 'deployment', 'device', 'provider', 'monitoring', 'merge']), required: z.boolean().default(true), execute: commandSchema.optional(), verify: commandSchema.optional(), idempotent: z.boolean().default(false), observationSeconds: z.number().nonnegative().default(0) }).strict();
// externalEvidence: what happens to evidence Iteris cannot obtain from a local checkout and that no
// configured stage verifies (device sessions, hosted services, missing attachments).
// advisory lists it in the PR for manual verification; required keeps the task waiting for it.
const workflow = z.object({ boundary: z.literal('verified-pr').default('verified-pr'), unfinishedDraft: z.literal(true).default(true), externalEvidence: z.enum(['advisory', 'required']).default('advisory') }).strict().default({});
const verification = z.object({ checks: z.array(checkSchema).default([]), policyFiles: z.array(z.string()).default(['REVIEW.md']), contextFiles: z.array(z.string()).default(['AGENTS.md']), maxContextCharacters: z.number().int().min(1000).max(1000000).default(40000), fixtures: z.array(z.string()).default([]), stages: z.array(stageSchema).default([]), requiredCiChecks: z.array(z.string()).optional() }).strict().default({});
const environment = z.object({ runtimes: z.array(z.object({ id, executable: z.string().min(1), versionArgs: z.array(z.string()).default(['--version']), versionPattern: z.string().optional(), setup: commandSchema.optional() }).strict()).default([]), env: z.record(z.string()).default({}), probes: z.array(checkSchema).default([]), setup: z.array(commandSchema).default([]) }).strict().default({});
// attempts: immediate in-process repairs per failure within one task timeout.
// maxTaskAttempts: fresh-instance attempts per task across the whole queue; 0 never gives up.
// idleTimeout: seconds without harness output before the instance is killed as stalled; 0 disables.
const recovery = z.object({ enabled: z.boolean().default(true), scope: z.literal('project-local').default('project-local'), attempts: z.number().int().min(0).max(10).default(2), finalVerificationReserve: z.number().min(0.1).max(0.5).default(0.2), maxTaskAttempts: z.number().int().min(0).default(0), idleTimeout: z.number().nonnegative().default(1800) }).strict().default({});
const continuation = z.object({ watch: z.boolean().default(true), initialSeconds: z.number().positive().default(60), maxSeconds: z.number().positive().max(86400).default(900) }).strict().default({});
const integrations = z.object({ source: z.object({ name: id, namespace: z.string().min(1), command: commandSchema }).strict().optional(), status: z.record(z.object({ command: commandSchema, idempotent: z.boolean().default(true), verify: commandSchema.optional() }).strict()).default({}), externalActions: z.array(id).default([]) }).strict().default({});
const profile = z.object({ id, match: z.object({ provider: z.enum(['github', 'trello', 'custom', 'command']).optional(), labels: z.array(z.string()).default([]), paths: z.array(z.string()).default([]) }).strict(), verification: verification.optional(), environment: environment.optional(), recovery: recovery.optional(), workflow: workflow.optional() }).strict();
export const lifecycleShape = { workflow, verification, environment, recovery, continuation, integrations, profiles: z.array(profile).default([]) };
export const lifecycleConfigSchema = z.object(lifecycleShape).strict();
export type LifecycleConfig = z.infer<typeof lifecycleConfigSchema>;
export function globMatch(pattern: string, value: string): boolean {
    const regex = pattern.split('**').map(part => part.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${regex}$`).test(value);
}
export function mergeById<T extends {
    id: string;
}>(items: T[]): T[] {
    const merged = new Map<string, T>();
    for (const item of items) {
        const previous = merged.get(item.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(item))
            throw new Error(`Conflicting definitions for ${item.id}`);
        merged.set(item.id, item);
    }
    return [...merged.values()];
}
export function validateDefinitions(config: LifecycleConfig): void {
    mergeById([...config.environment.runtimes, ...config.profiles.flatMap(p => p.environment?.runtimes ?? [])]);
    mergeById([...config.environment.probes, ...config.profiles.flatMap(p => p.environment?.probes ?? [])]);
    mergeById([...config.verification.checks, ...config.profiles.flatMap(p => p.verification?.checks ?? [])]);
    mergeById([...config.verification.stages, ...config.profiles.flatMap(p => p.verification?.stages ?? [])]);
    for (const stage of [...config.verification.stages, ...config.profiles.flatMap(p => p.verification?.stages ?? [])])
        if (stage.execute && !config.integrations.externalActions.includes(stage.id))
            throw new Error(`Stage ${stage.id} execution requires integrations.externalActions authorization`);
}
export function resolveTaskConfig(config: IterisConfig, ticket: Ticket, paths: string[] = [], overrides: Partial<IterisConfig> = {}): IterisConfig {
    const result = structuredClone(config);
    for (const profile of config.profiles) {
        const match = profile.match;
        if (match.provider && match.provider !== (ticket.source?.provider ?? config.provider ?? 'github'))
            continue;
        if (match.labels.some(label => !ticket.labels.includes(label)))
            continue;
        if (match.paths.length && !paths.some(file => match.paths.some(pattern => globMatch(pattern, file))))
            continue;
        if (profile.verification) {
            result.verification.checks = mergeById([...result.verification.checks, ...profile.verification.checks]);
            result.verification.stages = mergeById([...result.verification.stages, ...profile.verification.stages]);
            result.verification.policyFiles = [...new Set([...result.verification.policyFiles, ...profile.verification.policyFiles])];
            result.verification.contextFiles = [...new Set([...result.verification.contextFiles, ...profile.verification.contextFiles])];
            result.verification.fixtures = [...new Set([...result.verification.fixtures, ...profile.verification.fixtures])];
            result.verification.maxContextCharacters = Math.max(result.verification.maxContextCharacters, profile.verification.maxContextCharacters);
            if (profile.verification.requiredCiChecks)
                result.verification.requiredCiChecks = [...new Set([...(result.verification.requiredCiChecks ?? []), ...profile.verification.requiredCiChecks])];
        }
        if (profile.environment)
            result.environment = { ...result.environment, runtimes: mergeById([...result.environment.runtimes, ...profile.environment.runtimes]), probes: mergeById([...result.environment.probes, ...profile.environment.probes]), setup: [...new Map([...result.environment.setup, ...profile.environment.setup].map(c => [JSON.stringify(c), c])).values()], env: { ...result.environment.env, ...profile.environment.env } };
        if (profile.recovery)
            result.recovery = profile.recovery;
    }
    Object.assign(result, overrides);
    validateDefinitions(result);
    return result;
}
