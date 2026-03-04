import {Octokit} from '@octokit/rest';
import type {IterisConfig} from '../types.js';

function createOctokit(): Octokit {
	return new Octokit({auth: process.env['GITHUB_TOKEN']});
}

export async function findPrForBranch(config: IterisConfig, branch: string): Promise<{url: string; number: number} | undefined> {
	const octokit = createOctokit();
	const [owner, repo] = config.repo.split('/') as [string, string];

	const {data: prs} = await octokit.pulls.list({
		owner,
		repo,
		head: `${owner}:${branch}`,
		state: 'open',
	});

	if (prs.length > 0) {
		return {
			url: prs[0]!.html_url,
			number: prs[0]!.number,
		};
	}

	return undefined;
}

export async function addLabelToIssue(config: IterisConfig, issueNumber: number, label: string): Promise<void> {
	const octokit = createOctokit();
	const [owner, repo] = config.repo.split('/') as [string, string];

	await octokit.issues.addLabels({
		owner,
		repo,
		issue_number: issueNumber,
		labels: [label],
	});
}
