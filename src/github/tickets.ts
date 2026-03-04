import {Octokit} from '@octokit/rest';
import type {IterisConfig, Ticket} from '../types.js';
import {type ProjectInfo, listProjects, fetchProjectItems} from './projects.js';

export function createOctokit(): Octokit {
	return new Octokit({auth: process.env['GITHUB_TOKEN']});
}

export type ProjectSelectionResult =
	| {kind: 'tickets'; tickets: Ticket[]}
	| {kind: 'pickProject'; projects: ProjectInfo[]};

export async function fetchTodoTickets(
	config: IterisConfig,
	selectedProjectNumber?: number,
): Promise<ProjectSelectionResult> {
	const octokit = createOctokit();
	const [owner] = config.repo.split('/') as [string, string];

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
		throw new Error(`No GitHub Projects V2 found for "${owner}". Create a project or set "projectNumber" in .iteris.json.`);
	}

	if (projects.length === 1) {
		console.log(`[debug] Auto-selecting the only project: #${projects[0]!.number} "${projects[0]!.title}"`);
		const tickets = await fetchProjectItems(octokit, owner, projects[0]!.number, config.todoStatus);
		return {kind: 'tickets', tickets};
	}

	// Multiple projects — caller needs to show a picker
	console.log(`[debug] Found ${projects.length} projects, need user to pick one`);
	return {kind: 'pickProject', projects};
}
