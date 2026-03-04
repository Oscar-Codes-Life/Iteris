import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {Ticket, TicketStatus} from '../types.js';

const priorityConfig: Record<string, {color: string; label: string}> = {
	p0: {color: 'red', label: 'p0'},
	p1: {color: 'yellow', label: 'p1'},
	p2: {color: 'cyan', label: 'p2'},
};

const statusBadge: Record<string, {color: string; label: string}> = {
	done: {color: 'green', label: '✓ Complete'},
	failed: {color: 'red', label: '✗ Failed'},
	stale: {color: 'gray', label: '⊘ Stale'},
};

type TicketPickerProps = {
	tickets: Ticket[];
	previousStatuses: Map<number, TicketStatus>;
	onSelect: (tickets: Ticket[]) => void;
};

export function TicketPicker({tickets, previousStatuses, onSelect}: TicketPickerProps) {
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<number>>(() => {
		const initial = new Set<number>();
		for (const ticket of tickets) {
			const status = previousStatuses.get(ticket.number);
			if (status !== 'done') {
				initial.add(ticket.number);
			}
		}

		return initial;
	});

	useInput((input, key) => {
		if (key.upArrow || input === 'k') {
			setCursor(prev => (prev > 0 ? prev - 1 : prev));
		} else if (key.downArrow || input === 'j') {
			setCursor(prev => (prev < tickets.length - 1 ? prev + 1 : prev));
		} else if (input === ' ') {
			const ticket = tickets[cursor]!;
			setSelected(prev => {
				const next = new Set(prev);
				if (next.has(ticket.number)) {
					next.delete(ticket.number);
				} else {
					next.add(ticket.number);
				}

				return next;
			});
		} else if (input === 'a') {
			setSelected(prev => {
				const allSelected = tickets.every(t => prev.has(t.number));
				if (allSelected) {
					return new Set<number>();
				}

				return new Set(tickets.map(t => t.number));
			});
		} else if (key.return && selected.size > 0) {
			const chosen = tickets.filter(t => selected.has(t.number));
			onSelect(chosen);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">Select tickets to build</Text>
				<Text dimColor> ({tickets.length} available)</Text>
			</Box>

			{tickets.map((ticket, i) => {
				const isCurrent = i === cursor;
				const isSelected = selected.has(ticket.number);
				const priority = ticket.labels.find(l => priorityConfig[l]);
				const pConfig = priority ? priorityConfig[priority] : undefined;
				const status = previousStatuses.get(ticket.number);
				const badge = status ? statusBadge[status] : undefined;

				return (
					<Box key={ticket.number} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '[x]' : '[ ]'}</Text>
						<Text bold color={isCurrent ? 'white' : 'gray'}>#{ticket.number}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{ticket.title}</Text>
						{pConfig && (
							<Text color={pConfig.color}>[{pConfig.label}]</Text>
						)}
						{badge && (
							<Text color={badge.color}>{badge.label}</Text>
						)}
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ navigate · Space toggle · a all · Enter confirm ({selected.size} selected)</Text>
			</Box>
		</Box>
	);
}
