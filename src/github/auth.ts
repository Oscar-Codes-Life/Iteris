import {execSync} from 'node:child_process';

export function resolveGithubToken(): string | undefined {
	const envToken = process.env['GITHUB_TOKEN'];
	if (envToken) return envToken;

	for (const shell of ['zsh', 'bash']) {
		try {
			const output = execSync(`${shell} -ilc 'echo $GITHUB_TOKEN'`, {
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			if (output) {
				process.env['GITHUB_TOKEN'] = output;
				return output;
			}
		} catch {
			// Shell not available, try next
		}
	}

	return undefined;
}
