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
1. Checkout the task branch if it already exists locally or on origin; otherwise create it: \`${ticketBranch(ticket)}\`
2. Implement the changes described in the ticket
3. Run quality checks:
${qualityCheckLines}
4. Fix failures in checks that can run locally, then commit all changes with message \`fix: #${ticket.number} — ${ticket.title}\`. If a check needs unavailable hosted CI credentials or infrastructure, record the exact pending check and commit without waiting for CI; Iteris will open the PR so that gate can run there.
5. Leave the branch committed and the working tree clean. Do not push; Iteris publishes only after independent review.
6. When fully done, print exactly: <task>done</task>

Do NOT create a pull request — Iteris will review the final changes and open it in a later phase.

## Memory from Previous Runs
${progressContent || '(no previous runs)'}
`;
}
