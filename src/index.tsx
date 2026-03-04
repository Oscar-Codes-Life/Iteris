import {render} from 'ink';
import {loadConfig} from './config.js';
import {fetchTodoTickets} from './github/tickets.js';
import {getCompletedTicketNumbers} from './state/manager.js';
import {App} from './ui/App.js';

async function main() {
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

	console.log(`Found ${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} to process.\n`);

	const {waitUntilExit} = render(
		<App config={config} tickets={tickets} cwd={process.cwd()} />,
	);

	await waitUntilExit();
}

void main();
