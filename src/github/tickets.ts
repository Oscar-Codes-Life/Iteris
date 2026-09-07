import {fetchRepositoryIssues} from './issues.js';
import {saveConfigField} from '../config.js';
import {resolveGithubToken} from './auth.js';
import {Octokit} from '@octokit/rest';
import type {IterisConfig, Ticket} from '../types.js';
import {type ProjectInfo, listProjects, fetchProjectItems} from './projects.js';

export function createOctokit(): Octokit {
	return new Octokit({auth: resolveGithubToken()});
}

export type ProjectSelectionResult =
	| {kind: 'tickets'; tickets: Ticket[]}
	| {kind: 'pickProject'; projects: ProjectInfo[]};

export async function fetchTodoTickets(
	config: IterisConfig,
	selectedProjectNumber?: number,
	octokit: Octokit = createOctokit(),
	cwd = process.cwd(),
): Promise<ProjectSelectionResult> {
	const [owner] = config.repo.split('/') as [string, string];

	if (config.githubSource === 'issues') {
		console.log(`Fetching open repository issues from ${config.repo}...`);
		return {kind: 'tickets', tickets: await fetchRepositoryIssues(octokit, config.repo)};
	}

	const projectNumber = selectedProjectNumber ?? config.projectNumber;

	if (projectNumber) {
		console.log(`[debug] Using project #${projectNumber}`);
		const tickets = await fetchProjectItems(octokit, owner, projectNumber, config.todoStatus);
		return {kind: 'tickets', tickets};
	}

	// Discover projects
	console.log(`[debug] No projectNumber configured, discovering projects...`);
	const projects = await listProjects(octokit, owner);

	if (projects.length === 0) {
		await saveConfigField('githubSource', 'issues', cwd);
		config.githubSource = 'issues';
		console.log(`No visible GitHub Projects found for ${owner}. Saved githubSource=issues. Showing open repository issues instead.`);
		return {kind: 'tickets', tickets: await fetchRepositoryIssues(octokit, config.repo)};
	}

	if (projects.length === 1) {
		console.log(`[debug] Auto-selecting the only project: #${projects[0]!.number} "${projects[0]!.title}"`);
		config.projectNumber = projects[0]!.number;
		await saveConfigField('projectNumber', config.projectNumber, cwd);
		const tickets = await fetchProjectItems(octokit, owner, projects[0]!.number, config.todoStatus);
		return {kind: 'tickets', tickets};
	}

	// Multiple projects — caller needs to show a picker
	console.log(`[debug] Found ${projects.length} projects, need user to pick one`);
	return {kind: 'pickProject', projects};
}
