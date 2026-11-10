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

export const DESCRIPTION_START = '<!-- iteris:description:start -->';
export const DESCRIPTION_END = '<!-- iteris:description:end -->';
export function descriptionSection(description: string): string {return `${DESCRIPTION_START}\n${description.trim()}\n${DESCRIPTION_END}`;}
export function replaceDescriptionSection(body: string, description: string): string {
	const section = descriptionSection(description);
	const start = body.indexOf(DESCRIPTION_START), end = body.indexOf(DESCRIPTION_END, start);
	if (start >= 0 && end >= start) return body.slice(0, start) + section + body.slice(end + DESCRIPTION_END.length);
	// Bodies from before these markers: Iteris wrote everything from its "## Summary" down to the review section.
	// Text a person added above that heading stays.
	const review = body.indexOf(REVIEW_START);
	if (review < 0) return `${section}\n\n${body.trim()}`.trim();
	const summary = body.slice(0, review).search(/^## Summary\s*$/m);
	const kept = summary >= 0 ? body.slice(0, summary).trim() : body.slice(0, review).trim();
	return `${kept ? `${kept}\n\n` : ''}${section}\n\n${body.slice(review)}`;
}
/** Rewrites the sections given, in one update, leaving the rest of the body as it is. */
export async function updatePrSections(config: IterisConfig, number: number, sections: {description?: string; review?: string; lifecycle?: string}, octokit: Octokit = createOctokit()): Promise<void> {
	const [owner, repo] = config.repo.split('/') as [string, string];
	const {data} = await octokit.pulls.get({owner, repo, pull_number: number});
	let body = data.body ?? '';
	if (sections.description !== undefined) body = replaceDescriptionSection(body, sections.description);
	if (sections.review !== undefined) body = replaceReviewSection(body, sections.review);
	if (sections.lifecycle !== undefined) body = replaceLifecycleSection(body, sections.lifecycle);
	body = fitPrBody(body);
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
	// A review quotes commands and task files by absolute path; the account name on the machine that ran it is nobody's business.
	body = body.replace(/(?<![\w.-])\/(?:Users|home)\/[^\s\/'"`)<>]+/g, '~');
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

/** The stand-in a draft carries until its review passes. */
export const PENDING_DESCRIPTION = '_Iteris is still verifying this change.';
export function hasPlaceholderDescription(body: string): boolean {
	const review = body.indexOf(REVIEW_START);
	// The second and third are the stand-ins of earlier versions.
	return review >= 0 && (body.includes(PENDING_DESCRIPTION) || /^## Completion requirements\s*$|^- See the commits in this pull request\.\s*$/m.test(body.slice(0, review)));
}
function foldSection(body: string, start: string, end: string, fold: (inner: string) => string | undefined): string {
	const from = body.indexOf(start), to = body.indexOf(end, from);
	if (from < 0 || to < from) return body;
	const inner = body.slice(from + start.length, to), folded = inner.includes('<details>') ? undefined : fold(inner.trim());
	return folded === undefined ? body : `${body.slice(0, from + start.length)}\n${folded}\n${body.slice(to)}`;
}
/**
 * For a pull request whose run is no longer on this machine: the reports cannot be rendered again, so the
 * long lists older versions published are folded where they stand and the new description is put above them.
 */
export function healPublishedBody(body: string, description: string): string {
	return tidyPublishedBody(replaceDescriptionSection(body, description));
}
const VERDICT = /^\*\*(?:PASSED|BLOCKED|INCOMPLETE)\*\* — /;
const VERDICT_LIMIT = 400;
/** Idempotent, and needs no model: folds what older versions published at full length and drops harness noise above the description. */
export function tidyPublishedBody(body: string): string {
	let healed = body;
	const described = healed.indexOf(DESCRIPTION_START);
	// Lines a harness printed about its own output, which older versions published at the top of the body.
	if (described > 0) {
		const above = healed.slice(0, described).split('\n').filter(line => !/^(?:Warning: truncated output \(original token count: \d+\)|Total output lines: \d+)\s*$/.test(line)).join('\n').trim();
		healed = `${above ? `${above}\n\n` : ''}${healed.slice(described)}`;
	}
	// An incomplete review's verdict could run to a page; its first sentence stays visible, the rest joins the folded details.
	const from = healed.indexOf(REVIEW_START), to = healed.indexOf(REVIEW_END, from);
	if (from >= 0 && to > from) {
		const lines = healed.slice(from, to).split('\n'), index = lines.findIndex(line => VERDICT.test(line) && line.length > VERDICT_LIMIT);
		if (index >= 0) {
			const full = lines[index]!, cut = full.slice(0, VERDICT_LIMIT - 100), sentence = cut.lastIndexOf('. ');
			lines[index] = `${(sentence > 80 ? cut.slice(0, sentence + 1) : `${cut}…`)} _Full verdict in the review details._`;
			const folded = lines.findIndex(line => line === '<summary>Review details</summary>');
			// Quoted, so that a second pass does not take the full text for a verdict line again.
			if (folded >= 0) lines.splice(folded + 1, 0, '', 'Full verdict:', '', `> ${full}`);
			else {
				// Ahead of the first detail heading, so the header lines under the verdict stay where they are.
				const heading = lines.findIndex((line, at) => at > index && line.startsWith('### '));
				lines.splice(heading >= 0 ? heading : lines.length, 0, '### Full verdict', '', `> ${full}`, '');
			}
			healed = healed.slice(0, from) + lines.join('\n') + healed.slice(to);
		}
	}
	healed = foldSection(healed, REVIEW_START, REVIEW_END, inner => {
		const detail = inner.search(/^### /m);
		return detail < 0 ? undefined : `${inner.slice(0, detail).trim()}\n\n<details>\n<summary>Review details</summary>\n\n${inner.slice(detail).trim()}\n\n</details>`;
	});
	healed = foldSection(healed, LIFECYCLE_START, LIFECYCLE_END, inner => {
		const state = /^State: \*\*(\w+)\*\*/m.exec(inner)?.[1];
		if (!state) return undefined;
		const record = inner.replace(/^## Task completion\s*/, '').replace(/^# .*\n+/, '').trim();
		return `## Task completion\n<details>\n<summary>Iteris's record when it last updated this pull request: ${state}</summary>\n\n${record}\n\n</details>`;
	});
	return fitPrBody(healed);
}
export type PublishedPr = {number: number; url: string; title: string; body: string; state: string};
/** Every pull request in the repository, open or not, whose body Iteris wrote. */
export async function listIterisPrs(config: IterisConfig, octokit: Octokit = createOctokit()): Promise<PublishedPr[]> {
	const [owner, repo] = config.repo.split('/') as [string, string];
	const prs = await octokit.paginate(octokit.pulls.list, {owner, repo, state: 'all', per_page: 100});
	return prs.filter(pr => (pr.body ?? '').includes(REVIEW_START)).map(pr => ({number: pr.number, url: pr.html_url, title: pr.title, body: pr.body ?? '', state: pr.merged_at ? 'merged' : pr.state}));
}
/** Commit subjects and the diff as GitHub has them, which also works for a merged pull request whose branch is gone. */
export async function prChanges(config: IterisConfig, number: number, octokit: Octokit = createOctokit()): Promise<{commits: string; diff: string}> {
	const [owner, repo] = config.repo.split('/') as [string, string];
	const commits = (await octokit.paginate(octokit.pulls.listCommits, {owner, repo, pull_number: number, per_page: 100})).map(commit => commit.commit.message.split('\n')[0]).join('\n');
	let diff: string;
	try {
		diff = (await octokit.pulls.get({owner, repo, pull_number: number, mediaType: {format: 'diff'}})).data as unknown as string;
	} catch {
		// GitHub refuses one diff for a very large pull request; the per-file patches are still served.
		const files = await octokit.paginate(octokit.pulls.listFiles, {owner, repo, pull_number: number, per_page: 100});
		diff = files.map(file => `--- ${file.filename} (${file.status})\n${file.patch ?? '(no text patch)'}`).join('\n');
	}
	return {commits: commits || '(none)', diff: diff || '(no changes)'};
}
export async function updatePrBody(config: IterisConfig, number: number, body: string, octokit: Octokit = createOctokit()): Promise<void> {
	const [owner, repo] = config.repo.split('/') as [string, string];
	await octokit.pulls.update({owner, repo, pull_number: number, body: fitPrBody(body)});
}
