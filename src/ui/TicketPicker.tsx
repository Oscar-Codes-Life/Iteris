import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {Ticket, TicketStatus} from '../types.js';

export const ticketIdentity=(ticket:Ticket)=>ticket.source?JSON.stringify([ticket.source.provider,ticket.source.namespace,ticket.source.id]):ticket.custom?.identity??String(ticket.number);
const identity=ticketIdentity;

const priorityConfig: Record<string, {color: string; label: string}> = {
	p0: {color: 'red', label: 'p0'},
	p1: {color: 'yellow', label: 'p1'},
	p2: {color: 'cyan', label: 'p2'},
};

const statusBadge: Record<string, {color: string; label: string}> = {
	done: {color: 'green', label: '✓ Complete'},
	failed: {color: 'red', label: '✗ Failed'},
	blocked: {color: 'red', label: '! Review blocked'},
	incomplete: {color: 'yellow', label: '? Review incomplete'},
	waiting: {color: 'yellow', label: '… Waiting for evidence'},
	cancelled: {color: 'gray', label: '⊘ Cancelled'},
	stale: {color: 'gray', label: '⊘ Stale'},
};

type TicketPickerProps = {
	tickets: Ticket[];
	previousStatuses: Map<number, TicketStatus>;
	sourceStatuses?:Map<string,TicketStatus>;
	onSelect: (tickets: Ticket[]) => void;
};

export function TicketPicker({tickets, previousStatuses, sourceStatuses, onSelect}: TicketPickerProps) {
	const previousStatus=(ticket:Ticket)=>sourceStatuses?.get(identity(ticket)) ?? (ticket.source ? undefined : previousStatuses.get(ticket.number));
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<string>>(() => {
		const initial = new Set<string>();
		for (const ticket of tickets) {
			const status = previousStatus(ticket);
			if (status !== 'done' || ticket.custom?.changed) {
				initial.add(identity(ticket));
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
				if (next.has(identity(ticket))) {
					next.delete(identity(ticket));
				} else {
					next.add(identity(ticket));
				}

				return next;
			});
		} else if (input === 'a') {
			setSelected(prev => {
				const allSelected = tickets.every(t => prev.has(identity(t)));
				if (allSelected) {
					return new Set<string>();
				}

				return new Set(tickets.map(t => identity(t)));
			});
		} else if (key.return) {
			const chosen = tickets.filter(t => selected.has(identity(t)));
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
				const isSelected = selected.has(identity(ticket));
				const priority = ticket.labels.find(l => priorityConfig[l]);
				const pConfig = priority ? priorityConfig[priority] : undefined;
				const status = previousStatus(ticket);
				const badge = status ? statusBadge[status] : undefined;

				return (
					<Box key={identity(ticket)} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '[x]' : '[ ]'}</Text>
						<Text bold color={isCurrent ? 'white' : 'gray'}>#{ticket.number}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{ticket.title}</Text>
						{pConfig && (
							<Text color={pConfig.color}>[{pConfig.label}]</Text>
						)}
						{ticket.custom?.changed && <Text color="yellow">[Changed]</Text>}
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
