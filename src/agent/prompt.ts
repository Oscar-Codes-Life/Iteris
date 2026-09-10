import {ticketBranch} from '../types.js';
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
1. ${ticket.custom ? 'Checkout the task branch if it already exists locally or on origin; otherwise create it' : 'Create and checkout a new branch'}: \`${ticketBranch(ticket)}\`
2. Implement the changes described in the ticket
3. Run quality checks:
${qualityCheckLines}
4. If checks pass: commit all changes with message \`fix: #${ticket.number} — ${ticket.title}\`
5. Push the branch to origin
6. When fully done, print exactly: <task>done</task>

Do NOT create a pull request — Iteris will review the final changes and open it in a later phase.

## Memory from Previous Runs
${progressContent || '(no previous runs)'}
`;
}
