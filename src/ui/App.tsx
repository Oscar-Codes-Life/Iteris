import {ticketBranch} from '../types.js';
import {useState, useEffect, useRef} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import type {IterisConfig, Ticket, TicketState} from '../types.js';
import {runAllTickets} from '../agent/runner.js';
import {loadConfig} from '../config.js';
import {prepareHarness, configure, type Picker} from '../setup.js';
import {selectionLabel} from '../harness/settings.js';
import {Choice, type ChoiceOption} from './Choice.js';
import {TicketRow} from './TicketRow.js';
import {LiveLog} from './LiveLog.js';

type Dialog = {title: string; options: ChoiceOption[]; initial?: string; resolve: (value: string) => void; reject: (error: Error) => void};
const activeStatuses = new Set(['planning', 'running', 'reviewing', 'creating-pr', 'summarizing']);
export function App({config, tickets, cwd}: {config: IterisConfig; tickets: Ticket[]; cwd: string}) {
	const {exit} = useApp();
	const [states, setStates] = useState<Map<number, TicketState>>(() => new Map(tickets.map(ticket => [ticket.number, {ticket, status: 'pending', branch: ticketBranch(ticket), logLines: [], elapsedMs: 0}])));
	const [finished, setFinished] = useState(false);
	const [error, setError] = useState('');
	const [pending, setPending] = useState(config);
	const [commandText, setCommandText] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const dialogRef = useRef<Dialog | null>(null);
	const gate = useRef<Promise<void>>(Promise.resolve());
	const controller = useRef(new AbortController());
	const pick: Picker = (title, options, initial) => new Promise((resolve, reject) => {
		if (controller.current.signal.aborted) {reject(new Error('Cancelled')); return;}
		const next: Dialog = {title, options, initial, resolve, reject}; dialogRef.current = next; setDialog(next);
	});
	function closeDialog(value?: string) {
		const current = dialogRef.current; dialogRef.current = null; setDialog(null);
		if (value === undefined) current?.reject(new Error('Cancelled')); else current?.resolve(value);
	}
	useEffect(() => {
		const update = (number: number, state: TicketState) => {setStates(previous => new Map(previous).set(number, state));};
		void runAllTickets(tickets, config, cwd, {
			onStatusChange: update, onLogLine() {}, onComplete: update,
			async onFailure(_number, state) {return await pick(`Ticket #${state.ticket.number}: ${state.failureReason ?? 'failed'}`, [{value: 'retry', label: 'Retry with same settings'}, {value: 'skip', label: 'Skip ticket'}]) as 'retry' | 'skip';},
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
		}, controller.current.signal).then(() => setFinished(true), failure => {setError(String(failure)); setFinished(true);});
		return () => {controller.current.abort(); dialogRef.current?.reject(new Error('Cancelled'));};
	}, []);
	useEffect(() => {
		const timer = setInterval(() => setStates(previous => new Map([...previous].map(([number, state]) => [number, activeStatuses.has(state.status) && state.startedAt ? {...state, elapsedMs: Date.now() - state.startedAt.getTime()} : state]))), 1000);
		return () => clearInterval(timer);
	}, []);
	function submit(text: string) {
		const parts = text.trim().replace(/^\//, '').split(/\s+/);
		if (parts.length > 2 || !['harness', 'model', 'effort'].includes(parts[0]!)) {setError('Commands: /harness [claude|codex], /model [id], /effort [level]'); return;}
		setBusy(true); setError('');
		gate.current = configure(parts[0]!, parts[1], {picker: pick, cwd, active: true}).then(next => {setPending(next);}, failure => {setError(failure instanceof Error ? failure.message : String(failure));}).finally(() => setBusy(false));
	}
	useInput((input, key) => {
		if (dialog || busy) return;
		if (commandText !== null) {
			if (key.escape) setCommandText(null);
			else if (key.return) {setCommandText(null); submit(commandText);}
			else if (key.backspace || key.delete) setCommandText(value => value?.slice(0, -1) ?? '');
			else if (!key.ctrl && !key.meta) setCommandText(value => (value ?? '') + input);
		} else if (input === '/') setCommandText('/');
		else if (input === 'q' && finished) exit();
	});
	const active = [...states.values()].find(state => activeStatuses.has(state.status));
	const hasFailures = [...states.values()].some(state => state.status === 'failed' || state.status === 'stale');
	return <Box flexDirection="column" padding={1}>
		<Text bold color="magenta">Iteris · {config.repo}</Text>
		<Text dimColor>Saved settings for the next ticket: {selectionLabel(pending)}</Text>
		{active && <Box flexDirection="column" marginY={1}><Text bold>Working on #{active.ticket.number}: {active.ticket.title} · {active.status}</Text><Text>{active.selection?.harness} · {active.selection?.model} · effort: {active.selection?.effort ?? 'Not supported'}</Text></Box>}
		{[...states.values()].map(state => <TicketRow key={state.ticket.number} state={state} />)}
		{active && <LiveLog lines={active.logLines} harness={active.selection?.harness ?? config.harness} />}
		{error && <Text color="red">{error}</Text>}
		{dialog && <Choice key={dialog.title} {...dialog} onSelect={value => closeDialog(value)} onCancel={() => closeDialog()} />}
		{commandText !== null && <Text color="cyan">{commandText}▌</Text>}
		{busy && !dialog && <Text dimColor>Checking settings…</Text>}
		{finished && <Text color={hasFailures || error ? 'yellow' : 'green'}>{hasFailures || error ? 'Queue finished with failures.' : 'All tickets complete.'} Press q to exit.</Text>}
		{!dialog && !busy && <Text dimColor>/harness · /model · /effort (changes apply to the next ticket)</Text>}
	</Box>;
}
