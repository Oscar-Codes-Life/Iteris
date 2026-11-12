import {useEffect, useState} from 'react';
import type {Key} from 'ink';
import type {TicketState} from '../types.js';
import {personQuestion} from '../lifecycle/attempts.js';
import {submitAnswer} from '../lifecycle/answers.js';
import {hasActiveRun} from '../state/active.js';

/** What a stopped task asks the person, when it stopped to ask. */
export const question = (state: TicketState | undefined) => state?.status === 'blocked' ? personQuestion(state.failureReason) : undefined;
export type AnswerField = {draft: string | null; note?: string};

/**
 * The text field under a task that asks for help. Enter opens it on the selected task, Enter again sends,
 * Escape closes it. While it is open every key belongs to it, so the view's own shortcuts must stand aside:
 * `handle` returns true for a key it used.
 */
export function useAnswer(cwd: string, current: TicketState | undefined): AnswerField & {handle: (input: string, key: Key) => boolean} {
	const [draft, setDraft] = useState<string | null>(null);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const key = current?.runKey, asking = !!key && question(current) !== undefined;
	// Moving to another task, or the task continuing, closes the field.
	useEffect(() => {
		setDraft(null);
		if (key && !asking) setNotes(previous => {const {[key]: _sent, ...rest} = previous; return rest;});
	}, [key, asking]);
	const handle = (input: string, pressed: Key): boolean => {
		if (!key || !asking) return false;
		if (draft === null) {
			if (!pressed.return) return false;
			setDraft(''); return true;
		}
		if (pressed.escape) setDraft(null);
		else if (pressed.return) {
			if (!draft.trim()) return true;
			setDraft(null);
			const note = (text: string) => setNotes(previous => ({...previous, [key]: text}));
			void submitAnswer(cwd, key, draft).then(async () => note(await hasActiveRun(cwd) ? 'Answer sent · a fresh instance continues this task on the queue\'s next round' : 'Answer saved · run iteris to continue this task'), error => note(`Could not save the answer: ${error instanceof Error ? error.message : String(error)}`));
		}
		else if (pressed.backspace || pressed.delete) setDraft(value => value?.slice(0, -1) ?? '');
		else if (!pressed.ctrl && !pressed.meta && !pressed.tab && input) {
			// Pasted text arrives as one input: its line breaks become spaces and other control characters are dropped.
			const typed = input.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
			if (typed) setDraft(value => (value ?? '') + typed);
		}
		return true;
	};
	return {draft, note: key ? notes[key] : undefined, handle};
}
