import {useEffect, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {open, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {IterisConfig, TicketState} from '../types.js';
import {listRuns} from '../lifecycle/state.js';
import {retryScheduled} from '../lifecycle/attempts.js';
import {hasActiveRun} from '../state/active.js';
import {Instances} from './Instances.js';
import {useAnswer, question} from './answer.js';

export async function readInstances(cwd: string, config: IterisConfig): Promise<TicketState[]> {
	const active = await hasActiveRun(cwd);
	const runs = await listRuns(cwd, config.repo);
	return Promise.all(runs.sort((a, b) => Number(['complete', 'cancelled'].includes(a.state)) - Number(['complete', 'cancelled'].includes(b.state)) || a.createdAt.localeCompare(b.createdAt)).map(async run => {
		let saved: Partial<TicketState> = {};
		try {saved = JSON.parse(await readFile(path.join(run.artifacts, 'instance.json'), 'utf8'));} catch { /* not started */ }
		let logLines: string[] = [];
		try {
			const file = await open(path.join(run.artifacts, 'log.txt'), 'r');
			try {const {size} = await file.stat(); const buffer = Buffer.alloc(Math.min(size, 8192)); await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length)); logLines = buffer.toString('utf8').trimEnd().split('\n').slice(-50);} finally {await file.close();}
		} catch { /* no output yet */ }
		const status: TicketState['status'] = run.state === 'complete' ? 'done' : run.state === 'queued' ? 'pending' : run.state === 'active' ? active ? saved.status ?? 'running' : 'waiting' : retryScheduled(run) ? 'retrying' : run.state;
		return {...saved, ticket: run.ticket, runKey: run.key, branch: run.branch, workspace: run.workspace, status, logLines,
			startedAt: saved.startedAt ? new Date(saved.startedAt) : undefined,
			elapsedMs: run.state === 'active' && active && saved.startedAt ? Date.now() - new Date(saved.startedAt).getTime() : saved.elapsedMs ?? 0,
			prUrl: run.publication?.url, failureReason: run.state === 'active' && !active ? 'Interrupted · run iteris resume to continue' : run.reason};
	}));
}

export function InstanceMonitor({cwd, config}: {cwd: string; config: IterisConfig}) {
	const {exit} = useApp();
	const [states, setStates] = useState<TicketState[]>([]);
	const [selected, setSelected] = useState(0);
	const [error, setError] = useState('');
	useEffect(() => {
		let stopped = false;
		let timer: NodeJS.Timeout;
		const refresh = async () => {
			try {const next = await readInstances(cwd, config); if (!stopped) {setStates(next); setError('');}} catch (error) {if (!stopped) setError(String(error));}
			if (!stopped) timer = setTimeout(refresh, 1000);
		};
		void refresh(); return () => {stopped = true; clearTimeout(timer);};
	}, [cwd, config]);
	const current = states[Math.min(selected, Math.max(0, states.length - 1))];
	const answer = useAnswer(cwd, current);
	useInput((input, key) => {
		if (answer.handle(input, key)) return;
		if (input === 'q' || key.escape) exit();
		if (key.upArrow || input === 'k') setSelected(value => Math.max(0, value - 1));
		if (key.downArrow || input === 'j') setSelected(value => Math.min(states.length - 1, value + 1));
	});
	return <Box flexDirection="column" paddingX={1}>
		<Text bold color="magenta">Iteris · {config.repo}</Text>
		<Text bold>Instances <Text dimColor>· live project overview</Text></Text>
		<Instances states={states} selected={selected} workspace={config.workspace} answer={answer} />
		{error && <Text color="red">{error}</Text>}
		{answer.draft === null && <Text dimColor>↑/↓ select · {question(current) !== undefined ? 'Enter answer · ' : ''}q close monitor · tasks keep running</Text>}
	</Box>;
}
