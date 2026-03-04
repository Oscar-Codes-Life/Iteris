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

export type IterisConfig = {
	repo: string;
	todoLabel: string;
	baseBranch: string;
	timeout: number;
	claudeFlags: string[];
	qualityChecks: string[];
	pr: {
		draft: boolean;
		addLabelOnOpen?: string;
	};
};
