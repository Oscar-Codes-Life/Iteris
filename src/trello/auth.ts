import {execSync} from 'node:child_process';
import {appendFileSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
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

export function saveTrelloCredentials(credentials: TrelloCredentials): void {
	process.env['TRELLO_API_KEY'] = credentials.apiKey;
	process.env['TRELLO_TOKEN'] = credentials.token;

	const home = homedir();
	const rcFiles = ['.zshrc', '.bashrc'];
	let saved = false;

	for (const rc of rcFiles) {
		const rcPath = path.join(home, rc);
		if (existsSync(rcPath)) {
			const lines = [
				'',
				'# Trello credentials (added by Iteris)',
				`export TRELLO_API_KEY="${credentials.apiKey}"`,
				`export TRELLO_TOKEN="${credentials.token}"`,
			].join('\n');
			appendFileSync(rcPath, lines + '\n');
			saved = true;
			break;
		}
	}

	if (!saved) {
		// Fallback: create .zshrc
		const rcPath = path.join(home, '.zshrc');
		const lines = [
			'# Trello credentials (added by Iteris)',
			`export TRELLO_API_KEY="${credentials.apiKey}"`,
			`export TRELLO_TOKEN="${credentials.token}"`,
		].join('\n');
		appendFileSync(rcPath, lines + '\n');
	}
}
