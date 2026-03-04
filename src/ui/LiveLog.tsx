import {Box, Text} from 'ink';

type LiveLogProps = {
	lines: string[];
	maxLines?: number;
};

export function LiveLog({lines, maxLines = 8}: LiveLogProps) {
	const visible = lines.slice(-maxLines);

	return (
		<Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
			<Text bold dimColor>Claude Code output:</Text>
			{visible.length === 0 && (
				<Text dimColor>(waiting for output...)</Text>
			)}
			{visible.map((line, i) => (
				<Text key={i} wrap="truncate">{`> ${line}`}</Text>
			))}
		</Box>
	);
}
