import {execSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {homedir, userInfo} from 'node:os';
import path from 'node:path';

export type TrelloCredentials = {apiKey: string; token: string};

export function resolveTrelloCredentials(): TrelloCredentials | undefined {
	let apiKey = process.env['TRELLO_API_KEY'];
	let token = process.env['TRELLO_TOKEN'];

	if (apiKey && token) return {apiKey, token};

	for (const shell of ['zsh', 'bash']) {
		try {
			const output = execSync(`${shell} -ilc 'echo "$TRELLO_API_KEY|$TRELLO_TOKEN"'`, {
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			const [key, tok] = output.split('|');
			if (key && tok) {
				apiKey ??= key;
				token ??= tok;
				process.env['TRELLO_API_KEY'] = apiKey;
				process.env['TRELLO_TOKEN'] = token;
				return {apiKey, token};
			}
		} catch {
			// Shell not available, try next
		}
	}

	return undefined;
}

export function saveTrelloCredentials(credentials: TrelloCredentials, options: {home?: string; shell?: string; zdotdir?: string} = {}): string {
	const home = options.home ?? homedir();
	const shell = path.basename(options.shell ?? (process.env['SHELL'] || userInfo().shell || ''));
	if (shell !== 'bash' && shell !== 'zsh') {
		throw new Error('Unsupported shell. Set SHELL to your Bash or Zsh executable before saving Trello credentials.');
	}
	const zdotdir = options.zdotdir ?? process.env['ZDOTDIR'];
	const rcPath = path.join(shell === 'zsh' && zdotdir ? zdotdir : home, `.${shell}rc`);
	// Preserve credentials literally when the shell sources its profile.
	const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
	const lines = [
		'',
		'# Trello credentials (added by Iteris)',
		`export TRELLO_API_KEY=${quote(credentials.apiKey)}`,
		`export TRELLO_TOKEN=${quote(credentials.token)}`,
		'',
	].join('\n');
	appendFileSync(rcPath, lines, {mode: 0o600});
	process.env['TRELLO_API_KEY'] = credentials.apiKey;
	process.env['TRELLO_TOKEN'] = credentials.token;
	return rcPath;
}
