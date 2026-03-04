import {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import terminalImage from 'terminal-image';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

type WelcomeProps = {
	onContinue: () => void;
};

export function Welcome({onContinue}: WelcomeProps) {
	const [icon, setIcon] = useState<string | undefined>();

	useEffect(() => {
		const dirname = path.dirname(fileURLToPath(import.meta.url));
		const iconPath = path.resolve(dirname, '..', '..', 'assets', 'iteris-icon.png');

		terminalImage.file(iconPath, {width: 20})
			.then(setIcon)
			.catch(() => {
				// Terminal doesn't support images — skip
			});
	}, []);

	useInput(() => {
		onContinue();
	});

	return (
		<Box flexDirection="column" padding={1}>
			{icon && <Text>{icon}</Text>}

			<Box flexDirection="column">
				<Box gap={1}>
					<Text bold color="magenta">Iteris</Text>
					<Text dimColor>—</Text>
					<Text>Autonomous agent that pulls GitHub tickets, ships them via Claude Code,</Text>
				</Box>
				<Text>and manages the full lifecycle from branch to PR.</Text>
				<Text dimColor>Powered by Claude Code · Built by Oscar Gallo</Text>
			</Box>

			<Box marginTop={1}>
				<Text dimColor>Press any key to continue</Text>
			</Box>
		</Box>
	);
}
