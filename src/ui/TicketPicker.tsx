import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {Ticket} from '../types.js';

const priorityConfig: Record<string, {color: string; label: string}> = {
	p0: {color: 'red', label: 'p0'},
	p1: {color: 'yellow', label: 'p1'},
	p2: {color: 'cyan', label: 'p2'},
};

type TicketPickerProps = {
	tickets: Ticket[];
	onSelect: (ticket: Ticket) => void;
};

export function TicketPicker({tickets, onSelect}: TicketPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.upArrow || _input === 'k') {
			setCursor(prev => (prev > 0 ? prev - 1 : prev));
		} else if (key.downArrow || _input === 'j') {
			setCursor(prev => (prev < tickets.length - 1 ? prev + 1 : prev));
		} else if (key.return) {
			onSelect(tickets[cursor]!);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">Select a ticket to build</Text>
				<Text dimColor> ({tickets.length} available)</Text>
			</Box>

			{tickets.map((ticket, i) => {
				const isCurrent = i === cursor;
				const priority = ticket.labels.find(l => priorityConfig[l]);
				const pConfig = priority ? priorityConfig[priority] : undefined;

				return (
					<Box key={ticket.number} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text bold color={isCurrent ? 'white' : 'gray'}>#{ticket.number}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{ticket.title}</Text>
						{pConfig && (
							<Text color={pConfig.color}>[{pConfig.label}]</Text>
						)}
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ navigate · Enter select</Text>
			</Box>
		</Box>
	);
}
