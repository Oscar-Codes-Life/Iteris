import slugify_ from 'slugify';

const slugify = slugify_ as unknown as (input: string, options?: {lower?: boolean; strict?: boolean}) => string;
import type {IterisConfig, Ticket} from '../types.js';
import {type TrelloBoard, type TrelloList, listBoards, listBoardLists, listCards} from './api.js';
import {cacheCardId} from './completion.js';

export type TrelloSelectionResult =
	| {kind: 'pickBoard'; boards: TrelloBoard[]}
	| {kind: 'pickList'; lists: TrelloList[]}
	| {kind: 'tickets'; tickets: Ticket[]};

export async function fetchTrelloTickets(
	config: IterisConfig,
	boardId?: string,
	listId?: string,
): Promise<TrelloSelectionResult> {
	const resolvedBoardId = boardId ?? config.trello?.boardId;
	const resolvedListId = listId ?? config.trello?.listId;

	if (!resolvedBoardId) {
		const boards = await listBoards();
		if (boards.length === 0) {
			throw new Error('No open Trello boards found for this account.');
		}

		if (boards.length === 1) {
			return fetchTrelloTickets(config, boards[0]!.id, resolvedListId);
		}

		return {kind: 'pickBoard', boards};
	}

	if (!resolvedListId) {
		const lists = await listBoardLists(resolvedBoardId);
		if (lists.length === 0) {
			throw new Error('No open lists found on this board.');
		}

		if (lists.length === 1) {
			return fetchTrelloTickets(config, resolvedBoardId, lists[0]!.id);
		}

		return {kind: 'pickList', lists};
	}

	const cards = await listCards(resolvedListId);
	const tickets: Ticket[] = cards.map(card => {
		cacheCardId(card.idShort, card.id);
		return {
			number: card.idShort,
			title: card.name,
			body: card.desc,
			slug: slugify(card.name, {lower: true, strict: true}),
			labels: card.labels.map(l => l.name),
			htmlUrl: card.shortUrl,
		};
	});

	return {kind: 'tickets', tickets};
}
