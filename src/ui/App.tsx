import {Instances, activeStatuses} from './Instances.js';
import {readInstances} from './InstanceMonitor.js';
import {ticketBranch} from '../types.js';
import {useState, useEffect, useRef} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import type {IterisConfig, Ticket, TicketState} from '../types.js';
import {runAllTickets, type RunnerCallbacks} from '../agent/runner.js';
import {loadConfig} from '../config.js';
import {prepareHarness, configure, type Picker} from '../setup.js';
import {selectionLabel} from '../harness/settings.js';
import {Choice, type ChoiceOption} from './Choice.js';
import {TicketRow} from './TicketRow.js';
import {LiveLog} from './LiveLog.js';
import {taskKey} from '../lifecycle/state.js';
import {runWorker} from '../lifecycle/worker.js';
import {claimQueue} from '../state/active.js';
import {useAnswer, question} from './answer.js';

type Dialog = {title: string; options: ChoiceOption[]; initial?: string; resolve: (value: string) => void; reject: (error: Error) => void};
export function App({config, tickets, cwd, resume = false}: {config: IterisConfig; tickets: Ticket[]; cwd: string; resume?: boolean}) {
	const {exit} = useApp();
	const [states, setStates] = useState<Map<string, TicketState>>(() => new Map(tickets.map(ticket => [taskKey(ticket,config), {ticket, status: 'pending', branch: ticketBranch(ticket), logLines: [], elapsedMs: 0}])));
	const [view, setView] = useState<'queue' | 'instances'>(config.workspace.mode === 'worktree' ? 'instances' : 'queue');
	const [selected, setSelected] = useState(0);
	const dialogGate = useRef<Promise<unknown>>(Promise.resolve());
	const [finished, setFinished] = useState(false);
	const [error, setError] = useState('');
	const [pending, setPending] = useState(config);
	const [commandText, setCommandText] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const dialogRef = useRef<Dialog | null>(null);
	const gate = useRef<Promise<void>>(Promise.resolve());
	const controller = useRef(new AbortController());
	const pick: Picker = (title, options, initial) => {
		const request = dialogGate.current.then(() => new Promise<string>((resolve, reject) => {
		if (controller.current.signal.aborted) {reject(new Error('Cancelled')); return;}
		const next: Dialog = {title, options, initial, resolve, reject}; dialogRef.current = next; setDialog(next);
		}));
		dialogGate.current = request.catch(() => {});
		return request;
	};
	function closeDialog(value?: string) {
		const current = dialogRef.current; dialogRef.current = null; setDialog(null);
		if (value === undefined) current?.reject(new Error('Cancelled')); else current?.resolve(value);
	}
	useEffect(() => {
		const update = (_number: number, state: TicketState) => {setStates(previous => new Map(previous).set(state.runKey??taskKey(state.ticket,config), state));};
		const callbacks: RunnerCallbacks = {
			onStatusChange: update, onLogLine() {}, onComplete: update,
			// Failed attempts never wait for a person; they are journaled and retried by a fresh instance.
			onAttemptFailed: update,
			async beforeTicket() {
				for (;;) {
					if (controller.current.signal.aborted) throw new Error('Cancelled');
					await gate.current;
					try {
						setBusy(true);
						const fresh = await prepareHarness(await loadConfig(cwd), pick, cwd);
						setPending(fresh); setBusy(false); return fresh;
					} catch (failure) {
						if (controller.current.signal.aborted) throw failure;
						setBusy(false);
						await pick(`Queue paused: ${failure instanceof Error ? failure.message : String(failure)}`, [{value: 'retry', label: 'Reload configuration and retry'}]);
					}
				}
			},
		};
		const run = async () => {
			// One queue per repository, from the first ticket to the last wait.
			const release = await claimQueue(cwd);
			try {await work();} finally {await release();}
		};
		const work = async () => {
			if (resume) {
				const saved = await readInstances(cwd, config);
				setStates(new Map(saved.map(state => [state.runKey!, state])));
				await runWorker({config, cwd, callbacks, signal: controller.current.signal, force: true, once: !config.continuation.watch, answers: true});
			} else {
				await runAllTickets(tickets, config, cwd, callbacks, controller.current.signal);
				if (config.continuation.watch) await runWorker({config, cwd, callbacks, signal: controller.current.signal, answers: true});
			}
		};
		void run().then(() => setFinished(true), failure => {setError(String(failure)); setFinished(true);});
		return () => {controller.current.abort(); dialogRef.current?.reject(new Error('Cancelled'));};
	}, []);
	useEffect(() => {
		const timer = setInterval(() => setStates(previous => new Map([...previous].map(([number, state]) => [number, activeStatuses.has(state.status) && state.startedAt ? {...state, elapsedMs: Date.now() - state.startedAt.getTime()} : state]))), 1000);
		return () => clearInterval(timer);
	}, []);
	function submit(text: string) {
		const parts = text.trim().replace(/^\//, '').split(/\s+/);
		if (parts.length > 2 || !['harness', 'model', 'effort', 'workspace', 'parallel'].includes(parts[0]!)) {setError('Commands: /harness, /model, /effort, /workspace [local|worktree], /parallel [1–8]'); return;}
		setBusy(true); setError('');
		gate.current = configure(parts[0]!, parts[1], {picker: pick, cwd, active: true}).then(next => {setPending(next);}, failure => {setError(failure instanceof Error ? failure.message : String(failure));}).finally(() => setBusy(false));
	}
	const list = [...states.values()], current = view === 'instances' ? list[Math.min(selected, Math.max(0, list.length - 1))] : undefined;
	const answer = useAnswer(cwd, current);
	useInput((input, key) => {
		if (dialog || busy) return;
		if (commandText === null && answer.handle(input, key)) return;
		if (commandText !== null) {
			if (key.escape) setCommandText(null);
			else if (key.return) {setCommandText(null); submit(commandText);}
			else if (key.backspace || key.delete) setCommandText(value => value?.slice(0, -1) ?? '');
			else if (!key.ctrl && !key.meta) setCommandText(value => (value ?? '') + input);
		} else if (key.tab || input === 'i') setView(value => value === 'instances' ? 'queue' : 'instances');
		else if (view === 'instances' && (key.upArrow || input === 'k')) setSelected(value => Math.max(0, value - 1));
		else if (view === 'instances' && (key.downArrow || input === 'j')) setSelected(value => Math.min(states.size - 1, value + 1));
		else if (input === '/') setCommandText('/');
		else if (input === 'q' && (finished || ![...states.values()].some(state=>activeStatuses.has(state.status)))) {controller.current.abort();exit();}
	});
	const active = [...states.values()].find(state => activeStatuses.has(state.status));
	const hasFailures = [...states.values()].some(state => ['failed', 'stale', 'blocked', 'incomplete', 'waiting', 'retrying', 'cancelled'].includes(state.status));
	return <Box flexDirection="column" paddingX={1}>
		<Text bold color="magenta">Iteris · {config.repo}</Text>
		<Text dimColor wrap="truncate">Saved settings for the next ticket: {selectionLabel(pending)}</Text>
		<Box gap={2}><Text bold color={view === 'instances' ? 'magenta' : 'gray'}>Instances</Text><Text bold color={view === 'queue' ? 'magenta' : 'gray'}>Queue</Text><Text dimColor>Tab switch</Text></Box>
		{view === 'instances' ? <Instances states={list} selected={selected} workspace={config.workspace} answer={answer} /> : <Box flexDirection="column">
		{active && <Box flexDirection="column" marginY={1}><Text bold>Working on #{active.ticket.number}: {active.ticket.title} · {active.status}</Text><Text>{active.selection?.harness} · {active.selection?.model} · effort: {active.selection?.effort ?? 'Not supported'}</Text></Box>}
		{[...states.values()].map(state => <TicketRow key={state.runKey??taskKey(state.ticket,config)} state={state} />)}
		{active && <LiveLog lines={active.logLines} harness={active.selection?.harness ?? config.harness} />}
		</Box>}
		{error && <Text color="red">{error}</Text>}
		{dialog && <Choice key={dialog.title} {...dialog} onSelect={value => closeDialog(value)} onCancel={() => closeDialog()} />}
		{commandText !== null && <Box flexDirection="column"><Text dimColor wrap="truncate">/harness · /model · /effort · /workspace · /parallel</Text><Text color="cyan">{commandText}▌</Text></Box>}
		{(pending.workspace.mode !== config.workspace.mode || pending.workspace.concurrency !== config.workspace.concurrency) && <Text dimColor>Next queue: {pending.workspace.mode} · {pending.workspace.concurrency} parallel slots</Text>}
		{busy && !dialog && <Text dimColor>Checking settings…</Text>}
		{finished && <Text color={hasFailures || error ? 'yellow' : 'green'}>{hasFailures || error ? 'Queue contains unfinished tasks. Run iteris status for next actions.' : 'All tickets complete.'} Press q to exit.</Text>}
		{!dialog && !busy && answer.draft === null && <Text dimColor>↑/↓ select · {question(current) !== undefined ? 'Enter answer · ' : ''}/ settings · q exit when idle</Text>}
	</Box>;
}
