import {spawn, type ChildProcess} from 'node:child_process';
import type {IterisConfig, Ticket, TicketState} from '../types.js';
import {buildClaudeArgs} from '../config.js';
import {createRunFolder, writeStatus, writePrompt, appendLog} from '../state/manager.js';
import {readProgress, appendProgress} from '../state/progress.js';
import {findPrForBranch, addLabelToIssue} from '../github/pr.js';
import {moveCardOnComplete} from '../trello/completion.js';
import {expandPrompt} from './prompt.js';
import {OutputWatcher} from './watcher.js';
import {generateSummary} from './summarizer.js';
import {runCodeReview} from './reviewer.js';

export type RunnerCallbacks = {
	onStatusChange: (ticketNumber: number, state: TicketState) => void;
	onLogLine: (ticketNumber: number, line: string) => void;
	onComplete: (ticketNumber: number, state: TicketState) => void;
	onFailure: (ticketNumber: number, state: TicketState) => Promise<'retry' | 'skip'>;
};

let activeProcess: ChildProcess | null = null;

function setupSignalHandlers(getCurrentState: () => {ticket: Ticket; folder: string; state: TicketState} | undefined): void {
	const cleanup = async () => {
		if (activeProcess) {
			activeProcess.kill('SIGTERM');
			activeProcess = null;
		}

		const current = getCurrentState();
		if (current) {
			const staleState: TicketState = {
				...current.state,
				status: 'stale',
				finishedAt: new Date(),
			};

			await writeStatus(current.folder, staleState);
		}

		process.exit(0);
	};

	process.on('SIGINT', () => {
		void cleanup();
	});

	process.on('SIGTERM', () => {
		void cleanup();
	});
}

async function runSingleTicket(
	ticket: Ticket,
	config: IterisConfig,
	cwd: string,
	callbacks: RunnerCallbacks,
): Promise<TicketState> {
	const branch = `iteris/${ticket.number}-${ticket.slug}`;
	const folder = await createRunFolder(cwd, ticket);

	const state: TicketState = {
		ticket,
		status: 'running',
		branch,
		logLines: [],
		elapsedMs: 0,
		startedAt: new Date(),
	};

	callbacks.onStatusChange(ticket.number, {...state});
	await writeStatus(folder, state);

	const progressContent = await readProgress(cwd);
	const prompt = expandPrompt(ticket, config, progressContent);
	await writePrompt(folder, prompt);

	return new Promise<TicketState>(resolve => {
		const proc = spawn('claude', buildClaudeArgs(config), {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd,
		});

		activeProcess = proc;

		const watcher = new OutputWatcher(proc.stdout!);
		const stderrWatcher = new OutputWatcher(proc.stderr!);

		const startTime = Date.now();

		const timeoutId = setTimeout(() => {
			proc.kill('SIGTERM');
		}, config.timeout * 1000);

		watcher.on('line', (line: string) => {
			state.logLines = [...watcher.lines];
			state.elapsedMs = Date.now() - startTime;
			callbacks.onLogLine(ticket.number, line);
			callbacks.onStatusChange(ticket.number, {...state});
			void appendLog(folder, line + '\n');
		});

		stderrWatcher.on('line', (line: string) => {
			void appendLog(folder, `[stderr] ${line}\n`);
		});

		watcher.on('done', () => {
			// Don't kill immediately — wait for process to exit naturally
			// Give it a few seconds to finish cleanly
			setTimeout(() => {
				if (activeProcess === proc) {
					proc.kill('SIGTERM');
				}
			}, 3000);
		});

		proc.on('exit', async (code) => {
			clearTimeout(timeoutId);
			activeProcess = null;
			state.elapsedMs = Date.now() - startTime;
			state.finishedAt = new Date();

			if (watcher.isDone) {
				// Transition to reviewing phase
				state.status = 'reviewing';
				callbacks.onStatusChange(ticket.number, {...state});
				await writeStatus(folder, state);

				const reviewSuccess = await runCodeReview({
					ticket,
					config,
					cwd,
					folder,
					onLogLine(line) {
						state.logLines = [...state.logLines.slice(-49), line];
						state.elapsedMs = Date.now() - startTime;
						callbacks.onLogLine(ticket.number, line);
						callbacks.onStatusChange(ticket.number, {...state});
					},
					onProcess(reviewProc) {
						activeProcess = reviewProc;
					},
				});

				activeProcess = null;
				state.elapsedMs = Date.now() - startTime;
				state.finishedAt = new Date();

				if (reviewSuccess) {
					state.status = 'done';

					// Check for PR
					try {
						const pr = await findPrForBranch(config, branch);
						if (pr) {
							state.prUrl = pr.url;
							state.prNumber = pr.number;

							if (config.pr.addLabelOnOpen) {
								await addLabelToIssue(config, ticket.number, config.pr.addLabelOnOpen);
							}
						}
					} catch {
						// PR lookup failed, not critical
					}

					if (config.provider === 'trello') {
						try {
							await moveCardOnComplete(config, ticket.number);
						} catch {
							// Card move failed, not critical
						}
					}

					await writeStatus(folder, state);
					await appendProgress(cwd, `#${ticket.number} (${ticket.title}) — completed successfully`);
					try {
						await generateSummary(folder);
					} catch {
						// Summary generation failed, not critical
					}

					callbacks.onComplete(ticket.number, {...state});
				} else {
					state.status = 'failed';
					await writeStatus(folder, state);
				}
			} else if (code !== 0 || state.elapsedMs >= config.timeout * 1000) {
				state.status = state.elapsedMs >= config.timeout * 1000 ? 'stale' : 'failed';
				await writeStatus(folder, state);
			} else {
				state.status = 'stale';
				await writeStatus(folder, state);
			}

			resolve({...state});
		});

		proc.stdin!.write(prompt);
		proc.stdin!.end();
	});
}

export async function runAllTickets(
	tickets: Ticket[],
	config: IterisConfig,
	cwd: string,
	callbacks: RunnerCallbacks,
): Promise<void> {
	let currentContext: {ticket: Ticket; folder: string; state: TicketState} | undefined;

	setupSignalHandlers(() => currentContext);

	for (const ticket of tickets) {
		const branch = `iteris/${ticket.number}-${ticket.slug}`;
		const folder = await createRunFolder(cwd, ticket);

		let result: TicketState | undefined;
		let shouldRetry = true;

		while (shouldRetry) {
			shouldRetry = false;

			const initialState: TicketState = {
				ticket,
				status: 'pending',
				branch,
				logLines: [],
				elapsedMs: 0,
			};

			currentContext = {ticket, folder, state: initialState};

			result = await runSingleTicket(ticket, config, cwd, callbacks);
			currentContext = undefined;

			if (result.status === 'failed' || result.status === 'stale') {
				const decision = await callbacks.onFailure(ticket.number, {...result});
				if (decision === 'retry') {
					shouldRetry = true;
				}

				// 'skip' → continue to next ticket
			}
		}
	}
}
