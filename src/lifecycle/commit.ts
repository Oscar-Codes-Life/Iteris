import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git, assertClean } from '../review/context.js';
import { runCommand } from '../review/command.js';
/** The host owns Git writes; workspace sandboxes can keep .git protected. */
export function prepareBranch(cwd: string, branch: string, base: string): void {
    assertClean(cwd);
    if (git(cwd, ['branch', '--show-current']).trim() === branch)
        return;
    let exists = false;
    try {
        git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
        exists = true;
    }
    catch { /* new branch */ }
    git(cwd, exists ? ['checkout', branch] : ['checkout', '-b', branch, base]);
}
export function commitSourceChanges(cwd: string, branch: string, message: string): void {
    if (git(cwd, ['branch', '--show-current']).trim() !== branch)
        throw new Error('Harness changed the task branch');
    const entries = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
    const hostPath = (file: string) => /^(?:\.iteris|\.tasks)(?:\/|$)|^\.iteris\.json(?:\.|$)/.test(file);
    const paths = new Set<string>();
    let sourceChanged = false;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const status = entry.slice(0, 2), file = entry.slice(3);
        // Porcelain -z puts a rename/copy destination first, then its original path.
        const original = /[RC]/.test(status) ? entries[++index] : undefined;
        if (hostPath(file) || (original !== undefined && hostPath(original))) {
            if (status !== '??')
                throw new Error('Harness modified host-owned configuration or lifecycle state');
            continue;
        }
        sourceChanged = true;
        // Index-only changes are already staged. In particular, a staged deletion
        // or rename's old path no longer exists in the index and must not be added.
        if (status === '??' || status[1] !== ' ') {
            paths.add(file);
            if (status[1] === 'R' && original !== undefined)
                paths.add(original);
        }
    }
    if (!sourceChanged)
        return;
    if (paths.size)
        git(cwd, ['--literal-pathspecs', 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], [...paths].join('\0') + '\0');
    git(cwd, ['commit', '-m', message]);
    assertClean(cwd);
}
/**
 * Preserve uncommitted work left by a stopped or crashed instance on the task
 * branch so the next fresh instance starts from it instead of a dirty tree.
 * Returns true when a checkpoint commit was created. Work on any other branch
 * is left untouched for the existing clean-tree checks to report.
 */
export function checkpointPartialWork(cwd: string, branch: string, message: string): boolean {
    // An instance stopped while resolving a base merge leaves conflict markers behind.
    // Committing them as work would publish a broken tree; the next attempt merges again.
    abortMerge(cwd);
    let current: string;
    try {
        current = git(cwd, ['branch', '--show-current']).trim();
    }
    catch {
        return false;
    }
    if (current !== branch)
        return false;
    const before = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
    commitSourceChanges(cwd, branch, message);
    return git(cwd, ['rev-parse', '--verify', 'HEAD']).trim() !== before;
}

export function mergeInProgress(cwd: string): boolean {
    try {
        git(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
        return true;
    }
    catch {
        return false;
    }
}
export function abortMerge(cwd: string): void {
    if (mergeInProgress(cwd))
        git(cwd, ['merge', '--abort']);
}
export type BaseIntegration = {
    /** current: already contains the base. conflicted: a merge is in progress and `files` need resolving. */
    status: 'current' | 'fast-forwarded' | 'merged' | 'conflicted';
    before: string;
    base: string;
    files: string[];
};
/**
 * Bring the task branch up to date with its base before work continues.
 *
 * A branch cut from a stale local base, or left behind while the base moved, conflicts with
 * its pull request target. GitHub runs no pull-request checks on a conflicting PR, so required
 * CI never reports and the task can never complete. The base is merged, never rebased: the
 * published branch only moves forward.
 */
export async function integrateBase(cwd: string, branch: string, baseBranch: string, signal?: AbortSignal): Promise<BaseIntegration> {
    assertClean(cwd);
    if (git(cwd, ['branch', '--show-current']).trim() !== branch)
        throw new Error('Harness changed the task branch');
    const run = (args: string[]) => runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, deadline: Date.now() + 180_000, signal });
    // Offline or without a remote, the last known base still applies.
    await run(['fetch', '--quiet', 'origin', baseBranch]);
    let base = '';
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
        try {
            base = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
            break;
        }
        catch { /* try the local branch */ }
    }
    const before = git(cwd, ['rev-parse', 'HEAD']).trim();
    const contains = (ancestor: string, descendant: string) => { try {
        git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
    }
    catch {
        return false;
    } };
    if (!base || contains(base, before))
        return { status: 'current', before, base, files: [] };
    if (contains(before, base)) {
        // No task commits yet: start from the current base instead of a stale one.
        const forwarded = await run(['merge', '--quiet', '--ff-only', base]);
        if (forwarded.exitCode !== 0 || forwarded.error)
            throw new Error(`Could not update ${branch} to ${baseBranch}: ${forwarded.error ?? forwarded.output}`);
        return { status: 'fast-forwarded', before, base, files: [] };
    }
    const merged = await run(['merge', '--quiet', '--no-ff', '-m', `Merge ${baseBranch} into ${branch}`, base]);
    if (merged.exitCode === 0 && !merged.error)
        return { status: 'merged', before, base, files: [] };
    const files = mergeInProgress(cwd) ? git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean) : [];
    if (!files.length) {
        abortMerge(cwd);
        throw new Error(`Could not merge ${baseBranch} into ${branch}: ${merged.error ?? merged.output}`);
    }
    return { status: 'conflicted', before, base, files };
}
/** Conflicted files that still contain conflict markers. */
export function unresolvedConflicts(cwd: string, files: string[]): string[] {
    return files.filter(file => { try {
        return /^(?:<{7}|>{7}) /m.test(readFileSync(path.join(cwd, file), 'utf8'));
    }
    catch {
        return false;
    } });
}
