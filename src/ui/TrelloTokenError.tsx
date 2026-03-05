import {Box, Text, useApp, useInput} from 'ink';

type TrelloTokenErrorProps = {
	onRetry: () => void;
};

export function TrelloTokenError({onRetry}: TrelloTokenErrorProps) {
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
				<Text bold color="red">Missing Trello Credentials</Text>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text>
					TRELLO_API_KEY and TRELLO_TOKEN are not set. Iteris needs these to fetch Trello cards.
				</Text>
				<Box marginTop={1}>
					<Text>
						1. Get your API key at: <Text color="cyan" underline>https://trello.com/power-ups/admin</Text>
					</Text>
				</Box>
				<Box>
					<Text>
						2. Generate a token from the API key page
					</Text>
				</Box>
				<Box marginTop={1}>
					<Text>
						Then set them in your shell:{'\n'}
						<Text color="yellow">  export TRELLO_API_KEY=your_key</Text>{'\n'}
						<Text color="yellow">  export TRELLO_TOKEN=your_token</Text>
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
