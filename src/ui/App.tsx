import {useState, useEffect, useCallback} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import type {IterisConfig, Ticket, TicketState} from '../types.js';
import {runAllTickets, type RunnerCallbacks} from '../agent/runner.js';
import {TicketRow} from './TicketRow.js';
import {LiveLog} from './LiveLog.js';

type AppProps = {
	config: IterisConfig;
	tickets: Ticket[];
	cwd: string;
};

type FailurePrompt = {
	ticketNumber: number;
	resolve: (decision: 'retry' | 'skip') => void;
};

export function App({config, tickets, cwd}: AppProps) {
	const {exit} = useApp();
	const [states, setStates] = useState<Map<number, TicketState>>(() => {
		const initial = new Map<number, TicketState>();
		for (const ticket of tickets) {
			initial.set(ticket.number, {
				ticket,
				status: 'pending',
				branch: `iteris/${ticket.number}-${ticket.slug}`,
				logLines: [],
				elapsedMs: 0,
			});
		}

		return initial;
	});

	const [activeTicket, setActiveTicket] = useState<number | null>(null);
	const [isFinished, setIsFinished] = useState(false);
	const [failurePrompt, setFailurePrompt] = useState<FailurePrompt | null>(null);

	// Elapsed time ticker
	useEffect(() => {
		const interval = setInterval(() => {
			if (activeTicket === null) return;

			setStates(prev => {
				const next = new Map(prev);
				const current = next.get(activeTicket);
				if ((current?.status === 'running' || current?.status === 'reviewing') && current.startedAt) {
					next.set(activeTicket, {
						...current,
						elapsedMs: Date.now() - current.startedAt.getTime(),
					});
				}

				return next;
			});
		}, 1000);

		return () => {
			clearInterval(interval);
		};
	}, [activeTicket]);

	const updateState = useCallback((ticketNumber: number, state: TicketState) => {
		setStates(prev => {
			const next = new Map(prev);
			next.set(ticketNumber, state);
			return next;
		});
	}, []);

	// Start runner
	useEffect(() => {
		const callbacks: RunnerCallbacks = {
			onStatusChange(ticketNumber, state) {
				if (state.status === 'running') {
					setActiveTicket(ticketNumber);
				}

				updateState(ticketNumber, state);
			},
			onLogLine(_ticketNumber, _line) {
				// State updates handled by onStatusChange
			},
			onComplete(ticketNumber, state) {
				updateState(ticketNumber, state);
				setActiveTicket(null);
			},
			async onFailure(ticketNumber, state) {
				updateState(ticketNumber, state);
				setActiveTicket(null);

				return new Promise<'retry' | 'skip'>(resolve => {
					setFailurePrompt({ticketNumber, resolve});
				});
			},
		};

		void runAllTickets(tickets, config, cwd, callbacks).then(() => {
			setIsFinished(true);
		});
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// Handle keyboard input
	useInput((input, _key) => {
		if (failurePrompt) {
			if (input === 'r') {
				failurePrompt.resolve('retry');
				setFailurePrompt(null);
			} else if (input === 's') {
				failurePrompt.resolve('skip');
				setFailurePrompt(null);
			}
		}

		if (isFinished && input === 'q') {
			exit();
		}
	});

	const remaining = [...states.values()].filter(s => s.status === 'pending' || s.status === 'running' || s.status === 'reviewing').length;
	const activeState = activeTicket ? states.get(activeTicket) : null;

	return (
		<Box flexDirection="column" padding={1}>
			{/* Header */}
			<Box gap={1}>
				<Text bold color="magenta">Iteris</Text>
				<Text dimColor>{config.repo}</Text>
				{!isFinished && <Text>{remaining} ticket{remaining !== 1 ? 's' : ''} remaining</Text>}
				{isFinished && <Text color="green">All tickets complete</Text>}
			</Box>

			<Box marginTop={1} />

			{/* Ticket rows */}
			<Box flexDirection="column">
				{[...states.values()].map(state => (
					<TicketRow key={state.ticket.number} state={state} />
				))}
			</Box>

			{/* Live log for active ticket */}
			{activeState && (activeState.status === 'running' || activeState.status === 'reviewing') && (
				<LiveLog lines={activeState.logLines} />
			)}

			{/* Failure prompt */}
			{failurePrompt && (
				<Box marginTop={1}>
					<Text color="red" bold>
						Ticket #{failurePrompt.ticketNumber} failed. Press <Text color="white">r</Text> to retry, <Text color="white">s</Text> to skip
					</Text>
				</Box>
			)}

			{/* Footer */}
			{isFinished && (
				<Box marginTop={1}>
					<Text dimColor>Press q to exit</Text>
				</Box>
			)}
		</Box>
	);
}
