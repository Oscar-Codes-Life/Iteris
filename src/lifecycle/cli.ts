import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { IterisConfig } from '../types.js';
import { listRuns, readRun, saveRun, renderRun } from './state.js';
import { prepareEnvironment, persistedManifest, resolveExecutable } from './environment.js';
import { runCommand } from '../review/command.js';
import { addEvidence } from './requirements.js';
import { runWorker } from './worker.js';
import { acquireRun, hasActiveRun } from '../state/active.js';
import { requestCancellation } from './cancellation.js';
import { resolveTaskConfig } from './config.js';
import path from 'node:path';
export async function lifecycleCommand(command: string, args: string[], config: IterisConfig, cwd: string): Promise<boolean> {
    if (!['status', 'resume', 'doctor', 'evidence', 'cancel'].includes(command))
        return false;
    if (command === 'status') {
        const runs = args[0] ? [await readRun(cwd, args[0])].filter(Boolean) : await listRuns(cwd, config.repo);
        for (const run of runs)
            if (run)
                console.log(`${run.key}\n${renderRun(run)}`);
        if (!runs.length)
            console.log('No persisted task runs.');
        return true;
    }
    if (command === 'doctor') {
        const snapshot = structuredClone(config);
        snapshot.recovery.enabled = false;
        const manifest = await prepareEnvironment(snapshot, cwd), executable = await resolveExecutable(config.harness, cwd, manifest.path);
        const harness = await runCommand(executable, ['--version'], { cwd, env: { ...process.env, PATH: manifest.path }, deadline: Date.now() + 30000 });
        console.log(JSON.stringify({ environment: persistedManifest(manifest), harness: { name: config.harness, executable, version: harness.output.trim(), available: harness.exitCode === 0 }, stages: config.verification.stages.map(stage => ({ id: stage.id, kind: stage.kind, verification: !!stage.verify, executionEnabled: config.integrations.externalActions.includes(stage.id) })) }, null, 2));
        return true;
    }
    if (command === 'resume') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.on('SIGINT', abort);
        process.on('SIGTERM', abort);
        try {
            await runWorker({ config, cwd, once: args.includes('--once'), force: true, signal: controller.signal, callbacks: { onStatusChange(_, state) { console.log(`${state.ticket.title}: ${state.status}${state.failureReason ? ` — ${state.failureReason}` : ''}`); }, onLogLine(_, line) { console.log(line); }, onComplete() { } } });
        }
        finally {
            process.off('SIGINT', abort);
            process.off('SIGTERM', abort);
        }
        return true;
    }
    const key = args[0];
    if (!key)
        throw new Error(`${command} requires a task key from iteris status`);
    if (!await readRun(cwd, key))
        throw new Error('Task run not found');
    if (command === 'cancel') {
        await requestCancellation(cwd, key);
        if (!await hasActiveRun(cwd)) {
            const release = await acquireRun(cwd);
            try {
                const run = (await readRun(cwd, key))!;
                run.state = 'cancelled';
                run.phase = 'cancelled';
                run.reason = 'Cancelled explicitly';
                await saveRun(cwd, run);
            }
            finally {
                await release();
            }
        }
        console.log('Cancellation recorded. The active task stops at the next cancellation checkpoint.');
        return true;
    }
    const filename = args[1];
    if (!filename)
        throw new Error('Usage: iteris evidence <task-key> <receipt.json>');
    const receipt = z.object({ version: z.literal(1), requirementId: z.string(), commit: z.string(), build: z.string().optional(), observedAt: z.string().datetime(), provenance: z.string().min(1), details: z.string().min(1), success: z.boolean() }).strict().parse(JSON.parse(await readFile(filename, 'utf8')));
    const release = await acquireRun(cwd);
    try {
        const run = (await readRun(cwd, key))!;
        const requirement = run.requirements.find(r => r.id === receipt.requirementId);
        if (!requirement || ['local', 'review', 'publication', 'ci'].includes(requirement.stage))
            throw new Error('Submitted evidence must reference an external acceptance requirement');
        if (receipt.commit !== (run.publication?.head ?? run.implementation?.head))
            throw new Error('Evidence references another commit');
        if (Date.parse(receipt.observedAt) > Date.now() + 60000)
            throw new Error('Evidence observation time is in the future');
        let files: string[] = [];
        try {
            files = JSON.parse(await readFile(path.join(run.artifacts, 'review', 'context.json'), 'utf8')).changedFiles ?? [];
        }
        catch { /* no published context */ }
        const snapshot = resolveTaskConfig(config, run.ticket, files), stage = snapshot.verification.stages.find(s => s.id === requirement.stage || s.kind === requirement.stage);
        const observations = run.evidence.filter(e => e.requirementId === receipt.requirementId && e.commit === receipt.commit && e.provenance === receipt.provenance && e.build === receipt.build);
        const failure = [...observations].reverse().find(e => e.positiveObservation === false);
        const previous = observations.find(e => (e.positiveObservation === true || e.success) && (!failure || Date.parse(e.observedAt) > Date.parse(failure.observedAt)));
        const observed = !stage?.observationSeconds || (previous && Date.parse(receipt.observedAt) - Date.parse(previous.observedAt) >= stage.observationSeconds * 1000);
        const success = receipt.success && !!observed;
        addEvidence(run, receipt.requirementId, receipt.commit, receipt.provenance, receipt.details, success, run.publication?.base, receipt.observedAt, receipt.build).positiveObservation = receipt.success;
        if (success)
            run.dependencies = run.dependencies.filter(d => d.id !== requirement.stage && d.id !== `stage:${requirement.stage}`);
        await saveRun(cwd, run);
        console.log('Evidence recorded. Run iteris resume --once to reconcile completion.');
        return true;
    }
    finally {
        await release();
    }
}
