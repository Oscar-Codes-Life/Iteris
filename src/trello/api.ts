const BASE_URL = 'https://api.trello.com/1';

function getCredentials(): {key: string; token: string} {
	const key = process.env['TRELLO_API_KEY'];
	const token = process.env['TRELLO_TOKEN'];
	if (!key || !token) {
		throw new Error('TRELLO_API_KEY and TRELLO_TOKEN must be set.');
	}

	return {key, token};
}

async function trelloFetch<T>(path: string, params: Record<string, string> = {}, method = 'GET', body?: Record<string, string>): Promise<T> {
	const {key, token} = getCredentials();
	const url = new URL(`${BASE_URL}${path}`);
	url.searchParams.set('key', key);
	url.searchParams.set('token', token);
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}

	const init: RequestInit = {method};
	if (body) {
		init.headers = {'Content-Type': 'application/json'};
		init.body = JSON.stringify(body);
	}

	const res = await fetch(url.toString(), init);
	if (!res.ok) {
		throw new Error(`Trello API error: ${res.status} ${res.statusText} (${method} ${path})`);
	}

	return res.json() as Promise<T>;
}

export type TrelloBoard = {id: string; name: string; url: string};
export type TrelloList = {id: string; name: string};
export type TrelloLabel = {id: string; name: string; color: string};
export type TrelloCard = {
	id: string;
	idShort: number;
	name: string;
	desc: string;
	shortUrl: string;
	labels: TrelloLabel[];
};

export async function listBoards(): Promise<TrelloBoard[]> {
	return trelloFetch<TrelloBoard[]>('/members/me/boards', {
		filter: 'open',
		fields: 'id,name,url',
	});
}

export async function listBoardLists(boardId: string): Promise<TrelloList[]> {
	return trelloFetch<TrelloList[]>(`/boards/${boardId}/lists`, {
		filter: 'open',
		fields: 'id,name',
	});
}

export async function listCards(listId: string): Promise<TrelloCard[]> {
	return trelloFetch<TrelloCard[]>(`/lists/${listId}/cards`, {
		fields: 'id,idShort,name,desc,shortUrl,labels',
	});
}

export async function moveCard(cardId: string, destListId: string): Promise<void> {
	await trelloFetch(`/cards/${cardId}`, {idList: destListId}, 'PUT');
}

export async function findListByName(boardId: string, name: string): Promise<TrelloList | undefined> {
	const lists = await listBoardLists(boardId);
	return lists.find(l => l.name.toLowerCase() === name.toLowerCase());
}
