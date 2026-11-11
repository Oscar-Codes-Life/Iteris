import {keepAwake} from './harness/awake.js';
import {InstanceMonitor} from './ui/InstanceMonitor.js';
import {VERSION} from './version.js';
import {reviewBranch} from './review/cli.js';
import {setupCustom} from './custom/setup.js';
import {customStatuses} from './custom/import.js';
import {loadCustomTasks} from './custom/cache.js';
import {choose} from './ui/Choice.js';
import {hasActiveRun} from './state/active.js';
import {loadPendingQueue} from './state/queue.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {render} from 'ink';
import terminalImage from 'terminal-image';
import {loadConfig, saveConfigField} from './config.js';
import {ensureGithubAuth} from './github/auth.js';
import {setupHarness, prepareHarness, configure} from './setup.js';
import {selectionLabel} from './harness/settings.js';
import type {ProjectInfo} from './github/projects.js';
import {fetchTodoTickets} from './github/tickets.js';
import {ProjectPicker} from './github/ui/ProjectPicker.js';
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
import {TicketPicker,ticketIdentity} from './ui/TicketPicker.js';
import {lifecycleCommand} from './lifecycle/cli.js';
import {sourceAdapter} from './lifecycle/adapters.js';
import {unfinishedTickets} from './lifecycle/worker.js';
import {listRuns,taskKey} from './lifecycle/state.js';
import {migrateLegacyRuns} from './lifecycle/migration.js';

async function printBranding() {
	const dirname = path.dirname(fileURLToPath(import.meta.url));
	const iconPath = path.resolve(dirname, '..', 'assets', 'iteris-icon.png');

	try {
		const icon = await terminalImage.file(iconPath, {width: 20});
		console.log(icon);
	} catch {
		// Terminal doesn't support images — skip
	}

	console.log('\x1b[1m\x1b[35mIteris\x1b[0m \x1b[2m—\x1b[0m Autonomous agent that pulls GitHub tickets, ships them via Claude Code or Codex,');
	console.log('and manages the full lifecycle from branch to PR.');
	console.log('\x1b[2mClaude Code + Codex · Built by Oscar Gallo\x1b[0m');
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

function showTicketPicker(tickets: Ticket[], previousStatuses: Map<number, TicketStatus>,sourceStatuses:Map<string,TicketStatus>): Promise<Ticket[]> {
	return new Promise(resolve => {
		const {unmount} = render(
			<TicketPicker tickets={tickets} previousStatuses={previousStatuses} sourceStatuses={sourceStatuses} onSelect={(selected) => {
				unmount();
				resolve(selected);
			}} />,
		);
	});
}

function waitForTrelloCredentials(): Promise<void> {
	return new Promise((resolve, reject) => {
		const {unmount, waitUntilExit} = render(
			<TrelloSetup onComplete={(credentials) => {
				const profile = saveTrelloCredentials(credentials);
				unmount();
				console.log(`Trello credentials saved to ${profile}.`);
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
	const once=process.argv.includes('--once');
	const args=process.argv.slice(2).filter(arg=>arg!=='--once');
	const [command, argument, ...extra] = args;
	if (command === '--version' || command === '-V') {
		console.log(VERSION);
		return;
	}
	if (command === '--help' || command === '-h') {
		console.log('iteris [--version | --help] [--once] [setup | refresh | next | resume | status [task-key] | doctor | evidence <task-key> <receipt.json> | cancel <task-key> | describe [task-key | --all] [--rewrite] [--dry-run] | review [standard|deep|audit] | harness [claude|codex] | model [id] | effort [level] | workspace [local|worktree] | parallel [1-8] | instances]');
		return;
	}
	let config = await loadConfig();
	await migrateLegacyRuns(process.cwd(),config);
	if(once)config.continuation.watch=false;
	if (command === 'instances') {
		if (argument) throw new Error('Usage: iteris instances');
		const instance = render(<InstanceMonitor config={config} cwd={process.cwd()} />);
		await instance.waitUntilExit(); return;
	}
	if ((command === 'resume' && !argument) || (!command && (await unfinishedTickets(process.cwd(), config)).length)) {
		if (await hasActiveRun()) {
			const monitor = render(<InstanceMonitor config={config} cwd={process.cwd()} />);
			await monitor.waitUntilExit(); return;
		}
		if (process.stdin.isTTY) {
			keepAwake();
			const app = render(<App config={config} cwd={process.cwd()} tickets={await unfinishedTickets(process.cwd(), config)} resume />);
			await app.waitUntilExit(); return;
		}
	}
	if(command && await lifecycleCommand(command,[...args.slice(1),...(once?['--once']:[])],config,process.cwd()))return;
	if(!command && (await unfinishedTickets(process.cwd(),config)).length){await lifecycleCommand('resume',once?['--once']:[],config,process.cwd());return;}
	if (extra.length || ((command === 'setup' || command === 'refresh' || command === 'next') && argument) || (command && !['setup', 'refresh', 'next', 'review', 'harness', 'model', 'effort', 'workspace', 'parallel'].includes(command))) throw new Error('Unknown command. Run iteris --help.');
	await printBranding();
	if (command && command !== 'setup' && command !== 'refresh' && command !== 'next' && command !== 'review') {
		config = await configure(command, argument);
		console.log(`Saved: ${selectionLabel(config)} · ${config.workspace.mode} · ${config.workspace.concurrency} parallel slots`);
		return;
	}
	if (await hasActiveRun()) throw new Error('An Iteris queue is already running here. Use iteris harness/model/effort to change pending settings.');
	if (command === 'setup' || !config.setupComplete) config = await setupHarness();
	else config = await prepareHarness(config);
	if (command === 'review') {
		process.exitCode = await reviewBranch(config, process.cwd(), argument) ? 0 : 1;
		return;
	}
	await ensureGithubAuth();
	if (!config.provider || command === 'setup') {
		config.provider = await showProviderPicker();
		await saveConfigField('provider', config.provider);
	}
	if (config.provider === 'trello' && !resolveTrelloCredentials()) await waitForTrelloCredentials();
	if (config.provider === 'custom' && (!config.custom || command === 'setup')) config = await setupCustom(config);
	await saveConfigField('setupComplete', true);
	if (command === 'setup') {
		console.log('Setup complete. Run iteris to select tickets.');
		return;
	}
	await run(config, command === 'refresh' || command === 'next', command === 'next');
}

async function fetchTicketsForProvider(config: IterisConfig, refresh = false, onlyNew = false): Promise<Ticket[]> {
	if(config.provider==='command')return sourceAdapter(config,process.cwd()).fetch();
	if (config.provider === 'custom') {
		const imported = await loadCustomTasks(config, process.cwd(), {
			refresh, onlyNew, onProgress: message => console.log(message),
			useLegacy: async (directory, count) => await choose(`Found ${count} downloaded tasks in ${directory}. Use these with the current endpoint?`, [
				{value: 'reuse', label: 'Use downloaded tasks'},
				{value: 'refresh', label: 'Fetch fresh tasks from the endpoint'},
			]) === 'reuse',
		});
		if (imported.cached) console.log(`Using ${imported.tickets.length} downloaded tasks. Run iteris refresh to fetch updates.`);
		if (imported.directory) console.log(`${imported.cached ? 'Tasks loaded from' : 'Tasks saved to'} ${imported.directory}`);
		if (imported.duplicates) console.log(`Collapsed ${imported.duplicates} duplicate records.`);
		return imported.tickets;
	}
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
		await saveConfigField('projectNumber', selected.number);
		config.projectNumber = selected.number;
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

/** refresh: fetch from the source again instead of resuming or reusing downloads. onlyNew: offer only tasks never taken here. */
async function run(config: IterisConfig, refresh = false, onlyNew = false) {
	const unfinished=refresh ? [] : await unfinishedTickets(process.cwd(),config);
	if(unfinished.length){await lifecycleCommand('resume',config.continuation.watch?[]:['--once'],config,process.cwd());return;}
	const pending = refresh ? undefined : await loadPendingQueue(process.cwd(), config);
	if (pending?.length) {
		console.log(`Resuming ${pending.length} ticket${pending.length === 1 ? '' : 's'} from the interrupted queue.`);
		keepAwake();
		const {waitUntilExit} = render(<App config={config} tickets={pending} cwd={process.cwd()} />);
		await waitUntilExit();
		return;
	}
	let tickets: Ticket[];
	try {
		tickets = await fetchTicketsForProvider(config, refresh, onlyNew);
	} catch (error) {
		console.error('Failed to fetch tickets:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
	if (onlyNew) {
		// A custom source leaves taken tasks out before downloading them; every other source is filtered here.
		const taken = new Set((await listRuns(process.cwd(), config.repo)).map(run => run.key));
		tickets = tickets.filter(ticket => !taken.has(taskKey(ticket, config)));
	}

	if (tickets.length === 0) {
		console.log(onlyNew ? 'No new tickets: everything at the source has already been taken here. Run iteris refresh to fetch all of it again.' : 'No tickets found. Nothing to do.');
		process.exit(0);
	}

	const previousStatuses = config.provider === 'custom' ? await customStatuses(process.cwd(), tickets) : await getTicketStatuses(process.cwd());
	const sourceStatuses=new Map<string,TicketStatus>();
	for(const run of await listRuns(process.cwd(),config.repo)){const ticket=tickets.find(ticket=>taskKey(ticket,config)===run.key);if(ticket)sourceStatuses.set(ticketIdentity(ticket),run.state==='complete'?'done':run.state==='waiting'?'waiting':run.state==='cancelled'?'cancelled':'incomplete');}
	const selected = await showTicketPicker(tickets, previousStatuses,sourceStatuses);

	if (selected.length === 0) {
		console.log('No tickets selected. Nothing to do.');
		process.exit(0);
	}

	keepAwake();
	const {waitUntilExit} = render(
		<App config={config} tickets={selected} cwd={process.cwd()} />,
	);

	await waitUntilExit();
}

void main().catch(error => {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;});
