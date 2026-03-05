import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {Provider} from '../types.js';

const providers: {value: Provider; label: string}[] = [
	{value: 'github', label: 'GitHub Projects'},
	{value: 'trello', label: 'Trello'},
];

type ProviderPickerProps = {
	onSelect: (provider: Provider) => void;
};

export function ProviderPicker({onSelect}: ProviderPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.upArrow || _input === 'k') {
			setCursor(prev => (prev > 0 ? prev - 1 : prev));
		} else if (key.downArrow || _input === 'j') {
			setCursor(prev => (prev < providers.length - 1 ? prev + 1 : prev));
		} else if (key.return) {
			onSelect(providers[cursor]!.value);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">Select a ticket source</Text>
			</Box>

			{providers.map((provider, i) => {
				const isCurrent = i === cursor;
				return (
					<Box key={provider.value} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{provider.label}</Text>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ navigate · Enter select</Text>
			</Box>
		</Box>
	);
}
