import {execSync} from 'node:child_process';

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
