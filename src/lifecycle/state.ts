import {stateRoot} from '../state/workspace.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { IterisConfig, Ticket } from '../types.js';
import type { ExecutionManifest } from './environment.js';
import { renderAttempts, type AttemptRecord } from './attempts.js';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type LifecycleState = 'queued' | 'active' | 'waiting' | 'blocked' | 'complete' | 'cancelled';
export type FailureKind = 'code' | 'test' | 'environment' | 'transport' | 'review-protocol' | 'capability' | 'external';
export type Dependency = {
    id: string;
    kind: FailureKind;
    description: string;
    nextAction: string;
    lastProbe?: string;
    nextRetryAt: string;
    attempts: number;
};
export type Requirement = {
    id: string;
    text: string;
    sourceRef: string;
    stage: string;
    method: string;
    status: 'pending' | 'verified';
    evidenceIds: string[];
};
export type Evidence = {
    id: string;
    requirementId: string;
    commit: string;
    base?: string;
    build?: string;
    observedAt: string;
    expiresAt?: string;
    provenance: string;
    details: string;
    success: boolean;
    positiveObservation?: boolean;
};
export type ExternalAction = {
    id: string;
    kind: 'source-status' | 'stage';
    target: TaskRun['source'];
    stage?: string;
    status: 'pending' | 'executing' | 'verified' | 'waiting';
    idempotent: boolean;
    intent: string;
    operationId: string;
    startedAt?: string;
    result?: string;
    commit: string;
};
export type TaskRun = {
    workspace?: {mode: 'local' | 'worktree'; path: string};
    version: 1;
    key: string;
    repository: string;
    source: NonNullable<Ticket['source']>;
    fingerprint: string;
    ticket: Ticket;
    branch: string;
    state: LifecycleState;
    phase: string;
    createdAt: string;
    updatedAt: string;
    requirements: Requirement[];
    evidence: Evidence[];
    dependencies: Dependency[];
    environment?: ExecutionManifest;
    retries: Array<{
        signature: string;
        kind: FailureKind;
        head: string;
        attempts: number;
        progress: string;
    }>;
    publication?: {
        url: string;
        number: number;
        head: string;
        base: string;
        draft: boolean;
        /** Commit the published PR description was written for; absent while the PR carries a placeholder. */
        described?: string;
    };
    ciFreshness?: {
        head: string;
        base: string;
        after: string;
    };
    implementation?: {
        head: string;
        fingerprint: string;
    };
    actions: ExternalAction[];
    artifacts: string;
    plan?: string;
    reason?: string;
    reviewSummary?: {
        head?: string;
        outcome: string;
        rounds: number;
        repairs: number;
        elapsedMs: number;
    };
    planning?: import('./planning.js').PlanningPack;
    /** Test and non-test lines of the reviewed commit against its base, shown in the pull request. */
    changeSize?: import('../review/context.js').ChangeSize;
    /** Journal of failed attempts; a fresh instance receives it in its prompt. */
    attempts?: AttemptRecord[];
    /** Replies from a person to an instance that stopped to ask; a fresh instance receives them in its prompt. */
    answers?: import('./attempts.js').Answer[];
};
export function sourceIdentity(ticket: Ticket, config: IterisConfig): NonNullable<Ticket['source']> {
    if (ticket.source)
        return ticket.source;
    const provider = config.provider ?? 'github';
    return { provider, namespace: provider === 'trello' ? config.trello?.boardId ?? 'unresolved-board' : provider === 'custom' ? config.custom?.endpoint ?? config.repo : config.repo,
        id: ticket.custom?.identity ?? (provider === 'trello' ? `legacy:${ticket.number}` : String(ticket.number)) };
}
const canonicalIdentity = (repository: string, source: NonNullable<Ticket['source']>) => [repository, source.provider, source.namespace, source.id];
export const taskKey = (ticket: Ticket, config: IterisConfig) => hash(canonicalIdentity(config.repo, sourceIdentity(ticket, config)));
export const taskFingerprint = (ticket: Ticket) => ticket.custom ? hash(ticket.custom.fingerprint) : hash([ticket.title, ticket.body, [...ticket.labels].sort()]);
export const runPath = (cwd: string, key: string) => path.join(stateRoot(cwd), '.iteris', 'tasks', key, 'run.json');
export async function atomicJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
    }
    finally {
        await unlink(temporary).catch(() => { });
    }
}
// Validate identity-bearing fields on read. Never accept arbitrary run paths or outbox targets.
const sourceSchema = z.object({ provider: z.enum(['github', 'trello', 'custom', 'command']), namespace: z.string().min(1), id: z.string().min(1), issueId: z.string().optional(), projectItemId: z.string().optional(), repository: z.string().optional() });
const storedSchema = z.object({ workspace: z.object({mode: z.enum(['local', 'worktree']), path: z.string()}).optional(), version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), repository: z.string(), source: sourceSchema, fingerprint: z.string(), ticket: z.object({ number: z.number(), title: z.string(), body: z.string(), labels: z.array(z.string()), slug: z.string(), htmlUrl: z.string() }).passthrough(), branch: z.string(), state: z.enum(['queued', 'active', 'waiting', 'blocked', 'complete', 'cancelled']), phase: z.string(), requirements: z.array(z.object({ id: z.string(), stage: z.string() }).passthrough()), evidence: z.array(z.object({ id: z.string(), commit: z.string(), success: z.boolean() }).passthrough()), dependencies: z.array(z.object({ id: z.string(), nextRetryAt: z.string() }).passthrough()), retries: z.array(z.unknown()), actions: z.array(z.object({ target: sourceSchema }).passthrough()), artifacts: z.string(), createdAt: z.string(), updatedAt: z.string() }).passthrough();
export async function readRun(cwd: string, key: string): Promise<TaskRun | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error('Invalid task key');
    try {
        const parsed = storedSchema.parse(JSON.parse(await readFile(runPath(cwd, key), 'utf8'))) as unknown as TaskRun;
        if (parsed.key !== key || hash(canonicalIdentity(parsed.repository, parsed.source)) !== key || parsed.actions.some(a => JSON.stringify(a.target) !== JSON.stringify(parsed.source)))
            throw new Error('Task identity or outbox target mismatch');
        if (!path.resolve(parsed.artifacts).startsWith(path.resolve(stateRoot(cwd), '.iteris') + path.sep))
            throw new Error('Run artifacts escape project state directory');
        // Runs from before worktree support were implemented in the launching
        // checkout. Changing the default must not relocate their active branch.
        if (!parsed.workspace && (parsed.implementation || parsed.publication || parsed.plan))
            parsed.workspace = {mode: 'local', path: stateRoot(cwd)};
        return parsed;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export async function saveRun(cwd: string, run: TaskRun): Promise<void> {
    if (run.actions.some(a => JSON.stringify(a.target) !== JSON.stringify(run.source)))
        throw new Error('Outbox action targets another task');
    run.updatedAt = new Date().toISOString();
    await atomicJson(runPath(cwd, run.key), run);
    await writeFile(path.join(path.dirname(runPath(cwd, run.key)), 'status.md'), renderRun(run));
    if (run.attempts?.length)
        await writeFile(path.join(path.dirname(runPath(cwd, run.key)), 'attempts.md'), renderAttempts(run));
}
export async function listRuns(cwd: string, repository?: string): Promise<TaskRun[]> {
    let entries: string[];
    try {
        entries = await readdir(path.join(stateRoot(cwd), '.iteris', 'tasks'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return [];
        throw error;
    }
    const runs = await Promise.all(entries.filter(key => /^[a-f0-9]{64}$/.test(key)).map(key => readRun(cwd, key)));
    return runs.filter((run): run is TaskRun => !!run && (!repository || run.repository === repository));
}
export async function ensureRun(cwd: string, ticket: Ticket, config: IterisConfig, artifacts: string, branch: string): Promise<TaskRun> {
    const key = taskKey(ticket, config), fingerprint = taskFingerprint(ticket);
    const existing = await readRun(cwd, key);
    if (existing) {
        if (existing.fingerprint !== fingerprint) {
            await atomicJson(path.join(path.dirname(runPath(cwd, key)), 'history', `${existing.updatedAt.replace(/:/g, '-')}.json`), existing);
            existing.fingerprint = fingerprint;
            existing.ticket = ticket;
            existing.state = 'queued';
            existing.reason = 'Task content changed; requirements and evidence need reconciliation';
            existing.requirements = [];
            existing.evidence = [];
            existing.dependencies = [];
            existing.implementation = undefined;
            existing.plan = undefined;
            existing.planning = undefined;
            existing.retries = [];
            existing.attempts = [];
            existing.reviewSummary = undefined;
            // Keep outstanding intent: a changed ticket cannot erase an interrupted deployment.
            existing.phase = 'preflight';
        }
        return existing;
    }
    const now = new Date().toISOString();
    return { version: 1, key, repository: config.repo, source: sourceIdentity(ticket, config), fingerprint, ticket, branch, state: 'queued', phase: 'preflight', createdAt: now, updatedAt: now, requirements: [], evidence: [], dependencies: [], retries: [], actions: [], artifacts };
}
export async function rebindLegacyIdentity(cwd: string, run: TaskRun, ticket: Ticket, config: IterisConfig): Promise<void> {
    if (!ticket.source || ticket.source.provider !== run.source.provider || ticket.source.namespace !== run.source.namespace)
        throw new Error('Source refresh cannot change provider or namespace');
    if (ticket.source.id === run.source.id)
        return;
    if (!(run.source.id.startsWith('legacy:') || (run.source.provider === 'github' && run.source.id === String(run.ticket.number) && !run.source.issueId)))
        throw new Error('Stable source identity changed unexpectedly');
    const previous = structuredClone(run), key = taskKey(ticket, config);
    if (await readRun(cwd, key))
        throw new Error('Legacy identity conflicts with another existing task run');
    if (run.actions.some(action => action.status !== 'verified'))
        throw new Error('Pending legacy actions require identity reconciliation');
    run.source = ticket.source;
    run.key = key;
    run.ticket = ticket;
    if (run.source.provider === 'trello')
        run.dependencies = run.dependencies.filter(dependency => dependency.id !== 'trello-identity');
    for (const action of run.actions)
        action.target = structuredClone(run.source);
    await saveRun(cwd, run);
    previous.state = 'cancelled';
    previous.reason = `Identity reconciled to ${key}`;
    await saveRun(cwd, previous);
}
export function waitFor(run: TaskRun, config: IterisConfig, id: string, kind: FailureKind, description: string, nextAction: string, now = Date.now(), seconds?: number): void {
    const old = run.dependencies.find(d => d.id === id);
    const attempts = (old?.attempts ?? 0) + 1;
    // A fixed wait when the caller knows how long the thing it waits for takes; otherwise a growing one.
    const interval = seconds ?? Math.min(config.continuation.maxSeconds, config.continuation.initialSeconds * 2 ** Math.min(attempts - 1, 10));
    run.dependencies = [...run.dependencies.filter(d => d.id !== id), { id, kind, description, nextAction, lastProbe: new Date(now).toISOString(), nextRetryAt: new Date(now + interval * 1000).toISOString(), attempts }];
    run.state = 'waiting';
    run.reason = description;
}
export function recordFailure(run: TaskRun, config: IterisConfig, kind: FailureKind, invariant: unknown, head: string, progress: string): boolean {
    const signature = hash([kind, invariant]);
    const entry = run.retries.find(r => r.signature === signature);
    if (entry) {
        entry.attempts++;
        entry.head = head;
        entry.progress = progress;
    }
    else
        run.retries.push({ signature, kind, head, progress, attempts: 1 });
    return config.recovery.enabled && (entry?.attempts ?? 1) <= config.recovery.attempts;
}
export function clearVerifiedLocalDependencies(run: TaskRun): void {
    const phases = new Set(['preflight', 'planning', 'running', 'reviewing', 'creating-pr', 'local-review']);
    run.dependencies = run.dependencies.filter(dependency => dependency.kind !== 'environment' && !(phases.has(dependency.id) && dependency.kind !== 'external'));
}
/** Evidence provenance for a requirement Iteris cannot observe itself; it is listed for a person and does not block. */
export const MANUAL_FOLLOW_UP = 'manual-follow-up';
export function manualFollowUps(run: Pick<TaskRun, 'requirements' | 'evidence'>): Requirement[] {
    return run.requirements.filter(requirement => requirement.status === 'verified' && [...run.evidence].reverse().find(e => e.requirementId === requirement.id)?.provenance === MANUAL_FOLLOW_UP);
}
export function renderRun(run: TaskRun): string {
    const manual = new Set(manualFollowUps(run).map(requirement => requirement.id));
    const head = run.publication?.head ?? run.implementation?.head, base = run.publication?.base;
    const covered = run.requirements.filter(r => [...run.evidence].reverse().find(e => e.requirementId === r.id && e.commit === head && (!e.base || !base || e.base === base))?.success).length;
    const elapsed = Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt));
    const verified = run.state === 'complete' && !!run.publication && covered === run.requirements.length && run.requirements.length > 0 && !run.dependencies.length && run.actions.every(a => a.status === 'verified');
    return `# ${run.ticket.title}\n\nState: **${run.state}** · Phase: ${run.phase}\nSource: ${run.source.provider}/${run.source.namespace}/${run.source.id}\n${run.publication ? `PR: ${run.publication.url} (${run.publication.draft ? 'draft' : 'review-ready'})\n` : ''}Verified completion: ${verified ? 'yes' : 'no'}; current-commit evidence: ${covered - manual.size}/${run.requirements.length - manual.size}${manual.size ? `; needs manual verification: ${manual.size}` : ''}; elapsed: ${Math.round(elapsed / 1000)}s.\nReview repairs: ${run.reviewSummary?.repairs ?? 0}; setup/CI attempts: ${run.retries.filter(r => r.kind !== 'code').reduce((sum, r) => sum + r.attempts, 0)}.\n${run.attempts?.length ? `Failed attempts: ${run.attempts.length}; last: ${run.attempts.at(-1)!.phase} — ${run.attempts.at(-1)!.reason.slice(0, 300)}. Journal: attempts.md\n` : ''}\n${run.requirements.map(r => manual.has(r.id) ? `- [ ] ${r.text} (${r.id}; ${r.stage}) — needs manual verification; not verified by Iteris and not blocking` : `- [${r.status === 'verified' ? 'x' : ' '}] ${r.text} (${r.id}; ${r.stage})`).join('\n')}\n\n${run.dependencies.map(d => `- ${d.kind}: ${d.description}\n  Next action: ${d.nextAction}; last probe: ${d.lastProbe ?? 'not yet probed'}; retry: ${d.nextRetryAt}`).join('\n')}\n\n${run.evidence.map(e => `- ${e.provenance === MANUAL_FOLLOW_UP ? 'Manual verification needed' : e.success ? 'Verified' : 'Pending/failed'} ${e.requirementId}: ${e.provenance}, commit ${e.commit}, observed ${e.observedAt}`).join('\n')}\n`;
}
/**
 * Ticket lines that ask for nothing: a bare label ("Acceptance criteria:"), and the task-file instructions Iteris
 * itself appends for the instance. As requirements they are noise, and the second puts a local path in the pull request.
 */
export const notRequirement = (line: string) => /^(?:[-*>]\s*)*[^.!?:]{1,80}:$/.test(line.trim()) || /^(?:[-*>]\s*)*(?:Task file: |Resolve attachment paths relative to this task file\.)/.test(line.trim());
const HOST_GATES: Record<string, string> = { 'local-checks': 'Local checks pass on the final commit', 'independent-review': 'Independent review covers the final commit', 'publication': 'Pull request is published', 'required-ci': 'Required CI checks pass' };
/**
 * What a person reading the pull request needs: where the task stands, what still waits, and what they must
 * verify themselves. Identifiers, the evidence log and the attempt history stay in the local status.md.
 */
export function renderPrCompletion(run: TaskRun): string {
    const item = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/^(?:[-*>]\s*)+/, '').replace(/[<>]/g, '').trim();
    // A follow-up reads "requirement — the reviewer's evidence"; the evidence is in the review, the requirement is what to check.
    const brief = (text: string) => { const head = text.split(' — ')[0]!; return head.length > 240 ? `${head.slice(0, 237)}…` : head; };
    // Runs recorded before such lines were left out of the requirements still carry them.
    const manualIds = new Set(manualFollowUps(run).map(requirement => requirement.id)), manual = manualFollowUps(run).filter(requirement => !notRequirement(requirement.text));
    const gates = run.requirements.filter(requirement => requirement.id in HOST_GATES);
    const others = run.requirements.filter(requirement => !(requirement.id in HOST_GATES) && !manualIds.has(requirement.id) && !notRequirement(requirement.text));
    const pending = [...gates, ...others].filter(requirement => requirement.status !== 'verified');
    const commit = (run.publication?.head ?? run.implementation?.head)?.slice(0, 9);
    // No checklist: a row of boxes reads as unfinished work, and once the task is complete there is nothing left to tick.
    const headline = run.state === 'complete' ? `**Complete.** Local checks, independent review and required CI passed on commit \`${commit}\`.${manual.length ? ` ${manual.length === 1 ? 'One point' : `${manual.length} points`} below still ${manual.length === 1 ? 'needs' : 'need'} a person to confirm.` : ''}`
        : run.state === 'cancelled' ? '**Cancelled.**'
        : `**In progress.** ${run.state === 'blocked' ? 'Iteris has stopped working on this task' : 'Iteris is still working on this task'}${run.reason ? `: ${item(run.reason).slice(0, 300)}` : '.'}`;
    const outstanding = run.state === 'complete' || run.state === 'cancelled' ? [] : [...gates.filter(requirement => requirement.status !== 'verified').map(requirement => HOST_GATES[requirement.id]!), ...(others.some(requirement => requirement.status !== 'verified') ? [`${others.filter(requirement => requirement.status !== 'verified').length} of ${others.length} ticket requirements`] : [])];
    const count = (value: number) => value.toLocaleString('en-US'), size = run.changeSize;
    const sizeLine = size ? `Change size: +${count(size.other.added)} −${count(size.other.deleted)} in ${count(size.other.files)} non-test file${size.other.files === 1 ? '' : 's'}; tests +${count(size.tests.added)} −${count(size.tests.deleted)} in ${count(size.tests.files)} file${size.tests.files === 1 ? '' : 's'}${size.tests.newFiles ? ` (${count(size.tests.newFiles)} new)` : ''}.` : '';
    return [
        headline,
        ...(sizeLine ? ['', sizeLine] : []),
        ...(outstanding.length ? ['', `Not yet verified on commit \`${commit}\`: ${outstanding.join('; ')}.`] : []),
        ...(manual.length ? ['', '**Please verify by hand** (Iteris cannot observe these, so they do not hold the task):', '', ...manual.map(requirement => `- ${brief(item(requirement.text))}`)] : []),
        ...(run.dependencies.length ? ['', '**Waiting on:**', '', ...run.dependencies.map(dependency => `- ${item(dependency.description).slice(0, 500)} Next: ${item(dependency.nextAction).slice(0, 300)}`)] : []),
        ...(others.length ? ['', '<details>', `<summary>Ticket requirements reviewed (${others.length})</summary>`, '', ...others.map(requirement => `- ${item(requirement.text)}${pending.includes(requirement) && run.state !== 'complete' ? ' _(not yet verified)_' : ''}`), '', '</details>'] : []),
    ].join('\n');
}
