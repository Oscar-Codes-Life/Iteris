import type {ChildProcess} from 'node:child_process';
import type {IterisConfig} from '../types.js';
import {runHarness} from '../harness/process.js';
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

const PROMPT = `You are summarizing the output of an agent session that worked on a GitHub ticket. Write a concise summary in markdown covering:

- **Changes made**: What files were created, modified, or deleted
- **Commands run**: Key shell commands executed (builds, tests, git operations)
- **PR details**: If a pull request was created, its URL and description
- **Errors encountered**: Any failures or issues hit during the process

Keep it brief and factual. Use bullet points. Do not include the raw log.`;

export async function generateSummary(folder: string, config: IterisConfig, cwd: string, onProcess?: (proc: ChildProcess) => void, signal?: AbortSignal): Promise<string | null> {
	let log: string;
	try {
		log = await readLog(folder);
	} catch {
		return null;
	}

	const truncated = truncateLog(log);
	const input = `${PROMPT}\n\n---\n\nSession log:\n\n${truncated}`;

	const result = await runHarness({config, phase: 'summary', prompt: input, cwd, timeoutMs: SUMMARY_TIMEOUT, onProcess, signal});
	if (!result.success || !result.text) return null;
	await writeSummary(folder, result.text);
	return result.text;
}
