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
    const current = { head: pr.head.sha, base: branch.commit.sha };
    if (pr.state === 'closed' && !pr.merged)
        return { ...current, state: 'failed', details: 'PR was closed without merging' };
    if (current.head !== run.publication.head || current.base !== run.publication.base)
        return { ...current, state: 'changed', details: 'Published head or current base changed; review and checks must run again' };
    let required = config.verification.requiredCiChecks;
    if (!required) {
        const discovered = new Set<string>();
        if (branch.protected) {
            const { data: protection } = await octokit.repos.getBranchProtection({ owner, repo, branch: config.baseBranch });
            for (const check of protection.required_status_checks?.contexts ?? [])
                discovered.add(check);
            for (const check of protection.required_status_checks?.checks ?? [])
                discovered.add(check.context);
        }
        // Rulesets may impose required checks even without classic protection.
        const { data: rules } = await octokit.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { owner, repo, branch: config.baseBranch });
        for (const rule of rules as Array<{
            type: string;
            parameters?: {
                required_status_checks?: Array<{
                    context: string;
                }>;
            };
        }>)
            if (rule.type === 'required_status_checks')
                for (const check of rule.parameters?.required_status_checks ?? [])
                    discovered.add(check.context);
        required = [...discovered];
    }
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
            const currentBase = startedAfterReconciliation && (!referencedBases.length || referencedBases.includes(current.base));
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
