import {Octokit} from '@octokit/rest';
import slugify_ from 'slugify';

const slugify = slugify_ as unknown as (input: string, options?: {lower?: boolean; strict?: boolean}) => string;
import type {IterisConfig, Ticket} from '../types.js';

export function createOctokit(): Octokit {
	return new Octokit({auth: process.env['GITHUB_TOKEN']});
}

export async function fetchTodoTickets(config: IterisConfig): Promise<Ticket[]> {
	const octokit = createOctokit();
	const [owner, repo] = config.repo.split('/') as [string, string];

	const {data: issues} = await octokit.issues.listForRepo({
		owner,
		repo,
		labels: config.todoLabel,
		state: 'open',
		sort: 'created',
		direction: 'asc',
		per_page: 100,
	});

	// Filter out pull requests (GitHub API returns PRs as issues too)
	const filtered = issues.filter(issue => !issue.pull_request);

	// Sort by priority label (p0 > p1 > p2) then creation date
	const priorityOrder = (labels: string[]): number => {
		if (labels.includes('p0')) return 0;
		if (labels.includes('p1')) return 1;
		if (labels.includes('p2')) return 2;
		return 3;
	};

	return filtered
		.map(issue => ({
			number: issue.number,
			title: issue.title,
			body: issue.body ?? '',
			slug: slugify(issue.title, {lower: true, strict: true}),
			labels: issue.labels
				.map(l => (typeof l === 'string' ? l : l.name ?? ''))
				.filter(Boolean),
			htmlUrl: issue.html_url,
		}))
		.sort((a, b) => priorityOrder(a.labels) - priorityOrder(b.labels));
}
