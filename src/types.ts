export type TicketStatus = 'pending' | 'planning' | 'summarizing' | 'running' | 'reviewing' | 'done' | 'stale' | 'failed';

export type Ticket = {
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
	failureReason?: string;
	startedAt?: Date;
	finishedAt?: Date;
	logLines: string[];
	elapsedMs: number;
};

export type Provider = 'github' | 'trello';

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
	pr: {
		draft: boolean;
		addLabelOnOpen?: string;
	};
	trello?: TrelloConfig;
};
