import { Octokit } from '@octokit/rest';
import { resolveGithubToken } from '../github/auth.js';
import type { IterisConfig } from '../types.js';
import type { TaskRun } from './state.js';
export type CiResult = {
    state: 'passed' | 'waiting' | 'failed' | 'changed';
    details: string;
    head: string;
    base: string;
};
export async function verifyGithubCi(config: IterisConfig, run: TaskRun, octokit: Octokit = new Octokit({ auth: resolveGithubToken() })): Promise<CiResult> {
    if (!run.publication)
        throw new Error('CI requires publication');
    const [owner, repo] = config.repo.split('/') as [
        string,
        string
    ];
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: run.publication.number });
    const { data: branch } = await octokit.repos.getBranch({ owner, repo, branch: config.baseBranch });
    const live = { head: pr.head.sha, base: branch.commit.sha };
    if (pr.state === 'closed' && !pr.merged)
        return { ...live, state: 'failed', details: 'PR was closed without merging' };
    if (live.head !== run.publication.head)
        return { ...live, state: 'changed', details: 'Published head changed; review and checks must run again' };
    let required = config.verification.requiredCiChecks;
    // Whether the repository itself requires a branch to be up to date before merging.
    let strict = false;
    if (!required) {
        const discovered = new Set<string>();
        if (branch.protected) {
            // GitHub also reports a branch as protected when only rulesets cover it; classic protection
            // then answers 404 "Branch not protected", which means no classic rules, not a failed discovery.
            const protection = await octokit.repos.getBranchProtection({ owner, repo, branch: config.baseBranch }).then(response => response.data, error => {
                if ((error as { status?: number }).status === 404)
                    return undefined;
                throw error;
            });
            strict ||= protection?.required_status_checks?.strict === true;
            for (const check of protection?.required_status_checks?.contexts ?? [])
                discovered.add(check);
            for (const check of protection?.required_status_checks?.checks ?? [])
                discovered.add(check.context);
        }
        // Rulesets may impose required checks even without classic protection.
        const { data: rules } = await octokit.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { owner, repo, branch: config.baseBranch });
        for (const rule of rules as Array<{
            type: string;
            parameters?: {
                strict_required_status_checks_policy?: boolean;
                required_status_checks?: Array<{
                    context: string;
                }>;
            };
        }>)
            if (rule.type === 'required_status_checks') {
                strict ||= rule.parameters?.strict_required_status_checks_policy === true;
                for (const check of rule.parameters?.required_status_checks ?? [])
                    discovered.add(check.context);
            }
        required = [...discovered];
    }
    // An active base moves during every review and CI run. Evidence for the published commit stays
    // valid while the pull request still merges cleanly, unless the repository demands an up-to-date branch.
    if (live.base !== run.publication.base && !pr.merged) {
        if (strict)
            return { ...live, state: 'changed', details: 'The base moved and the repository requires an up-to-date branch; the base must be merged and verified again' };
        if (pr.mergeable === false)
            return { ...live, state: 'changed', details: 'The base moved and now conflicts with the published commit; the base must be merged and verified again' };
        if (pr.mergeable !== true)
            return { head: live.head, base: run.publication.base, state: 'waiting', details: 'The base moved; GitHub has not yet reported whether the pull request still merges cleanly' };
    }
    const current = { head: live.head, base: run.publication.base };
    if (!required.length)
        return { ...current, state: 'passed', details: 'Required-check discovery succeeded; repository requires no CI checks' };
    const runs = await octokit.paginate(octokit.checks.listForRef, { owner, repo, ref: current.head, per_page: 100 });
    const statuses = await octokit.paginate(octokit.repos.listCommitStatusesForRef, { owner, repo, ref: current.head, per_page: 100 });
    const freshness = run.ciFreshness?.head === current.head && run.ciFreshness.base === current.base ? Date.parse(run.ciFreshness.after) : undefined;
    const result = required.map(name => {
        const check = runs.filter(c => c.name === name).sort((a, b) => Date.parse(b.started_at ?? '') - Date.parse(a.started_at ?? ''))[0];
        const status = statuses.find(s => s.context === name);
        if (check) {
            const referencedBases = check.pull_requests?.map(pr => pr.base.sha) ?? [];
            const startedAfterReconciliation = freshness === undefined || Date.parse(check.started_at ?? '') >= freshness;
            // Only a reconciliation demands CI for one exact base; otherwise a run on the published commit is the evidence.
            const currentBase = startedAfterReconciliation && (freshness === undefined || !referencedBases.length || referencedBases.includes(current.base));
            return { name, state: !currentBase ? 'waiting' : check.status === 'completed' ? ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '') ? 'passed' : 'failed' : 'waiting' };
        }
        if (freshness !== undefined && (!status || Date.parse(status.updated_at) < freshness))
            return { name, state: 'waiting' };
        return { name, state: status?.state === 'success' ? 'passed' : ['failure', 'error'].includes(status?.state ?? '') ? 'failed' : 'waiting' };
    });
    return { ...current, state: result.some(r => r.state === 'failed') ? 'failed' : result.some(r => r.state === 'waiting') ? 'waiting' : 'passed', details: result.map(r => `${r.name}: ${r.state}`).join('\n') };
}
export async function setGithubDraft(config: IterisConfig, number: number, draft: boolean, octokit: Octokit = new Octokit({ auth: resolveGithubToken() })): Promise<void> {
    const [owner, repo] = config.repo.split('/') as [
        string,
        string
    ];
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: number });
    if (data.draft === draft)
        return;
    await octokit.graphql(draft ? 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}' : 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}', { id: data.node_id });
    if ((await octokit.pulls.get({ owner, repo, pull_number: number })).data.draft !== draft)
        throw new Error('PR readiness transition could not be verified');
}
