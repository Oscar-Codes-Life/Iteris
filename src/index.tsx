import {render} from 'ink';
import {loadConfig, resolveGithubToken} from './config.js';
import {fetchTodoTickets} from './github/tickets.js';
import {getCompletedTicketNumbers} from './state/manager.js';
import type {Ticket} from './types.js';
import {App} from './ui/App.js';
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

function showTicketPicker(tickets: Ticket[]): Promise<Ticket> {
	return new Promise(resolve => {
		const {unmount} = render(
			<TicketPicker tickets={tickets} onSelect={(ticket) => {
				unmount();
				resolve(ticket);
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

	let tickets;
	try {
		tickets = await fetchTodoTickets(config);
	} catch (error) {
		console.error('Failed to fetch tickets:', error instanceof Error ? error.message : error);
		process.exit(1);
	}

	// Filter out already-completed tickets
	const completed = await getCompletedTicketNumbers(process.cwd());
	tickets = tickets.filter(t => !completed.has(t.number));

	if (tickets.length === 0) {
		console.log('No Todo tickets found. Nothing to do.');
		process.exit(0);
	}

	let selected: Ticket;
	if (tickets.length === 1) {
		selected = tickets[0]!;
	} else {
		selected = await showTicketPicker(tickets);
	}

	const {waitUntilExit} = render(
		<App config={config} tickets={[selected]} cwd={process.cwd()} />,
	);

	await waitUntilExit();
}

void main();
