export type TicketStatus = 'pending' | 'running' | 'done' | 'stale' | 'failed';

export type Ticket = {
	number: number;
	title: string;
	body: string;
	slug: string;
	labels: string[];
	htmlUrl: string;
};

export type TicketState = {
	ticket: Ticket;
	status: TicketStatus;
	branch: string;
	prUrl?: string;
	prNumber?: number;
	startedAt?: Date;
	finishedAt?: Date;
	logLines: string[];
	elapsedMs: number;
};

export type Provider = 'github' | 'trello';

export type {TrelloConfig} from './trello/types.js';
import type {TrelloConfig} from './trello/types.js';

export type IterisConfig = {
	repo: string;
	provider?: Provider;
	todoStatus: string;
	projectNumber?: number;
	baseBranch: string;
	timeout: number;
	claudeFlags: string[];
	qualityChecks: string[];
	pr: {
		draft: boolean;
		addLabelOnOpen?: string;
	};
	trello?: TrelloConfig;
};
