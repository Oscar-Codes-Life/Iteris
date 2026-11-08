import {ticketBranch} from '../types.js';
import type {IterisConfig, Ticket} from '../types.js';

export function expandPrompt(ticket: Ticket, config: IterisConfig, progressContent: string, attemptHistory = ''): string {
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
4. Make the quality checks pass, then commit the implementation with message \`fix: #${ticket.number} — ${ticket.title}\`. The task is finished only when its checks and the independent review pass. If a check genuinely cannot run here (for example it needs hosted CI or credentials this environment lacks), never fake or skip it: record the exact command and output in your final message and commit the rest of the work. Iteris verifies independently and retries unfinished work with a fresh instance that receives the recorded cause.
5. Leave the branch committed and the working tree clean. Do not push; Iteris publishes only after independent review.
6. When fully done, print exactly: <task>done</task>

Do NOT create a pull request — Iteris will review the final changes and open it in a later phase.
${attemptHistory ? `\n${attemptHistory}` : ''}
## Memory from Previous Runs
${progressContent || '(no previous runs)'}
`;
}
