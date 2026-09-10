import type {ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import type {IterisConfig, Ticket} from '../types.js';
import {runHarness, type ProcessResult} from '../harness/process.js';


function loadPromptTemplate(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const templatePath = resolve(currentDir, '../github/commands/code-review.md');
	return readFileSync(templatePath, 'utf-8');
}

type ReviewOptions = {
	ticket: Ticket;
	config: IterisConfig;
	cwd: string;
	folder: string;
	onLogLine: (line: string) => void;
	onProcess: (proc: ChildProcess) => void;
	signal?: AbortSignal;
};

export async function runCodeReview({
	ticket,
	config,
	cwd,
	onLogLine,
	onProcess,
	signal,
}: ReviewOptions): Promise<ProcessResult> {
	const template = loadPromptTemplate();

	const prompt = template
		.replace(/\$TICKET_NUMBER/g, String(ticket.number))
		.replace(/\$TICKET_TITLE/g, ticket.title)
		.replace(/\$BASE_BRANCH/g, config.baseBranch);

	const result = await runHarness({config, phase: 'review', prompt, cwd, timeoutMs: config.timeout * 1000, onProcess, signal,
		onLine(line) {onLogLine(`[review] ${line}`);},
	});
	return result;
}
