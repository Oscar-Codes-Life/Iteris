import path from 'node:path';
import { realpath, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { runCommand } from '../review/command.js';
import { resolveExecutable, CapabilityUnavailable } from './environment.js';
/**
 * Device files every ordinary tool opens for writing. Without them Git stops with
 * "could not open '/dev/null' for reading and writing" and each git check exits 128.
 */
export const SANDBOX_DEVICES = '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))';
/** Configured setup may use the network, but cannot mutate global installations. */
export async function runProjectSetup(executable: string, args: string[], options: {
    root: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    deadline: number;
    signal?: AbortSignal;
    shell?: string;
}) {
    const env = { ...options.env };
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN', 'SSH_AUTH_SOCK'])
        delete env[name];
    const command = options.shell ? [options.shell, '-c', [executable, ...args].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')] : [executable, ...args];
    let result;
    if (process.platform === 'darwin') {
        const sandbox = await resolveExecutable('sandbox-exec', options.root, env['PATH']);
        const temporary = await realpath(tmpdir());
        const protectedPaths = [path.join(options.root, '.iteris', 'tasks'), path.join(options.root, '.iteris', 'active.json'), path.join(options.root, '.iteris.json')];
        const secrets = ['.aws', '.ssh', '.config/gh', '.git-credentials'].map(file => path.join(homedir(), file));
        const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(options.root)}) (subpath ${JSON.stringify(temporary)}))${SANDBOX_DEVICES}${protectedPaths.map(file => `(deny file-write* (subpath ${JSON.stringify(file)}))`).join('')}${secrets.map(file => `(deny file-read* (subpath ${JSON.stringify(file)}))`).join('')}`;
        result = await runCommand(sandbox, ['-p', profile, ...command], { ...options, env, shell: false });
    }
    else if (process.platform === 'linux') {
        const sandbox = await resolveExecutable('bwrap', options.root, env['PATH']);
        const protectedPaths = [path.join(options.root, '.git'), path.join(options.root, '.iteris/tasks'), path.join(options.root, '.iteris/active.json'), path.join(options.root, '.iteris.json')], bindings: string[] = [];
        for (const file of protectedPaths)
            try {
                await access(file);
                bindings.push('--ro-bind', file, file);
            }
            catch { /* absent state is not mounted */ }
        result = await runCommand(sandbox, ['--die-with-parent', '--ro-bind', '/', '/', '--bind', options.root, options.root, ...bindings, '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--chdir', options.cwd, ...command], { ...options, env, shell: false });
    }
    else
        throw new CapabilityUnavailable('setup-isolation', 'Project-local setup isolation is unavailable on this platform', 'Prepare prerequisites manually or provide a compatible isolated execution environment');
    if (result.exitCode !== 0 && /sandbox_init.*not permitted|sandbox.*not supported|bwrap:.*(?:not permitted|namespace|not supported)/i.test(result.output))
        throw new CapabilityUnavailable('setup-isolation', result.output, 'Provide project-local command isolation or prepare prerequisites manually');
    return result;
}
