import type {IterisConfig, Ticket} from '../types.js';

export function expandPrompt(ticket: Ticket, config: IterisConfig, progressContent: string): string {
	const qualityCheckLines = config.qualityChecks.length > 0
		? config.qualityChecks.map(cmd => `   - \`${cmd}\``).join('\n')
		: '   - (no quality checks configured)';

	const prDraftNote = config.pr.draft ? ' (as draft)' : '';

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
6. Open a PR${prDraftNote} targeting \`${config.baseBranch}\` with:
   - Title: \`${ticket.title}\`
   - Body referencing the ticket: \`Closes #${ticket.number}\`
7. When fully done, print exactly: <task>done</task>

## Memory from Previous Runs
${progressContent || '(no previous runs)'}
`;
}
