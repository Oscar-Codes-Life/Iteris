import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {TrelloList} from '../api.js';

type ListPickerProps = {
	lists: TrelloList[];
	onSelect: (list: TrelloList) => void;
};

export function ListPicker({lists, onSelect}: ListPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.upArrow || _input === 'k') {
			setCursor(prev => (prev > 0 ? prev - 1 : prev));
		} else if (key.downArrow || _input === 'j') {
			setCursor(prev => (prev < lists.length - 1 ? prev + 1 : prev));
		} else if (key.return) {
			onSelect(lists[cursor]!);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">Select a Trello list (column)</Text>
				<Text dimColor> ({lists.length} available)</Text>
			</Box>

			{lists.map((list, i) => {
				const isCurrent = i === cursor;
				return (
					<Box key={list.id} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{list.name}</Text>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ navigate · Enter select</Text>
			</Box>
		</Box>
	);
}
