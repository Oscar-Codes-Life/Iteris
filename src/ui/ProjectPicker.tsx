import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {ProjectInfo} from '../github/projects.js';

type ProjectPickerProps = {
	projects: ProjectInfo[];
	onSelect: (project: ProjectInfo) => void;
};

export function ProjectPicker({projects, onSelect}: ProjectPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.upArrow || _input === 'k') {
			setCursor(prev => (prev > 0 ? prev - 1 : prev));
		} else if (key.downArrow || _input === 'j') {
			setCursor(prev => (prev < projects.length - 1 ? prev + 1 : prev));
		} else if (key.return) {
			onSelect(projects[cursor]!);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">Select a GitHub Project</Text>
				<Text dimColor> ({projects.length} available)</Text>
			</Box>

			{projects.map((project, i) => {
				const isCurrent = i === cursor;
				return (
					<Box key={project.number} gap={1}>
						<Text color={isCurrent ? 'magenta' : 'gray'}>{isCurrent ? '>' : ' '}</Text>
						<Text bold color={isCurrent ? 'white' : 'gray'}>#{project.number}</Text>
						<Text color={isCurrent ? 'white' : 'gray'}>{project.title}</Text>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ navigate · Enter select</Text>
			</Box>
		</Box>
	);
}
