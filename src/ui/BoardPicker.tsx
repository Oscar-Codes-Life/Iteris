import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {TrelloBoard} from '../trello/api.js';

type BoardPickerProps = {
	boards: TrelloBoard[];
	onSelect: (board: TrelloBoard) => void;
};

export function BoardPicker({boards, onSelect}: BoardPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.upArrow || _input === 'k') {
			setCursor(prev => (prev > 0 ? prev - 1 : prev));
		} else if (key.downArrow || _input === 'j') {
			setCursor(prev => (prev < boards.length - 1 ? prev + 1 : prev));
		} else if (key.return) {
			onSelect(boards[cursor]!);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">Select a Trello board</Text>
				<Text dimColor> ({boards.length} available)</Text>
			</Box>

			{boards.map((board, i) => {
				const isCurrent = i === cursor;
				return (
					<Box key={board.id} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{board.name}</Text>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ navigate · Enter select</Text>
			</Box>
		</Box>
	);
}
