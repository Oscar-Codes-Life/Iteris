import {resolveGithubToken} from './auth.js';
import {Octokit} from '@octokit/rest';
import type {IterisConfig} from '../types.js';

export type PullRequest = {url: string; number: number};
export type NewPullRequest = {branch: string; title: string; body: string};

function createOctokit(): Octokit {
	return new Octokit({auth: resolveGithubToken()});
}

export async function findPrForBranch(config: IterisConfig, branch: string): Promise<PullRequest | undefined> {
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

export async function createPullRequest(config: IterisConfig, pullRequest: NewPullRequest, octokit: Octokit = createOctokit()): Promise<PullRequest> {
	const [owner, repo] = config.repo.split('/') as [string, string];
	const {data} = await octokit.pulls.create({
		owner,
		repo,
		head: pullRequest.branch,
		base: config.baseBranch,
		title: pullRequest.title,
		body: pullRequest.body,
		draft: config.pr.draft,
	});
	return {url: data.html_url, number: data.number};
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
