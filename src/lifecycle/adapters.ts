import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { IterisConfig, Ticket } from '../types.js';
import { resolveGithubToken } from '../github/auth.js';
import { fetchRepositoryIssues } from '../github/issues.js';
import { fetchProjectItems } from '../github/projects.js';
import { fetchTrelloTickets } from '../trello/tickets.js';
import { getCard, listBoardCards, findListByName, moveCard } from '../trello/api.js';
import { loadCustomTasks } from '../custom/cache.js';
import { executeCommand, CapabilityUnavailable } from './environment.js';
import { sourceIdentity, type TaskRun } from './state.js';
import { download } from '../custom/http.js';
import { atPath, identifyItems } from '../custom/identity.js';
import { customSettings } from '../custom/schema.js';
import { registerSecret } from '../harness/redact.js';
export interface TaskSourceAdapter {
    fetch(): Promise<Ticket[]>;
    refresh(ticket: Ticket): Promise<Ticket>;
    synchronize?(run: TaskRun): Promise<void>;
}
const ticketSchema = z.object({ id: z.string().min(1), number: z.number().int().positive(), title: z.string().min(1), body: z.string(), labels: z.array(z.string()), url: z.string() }).strict();
const responseSchema = z.object({ version: z.literal(1), ok: z.boolean(), tasks: z.array(ticketSchema).optional(), task: ticketSchema.optional(), verified: z.boolean().optional(), receipt: z.string().optional(), error: z.string().optional() }).strict();
export async function commandSource(config: IterisConfig, cwd: string, operation: 'fetch' | 'refresh' | 'synchronize', ticket?: Ticket, run?: TaskRun) {
    const adapter = config.integrations.source;
    if (!adapter)
        throw new CapabilityUnavailable('source-adapter', 'No command source adapter configured', 'Configure integrations.source');
    const result = await executeCommand(adapter.command, cwd, config, undefined, { version: 1, operation, repository: config.repo, source: ticket ? sourceIdentity(ticket, config) : { provider: 'command', namespace: adapter.namespace }, task: ticket, runKey: run?.key, publication: run?.publication, operationId: run?.actions.find(a => a.kind === 'source-status' && a.status !== 'verified')?.operationId });
    if (result.exitCode !== 0 || result.error || result.truncated)
        throw new Error(`Command adapter failed: ${result.error ?? result.output}`);
    const response = responseSchema.parse(JSON.parse(result.stdout ?? result.output));
    if (!response.ok)
        throw new Error(response.error ?? 'Command adapter reported failure');
    return response;
}
function commandTicket(task: z.infer<typeof ticketSchema>, config: IterisConfig): Ticket {
    return { source: { provider: 'command', namespace: config.integrations.source!.namespace, id: task.id }, number: task.number, title: task.title, body: task.body, labels: task.labels, htmlUrl: task.url, slug: task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') };
}
export function githubTaskRepository(ticket: Ticket, config: IterisConfig): string {
    if (ticket.source?.repository)
        return ticket.source.repository;
    try {
        const match = /^\/([^/]+\/[^/]+)\/issues\/\d+\/?$/.exec(new URL(ticket.htmlUrl).pathname);
        if (match)
            return match[1]!;
    }
    catch { /* legacy task with no URL */ }
    return config.repo;
}
export function sourceAdapter(config: IterisConfig, cwd: string, octokit: Octokit = new Octokit({ auth: resolveGithubToken() })): TaskSourceAdapter {
    const provider = config.provider ?? 'github';
    if (provider === 'command')
        return {
            async fetch() { const result = await commandSource(config, cwd, 'fetch'); if (!result.tasks)
                throw new Error('Adapter omitted tasks'); return result.tasks.map(task => commandTicket(task, config)); },
            async refresh(ticket) { if (ticket.source?.namespace !== config.integrations.source?.namespace)
                throw new CapabilityUnavailable('source-namespace', 'Configured command adapter belongs to another source namespace', 'Restore the adapter configuration for this task namespace'); const result = await commandSource(config, cwd, 'refresh', ticket); if (!result.task || result.task.id !== ticket.source?.id)
                throw new Error('Adapter refreshed another task'); return commandTicket(result.task, config); },
            async synchronize(run) { const result = await commandSource(config, cwd, 'synchronize', run.ticket, run); if (result.verified !== true)
                throw new Error('Adapter did not verify source status'); }
        };
    if (provider === 'trello')
        return {
            async fetch() { const result = await fetchTrelloTickets(config); if (result.kind !== 'tickets')
                throw new CapabilityUnavailable('trello-selection', 'Trello board/list selection missing', 'Run iteris setup'); return result.tickets; },
            async refresh(ticket) {
                const source = sourceIdentity(ticket, config);
                let card;
                if (source.id.startsWith('legacy:')) {
                    const matches = (await listBoardCards(source.namespace)).filter(c => c.idShort === ticket.number);
                    if (matches.length !== 1)
                        throw new CapabilityUnavailable('trello-identity', 'Legacy Trello identity is ambiguous or unavailable', 'Resolve the full card ID on the configured board');
                    card = matches[0]!;
                }
                else
                    card = await getCard(source.id);
                if (card.idBoard !== source.namespace)
                    throw new Error('Trello card belongs to another board');
                return { ...ticket, source: { provider: 'trello', namespace: card.idBoard, id: card.id }, title: card.name, body: card.desc, labels: card.labels.map(l => l.name), htmlUrl: card.shortUrl };
            },
            async synchronize(run) {
                if (run.source.provider !== 'trello' || run.source.id.startsWith('legacy:'))
                    throw new CapabilityUnavailable('trello-identity', 'Full Trello card identity is required', 'Refresh the source identity before synchronizing');
                const card = await getCard(run.source.id);
                if (card.idBoard !== run.source.namespace)
                    throw new Error('Trello board mismatch');
                const list = await findListByName(run.source.namespace, config.trello?.moveOnComplete ?? '');
                if (!list)
                    throw new Error('Configured completion list unavailable');
                if (card.idList !== list.id)
                    await moveCard(card.id, list.id);
                if ((await getCard(card.id)).idList !== list.id)
                    throw new Error('Trello completion move could not be verified');
            }
        };
    if (provider === 'custom')
        return {
            async fetch() { return (await loadCustomTasks(config, cwd, { refresh: true })).tickets; },
            async refresh(ticket) {
                const custom = customSettings(config.custom), token = process.env[custom.apiKeyEnv];
                if (!token)
                    throw new CapabilityUnavailable('custom-credentials', `Missing environment variable ${custom.apiKeyEnv}`, `Provide ${custom.apiKeyEnv} to refresh the task source`);
                registerSecret(token);
                const response = await download(custom.endpoint, { endpoint: custom.endpoint, token, signal: new AbortController().signal });
                const payload = JSON.parse(response.data.toString('utf8')), items = custom.itemsPath ? atPath(payload, custom.itemsPath.split('.')) : payload;
                if (!Array.isArray(items))
                    throw new Error('Custom itemsPath must resolve to an array');
                const original = identifyItems(items, custom).items.find(item => item.identity === ticket.custom?.identity);
                if (!original)
                    throw new CapabilityUnavailable('custom-task', 'Custom task no longer available', 'Restore the source task or cancel this run');
                // Unchanged source records need no model conversion, new attachment paths,
                // repository lock or replacement verification contract.
                if (original.fingerprint === ticket.custom?.fingerprint)
                    return ticket;
                const tickets = await this.fetch(), refreshed = tickets.find(t => t.custom?.identity === ticket.custom?.identity);
                if (!refreshed)
                    throw new CapabilityUnavailable('custom-task', 'Changed custom task could not be normalized', 'Refresh the custom import and resume');
                return { ...refreshed, source: ticket.source };
            }
        };
    return {
        async fetch() { return config.githubSource === 'projects' && config.projectNumber ? fetchProjectItems(octokit, config.repo.split('/')[0]!, config.projectNumber, config.todoStatus) : fetchRepositoryIssues(octokit, config.repo); },
        async refresh(ticket) { const [owner, repo] = githubTaskRepository(ticket, config).split('/') as [
            string,
            string
        ]; const { data } = await octokit.issues.get({ owner, repo, issue_number: ticket.number }); if (ticket.source?.issueId && data.node_id !== ticket.source.issueId)
            throw new Error('GitHub issue identity changed'); return { ...ticket, source: ticket.source && !ticket.source.projectItemId ? { ...ticket.source, id: String(data.id), issueId: data.node_id } : ticket.source, title: data.title, body: data.body ?? '', labels: data.labels.map(l => typeof l === 'string' ? l : l.name).filter((l): l is string => !!l) }; }
    };
}
