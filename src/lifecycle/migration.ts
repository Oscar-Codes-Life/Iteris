import {stateRoot} from '../state/workspace.js';
import { readFile, readdir, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { IterisConfig, Ticket } from '../types.js';
import { ticketBranch } from '../types.js';
import { ensureRun, readRun, saveRun, taskKey, taskFingerprint, waitFor, type TaskRun } from './state.js';
import { git } from '../review/context.js';
export async function importLegacyArtifacts(cwd: string, ticket: Ticket, config: IterisConfig, destination: string): Promise<TaskRun | undefined> {
    if (await readRun(cwd, taskKey(ticket, config)))
        return;
    const legacy = path.join(stateRoot(cwd), '.iteris', 'runs', ticket.custom ? `custom-${ticket.custom.identity}` : `${ticket.number}-${ticket.slug}`);
    let context: {
        ticket: Ticket;
        stamp?: {
            head: string;
            branch: string;
        };
    };
    try {
        context = JSON.parse(await readFile(path.join(legacy, 'review', 'context.json'), 'utf8'));
    }
    catch {
        return;
    }
    if (ticket.custom ? context.ticket.custom?.identity !== ticket.custom.identity : !ticket.htmlUrl || context.ticket.htmlUrl !== ticket.htmlUrl)
        return;
    await mkdir(destination, { recursive: true });
    await cp(legacy, destination, { recursive: true, force: false });
    const run = await ensureRun(cwd, ticket, config, destination, context.stamp?.branch ?? ticketBranch(ticket));
    try {
        run.plan = (await readFile(path.join(destination, 'plan.md'), 'utf8')).replace(/\n$/, '');
    }
    catch { /* no saved plan */ }
    if (taskFingerprint(context.ticket) === taskFingerprint(ticket) && context.stamp) {
        try {
            const head = git(cwd, ['rev-parse', run.branch]).trim();
            git(cwd, ['merge-base', '--is-ancestor', context.stamp.head, head]);
            run.implementation = { head, fingerprint: run.fingerprint };
        }
        catch { /* reconcile implementation */ }
    }
    let report: {
        outcome?: string;
        reason?: string;
    } = {};
    try {
        report = JSON.parse(await readFile(path.join(legacy, 'review', 'result.json'), 'utf8'));
    }
    catch { /* missing evidence */ }
    run.state = 'queued';
    run.phase = 'reconciliation';
    run.reason = `Imported legacy run: ${report.outcome ?? 'missing evidence'}. Current-commit evidence must be reconciled.`;
    const status = await readFile(path.join(legacy, 'status.md'), 'utf8').catch(() => '');
    const url = /\*\*PR\*\*:\s*(https?:\/\/\S+)/.exec(status)?.[1];
    if (url && context.stamp) {
        const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        if (number)
            run.publication = { url, number, head: context.stamp.head, base: 'unverified', draft: true };
    }
    if (run.source.provider === 'trello' && run.source.id.startsWith('legacy:'))
        waitFor(run, config, 'trello-identity', 'capability', 'Legacy Trello card needs a full stable identity', 'Resolve the card through the configured board before any external update');
    await saveRun(cwd, run);
    return run;
}
export async function migrateLegacyRuns(cwd: string, config: IterisConfig): Promise<void> {
    let directories;
    try {
        directories = await readdir(path.join(stateRoot(cwd), '.iteris', 'runs'), { withFileTypes: true });
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return;
        throw error;
    }
    for (const directory of directories.filter(d => d.isDirectory())) {
        let ticket: Ticket;
        try {
            const context = JSON.parse(await readFile(path.join(stateRoot(cwd), '.iteris', 'runs', directory.name, 'review', 'context.json'), 'utf8'));
            ticket = context.ticket;
        }
        catch {
            continue;
        }
        const provider = ticket.custom ? 'custom' : ticket.htmlUrl?.includes('trello.com/') ? 'trello' : ticket.htmlUrl?.includes('github.com/') ? 'github' : undefined;
        if (!provider || provider !== config.provider)
            continue;
        await importLegacyArtifacts(cwd, ticket, { ...config, provider }, path.join(stateRoot(cwd), '.iteris', 'tasks', taskKey(ticket, { ...config, provider }), 'artifacts'));
    }
}
