import {spawn} from 'node:child_process';
import {readLog, writeSummary} from '../state/manager.js';

const SUMMARY_TIMEOUT = 60_000;
const MAX_LOG_CHARS = 80_000;

function truncateLog(log: string): string {
	if (log.length <= MAX_LOG_CHARS) return log;

	const half = Math.floor(MAX_LOG_CHARS / 2);
	return (
		log.slice(0, half) +
		'\n\n[... truncated middle section ...]\n\n' +
		log.slice(-half)
	);
}

const PROMPT = `You are summarizing the output of a Claude Code session that worked on a GitHub ticket. Write a concise summary in markdown covering:

- **Changes made**: What files were created, modified, or deleted
- **Commands run**: Key shell commands executed (builds, tests, git operations)
- **PR details**: If a pull request was created, its URL and description
- **Errors encountered**: Any failures or issues hit during the process

Keep it brief and factual. Use bullet points. Do not include the raw log.`;

export async function generateSummary(folder: string): Promise<string | null> {
	let log: string;
	try {
		log = await readLog(folder);
	} catch {
		return null;
	}

	const truncated = truncateLog(log);
	const input = `${PROMPT}\n\n---\n\nSession log:\n\n${truncated}`;

	return new Promise<string | null>(resolve => {
		const proc = spawn('claude', ['--print'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let output = '';
		const timeout = setTimeout(() => {
			proc.kill('SIGTERM');
			resolve(null);
		}, SUMMARY_TIMEOUT);

		proc.stdout!.on('data', (chunk: Buffer) => {
			output += chunk.toString();
		});

		proc.on('exit', async (code) => {
			clearTimeout(timeout);

			if (code !== 0 || !output.trim()) {
				resolve(null);
				return;
			}

			try {
				await writeSummary(folder, output.trim());
				resolve(output.trim());
			} catch {
				resolve(null);
			}
		});

		proc.on('error', () => {
			clearTimeout(timeout);
			resolve(null);
		});

		proc.stdin!.write(input);
		proc.stdin!.end();
	});
}
