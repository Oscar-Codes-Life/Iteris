import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {ticketBranch, type IterisConfig, type Ticket} from '../types.js';

const ticketSchema = z.object({
	number: z.number().int(), title: z.string(), body: z.string(), slug: z.string(), labels: z.array(z.string()), htmlUrl: z.string(),
	custom: z.object({identifier: z.string().optional(), identity: z.string(), fingerprint: z.string(), taskFile: z.string(), changed: z.boolean().optional(), branch: z.string().optional()}).optional(),
});
const queueSchema = z.object({version: z.literal(1), repo: z.string(), provider: z.string().optional(), tickets: z.array(ticketSchema).min(1)});
const filename = (cwd: string) => path.join(cwd, '.iteris', 'pending-queue.json');

export async function loadPendingQueue(cwd: string, config: IterisConfig): Promise<Ticket[] | undefined> {
	try {
		const saved = queueSchema.parse(JSON.parse(await readFile(filename(cwd), 'utf8')));
		if (saved.repo !== config.repo || saved.provider !== config.provider) return;
		// Queues written before readable custom branches used the identity hash as
		// the Git branch. Keep that branch when resuming an interrupted ticket.
		return saved.tickets.map(ticket => ticket.custom && !ticket.custom.branch
			? {...ticket, custom: {...ticket.custom, branch: `iteris/custom-${ticket.custom.identity}`}}
			: ticket);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw new Error(`Cannot resume the saved Iteris queue: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function savePendingQueue(cwd: string, config: IterisConfig, tickets: Ticket[]): Promise<void> {
	if (!tickets.length) {await clearPendingQueue(cwd); return;}
	await mkdir(path.dirname(filename(cwd)), {recursive: true});
	const temporary = `${filename(cwd)}.${randomUUID()}.tmp`;
	try {
		const savedTickets = tickets.map(ticket => ticket.custom
			? {...ticket, custom: {...ticket.custom, branch: ticketBranch(ticket)}}
			: ticket);
		await writeFile(temporary, JSON.stringify({version: 1, repo: config.repo, provider: config.provider, tickets: savedTickets}) + '\n', {mode: 0o600});
		await rename(temporary, filename(cwd));
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

export async function clearPendingQueue(cwd: string): Promise<void> {
	await unlink(filename(cwd)).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;});
}
