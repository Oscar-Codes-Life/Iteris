import {Box, Text, useApp, useInput} from 'ink';

type TokenErrorProps = {
	onRetry: () => void;
};

export function TokenError({onRetry}: TokenErrorProps) {
	const {exit} = useApp();

	useInput(input => {
		if (input === 'r') {
			onRetry();
		} else if (input === 'q') {
			exit();
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box gap={1}>
				<Text bold color="magenta">Iteris</Text>
				<Text bold color="red">Missing GitHub Token</Text>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text>
					GITHUB_TOKEN is not set. Iteris needs a GitHub token to fetch issues and create PRs.
				</Text>
				<Box marginTop={1}>
					<Text>
						Create a token at: <Text color="cyan" underline>https://github.com/settings/tokens/new</Text>
					</Text>
				</Box>
				<Box marginTop={1}>
					<Text>
						Then set it in your shell: <Text color="yellow">export GITHUB_TOKEN=ghp_...</Text>
					</Text>
				</Box>
			</Box>

			<Box marginTop={1}>
				<Text dimColor>
					Press <Text color="white" bold>r</Text> to reload · <Text color="white" bold>q</Text> to quit
				</Text>
			</Box>
		</Box>
	);
}
