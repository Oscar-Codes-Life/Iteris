import type {IterisConfig} from '../types.js';
import {findListByName, moveCard} from './api.js';

const cardIdCache = new Map<number, string>();

export function cacheCardId(idShort: number, id: string): void {
	cardIdCache.set(idShort, id);
}

export async function moveCardOnComplete(config: IterisConfig, ticketNumber: number): Promise<void> {
	const destName = config.trello?.moveOnComplete;
	const boardId = config.trello?.boardId;
	if (!destName || !boardId) return;

	const cardId = cardIdCache.get(ticketNumber);
	if (!cardId) return;

	const destList = await findListByName(boardId, destName);
	if (!destList) return;

	await moveCard(cardId, destList.id);
}
