import type {Octokit} from '@octokit/rest';
import slugify_ from 'slugify';
import type {Ticket} from '../types.js';

const slugify = slugify_ as unknown as (input: string, options?: {lower?: boolean; strict?: boolean}) => string;

export async function fetchRepositoryIssues(octokit: Octokit, repository: string): Promise<Ticket[]> {
	const [owner, repo] = repository.split('/') as [string, string];
	const issues = await octokit.paginate(octokit.issues.listForRepo, {
		owner, repo, state: 'open', sort: 'created', direction: 'asc', per_page: 100,
	});
	// GitHub's issues endpoint includes PRs. Only actual open issues belong in
	// the ticket picker; project Status fields do not apply to this source.
	const tickets: Ticket[] = issues.filter(issue => !issue.pull_request && issue.state === 'open').map(issue => ({
		number: issue.number,
		title: issue.title,
		body: issue.body ?? '',
		slug: slugify(issue.title, {lower: true, strict: true}),
		labels: issue.labels.map(label => typeof label === 'string' ? label : label.name).filter((label): label is string => typeof label === 'string'),
		htmlUrl: issue.html_url,
	}));
	const priority = (ticket: Ticket) => {
		for (let rank = 0; rank < 3; rank++) if (ticket.labels.includes(`p${rank}`)) return rank;
		return 3;
	};
	// Stable sort retains oldest-first order within the same priority.
	return tickets.sort((a, b) => priority(a) - priority(b));
}
