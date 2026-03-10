import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {render} from 'ink';
import terminalImage from 'terminal-image';
import {loadConfig, saveConfigField} from './config.js';
import {resolveGithubToken} from './github/auth.js';
import type {ProjectInfo} from './github/projects.js';
import {fetchTodoTickets} from './github/tickets.js';
import {ProjectPicker} from './github/ui/ProjectPicker.js';
import {TokenError} from './github/ui/TokenError.js';
import {getTicketStatuses} from './state/manager.js';
import type {TrelloBoard, TrelloList} from './trello/api.js';
import {resolveTrelloCredentials, saveTrelloCredentials} from './trello/auth.js';
import {fetchTrelloTickets} from './trello/tickets.js';
import {BoardPicker} from './trello/ui/BoardPicker.js';
import {ListPicker} from './trello/ui/ListPicker.js';
import {TrelloSetup} from './trello/ui/TrelloSetup.js';
import type {IterisConfig, Provider, Ticket, TicketStatus} from './types.js';
import {App} from './ui/App.js';
import {ProviderPicker} from './ui/ProviderPicker.js';
import {TicketPicker} from './ui/TicketPicker.js';

async function printBranding() {
	const dirname = path.dirname(fileURLToPath(import.meta.url));
	const iconPath = path.resolve(dirname, '..', 'assets', 'iteris-icon.png');

	try {
		const icon = await terminalImage.file(iconPath, {width: 20});
		console.log(icon);
	} catch {
		// Terminal doesn't support images — skip
	}

	console.log('\x1b[1m\x1b[35mIteris\x1b[0m \x1b[2m—\x1b[0m Autonomous agent that pulls GitHub tickets, ships them via Claude Code,');
	console.log('and manages the full lifecycle from branch to PR.');
	console.log('\x1b[2mPowered by Claude Code · Built by Oscar Gallo\x1b[0m');
	console.log();
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
		const {unmount, waitUntilExit} = render(
			<TrelloSetup onComplete={(credentials) => {
				saveTrelloCredentials(credentials);
				unmount();
				console.log('Trello credentials saved to your shell profile.');
				resolve();
			}} />,
		);

		void waitUntilExit().then(() => {
			if (!resolveTrelloCredentials()) {
				reject(new Error('Trello credentials required'));
			}
		});
	});
}

async function main() {
	await printBranding();

	let config: IterisConfig;
	try {
		config = await loadConfig();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}

	if (!config.provider) {
		const provider = await showProviderPicker();
		await saveConfigField('provider', provider);
		config.provider = provider;
	}

	if (config.provider === 'trello' && !resolveTrelloCredentials()) {
		try {
			await waitForTrelloCredentials();
		} catch {
			process.exit(1);
		}
	}

	if (!resolveGithubToken()) {
		try {
			await waitForGithubToken();
		} catch {
			process.exit(1);
		}
	}

	await run(config);
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
	console.log(`[debug] Config boardId=${config.trello?.boardId}, listId=${config.trello?.listId}`);

	let result = await fetchTrelloTickets(config);
	let boardId = config.trello?.boardId;
	console.log(`[debug] Initial fetch result: kind=${result.kind}`);

	if (result.kind === 'pickBoard') {
		const selected = await showBoardPicker(result.boards);
		console.log(`[debug] User selected board "${selected.name}"`);
		await saveConfigField('trello.boardId', selected.id);
		boardId = selected.id;
		console.log(`[debug] Fetching lists for boardId=${boardId}`);
		result = await fetchTrelloTickets(config, selected.id);
		console.log(`[debug] After board selection result: kind=${result.kind}`);
	}

	if (result.kind === 'pickList') {
		const selected = await showListPicker(result.lists);
		console.log(`[debug] User selected list "${selected.name}"`);
		await saveConfigField('trello.listId', selected.id);
		console.log(`[debug] Fetching tickets for boardId=${boardId}, listId=${selected.id}`);
		result = await fetchTrelloTickets(config, boardId, selected.id);
		console.log(`[debug] After list selection result: kind=${result.kind}`);
	}

	if (result.kind !== 'tickets') {
		throw new Error('Unexpected state: still need board/list selection.');
	}

	return result.tickets;
}

async function run(config: IterisConfig) {
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
