import type {Octokit} from '@octokit/rest';
import slugify_ from 'slugify';
import type {Ticket} from '../types.js';

const slugify = slugify_ as unknown as (input: string, options?: {lower?: boolean; strict?: boolean}) => string;

export type ProjectInfo = {
	number: number;
	title: string;
};

type ProjectsQueryResult = {
	projectsV2: {
		nodes: Array<{number: number; title: string}>;
	};
};

type ProjectItemsQueryResult = {
	projectV2: {
		items: {
			pageInfo: {hasNextPage: boolean; endCursor: string | null};
			nodes: Array<{
				fieldValueByName: {name: string} | null;
				content: {
					__typename: string;
					number: number;
					title: string;
					body: string;
					state: string;
					url: string;
					labels: {nodes: Array<{name: string}>};
				} | null;
			}>;
		};
	};
};

async function queryProjects(octokit: Octokit, owner: string, ownerType: 'organization' | 'user'): Promise<ProjectInfo[]> {
	const ownerField = ownerType === 'organization' ? 'organization' : 'user';
	const query = `
		query($owner: String!) {
			${ownerField}(login: $owner) {
				projectsV2(first: 100) {
					nodes {
						number
						title
					}
				}
			}
		}
	`;

	const result = await octokit.graphql<Record<string, ProjectsQueryResult>>(query, {owner});
	const data = result[ownerField];
	if (!data) return [];
	return data.projectsV2.nodes.map(n => ({number: n.number, title: n.title}));
}

export async function listProjects(octokit: Octokit, owner: string): Promise<ProjectInfo[]> {
	// Try organization first, fall back to user
	try {
		console.log(`[debug] Trying to list projects for org "${owner}"...`);
		const projects = await queryProjects(octokit, owner, 'organization');
		console.log(`[debug] Found ${projects.length} org project(s)`);
		return projects;
	} catch {
		console.log(`[debug] Not an org, trying user "${owner}"...`);
		const projects = await queryProjects(octokit, owner, 'user');
		console.log(`[debug] Found ${projects.length} user project(s)`);
		return projects;
	}
}

export async function fetchProjectItems(
	octokit: Octokit,
	owner: string,
	projectNumber: number,
	todoStatus: string,
): Promise<Ticket[]> {
	const tickets: Ticket[] = [];
	let cursor: string | null = null;
	let hasNextPage = true;

	// Try org first, fall back to user
	let ownerField = 'organization';
	try {
		await octokit.graphql(`query($owner: String!) { organization(login: $owner) { id } }`, {owner});
	} catch {
		ownerField = 'user';
	}

	console.log(`[debug] Fetching items from project #${projectNumber} (${ownerField}: ${owner}), filtering for status "${todoStatus}"...`);

	while (hasNextPage) {
		const query = `
			query($owner: String!, $number: Int!, $cursor: String) {
				${ownerField}(login: $owner) {
					projectV2(number: $number) {
						items(first: 100, after: $cursor) {
							pageInfo {
								hasNextPage
								endCursor
							}
							nodes {
								fieldValueByName(name: "Status") {
									... on ProjectV2ItemFieldSingleSelectValue {
										name
									}
								}
								content {
									__typename
									... on Issue {
										number
										title
										body
										state
										url
										labels(first: 20) {
											nodes {
												name
											}
										}
									}
								}
							}
						}
					}
				}
			}
		`;

		type OwnerResult = {projectV2: ProjectItemsQueryResult['projectV2'] | null} | undefined;

		const result = await octokit.graphql<Record<string, OwnerResult>>(
			query,
			{owner, number: projectNumber, cursor},
		);

		const data: OwnerResult = result[ownerField];
		if (!data?.projectV2) {
			throw new Error(`Project #${projectNumber} not found for ${ownerField} "${owner}".`);
		}

		const items: ProjectItemsQueryResult['projectV2']['items'] = data.projectV2.items;

		for (const node of items.nodes) {
			const {content, fieldValueByName} = node;
			if (!content || content.__typename !== 'Issue') continue;
			if (content.state !== 'OPEN') continue;

			const statusName = fieldValueByName?.name ?? '';
			if (statusName !== todoStatus) continue;

			tickets.push({
				number: content.number,
				title: content.title,
				body: content.body ?? '',
				slug: slugify(content.title, {lower: true, strict: true}),
				labels: content.labels.nodes.map((l: {name: string}) => l.name),
				htmlUrl: content.url,
			});
		}

		hasNextPage = items.pageInfo.hasNextPage;
		cursor = items.pageInfo.endCursor;
	}

	console.log(`[debug] Found ${tickets.length} ticket(s) with status "${todoStatus}"`);

	// Sort by priority label (p0 > p1 > p2) then creation date
	const priorityOrder = (labels: string[]): number => {
		if (labels.includes('p0')) return 0;
		if (labels.includes('p1')) return 1;
		if (labels.includes('p2')) return 2;
		return 3;
	};

	return tickets.sort((a, b) => priorityOrder(a.labels) - priorityOrder(b.labels));
}
