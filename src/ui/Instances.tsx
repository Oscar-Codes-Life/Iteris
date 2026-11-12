import {useEffect, useState} from 'react';
import {Box, Text, useStdout} from 'ink';
import type {TicketState, WorkspaceSettings} from '../types.js';
import {question, type AnswerField} from './answer.js';

export const activeStatuses = new Set(['preparing', 'planning', 'running', 'reviewing', 'recovering', 'creating-pr', 'summarizing']);
/** Iteris continues these by itself: a check that has not finished, or a fresh instance that is scheduled. */
const waiting = new Set(['waiting', 'retrying']);
/** Nothing more happens to these until a person acts. */
const needsYou = new Set(['failed', 'blocked', 'incomplete', 'stale']);
const color = (state: TicketState) => state.status === 'done' ? 'green' : needsYou.has(state.status) ? 'red' : waiting.has(state.status) ? 'yellow' : activeStatuses.has(state.status) ? 'cyan' : 'gray';
const icon = (state: TicketState) => state.status === 'done' ? '✓' : needsYou.has(state.status) ? '!' : waiting.has(state.status) ? '◷' : activeStatuses.has(state.status) ? '●' : '○';
/** What the task is doing while no instance is attached to it. */
const idle = (state: TicketState) => state.status === 'pending' ? 'Waiting for a task slot'
	: state.status === 'waiting' ? 'No instance running · Iteris checks again by itself'
	: state.status === 'retrying' ? `No instance running · a fresh one starts${state.attempt?.nextRetryAt ? ` after ${new Date(state.attempt.nextRetryAt).toLocaleTimeString()}` : ' later'}`
	: question(state) !== undefined ? 'Stopped · waiting for your answer'
	: state.status === 'blocked' ? 'Stopped · run iteris resume to try again, or iteris cancel <task key> to drop it'
	: state.status === 'done' ? 'Finished' : 'No instance running';
const elapsed = (ms: number) => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;

export function useTerminalSize() {
	const {stdout} = useStdout();
	const [size, setSize] = useState({columns: stdout.columns || 100, rows: stdout.rows || 30});
	useEffect(() => {
		const resize = () => setSize({columns: stdout.columns || 100, rows: stdout.rows || 30});
		stdout.on('resize', resize); return () => {stdout.off('resize', resize);};
	}, [stdout]);
	return size;
}

export function Instances({states, selected, workspace, answer}: {states: TicketState[]; selected: number; workspace: WorkspaceSettings; answer?: AnswerField}) {
	const {columns, rows} = useTerminalSize();
	const narrow = columns < 90;
	const focus = Math.min(selected, Math.max(0, states.length - 1));
	const current = states[focus];
	// A stopped task's reason is what the person has to act on, so it is shown in full.
	const stopped = current?.status === 'blocked';
	// When the task stopped to ask, its request and the answer field take the place of the output.
	const asked = question(current);
	const room = Math.max(80, (columns - 6) * 4);
	const clip = (text: string) => {const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > room ? `${flat.slice(0, room)}…` : flat;};
	const extra = Number(!!current?.prUrl) + (asked !== undefined ? 7 : current?.failureReason ? (stopped ? 4 : 1) : 0);
	const capacity = Math.max(1, Math.min(8, Math.floor((rows - 22 - extra) / (narrow ? 2 : 1))));
	const start = Math.max(0, Math.min(focus - Math.floor(capacity / 2), states.length - capacity));
	return <Box flexDirection="column">
		<Box marginTop={1} columnGap={columns < 65 ? 1 : 2}>
			<Text bold color="cyan">{states.filter(state => activeStatuses.has(state.status)).length} {columns < 65 ? 'active' : 'running'}</Text>
			<Text dimColor>{states.filter(state => state.status === 'pending').length} queued</Text>
			<Text color="green">{states.filter(state => state.status === 'done').length} {columns < 65 ? 'done' : 'complete'}</Text>
			<Text color="yellow">{states.filter(state => waiting.has(state.status)).length} waiting</Text>
				<Text color="red">{states.filter(state => needsYou.has(state.status)).length} {columns < 65 ? 'stopped' : 'need you'}</Text>
		</Box>
		<Text dimColor>{workspace.mode === 'worktree' ? `Worktrees · up to ${workspace.concurrency} parallel tasks` : 'Local checkout · one task at a time'}</Text>
		<Box flexDirection="column" marginTop={1}>
			{states.length === 0 && <Text dimColor>No instances yet. Select tickets with iteris to begin.</Text>}
			{states.slice(start, start + capacity).map((state, index) => {
				const chosen = start + index === focus;
				return <Box key={state.runKey ?? index} flexDirection={narrow ? 'column' : 'row'}>
					<Box flexGrow={1} flexShrink={1} minWidth={0}>
						<Box width={2} flexShrink={0}><Text color={chosen ? 'magenta' : 'gray'}>{chosen ? '›' : ' '}</Text></Box>
						<Box width={2} flexShrink={0}><Text color={color(state)}>{icon(state)}</Text></Box>
						<Text bold={chosen} wrap="truncate">#{state.ticket.number} {state.ticket.title}</Text>
					</Box>
					<Box paddingLeft={narrow ? 4 : 1} width={narrow ? undefined : 36} flexShrink={0}>
						<Box width={14}><Text color={color(state)}>{state.status}</Text></Box>
						<Box width={12}><Text dimColor>{state.selection?.harness ?? '—'}</Text></Box>
						<Text dimColor>{state.startedAt ? elapsed(state.elapsedMs) : '—'}</Text>
					</Box>
				</Box>;
			})}
			{states.length > capacity && <Text dimColor>  {start + 1}–{Math.min(start + capacity, states.length)} of {states.length} instances · ↑/↓ to browse</Text>}
		</Box>
		{current && <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
			<Text bold wrap="truncate">#{current.ticket.number} · {current.ticket.title}</Text>
			<Text color="cyan" wrap="truncate">{current.selection ? `${current.selection.harness} · ${current.selection.model ?? 'default'} · ${current.selection.effort ?? 'default effort'}` : idle(current)}</Text>
			<Text dimColor wrap="truncate-middle">{current.branch}</Text>
			<Text dimColor wrap="truncate-middle">{current.workspace?.path ?? 'Workspace will be prepared when this task starts'}</Text>
			{current.prUrl && <Text color="green" wrap="truncate">PR {current.prUrl}</Text>}
			{current.failureReason && asked === undefined && <Text color={stopped ? 'red' : 'yellow'} wrap={stopped ? 'wrap' : 'truncate'}>{stopped ? clip(current.failureReason) : current.failureReason}</Text>}
			{asked !== undefined ? <Box flexDirection="column" marginTop={1}>
				<Text bold color="yellow">Iteris needs your help to continue this task</Text>
				<Text wrap="wrap">{clip(asked)}</Text>
				{answer?.draft != null ? <Box flexDirection="column" marginTop={1}>
					<Text bold>Your answer <Text dimColor>· Enter sends · Esc cancels</Text></Text>
					<Text color="cyan" wrap="wrap">› {answer.draft.slice(-room)}▌</Text>
				</Box> : <Box marginTop={1}><Text color="cyan" wrap="truncate">{answer?.note ?? (answer ? 'Press Enter to type your answer' : 'Answer with: iteris answer <task key> "your answer"')}</Text></Box>}
			</Box> : <>
			<Box marginTop={1}><Text bold dimColor>{current.selection?.harness === 'codex' ? 'Codex' : current.selection?.harness === 'claude' ? 'Claude Code' : 'Task'} output</Text></Box>
			{current.logLines.length ? current.logLines.slice(-Math.max(1, Math.min(5, rows - 26))).map((line, index) => <Text key={index} wrap="truncate">› {line}</Text>) : <Text dimColor>Waiting for output…</Text>}
			</>}
		</Box>}
	</Box>;
}
