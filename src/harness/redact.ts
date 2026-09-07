const secrets = new Set<string>();
export function registerSecret(value: string | undefined): void {if (value) secrets.add(value);}
export function redact(value: string): string {
	for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TRELLO_TOKEN', 'TRELLO_API_KEY']) registerSecret(process.env[key]);
	for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
	return value;
}
