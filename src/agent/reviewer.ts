import {spawn, type ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import type {IterisConfig, Ticket} from '../types.js';
import {buildClaudeArgs} from '../config.js';
import {OutputWatcher} from './watcher.js';
import {appendLog} from '../state/manager.js';

const REVIEW_TIMEOUT = 300_000;

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
};

export async function runCodeReview({
	ticket,
	config,
	cwd,
	folder,
	onLogLine,
	onProcess,
}: ReviewOptions): Promise<boolean> {
	const template = loadPromptTemplate();

	const ticketRef = config.provider === 'trello'
		? `Implements Trello card: ${ticket.htmlUrl}`
		: `Closes #${ticket.number}`;

	const prDraftFlag = config.pr.draft ? ' --draft' : '';

	const prompt = template
		.replace(/\$TICKET_NUMBER/g, String(ticket.number))
		.replace(/\$TICKET_TITLE/g, ticket.title)
		.replace(/\$BASE_BRANCH/g, config.baseBranch)
		.replace(/\$TICKET_REF/g, ticketRef);

	// Append draft flag instruction if needed
	const fullPrompt = prDraftFlag
		? prompt.replace(
			'Create a pull request targeting',
			`Create a pull request${prDraftFlag} targeting`,
		)
		: prompt;

	return new Promise<boolean>(resolve => {
		const proc = spawn('claude', buildClaudeArgs(config), {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd,
		});

		onProcess(proc);

		const watcher = new OutputWatcher(proc.stdout!);
		const stderrWatcher = new OutputWatcher(proc.stderr!);

		const timeoutId = setTimeout(() => {
			proc.kill('SIGTERM');
		}, REVIEW_TIMEOUT);

		watcher.on('line', (line: string) => {
			onLogLine(`[review] ${line}`);
			void appendLog(folder, `[review] ${line}\n`);
		});

		stderrWatcher.on('line', (line: string) => {
			void appendLog(folder, `[review][stderr] ${line}\n`);
		});

		watcher.on('done', () => {
			setTimeout(() => {
				if (!proc.killed) {
					proc.kill('SIGTERM');
				}
			}, 3000);
		});

		proc.on('exit', () => {
			clearTimeout(timeoutId);
			resolve(watcher.isDone);
		});

		proc.on('error', () => {
			clearTimeout(timeoutId);
			resolve(false);
		});

		proc.stdin!.write(fullPrompt);
		proc.stdin!.end();
	});
}
