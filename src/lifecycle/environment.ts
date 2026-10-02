import { access, realpath, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { IterisConfig } from '../types.js';
import type { Command } from './config.js';
import { runCommand } from '../review/command.js';
import { registerSecret } from '../harness/redact.js';
import { hash, recordFailure, saveRun, type TaskRun } from './state.js';
import { runProjectSetup } from './isolation.js';
export type ExecutionManifest = {
    identity: string;
    platform: string;
    root: string;
    executables: Record<string, string>;
    versions: Record<string, string>;
    probes: Record<string, string>;
    env: Record<string, string>;
    path: string;
};
export class CapabilityUnavailable extends Error {
    constructor(public dependency: string, message: string, public nextAction: string) { super(message); }
}
export class SetupBudgetExhausted extends Error {
}
export function setupBudget(cwd: string, run: TaskRun, config: IterisConfig) {
    return async (command: Command) => {
        let source: string | undefined;
        try {
            source = hash(await readFile(path.resolve(cwd, command.executable), 'utf8'));
        }
        catch { /* installed executable rather than project script */ }
        const credentials = Object.fromEntries([...Object.values(config.environment.env), ...Object.values(command.env)].map(reference => [reference, hash(process.env[reference] ?? null)]));
        const allowed = recordFailure(run, config, 'environment', { command, source, credentials }, run.implementation?.head ?? 'preflight', 'Configured project-local setup attempt');
        await saveRun(cwd, run);
        return allowed;
    };
}
export async function projectDirectory(root: string, directory: string): Promise<string> {
    const resolved = await realpath(path.resolve(root, directory));
    const canonicalRoot = await realpath(root);
    if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep))
        throw new Error(`Command directory escapes project: ${directory}`);
    return resolved;
}
export async function resolveExecutable(executable: string, cwd: string, searchPath = process.env['PATH'] ?? ''): Promise<string> {
    const candidates = executable.includes('/') || executable.includes('\\') ? [path.resolve(cwd, executable)] : searchPath.split(path.delimiter).flatMap(directory => process.platform === 'win32' ? [path.join(directory, executable), ...(process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map(ext => path.join(directory, executable + ext.toLowerCase()))] : [path.join(directory, executable)]);
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return await realpath(candidate);
        }
        catch { /* next compatible tool */ }
    }
    throw new CapabilityUnavailable(executable, `Executable unavailable: ${executable}`, `Install or configure ${executable} in a project-local directory and run iteris resume`);
}
export function credentialEnvironment(references: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, reference] of Object.entries(references)) {
        const value = process.env[reference];
        if (value === undefined)
            throw new CapabilityUnavailable(`env:${reference}`, `Missing environment variable ${reference}`, `Provide ${reference} to the foreground worker`);
        registerSecret(value);
        env[name] = value;
    }
    return env;
}
export async function executeCommand(command: Command, cwd: string, config: IterisConfig, signal?: AbortSignal, input?: unknown, projectSetup = false) {
    const variant = command.platforms[process.platform] ?? command;
    const manifest = config._execution;
    const commandCwd = await projectDirectory(cwd, command.cwd);
    const executable = manifest?.executables[variant.executable] ?? await resolveExecutable(variant.executable, cwd, manifest?.path);
    const options = { cwd: commandCwd, env: { ...process.env, ...manifest?.env, ...credentialEnvironment(command.env), PATH: manifest?.path ?? process.env['PATH'] }, shell: variant.shell, deadline: Math.min(config._deadline ?? Infinity, Date.now() + command.timeout * 1000), signal, input: input === undefined ? undefined : JSON.stringify(input) + '\n' };
    if (projectSetup)
        return runProjectSetup(executable, variant.args, { ...options, root: await realpath(cwd) });
    return runCommand(executable, variant.args, options);
}
export async function prepareEnvironment(config: IterisConfig, cwd: string, signal?: AbortSignal, log: (message: string) => void = () => { }, attempt?: (command: Command) => Promise<boolean>): Promise<ExecutionManifest> {
    const root = await realpath(cwd);
    const manifest: ExecutionManifest = { identity: '', platform: process.platform, root, executables: {}, versions: {}, probes: {}, env: credentialEnvironment(config.environment.env), path: [path.join(root, '.iteris', 'tools', 'bin'), process.env['PATH'] ?? ''].join(path.delimiter) };
    config._execution = manifest;
    const runSetup = async (command: Command) => {
        if (!config.recovery.enabled)
            throw new CapabilityUnavailable('setup', 'Project setup is disabled', 'Enable recovery or prepare the project manually');
        if (attempt && !await attempt(command))
            throw new SetupBudgetExhausted('Project-local setup repair budget exhausted. Correct the configured installer or prepare prerequisites manually, then resume to probe them.');
        log('Running configured project-local setup');
        const result = await executeCommand(command, root, config, signal, undefined, true);
        if (result.exitCode !== 0 || result.error)
            throw new CapabilityUnavailable('setup', `Project setup failed: ${result.error ?? result.output}`, 'Correct the configured project-local setup command');
    };
    for (const runtime of config.environment.runtimes) {
        const probe = async () => {
            const executable = await resolveExecutable(runtime.executable, root, manifest.path);
            const result = await runCommand(executable, runtime.versionArgs, { cwd: root, env: { ...process.env, ...manifest.env, PATH: manifest.path }, deadline: Math.min(config._deadline ?? Infinity, Date.now() + 30000), signal });
            if (result.error || result.exitCode !== 0 || (runtime.versionPattern && !new RegExp(runtime.versionPattern).test(result.output)))
                throw new CapabilityUnavailable(runtime.id, `Runtime ${runtime.id} is incompatible: ${result.error ?? result.output.trim()}`, 'Configure a compatible executable or project-local runtime installer');
            manifest.executables[runtime.executable] = executable;
            manifest.versions[runtime.id] = result.output.trim();
        };
        try {
            await probe();
        }
        catch (error) {
            if (!runtime.setup)
                throw error;
            await runSetup(runtime.setup);
            await probe();
        }
        manifest.path = [...new Set([path.dirname(manifest.executables[runtime.executable]!), ...manifest.path.split(path.delimiter)])].join(path.delimiter);
    }
    for (const probe of config.environment.probes) {
        let result = await executeCommand(probe.command, root, config, signal);
        if (result.error || result.exitCode !== 0) {
            for (const setup of config.environment.setup)
                await runSetup(setup);
            result = await executeCommand(probe.command, root, config, signal);
            if (result.error || result.exitCode !== 0)
                throw new CapabilityUnavailable(probe.id, `Environment probe failed: ${probe.id}`, 'Repair the project setup, then resume');
        }
        manifest.probes[probe.id] = hash(result.output);
    }
    // Only hashes of credential values enter the durable manifest/cache identity.
    const localReferences = [...new Set(config.verification.checks.flatMap(check => Object.values(check.command.env)))];
    for (const reference of localReferences)
        registerSecret(process.env[reference]);
    manifest.identity = hash({ ...manifest, policy: config.environment, credentials: Object.fromEntries(localReferences.map(reference => [reference, hash(process.env[reference] ?? null)])), env: Object.fromEntries(Object.entries(manifest.env).map(([key, value]) => [key, hash(value)])) });
    return manifest;
}
export function persistedManifest(manifest: ExecutionManifest): ExecutionManifest {
    return { ...manifest, env: Object.fromEntries(Object.keys(manifest.env).map(key => [key, '[environment reference resolved by host]'])) };
}
