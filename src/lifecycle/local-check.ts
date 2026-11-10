import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { IterisConfig } from '../types.js';
import { runCommand } from '../review/command.js';
import { resolveExecutable, CapabilityUnavailable } from './environment.js';
import { SANDBOX_DEVICES } from './isolation.js';
/** Model-suggested commands are local evidence, never authorization to act externally. */
export async function runRecoveryCheck(command: string, cwd: string, config: IterisConfig, deadline: number, signal?: AbortSignal) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...config._execution?.env, PATH: config._execution?.path ?? process.env['PATH'] };
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'SSH_AUTH_SOCK', ...(config.custom ? [config.custom.apiKeyEnv] : [])])
        delete env[name];
    // Inert shell builtins can execute without an isolation capability.
    if (/^(?:true|false|exit [0-9]{1,3}|printf [a-zA-Z0-9._ -]+)$/.test(command))
        return runCommand(command, [], { cwd, deadline, signal, shell: true, env });
    const root = await realpath(cwd);
    if (process.platform === 'darwin') {
        const executable = await resolveExecutable('sandbox-exec', cwd);
        const temporary = await realpath(tmpdir());
        const protectedPaths = [path.join(root, '.iteris', 'tasks'), path.join(root, '.iteris', 'active.json'), path.join(root, '.iteris.json')];
        const secrets = ['.aws', '.ssh', '.config/gh', '.git-credentials', '.npmrc'].map(file => path.join(homedir(), file));
        const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(temporary)}))${SANDBOX_DEVICES}${protectedPaths.map(file => `(deny file-write* (subpath ${JSON.stringify(file)}))`).join('')}${secrets.map(file => `(deny file-read* (subpath ${JSON.stringify(file)}))`).join('')}`;
        const result = await runCommand(executable, ['-p', profile, '/bin/sh', '-c', command], { cwd, deadline, signal, env });
        if (result.exitCode !== 0 && /sandbox_init.*not permitted|sandbox.*not supported/i.test(result.output))
            throw new CapabilityUnavailable('local-check-isolation', result.output, 'Provide local command isolation or configure this command as an explicitly trusted check');
        return result;
    }
    if (process.platform === 'linux') {
        const executable = await resolveExecutable('bwrap', cwd);
        const result = await runCommand(executable, ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--bind', root, root, '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--chdir', root, '/bin/sh', '-c', command], { cwd, deadline, signal, env });
        if (result.exitCode !== 0 && /bwrap:.*(?:not permitted|namespace|not supported)/i.test(result.output))
            throw new CapabilityUnavailable('local-check-isolation', result.output, 'Provide local command isolation or configure this command as an explicitly trusted check');
        return result;
    }
    throw new CapabilityUnavailable('local-check-isolation', 'Local command isolation is unavailable on this platform', 'Configure the behavioral command as a trusted verification check or run Iteris in an environment with local command isolation');
}
