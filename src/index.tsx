import {render} from 'ink';
import {loadConfig, resolveGithubToken} from './config.js';
import type {ProjectInfo} from './github/projects.js';
import {fetchTodoTickets} from './github/tickets.js';
import {getTicketStatuses} from './state/manager.js';
import type {Ticket, TicketStatus} from './types.js';
import {App} from './ui/App.js';
import {ProjectPicker} from './ui/ProjectPicker.js';
import {TicketPicker} from './ui/TicketPicker.js';
import {TokenError} from './ui/TokenError.js';
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

async function main() {
	await showWelcome();

	// Check for token first
	if (!resolveGithubToken()) {
		const {rerender, waitUntilExit} = render(
			<TokenError onRetry={() => handleRetry()} />,
		);

		function handleRetry() {
			if (resolveGithubToken()) {
				rerender(<></>);
				void startApp();
			}
		}

		async function startApp() {
			try {
				await run();
			} catch (error) {
				console.error(error instanceof Error ? error.message : error);
				process.exit(1);
			}
		}

		await waitUntilExit();
		return;
	}

	await run();
}

async function run() {
	let config;
	try {
		config = await loadConfig();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}

	console.log(`Fetching tickets from ${config.repo}...`);

	let tickets: Ticket[];
	try {
		// First call — may need project selection
		let result = await fetchTodoTickets(config);

		if (result.kind === 'pickProject') {
			const selected = await showProjectPicker(result.projects);
			console.log(`[debug] User selected project #${selected.number} "${selected.title}"`);
			result = await fetchTodoTickets(config, selected.number);
		}

		if (result.kind !== 'tickets') {
			throw new Error('Unexpected state: still need project selection.');
		}

		tickets = result.tickets;
	} catch (error) {
		console.error('Failed to fetch tickets:', error instanceof Error ? error.message : error);
		process.exit(1);
	}

	if (tickets.length === 0) {
		console.log('No Todo tickets found. Nothing to do.');
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
