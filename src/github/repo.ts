import {execSync} from 'node:child_process';

export function detectRepoFromRemote(): string | undefined {
	try {
		const url = execSync('git remote get-url origin', {
			encoding: 'utf8',
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
