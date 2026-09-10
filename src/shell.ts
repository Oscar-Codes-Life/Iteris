import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {homedir, userInfo} from 'node:os';
import path from 'node:path';

export type ShellOptions = {home?: string; shell?: string; zdotdir?: string};
export function shellProfile(options: ShellOptions = {}) {
	const executable = options.shell ?? (process.env['SHELL'] || userInfo().shell || '');
	const shell = path.basename(executable);
	if (shell !== 'bash' && shell !== 'zsh') throw new Error('Unsupported shell. Set SHELL to your Bash or Zsh executable before saving credentials.');
	const home = options.home ?? homedir();
	const zdotdir = options.zdotdir ?? process.env['ZDOTDIR'];
	return {executable, shell, profile: path.join(shell === 'zsh' && zdotdir ? zdotdir : home, `.${shell}rc`)};
}
export function saveShellVariables(values: Record<string, string>, options: ShellOptions = {}): string {
	const {profile} = shellProfile(options);
	let contents = '';
	try {contents = readFileSync(profile, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
	for (const [name, value] of Object.entries(values)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Use an environment variable name such as CUSTOM_API_KEY, not the key value.');
		const start = `# Iteris: ${name}`;
		const end = `# End Iteris: ${name}`;
		const quote = "'" + value.replaceAll("'", "'\\''") + "'";
		const block = `${start}\nexport ${name}=${quote}\n${end}`;
		const lines = contents.split('\n');
		const first = lines.indexOf(start);
		const last = lines.indexOf(end, first + 1);
		if (first >= 0 && last > first) {
			lines.splice(first, last - first + 1, block);
			contents = lines.join('\n');
		} else contents += `\n${block}\n`;
	}
	writeFileSync(profile, contents, {mode: 0o600});
	Object.assign(process.env, values);
	return profile;
}
export function reloadShellVariable(name: string, options: ShellOptions = {}): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment variable name.');
	const {executable, shell, profile} = shellProfile(options);
	const args = shell === 'bash' ? ['--noprofile', '--norc', '-ic'] : ['-f', '-ic'];
	const valueExpression = shell === 'bash' ? '${!name}' : '${(P)name}';
	try {
		const value = execFileSync(executable, [...args, `. "$1" >/dev/null 2>&1 || exit 1; name=$2; printf '%s' "${valueExpression}"`, 'iteris', profile, name], {
			encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024,
		});
		if (!value.trim()) throw new Error('Missing value');
		process.env[name] = value;
		return value;
	} catch {throw new Error(`Could not reload ${name} from ${profile}. Check your shell profile and retry setup.`);}
}
