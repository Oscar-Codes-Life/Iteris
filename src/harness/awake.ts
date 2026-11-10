import {spawn} from 'node:child_process';

let held = false;
/**
 * A queue runs for hours. A Mac that goes to idle sleep suspends every instance without any error,
 * and the queue silently makes no progress until someone wakes it. Hold a power assertion for the
 * life of this process. Closing the lid on battery still sleeps; nothing a process does prevents that.
 */
export function keepAwake(): void {
	if (held || process.platform !== 'darwin') return;
	held = true;
	try {
		const child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], {stdio: 'ignore'});
		child.on('error', () => {held = false;});
		child.unref();
	} catch {held = false;}
}
