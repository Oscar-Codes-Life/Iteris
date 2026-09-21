import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ticketBranch, type IterisConfig, type Ticket} from '../types.js';
import {reviewSettings, type ReviewStamp, type Candidate} from './schema.js';
import {runCommand} from './command.js';

export const REVIEW_VERSION = 2;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function git(cwd: string, args: string[]): string {
	return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 8 * 1024 * 1024});
}
export function assertClean(cwd: string): void {
	// Only untracked Iteris-owned state is exempt. Tracked modifications always invalidate review.
	const changes = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
	const unexpected = changes.filter(entry => !(entry.startsWith('?? ') && /^(\.iteris\/|\.tasks\/|\.iteris\.json(?:\.|$))/.test(entry.slice(3))));
	if (unexpected.length) throw new Error('Working tree has uncommitted changes. Preserve and commit or resolve them before review.');
}
export type ReviewContext = {stamp: ReviewStamp; ticket: Ticket; plan: string; policy: string; checks: string[]; changedFiles: string[]; diff: string; risk: string[]};
export function captureContext(ticket: Ticket, config: IterisConfig, cwd: string, plan = '', branch = ticketBranch(ticket)): ReviewContext {
	assertClean(cwd);
	const current = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
	if (current !== branch) throw new Error(`Expected branch ${branch}; found ${current}.`);
	const head = git(cwd, ['rev-parse', 'HEAD']).trim();
	let base = '';
	for (const ref of [`refs/remotes/origin/${config.baseBranch}`, `refs/heads/${config.baseBranch}`]) {
		try {base = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(); break;} catch { /* try local */ }
	}
	if (!base) throw new Error(`Cannot resolve review base ${config.baseBranch}.`);
	const mergeBase = git(cwd, ['merge-base', base, head]).trim();
	const changedFiles = git(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head]).split('\0').filter(Boolean);
	if (!changedFiles.length) throw new Error('No committed changes to review against the configured base.');
	const diff = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=5', mergeBase, head]);
	if (diff.length > 240_000) throw new Error('Review diff exceeds 240,000 characters. Split this change before review; no content was silently omitted.');
	let policy = '';
	const policyExists = git(cwd, ['ls-tree', base, '--', 'REVIEW.md']).trim();
	if (policyExists) {
		if (!policyExists.startsWith('100644 ') && !policyExists.startsWith('100755 ')) throw new Error('REVIEW.md must be a regular tracked file on the base.');
		policy = git(cwd, ['show', `${base}:REVIEW.md`]);
	}
	if (policy.length > 40_000) throw new Error('REVIEW.md is too large (40,000 characters maximum).');
	const risk = changedFiles.filter(file => /auth|credential|secret|token|migrat|schema|harness|process|permission|concurr|(^|\/)types\./i.test(file));
	const scope = digest({version: REVIEW_VERSION, base, branch, ticket, policy, checks: config.qualityChecks, review: reviewSettings(config.review), harness: config.harness, settings: config.harnesses[config.harness], repo: config.repo, provider: config.provider});
	const key = digest({scope, head, mergeBase});
	return {stamp: {head, base, mergeBase, branch, scope, key}, ticket, plan, policy, checks: config.qualityChecks, changedFiles, diff, risk};
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
export async function createSnapshot(cwd: string, head: string, deadline: number, signal?: AbortSignal): Promise<{cwd: string; dispose: () => Promise<void>}> {
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

export async function publishReviewed(context: ReviewContext, config: IterisConfig, cwd: string, signal?: AbortSignal): Promise<void> {
	assertSnapshot(context, config, cwd);
	const deadline = Date.now() + 120_000;
	const pushed = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `${context.stamp.head}:refs/heads/${context.stamp.branch}`], {cwd, deadline, signal});
	if (pushed.exitCode !== 0 || pushed.error) throw new Error(pushed.error ?? `Push failed: ${pushed.output}`);
	await assertPublished(context, config, cwd, signal);
}
export async function assertPublished(context: ReviewContext, config: IterisConfig, cwd: string, signal?: AbortSignal): Promise<void> {
	assertSnapshot(context, config, cwd);
	const remote = await runCommand('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${context.stamp.branch}`, `refs/heads/${config.baseBranch}`], {cwd, deadline: Date.now() + 30_000, signal});
	const refs = new Map(remote.output.trim().split('\n').map(line => {const [sha, ref] = line.split(/\s+/); return [ref, sha];}));
	if (remote.error || remote.exitCode !== 0 || refs.get(`refs/heads/${context.stamp.branch}`) !== context.stamp.head) throw new Error('Remote branch does not match the reviewed commit.');
	if (refs.get(`refs/heads/${config.baseBranch}`) !== context.stamp.base) throw new Error('Remote base changed. Fetch the base and rerun review before opening the PR.');
	assertSnapshot(context, config, cwd);
}

export async function savedPlan(folder: string): Promise<string> {
	try {return await readFile(path.join(folder, 'plan.md'), 'utf8');} catch {return '';}
}
