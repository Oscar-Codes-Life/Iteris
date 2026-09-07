import {registerSecret} from '../harness/redact.js';
import {execFileSync} from 'node:child_process';
import {command, findExecutable} from '../harness/readiness.js';

export function resolveGithubToken(): string | undefined {
	const envToken = process.env['GH_TOKEN'] || process.env['GITHUB_TOKEN'];
	if (envToken) {registerSecret(envToken); return envToken;}
	try {
		const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
			encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
		}).trim() || undefined;
		registerSecret(token);
		return token;
	} catch {return undefined;}
}
export async function ensureGithubAuth(): Promise<void> {
	if (!await findExecutable('gh')) throw new Error('GitHub CLI (gh) is required to create PRs. Install gh, then retry.');
	if (!resolveGithubToken()) {
		const result = await command('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--scopes', 'read:project'], true);
		if (result.code !== 0 || !resolveGithubToken()) throw new Error('GitHub login did not complete.');
	}
	const result = await command('gh', ['api', 'user', '--silent']);
	if (result.code !== 0) throw new Error('GitHub authentication failed. Check GH_TOKEN/GITHUB_TOKEN or run gh auth login.');
}
