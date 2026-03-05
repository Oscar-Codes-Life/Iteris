import {render} from 'ink';
import {loadConfig, resolveGithubToken, resolveTrelloCredentials, saveConfigField} from './config.js';
import type {ProjectInfo} from './github/projects.js';
import {fetchTodoTickets} from './github/tickets.js';
import {getTicketStatuses} from './state/manager.js';
import type {TrelloBoard, TrelloList} from './trello/api.js';
import {fetchTrelloTickets} from './trello/tickets.js';
import type {IterisConfig, Provider, Ticket, TicketStatus} from './types.js';
import {App} from './ui/App.js';
import {BoardPicker} from './ui/BoardPicker.js';
import {ListPicker} from './ui/ListPicker.js';
import {ProjectPicker} from './ui/ProjectPicker.js';
import {ProviderPicker} from './ui/ProviderPicker.js';
import {TicketPicker} from './ui/TicketPicker.js';
import {TokenError} from './ui/TokenError.js';
import {TrelloTokenError} from './ui/TrelloTokenError.js';
import {Welcome} from './ui/Welcome.js';

function showWelcome(): Promise<void> {
	return new Promise(resolve => {
		const {unmount} = render(
			<Welcome onContinue={() => {
				unmount();
				resolve();
			}} />,
		);
	});
}

function showProviderPicker(): Promise<Provider> {
	return new Promise(resolve => {
		const {unmount} = render(
			<ProviderPicker onSelect={(provider) => {
				unmount();
				resolve(provider);
			}} />,
		);
	});
}

function showProjectPicker(projects: ProjectInfo[]): Promise<ProjectInfo> {
	return new Promise(resolve => {
		const {unmount} = render(
			<ProjectPicker projects={projects} onSelect={(project) => {
				unmount();
				resolve(project);
			}} />,
		);
	});
}

function showBoardPicker(boards: TrelloBoard[]): Promise<TrelloBoard> {
	return new Promise(resolve => {
		const {unmount} = render(
			<BoardPicker boards={boards} onSelect={(board) => {
				unmount();
				resolve(board);
			}} />,
		);
	});
}

function showListPicker(lists: TrelloList[]): Promise<TrelloList> {
	return new Promise(resolve => {
		const {unmount} = render(
			<ListPicker lists={lists} onSelect={(list) => {
				unmount();
				resolve(list);
			}} />,
		);
	});
}

function showTicketPicker(tickets: Ticket[], previousStatuses: Map<number, TicketStatus>): Promise<Ticket[]> {
	return new Promise(resolve => {
		const {unmount} = render(
			<TicketPicker tickets={tickets} previousStatuses={previousStatuses} onSelect={(selected) => {
				unmount();
				resolve(selected);
			}} />,
		);
	});
}

function waitForGithubToken(): Promise<void> {
	return new Promise((resolve, reject) => {
		const {rerender, waitUntilExit} = render(
			<TokenError onRetry={() => handleRetry()} />,
		);

		function handleRetry() {
			if (resolveGithubToken()) {
				rerender(<></>);
				resolve();
			}
		}

		void waitUntilExit().then(() => {
			// If user quit without resolving token, exit
			if (!resolveGithubToken()) {
				reject(new Error('GitHub token required'));
			}
		});
	});
}

function waitForTrelloCredentials(): Promise<void> {
	return new Promise((resolve, reject) => {
		const {rerender, waitUntilExit} = render(
			<TrelloTokenError onRetry={() => handleRetry()} />,
		);

		function handleRetry() {
			if (resolveTrelloCredentials()) {
				rerender(<></>);
				resolve();
			}
		}

		void waitUntilExit().then(() => {
			if (!resolveTrelloCredentials()) {
				reject(new Error('Trello credentials required'));
			}
		});
	});
}

async function main() {
	await showWelcome();

	// GitHub token is always needed (for PRs)
	if (!resolveGithubToken()) {
		try {
			await waitForGithubToken();
		} catch {
			process.exit(1);
		}
	}

	await run();
}

async function fetchTicketsForProvider(config: IterisConfig): Promise<Ticket[]> {
	if (config.provider === 'trello') {
		return fetchTrelloFlow(config);
	}

	return fetchGithubFlow(config);
}

async function fetchGithubFlow(config: IterisConfig): Promise<Ticket[]> {
	console.log(`Fetching tickets from ${config.repo}...`);

	let result = await fetchTodoTickets(config);

	if (result.kind === 'pickProject') {
		const selected = await showProjectPicker(result.projects);
		console.log(`[debug] User selected project #${selected.number} "${selected.title}"`);
		result = await fetchTodoTickets(config, selected.number);
	}

	if (result.kind !== 'tickets') {
		throw new Error('Unexpected state: still need project selection.');
	}

	return result.tickets;
}

async function fetchTrelloFlow(config: IterisConfig): Promise<Ticket[]> {
	console.log('Fetching tickets from Trello...');

	let result = await fetchTrelloTickets(config);

	if (result.kind === 'pickBoard') {
		const selected = await showBoardPicker(result.boards);
		console.log(`[debug] User selected board "${selected.name}"`);
		await saveConfigField('trello.boardId', selected.id);
		result = await fetchTrelloTickets(config, selected.id);
	}

	if (result.kind === 'pickList') {
		const selected = await showListPicker(result.lists);
		console.log(`[debug] User selected list "${selected.name}"`);
		await saveConfigField('trello.listId', selected.id);
		result = await fetchTrelloTickets(config, config.trello?.boardId, selected.id);
	}

	if (result.kind !== 'tickets') {
		throw new Error('Unexpected state: still need board/list selection.');
	}

	return result.tickets;
}

async function run() {
	let config: IterisConfig;
	try {
		config = await loadConfig();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}

	// Provider selection
	if (!config.provider) {
		const provider = await showProviderPicker();
		await saveConfigField('provider', provider);
		config.provider = provider;
	}

	// Trello credential check
	if (config.provider === 'trello' && !resolveTrelloCredentials()) {
		try {
			await waitForTrelloCredentials();
		} catch {
			process.exit(1);
		}
	}

	let tickets: Ticket[];
	try {
		tickets = await fetchTicketsForProvider(config);
	} catch (error) {
		console.error('Failed to fetch tickets:', error instanceof Error ? error.message : error);
		process.exit(1);
	}

	if (tickets.length === 0) {
		console.log('No tickets found. Nothing to do.');
		process.exit(0);
	}

	const previousStatuses = await getTicketStatuses(process.cwd());
	const selected = await showTicketPicker(tickets, previousStatuses);

	if (selected.length === 0) {
		console.log('No tickets selected. Nothing to do.');
		process.exit(0);
	}

	const {waitUntilExit} = render(
		<App config={config} tickets={selected} cwd={process.cwd()} />,
	);

	await waitUntilExit();
}

void main();
