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
		body: fitPrBody(pullRequest.body),
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

export const REVIEW_START = '<!-- iteris:review:start -->';
export const REVIEW_END = '<!-- iteris:review:end -->';
export function reviewSection(report: string): string {return `${REVIEW_START}\n${report}\n${REVIEW_END}`;}
export function replaceReviewSection(body: string, report: string): string {
	const start = body.indexOf(REVIEW_START), end = body.indexOf(REVIEW_END, start);
	if (start >= 0 && end >= start) return body.slice(0, start) + reviewSection(report) + body.slice(end + REVIEW_END.length);
	return `${body.trim()}\n\n${reviewSection(report)}`;
}
export async function updatePrReview(config: IterisConfig, number: number, report: string, octokit: Octokit = createOctokit()): Promise<void> {
	const [owner, repo] = config.repo.split('/') as [string, string];
	const {data} = await octokit.pulls.get({owner, repo, pull_number: number});
	const body = fitPrBody(replaceReviewSection(data.body ?? '', report));
	if (body !== data.body) await octokit.pulls.update({owner, repo, pull_number: number, body});
}

export const LIFECYCLE_START = '<!-- iteris:lifecycle:start -->';
export const LIFECYCLE_END = '<!-- iteris:lifecycle:end -->';
export function replaceLifecycleSection(body: string, report: string): string {
	const section = `${LIFECYCLE_START}\n## Task completion\n${report}\n${LIFECYCLE_END}`;
	const start = body.indexOf(LIFECYCLE_START), end = body.indexOf(LIFECYCLE_END, start);
	if (start >= 0 && end >= start) return body.slice(0,start) + section + body.slice(end + LIFECYCLE_END.length);
	return `${body.trim()}\n\n${section}`;
}
/** GitHub rejects a pull request body over 65,536 characters; a large review plus the completion report exceeds it. */
export const PR_BODY_LIMIT = 65_000;
const TRUNCATED = "\n\n[Truncated to fit GitHub's size limit; the complete report remains in the local Iteris run.]";
/** Shrinks the generated sections, keeping their markers so later updates still replace them in place. */
export function fitPrBody(body: string, limit = PR_BODY_LIMIT): string {
	for (const [start, end] of [[REVIEW_START, REVIEW_END], [LIFECYCLE_START, LIFECYCLE_END]] as const) {
		if (body.length <= limit) return body;
		const from = body.indexOf(start), to = body.indexOf(end, from);
		if (from < 0 || to < from) continue;
		const inner = body.slice(from + start.length, to);
		const keep = Math.max(0, inner.length - (body.length - limit) - TRUNCATED.length - 1);
		body = body.slice(0, from + start.length) + inner.slice(0, keep) + TRUNCATED + '\n' + body.slice(to);
	}
	return body.length <= limit ? body : body.slice(0, limit - TRUNCATED.length) + TRUNCATED;
}
export async function updatePrLifecycle(config: IterisConfig, number: number, report: string, octokit: Octokit = createOctokit()): Promise<void> {
	const [owner,repo] = config.repo.split('/') as [string,string];
	const {data} = await octokit.pulls.get({owner,repo,pull_number:number});
	const body = fitPrBody(replaceLifecycleSection(data.body ?? '',report));
	if (body !== data.body) await octokit.pulls.update({owner,repo,pull_number:number,body});
}
