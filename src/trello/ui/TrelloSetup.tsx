import {useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import type {TrelloCredentials} from '../auth.js';

type Step = 'apiKey' | 'token' | 'saving';

type TrelloSetupProps = {
	onComplete: (credentials: TrelloCredentials) => void;
};

export function TrelloSetup({onComplete}: TrelloSetupProps) {
	const {exit} = useApp();
	const [step, setStep] = useState<Step>('apiKey');
	const [apiKey, setApiKey] = useState('');
	const [token, setToken] = useState('');

	const currentValue = step === 'apiKey' ? apiKey : token;
	const setValue = step === 'apiKey' ? setApiKey : setToken;

	useInput((input, key) => {
		if (step === 'saving') return;

		if (key.escape) {
			exit();
			return;
		}

		if (key.return) {
			if (!currentValue.trim()) return;

			if (step === 'apiKey') {
				setStep('token');
			} else if (step === 'token') {
				setStep('saving');
				onComplete({apiKey: apiKey.trim(), token: token.trim()});
			}

			return;
		}

		if (key.backspace || key.delete) {
			setValue(prev => prev.slice(0, -1));
			return;
		}

		// Ignore control characters
		if (key.ctrl || key.meta) return;
		// Ignore arrow keys and other special keys
		if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
		if (key.tab) return;

		setValue(prev => prev + input);
	});

	const authUrl = apiKey.trim()
		? `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=${apiKey.trim()}`
		: '';

	return (
		<Box flexDirection="column" padding={1}>
			<Box gap={1}>
				<Text bold color="magenta">Iteris</Text>
				<Text bold>Trello Setup</Text>
			</Box>

			{/* Step 1: API Key */}
			<Box marginTop={1} flexDirection="column">
				<Text bold color={step === 'apiKey' ? 'white' : 'green'}>
					{step === 'apiKey' ? '>' : '✓'} Step 1: API Key
				</Text>
				{step === 'apiKey' ? (
					<Box flexDirection="column" marginLeft={2}>
						<Text>
							Get your API key at: <Text color="cyan" underline>https://trello.com/power-ups/admin</Text>
						</Text>
						<Box marginTop={1}>
							<Text>Paste your API key: </Text>
							<Text color="yellow">{apiKey || ''}</Text>
							<Text color="magenta">█</Text>
						</Box>
					</Box>
				) : (
					<Box marginLeft={2}>
						<Text dimColor>{apiKey.slice(0, 8)}...{apiKey.slice(-4)}</Text>
					</Box>
				)}
			</Box>

			{/* Step 2: Token */}
			{step !== 'apiKey' && (
				<Box marginTop={1} flexDirection="column">
					<Text bold color={step === 'token' ? 'white' : 'green'}>
						{step === 'token' ? '>' : '✓'} Step 2: Authorize & Get Token
					</Text>
					{step === 'token' ? (
						<Box flexDirection="column" marginLeft={2}>
							<Text>
								Open this URL to authorize Iteris:
							</Text>
							<Box marginTop={1}>
								<Text color="cyan" underline>{authUrl}</Text>
							</Box>
							<Box marginTop={1}>
								<Text dimColor>After clicking "Allow", copy the token shown on the page.</Text>
							</Box>
							<Box marginTop={1}>
								<Text>Paste your token: </Text>
								<Text color="yellow">{token || ''}</Text>
								<Text color="magenta">█</Text>
							</Box>
						</Box>
					) : (
						<Box marginLeft={2}>
							<Text dimColor>{token.slice(0, 8)}...{token.slice(-4)}</Text>
						</Box>
					)}
				</Box>
			)}

			{step === 'saving' && (
				<Box marginTop={1}>
					<Text color="green">Setting up credentials...</Text>
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					Enter to continue · Esc to quit
				</Text>
			</Box>
		</Box>
	);
}
