import {createHash} from 'node:crypto';

export type TicketStatus = 'pending' | 'planning' | 'summarizing' | 'running' | 'reviewing' | 'recovering' | 'creating-pr' | 'done' | 'stale' | 'failed' | 'blocked' | 'incomplete';

export type Ticket = {
	custom?: {identifier?: string; identity: string; fingerprint: string; taskFile: string; changed?: boolean; branch?: string};
	number: number;
	title: string;
	body: string;
	slug: string;
	labels: string[];
	htmlUrl: string;
};

export type Harness = 'claude' | 'codex';
export type HarnessSettings = {model?: string; effort?: string; flags: string[]};
export type ExecutionSelection = {harness: Harness; model?: string; effort?: string};

export type TicketState = {
	selection?: ExecutionSelection;
	ticket: Ticket;
	status: TicketStatus;
	branch: string;
	prUrl?: string;
	prNumber?: number;
	reviewPending?: string;
	failureReason?: string;
	startedAt?: Date;
	finishedAt?: Date;
	logLines: string[];
	elapsedMs: number;
};

export type Provider = 'github' | 'trello' | 'custom';

export type {TrelloConfig} from './trello/types.js';
import type {TrelloConfig} from './trello/types.js';

export type IterisConfig = {
	version: 2;
	harness: Harness;
	harnesses: Record<Harness, HarnessSettings>;
	setupComplete: boolean;
	repo: string;
	provider?: Provider;
	githubSource?: 'auto' | 'issues' | 'projects';
	todoStatus: string;
	projectNumber?: number;
	baseBranch: string;
	timeout: number;
	planMode: boolean;
	qualityChecks: string[];
	review?: Partial<import('./review/schema.js').ReviewConfig>;
	pr: {
		draft: boolean;
		addLabelOnOpen?: string;
	};
	trello?: TrelloConfig;
	custom?: import('./custom/schema.js').CustomConfig;
};

export function ticketBranch(ticket: Ticket): string {
	if (!ticket.custom) return `iteris/${ticket.number}-${ticket.slug}`;
	if (ticket.custom.branch) return ticket.custom.branch;
	return customBranch(ticket.custom.identifier, ticket.title, ticket.custom.identity);
}

export function customBranch(identifier: string | undefined, title: string, identity: string): string {
	const readable = (identifier || title).normalize('NFKD').toLowerCase()
		.replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'task';
	const hash = createHash('sha256').update(identity).digest();
	const code = hash.readUInt32BE(0) % 17_576;
	const suffix = [676, 26, 1].map(divisor => String.fromCharCode(97 + Math.floor(code / divisor) % 26)).join('');
	return `iteris/${readable}-${suffix}`;
}

export function ticketPrTitle(ticket: Ticket): string {
	return ticket.custom?.identifier ? `${ticket.custom.identifier}: ${ticket.title}` : ticket.title;
}
