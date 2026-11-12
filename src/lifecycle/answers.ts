import {stateRoot} from '../state/workspace.js';
import {readFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {atomicJson, type TaskRun} from './state.js';
import {ATTEMPT_DEPENDENCY, awaitingPerson, personQuestion} from './attempts.js';

/**
 * A person's reply to a task that stopped because it needs them.
 *
 * The reply is left as a file beside the task's state, the way a cancellation is, so the live view, the
 * monitor in a second terminal and `iteris answer` can all write it without touching run.json, which only
 * the queue writes. The queue takes it at the start of its next pass and schedules a fresh instance.
 */
const filename = (cwd: string, key: string) => path.join(stateRoot(cwd), '.iteris', 'tasks', key, 'answer.json');
const stored = z.object({version: z.literal(1), at: z.string(), text: z.string().min(1)});
const limit = 8000;

async function pending(cwd: string, key: string): Promise<z.infer<typeof stored> | undefined> {
	try {return stored.parse(JSON.parse(await readFile(filename(cwd, key), 'utf8')));} catch {return undefined;}
}

export async function submitAnswer(cwd: string, key: string, text: string): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid task key');
	const answer = text.replace(/\r\n?/g, '\n').trim();
	if (!answer) throw new Error('The answer is empty');
	// A second answer before the queue has taken the first adds to it.
	const earlier = await pending(cwd, key);
	await atomicJson(filename(cwd, key), {version: 1, at: new Date().toISOString(), text: [earlier?.text, answer].filter(Boolean).join('\n').slice(0, limit)});
}

export async function answerWaiting(cwd: string, key: string): Promise<boolean> {
	return !!await pending(cwd, key);
}

/** Moves a waiting answer into the run and schedules a fresh instance. Mutates the run; the caller saves it. */
export async function takeAnswer(cwd: string, run: TaskRun, now = Date.now()): Promise<boolean> {
	const answer = await pending(cwd, run.key);
	if (!answer) return false;
	(run.answers ??= []).push({at: answer.at, question: personQuestion(run.reason) ?? '', text: answer.text});
	if (awaitingPerson(run)) {
		const at = new Date(now).toISOString();
		run.dependencies = [...run.dependencies.filter(dependency => dependency.id !== ATTEMPT_DEPENDENCY), {
			id: ATTEMPT_DEPENDENCY, kind: 'capability', description: 'Your answer was received', nextAction: 'A fresh instance continues with your answer',
			lastProbe: at, nextRetryAt: at, attempts: run.attempts?.length ?? 0,
		}];
		run.state = 'waiting';
		run.reason = 'Continuing with your answer';
	}
	await unlink(filename(cwd, run.key)).catch(() => {});
	return true;
}
