import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ticketBranch, type IterisConfig, type Ticket} from '../types.js';
import {reviewSettings, type ReviewStamp, type Candidate} from './schema.js';
import {runCommand} from './command.js';
import {resolveTaskConfig} from '../lifecycle/config.js';
import {extractRequirements,applicableChecks} from '../lifecycle/requirements.js';
import {sourceIdentity} from '../lifecycle/state.js';

export const REVIEW_VERSION = 4;
export const INLINE_DIFF_LIMIT = 240_000;
const DIFF_PART_SIZE = 60_000;
const DIFF_DIRECTORY = '.iteris-review-diff';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function reviewDiffParts(diff: string): Array<{path: string; content: string; sha256: string}> {
	if (diff.length <= INLINE_DIFF_LIMIT) return [];
	const parts: Array<{path: string; content: string; sha256: string}> = [];
	for (let start = 0; start < diff.length;) {
		let end = Math.min(start + DIFF_PART_SIZE, diff.length);
		// Keep UTF-16 surrogate pairs together so writing and reading preserves the exact diff.
		if (end < diff.length && /[\uD800-\uDBFF]/.test(diff[end - 1]!)) end--;
		const content = diff.slice(start, end);
		parts.push({path: `${DIFF_DIRECTORY}/part-${String(parts.length + 1).padStart(4, '0')}.patch`, content,
			sha256: createHash('sha256').update(content).digest('hex')});
		start = end;
	}
	return parts;
}
export function reviewerContext(context: ReviewContext): ReviewContext & {diffParts?: Array<{path: string; characters: number; sha256: string}>; diffSha256?: string} {
	const parts = reviewDiffParts(context.diff);
	if (!parts.length) return context;
	return {...context, diff: 'Complete diff is stored in the snapshot files listed in diffParts. Read every part in order; no content was omitted.',
		diffParts: parts.map(part => ({path: part.path, characters: part.content.length, sha256: part.sha256})),
		diffSha256: createHash('sha256').update(context.diff).digest('hex')};
}
export function writerContext(context: ReviewContext): ReviewContext {
	if (context.diff.length <= INLINE_DIFF_LIMIT) return context;
	return {...context, diff: `Complete diff is available in this Git checkout. Run git diff --no-ext-diff --no-textconv --no-color --no-renames --unified=5 ${context.stamp.mergeBase} ${context.stamp.head} to inspect it; no content was omitted from the checkout.`};
}
export function git(cwd: string, args: string[], input?: string): string {
	return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 8 * 1024 * 1024});
}
export function assertClean(cwd: string): void {
	// Only untracked Iteris-owned state is exempt. Tracked modifications always invalidate review.
	const changes = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
	const unexpected = changes.filter(entry => !(entry.startsWith('?? ') && /^(\.iteris\/|\.tasks\/|\.iteris\.json(?:\.|$))/.test(entry.slice(3))));
	if (unexpected.length) throw new Error('Working tree has uncommitted changes. Preserve and commit or resolve them before review.');
}
export type ChangeSize = {other: {files: number; added: number; deleted: number}; tests: {files: number; added: number; deleted: number; newFiles: number}};
export type ReviewContext = {stamp: ReviewStamp; ticket: Ticket; plan: string; policy: string; checks: string[]; checkIds:string[]; changedFiles: string[]; diff: string; risk: string[]; requirements:ReturnType<typeof extractRequirements>; size?: ChangeSize};
const TEST_FILE = /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|fixtures)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/i;
/** How the diff splits between tests and everything else (code, resources, documents), so that its proportions can be judged and shown. */
export function changeSize(cwd: string, mergeBase: string, head: string): ChangeSize {
	const size: ChangeSize = {other: {files: 0, added: 0, deleted: 0}, tests: {files: 0, added: 0, deleted: 0, newFiles: 0}};
	const added = new Set(git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', mergeBase, head]).split('\0').filter(Boolean));
	for (const entry of git(cwd, ['diff', '--numstat', '-z', '--no-renames', mergeBase, head]).split('\0').filter(Boolean)) {
		const [insertions, deletions, ...name] = entry.split('\t'), file = name.join('\t');
		const test = TEST_FILE.test(file), group = test ? size.tests : size.other;
		group.files++; group.added += Number(insertions) || 0; group.deleted += Number(deletions) || 0;
		if (test && added.has(file)) size.tests.newFiles++;
	}
	return size;
}
function resolveBase(config: IterisConfig, cwd: string): string {
	for (const ref of [`refs/remotes/origin/${config.baseBranch}`, `refs/heads/${config.baseBranch}`]) {
		try {return git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();} catch { /* try local */ }
	}
	return '';
}
/** Policy and context files as committed on the base; a branch cannot rewrite its own review rules. */
function trustedPolicy(config: IterisConfig, cwd: string, base: string): string {
	let policy = '';
	for (const file of [...new Set([...config.verification.policyFiles,...config.verification.contextFiles])]) {
		if (file.includes('..') || path.isAbsolute(file)) throw new Error('Trusted context files must be repository-relative');
		const policyExists = git(cwd, ['ls-tree', base, '--', file]).trim();
		if (policyExists) {
			if (!policyExists.startsWith('100644 ') && !policyExists.startsWith('100755 ')) throw new Error(`${file} must be a regular tracked file on the base.`);
			policy += `\n## ${file}\n${git(cwd, ['show', `${base}:${file}`])}`;
		}
	}
	const limit = config.verification.maxContextCharacters;
	if (policy.length > limit) throw new Error(`Trusted review context is too large (${limit.toLocaleString('en-US')} characters maximum; the configured policy/context files total ${policy.length.toLocaleString('en-US')}). Set verification.maxContextCharacters in .iteris.json to accommodate the configured policy/context files.`);
	return policy;
}
/**
 * Fail before any instance runs when the trusted context cannot be supplied to
 * reviewers. Otherwise the limit is only met after a full implementation, on every attempt.
 */
export function assertContextBudget(config: IterisConfig, cwd: string): void {
	const base = resolveBase(config, cwd);
	if (base) trustedPolicy(config, cwd, base);
}
export function captureContext(ticket: Ticket, config: IterisConfig, cwd: string, plan = '', branch = ticketBranch(ticket)): ReviewContext {
	assertClean(cwd);
	const current = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
	if (current !== branch) throw new Error(`Expected branch ${branch}; found ${current}.`);
	const head = git(cwd, ['rev-parse', 'HEAD']).trim();
	// One attempt reviews against one base. Tasks in parallel worktrees share the remote-tracking refs,
	// so another task's fetch must not change this task's base in the middle of its review.
	const base = config._base || resolveBase(config, cwd);
	if (!base) throw new Error(`Cannot resolve review base ${config.baseBranch}.`);
	const mergeBase = git(cwd, ['merge-base', base, head]).trim();
	const changedFiles = git(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head]).split('\0').filter(Boolean);
	if (!changedFiles.length) throw new Error('No committed changes to review against the configured base.');
	const diff = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=5', mergeBase, head]);
	Object.assign(config,resolveTaskConfig(config,ticket,changedFiles));
	const policy = trustedPolicy(config, cwd, base);
	// Policy and context files are host inputs read from the base. A planned command that names one the
	// base does not have can only pass if the task creates that file, so it is not a project check.
	const absent = [...new Set([...config.verification.policyFiles,...config.verification.contextFiles])].filter(file => !git(cwd, ['ls-tree', base, '--', file]).trim());
	const planned = (config._plannedChecks ?? []).filter(command => config.qualityChecks.includes(command) || !absent.some(file => command.includes(file)));
	// Follow-ups a review recorded are its results. As inputs they would change the scope of the
	// very review that produced them, and a passed review could never be reused while CI runs.
	const requirements = (config._requirements ?? extractRequirements(ticket, config)).filter(requirement => !requirement.id.startsWith('dependency:'));
	const risk = changedFiles.filter(file => /auth|credential|secret|token|migrat|schema|harness|process|permission|concurr|(^|\/)types\./i.test(file));
	// The same task has one identity whether it arrives from the queue or from a saved run.
	const source = sourceIdentity(ticket, config);
	const scope = digest({version: REVIEW_VERSION + 1, base, branch, ticket:{number:ticket.number,title:ticket.title,body:ticket.body,labels:ticket.labels,source,custom:ticket.custom?.fingerprint}, plan, policy, checks: [...config.qualityChecks,...planned], requirements:requirements.map(r=>({id:r.id,text:r.text,stage:r.stage,method:r.method})), verification:config.verification, environment:config._execution?.identity, review: reviewSettings(config.review), harness: config.harness, settings: config.harnesses[config.harness], repo: config.repo, provider: source.provider});
	const key = digest({scope, head, mergeBase});
	return {stamp: {head, base, mergeBase, branch, scope, key}, ticket, plan, policy, checks: [...new Set([...config.qualityChecks,...planned])], checkIds:applicableChecks(config,changedFiles).map(c=>c.id), changedFiles, diff, risk, requirements, size: changeSize(cwd, mergeBase, head)};
}
export function assertSnapshot(context: ReviewContext, config: IterisConfig, cwd: string): void {
	const current = captureContext(context.ticket, config, cwd, context.plan, context.stamp.branch);
	if (current.stamp.key !== context.stamp.key) throw new Error('Review snapshot changed; review and checks must run again on the current commit and policy.');
}

export function suggestChecks(cwd: string, head: string): string[] {
	try {
		const manifest = JSON.parse(git(cwd, ['show', `${head}:package.json`])) as {scripts?: Record<string, unknown>};
		return ['typecheck', 'lint', 'test'].filter(name => typeof manifest.scripts?.[name] === 'string').map(name => `npm run ${name}`);
	} catch {return [];}
}

/** A detached disposable checkout with no remote or Git metadata for reviewers to publish through. */
export async function createSnapshot(cwd: string, head: string, deadline: number, signal?: AbortSignal, diff = ''): Promise<{cwd: string; dispose: () => Promise<void>}> {
	const root = await mkdtemp(path.join(tmpdir(), 'iteris-review-'));
	const snapshot = path.join(root, 'source');
	const dispose = () => rm(root, {recursive: true, force: true});
	try {
		for (const [directory, args] of [
			[cwd, ['clone', '--quiet', '--shared', '--no-checkout', '--template=', '--', cwd, snapshot]],
			[snapshot, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', head]],
		] as const) {
			const result = await runCommand('git', [...args], {cwd: directory, deadline, signal});
			if (result.exitCode !== 0 || result.error) throw new Error(result.error ?? `Could not create review snapshot: ${result.output}`);
		}
		await rm(path.join(snapshot, '.git'), {recursive: true, force: true});
		const parts = reviewDiffParts(diff);
		if (parts.length) {
			await mkdir(path.join(snapshot, DIFF_DIRECTORY));
			for (const part of parts) await writeFile(path.join(snapshot, part.path), part.content, {mode: 0o400});
		}
		return {cwd: snapshot, dispose};
	} catch (error) {await dispose(); throw error;}
}

export function validateLocation(candidate: Candidate, context: ReviewContext, cwd: string): void {
	if (!context.changedFiles.includes(candidate.file)) throw new Error(`Finding is outside the reviewed diff: ${candidate.file}`);
	const revision = candidate.side === 'new' ? context.stamp.head : context.stamp.mergeBase;
	const content = git(cwd, ['show', `${revision}:${candidate.file}`]);
	if (candidate.line > content.split('\n').length) throw new Error(`Invalid finding line: ${candidate.file}:${candidate.line}`);
	if (candidate.category === 'policy' && (!candidate.policyRule || !context.policy.includes(candidate.policyRule))) throw new Error('Policy finding must cite an exact rule from base REVIEW.md.');
}

export async function publishReviewed(context: ReviewContext, config: IterisConfig, cwd: string, signal?: AbortSignal, allowBaseDrift = false): Promise<boolean> {
	assertSnapshot(context, config, cwd);
	const deadline = Date.now() + 120_000;
	const pushed = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `${context.stamp.head}:refs/heads/${context.stamp.branch}`], {cwd, deadline, signal});
	if (pushed.exitCode !== 0 || pushed.error) throw new Error(pushed.error ?? `Push failed: ${pushed.output}`);
	return assertPublished(context, config, cwd, signal, allowBaseDrift);
}
/** Whether head merges into the remote base without conflicts. Leaves the local tracking refs untouched so the review snapshot stays valid. */
async function mergesCleanly(cwd: string, baseBranch: string, remoteBase: string, head: string, signal?: AbortSignal): Promise<boolean> {
	const probe = `refs/iteris/base-probe/${head}`;
	const run = (args: string[]) => runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd, deadline: Date.now() + 120_000, signal});
	try {
		const fetched = await run(['fetch', '--quiet', '--refmap=', 'origin', `+refs/heads/${baseBranch}:${probe}`]);
		if (fetched.exitCode !== 0 || fetched.error || git(cwd, ['rev-parse', '--verify', probe]).trim() !== remoteBase) return false;
		const merged = await run(['merge-tree', '--write-tree', remoteBase, head]);
		return merged.exitCode === 0 && !merged.error;
	} catch {return false;} finally {
		try {git(cwd, ['update-ref', '-d', probe]);} catch { /* never created */ }
	}
}
export async function assertPublished(context: ReviewContext, config: IterisConfig, cwd: string, signal?: AbortSignal, allowBaseDrift = false): Promise<boolean> {
	assertSnapshot(context, config, cwd);
	const remote = await runCommand('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${context.stamp.branch}`, `refs/heads/${config.baseBranch}`], {cwd, deadline: Date.now() + 30_000, signal});
	const refs = new Map(remote.output.trim().split('\n').map(line => {const [sha, ref] = line.split(/\s+/); return [ref, sha];}));
	if (remote.error || remote.exitCode !== 0 || refs.get(`refs/heads/${context.stamp.branch}`) !== context.stamp.head) throw new Error('Remote branch does not match the reviewed commit.');
	const remoteBase = refs.get(`refs/heads/${config.baseBranch}`);
	if (!remoteBase) throw new Error('Remote base branch is missing.');
	const baseChanged = remoteBase !== context.stamp.base;
	if (baseChanged && !allowBaseDrift) {
		// On an active repository the base moves during every review. The reviewed commit stays valid
		// while it still merges cleanly; hosted CI then runs against the merge. Only a conflict needs a new attempt.
		if (!await mergesCleanly(cwd, config.baseBranch, remoteBase, context.stamp.head, signal)) throw new Error('Remote base changed and conflicts with the reviewed commit. Fetch the base and rerun review before opening the PR.');
		assertSnapshot(context, config, cwd);
		return false;
	}
	assertSnapshot(context, config, cwd);
	return baseChanged;
}

export async function savedPlan(folder: string): Promise<string> {
	try {
		const content = await readFile(path.join(folder, 'plan.md'), 'utf8');
		// The runner appends one newline when saving the generated plan.
		return content.endsWith('\n') ? content.slice(0, -1) : content;
	} catch {return '';}
}
