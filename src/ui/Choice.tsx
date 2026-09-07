import {useState} from 'react';
import {Box, Text, useInput, render} from 'ink';
export type ChoiceOption = {value: string; label: string};
export function Choice({title, options, initial, onSelect, onCancel}: {title: string; options: ChoiceOption[]; initial?: string; onSelect: (value: string) => void; onCancel: () => void}) {
	const [cursor, setCursor] = useState(Math.max(0, options.findIndex(option => option.value === initial)));
	useInput((input, key) => {
		if (key.escape || input === 'q') onCancel();
		else if (key.upArrow) setCursor(value => Math.max(0, value - 1));
		else if (key.downArrow) setCursor(value => Math.min(options.length - 1, value + 1));
		else if (key.return && options[cursor]) onSelect(options[cursor]!.value);
	});
	return <Box flexDirection="column"><Text bold color="magenta">{title}</Text>{options.map((option, index) => <Text key={option.value} color={index === cursor ? 'cyan' : 'gray'}>{index === cursor ? '> ' : '  '}{option.label}</Text>)}<Text dimColor>↑/↓ select · Enter confirm · Esc cancel</Text></Box>;
}
export async function choose(title: string, options: ChoiceOption[], initial?: string): Promise<string> {
	if (!process.stdin.isTTY) throw new Error(`${title}: interactive terminal required. Supply a command argument or run iteris setup in a terminal.`);
	return new Promise((resolve, reject) => {
		let completed = false;
		const view = render(<Choice title={title} options={options} initial={initial} onSelect={value => {completed = true; view.unmount(); resolve(value);}} onCancel={() => {completed = true; view.unmount(); reject(new Error('Cancelled'));}} />);
		void view.waitUntilExit().then(() => {if (!completed) reject(new Error('Cancelled'));});
	});
}
