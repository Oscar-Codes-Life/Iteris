import {mkdir, writeFile, appendFile, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Ticket, TicketState, TicketStatus} from '../types.js';

function runFolder(cwd: string, ticket: Ticket): string {
	return path.join(cwd, '.iteris', 'runs', `${ticket.number}-${ticket.slug}`);
}

export async function createRunFolder(cwd: string, ticket: Ticket): Promise<string> {
	const folder = runFolder(cwd, ticket);
	await mkdir(folder, {recursive: true});
	return folder;
}

export async function writeStatus(folder: string, state: TicketState): Promise<void> {
	const lines = [
		`# Ticket #${state.ticket.number} — ${state.ticket.title}`,
		'',
		`**Status**: ${state.status}`,
		`**Branch**: ${state.branch}`,
	];

	if (state.prUrl) {
		lines.push(`**PR**: ${state.prUrl}`);
	}

	if (state.startedAt) {
		lines.push(`**Started**: ${state.startedAt.toISOString()}`);
	}

	if (state.finishedAt) {
		lines.push(`**Finished**: ${state.finishedAt.toISOString()}`);
	}

	lines.push('');
	await writeFile(path.join(folder, 'status.md'), lines.join('\n'));
}

export async function writePrompt(folder: string, prompt: string): Promise<void> {
	await writeFile(path.join(folder, 'prompt.md'), prompt);
}

export async function appendLog(folder: string, chunk: string): Promise<void> {
	await appendFile(path.join(folder, 'log.txt'), chunk);
}

export async function writeSummary(folder: string, content: string): Promise<void> {
	await writeFile(path.join(folder, 'summary.md'), content);
}

export async function readLog(folder: string): Promise<string> {
	return readFile(path.join(folder, 'log.txt'), 'utf-8');
}

export async function getCompletedTicketNumbers(cwd: string): Promise<Set<number>> {
	const runsDir = path.join(cwd, '.iteris', 'runs');
	const completed = new Set<number>();

	try {
		const entries = await readdir(runsDir, {withFileTypes: true});
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const match = /^(\d+)-/.exec(entry.name);
				if (match) {
					completed.add(Number(match[1]));
				}
			}
		}
	} catch {
		// No runs directory yet
	}

	return completed;
}

export async function getTicketStatuses(cwd: string): Promise<Map<number, TicketStatus>> {
	const runsDir = path.join(cwd, '.iteris', 'runs');
	const statuses = new Map<number, TicketStatus>();

	try {
		const entries = await readdir(runsDir, {withFileTypes: true});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const match = /^(\d+)-/.exec(entry.name);
			if (!match) continue;

			const ticketNum = Number(match[1]);
			try {
				const content = await readFile(path.join(runsDir, entry.name, 'status.md'), 'utf-8');
				const statusMatch = /\*\*Status\*\*:\s*(\S+)/.exec(content);
				if (statusMatch) {
					statuses.set(ticketNum, statusMatch[1] as TicketStatus);
				}
			} catch {
				// No status.md in this run folder
			}
		}
	} catch {
		// No runs directory yet
	}

	return statuses;
}
