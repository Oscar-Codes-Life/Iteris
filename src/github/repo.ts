import {execSync, execFileSync} from 'node:child_process';

export function detectRepoFromRemote(cwd = process.cwd()): string | undefined {
	try {
		const url = execSync('git remote get-url origin', {
			encoding: 'utf8',
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();

		// SSH: git@github.com:owner/repo.git
		const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];

		// HTTPS: https://github.com/owner/repo.git
		const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
		if (httpsMatch) return httpsMatch[1];

		return undefined;
	} catch {
		return undefined;
	}
}

/** Read Git refs without a network request or changing the checkout. */
export function detectDefaultBranch(cwd = process.cwd()): string | undefined {
 try {
  return execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim().replace(/^origin\//, '');
 } catch { return undefined; }
}

export function validateBaseBranch(branch: string, cwd: string): void {
 const git = (args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
 try { git(['rev-parse', '--git-dir']); } catch { return; }
 for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
  try { git(['rev-parse', '--verify', `${ref}^{commit}`]); return; } catch { /* try the remote ref */ }
 }
 const detected = detectDefaultBranch(cwd);
 throw new Error(`Base branch "${branch}" does not exist locally or under origin. ${detected ? `Set baseBranch to "${detected}" in .iteris.json if you intend to target the remote default branch, or fetch the intended branch.` : 'Fetch the intended branch or correct baseBranch in .iteris.json.'}`);
}
