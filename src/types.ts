import {createHash} from 'node:crypto';

export type TicketStatus = 'pending' | 'preparing' | 'planning' | 'summarizing' | 'running' | 'reviewing' | 'recovering' | 'retrying' | 'creating-pr' | 'done' | 'stale' | 'failed' | 'blocked' | 'incomplete' | 'waiting' | 'cancelled';

export type Ticket = {
	branch?: string;
	source?: {provider: Provider; namespace: string; id: string; issueId?: string; projectItemId?: string; repository?:string};
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

export type WorkspaceSettings = {mode: 'local' | 'worktree'; concurrency: number};

export type TicketState = {
	workspace?: {mode: 'local' | 'worktree'; path: string};
	runKey?: string;
	remaining?: string[];
	selection?: ExecutionSelection;
	ticket: Ticket;
	status: TicketStatus;
	branch: string;
	prUrl?: string;
	prNumber?: number;
	reviewPending?: string;
	failureReason?: string;
	/** Set when this pass failed and was journaled; retry means a fresh instance is scheduled. */
	attempt?: {number: number; status: string; disposition: 'retry' | 'waiting' | 'stopped'; nextRetryAt?: string; needsRepair?: boolean};
	startedAt?: Date;
	finishedAt?: Date;
	logLines: string[];
	elapsedMs: number;
};

export type Provider = 'github' | 'trello' | 'custom' | 'command';

export type {TrelloConfig} from './trello/types.js';
import type {TrelloConfig} from './trello/types.js';

export type IterisConfig = {
	workspace: WorkspaceSettings;
	version: 3;
	workflow: import('./lifecycle/config.js').LifecycleConfig['workflow'];
	verification: import('./lifecycle/config.js').LifecycleConfig['verification'];
	environment: import('./lifecycle/config.js').LifecycleConfig['environment'];
	recovery: import('./lifecycle/config.js').LifecycleConfig['recovery'];
	continuation: import('./lifecycle/config.js').LifecycleConfig['continuation'];
	integrations: import('./lifecycle/config.js').LifecycleConfig['integrations'];
	profiles: import('./lifecycle/config.js').LifecycleConfig['profiles'];
	/** Resolved by the host, never loaded from task text or serialized. */
	_execution?: import('./lifecycle/environment.js').ExecutionManifest;
	_deadline?: number;
	_plannedChecks?: string[];
	_requirements?: import('./lifecycle/state.js').Requirement[];
	/** Base commit this attempt works and is reviewed against, fixed when the attempt starts. */
	_base?: string;
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
	if (ticket.branch) return ticket.branch;
	if (ticket.custom?.branch) return ticket.custom.branch;
	if(ticket.source?.provider==='github' && (ticket.source.projectItemId || ticket.source.namespace.includes('/project/')))return customBranch(undefined,ticket.title,JSON.stringify([ticket.source.provider,ticket.source.namespace,ticket.source.id]));
	if (ticket.source && ticket.source.provider !== 'github') return customBranch(ticket.custom?.identifier, ticket.title, JSON.stringify([ticket.source.provider,ticket.source.namespace,ticket.source.id]));
	if (!ticket.custom) return `iteris/${ticket.number}-${ticket.slug}`;
	if (ticket.custom.branch) return ticket.custom.branch;
	return customBranch(ticket.custom.identifier, ticket.title, ticket.custom.identity);
}

export function customBranch(identifier: string | undefined, title: string, identity: string): string {
	const readable = (identifier || title).normalize('NFKD').toLowerCase()
		.replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'task';
	const suffix = createHash('sha256').update(identity).digest('hex').slice(0,16);
	return `iteris/${readable}-${suffix}`;
}

export function ticketPrTitle(ticket: Ticket): string {
	return ticket.custom?.identifier ? `${ticket.custom.identifier}: ${ticket.title}` : ticket.title;
}
