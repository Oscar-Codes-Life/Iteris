import type {IterisConfig, Ticket} from '../types.js';

export function expandPrompt(ticket: Ticket, config: IterisConfig, progressContent: string): string {
	const qualityCheckLines = config.qualityChecks.length > 0
		? config.qualityChecks.map(cmd => `   - \`${cmd}\``).join('\n')
		: '   - (no quality checks configured)';

	return `You are an autonomous software engineer working on a GitHub repository.

## Your Task
Ticket: #${ticket.number} — ${ticket.title}
Description:
${ticket.body}

## Instructions
1. Create and checkout a new branch: \`iteris/${ticket.number}-${ticket.slug}\`
2. Implement the changes described in the ticket
3. Run quality checks:
${qualityCheckLines}
4. If checks pass: commit all changes with message \`fix: #${ticket.number} — ${ticket.title}\`
5. Push the branch to origin
6. When fully done, print exactly: <task>done</task>

Do NOT create a pull request — a separate review agent will handle that.

## Memory from Previous Runs
${progressContent || '(no previous runs)'}
`;
}
