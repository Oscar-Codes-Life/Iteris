import path from 'node:path';
import {constants, copyFile, lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import {git} from '../review/context.js';
import {saveRun, type TaskRun} from './state.js';
import type {Harness, IterisConfig} from '../types.js';

const hostPath = (file: string) => /^(?:\.git|\.iteris|\.tasks)(?:\/|$)|^\.iteris\.json(?:\.|$)/.test(file);

async function safeParents(root: string, relative: string, create = false): Promise<void> {
	let current = root;
	for (const part of relative.split('/').slice(0, -1)) {
		if (!part || part === '..' || part === '.') throw new Error('Invalid relative path');
		current = path.join(current, part);
		if (create) await mkdir(current).catch(error => {if (error.code !== 'EEXIST') throw error;});
		const entry = await lstat(current);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Symlink or non-directory parent');
	}
}

/** Codex and Claude Code both use the root .worktreeinclude, in Git-ignore syntax. */
export async function copyWorktreeFiles(root: string, destination: string, harness: Harness, log: (line: string) => void = () => {}): Promise<{copied: number; skipped: number}> {
	const result = {copied: 0, skipped: 0};
	const manifest = path.join(root, '.worktreeinclude');
	let files: string[] = [];
	try {
		if ((await lstat(manifest)).isSymbolicLink()) throw new Error('Include file is a symlink');
		await readFile(manifest, 'utf8');
		const matches = git(root, ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z']).split('\0').filter(Boolean);
		const ignored = new Set(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0'));
		files = matches.filter(file => ignored.has(file));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`[worktree] Could not read .worktreeinclude; continuing with available files.`);
	}
	// Codex also carries ignored per-project instruction overrides.
	if (harness === 'codex') {
		try {if (git(root, ['check-ignore', 'AGENTS.override.md']).trim()) files.push('AGENTS.override.md');} catch { /* not ignored */ }
	}
	for (const file of new Set(files)) {
		if (hostPath(file) || path.isAbsolute(file) || file.split('/').includes('..')) continue;
		try {
			await safeParents(root, file);
			if (!(await lstat(path.join(root, file))).isFile()) {result.skipped++; continue;}
			await safeParents(destination, file, true);
			// Exclusive copy also refuses an existing destination symlink.
			await copyFile(path.join(root, file), path.join(destination, file), constants.COPYFILE_EXCL);
			result.copied++;
		} catch {result.skipped++; log(`[worktree] Skipped ${file}: unavailable or already present.`);}
	}
	log(`[worktree] Copied ${result.copied} local file${result.copied === 1 ? '' : 's'} for ${harness}${result.skipped ? `; ${result.skipped} skipped` : ''}.`);
	return result;
}

export async function prepareTaskWorkspace(root: string, run: TaskRun, config: IterisConfig, log: (line: string) => void = () => {}): Promise<string> {
	// A persisted checkout wins over a newly changed default, including on resume.
	if ((run.workspace?.mode ?? config.workspace.mode) === 'local') {
		run.workspace = {mode: 'local', path: root};
		await saveRun(root, run);
		return root;
	}
	const relative = `.iteris/worktrees/${run.key}`;
	await safeParents(root, relative, true);
	const destination = path.join(await realpath(root), relative);
	const existing = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').find(record => record.split('\0').includes(`worktree ${destination}`));
	if (existing) {
		if ((await lstat(destination)).isSymbolicLink() || !existing.split('\0').includes(`branch refs/heads/${run.branch}`)) throw new Error('Saved worktree no longer has the task branch; restore it before resuming.');
	} else {
		try {await lstat(destination); throw new Error(`Worktree directory already exists: ${destination}`);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
		let branchExists = false;
		try {git(root, ['rev-parse', '--verify', `refs/heads/${run.branch}`]); branchExists = true;} catch { /* new task */ }
		let base = `refs/heads/${config.baseBranch}`;
		try {git(root, ['rev-parse', '--verify', base]);} catch {base = `refs/remotes/origin/${config.baseBranch}`;}
		git(root, branchExists ? ['worktree', 'add', destination, run.branch] : ['worktree', 'add', '-b', run.branch, destination, base]);
	}
	const realRoot = await realpath(root);
	if (!await realpath(destination).then(value => value === path.join(realRoot, relative))) throw new Error('Worktree path escapes the project');
	run.workspace = {mode: 'worktree', path: destination};
	await saveRun(root, run);
	await copyWorktreeFiles(root, destination, config.harness, log);
	return destination;
}
