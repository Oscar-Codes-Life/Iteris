import { git, assertClean } from '../review/context.js';
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
