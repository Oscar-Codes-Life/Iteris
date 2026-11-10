import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '.iteris/evidence';
/**
 * Where an instance keeps the record of how it checked its work: reproduction output, transcripts, notes.
 * It sits under `.iteris/` in the task's checkout, which the host never commits, so none of it reaches the
 * pull request. One folder per task branch, because a local-mode checkout is shared by successive tasks.
 */
export function evidenceDirectory(branch: string): string {
    return `${ROOT}/${branch.replace(/^iteris\//, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'task'}`;
}
/** Creates the folder and returns what a writing instance is told about it. */
export function evidenceNote(cwd: string, branch: string): string {
    const directory = evidenceDirectory(branch);
    try {
        mkdirSync(path.join(cwd, directory), { recursive: true });
        // An instance that stages everything itself must not stage this folder either.
        const ignore = path.join(cwd, ROOT, '.gitignore');
        if (!existsSync(ignore))
            writeFileSync(ignore, '*\n');
    }
    catch { /* The instance can still create it; the host never commits .iteris either way. */ }
    return `Evidence stays out of the repository. Put reproduction output, command transcripts, verification notes, screenshots and any other record of how you checked the work in \`${directory}/\` (relative to the repository root). The host keeps that folder out of Git and shows it to the independent reviewers. Never add such files to the repository, even where it has a folder or convention for them (for example \`plans/\` or an evidence directory), and do not write plan, validation, review or status documents about this task there either: the pull request contains only the source, tests and documentation the ticket itself asks for. If an earlier attempt added such files on this branch, delete them from the repository and move anything still useful into \`${directory}/\`.`;
}
/** Gives a review snapshot the task's evidence, which a clone of the commit does not contain. */
export async function copyEvidence(cwd: string, snapshot: string, branch: string): Promise<void> {
    const directory = evidenceDirectory(branch);
    try {
        await cp(path.join(cwd, directory), path.join(snapshot, directory), { recursive: true });
    }
    catch { /* nothing recorded */ }
}
/** Keeps a copy with the task's host-side artifacts, which outlive the worktree the instance wrote in. */
export async function archiveEvidence(cwd: string, artifacts: string, branch: string): Promise<void> {
    try {
        await cp(path.join(cwd, evidenceDirectory(branch)), path.join(artifacts, 'evidence'), { recursive: true });
    }
    catch { /* nothing recorded */ }
}
