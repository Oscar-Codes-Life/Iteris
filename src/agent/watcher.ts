import {EventEmitter} from 'node:events';
import type {Readable} from 'node:stream';

const MAX_BUFFER_LINES = 50;
const DONE_SIGNAL = '<task>done</task>';

export class OutputWatcher extends EventEmitter {
	private buffer = '';
	readonly lines: string[] = [];
	private doneDetected = false;

	constructor(stream: Readable) {
		super();

		stream.on('data', (chunk: Buffer) => {
			this.buffer += chunk.toString();

			const parts = this.buffer.split('\n');
			// Keep the last incomplete line in the buffer
			this.buffer = parts.pop() ?? '';

			for (const line of parts) {
				this.addLine(line);
			}
		});

		stream.on('end', () => {
			// Flush remaining buffer
			if (this.buffer.length > 0) {
				this.addLine(this.buffer);
				this.buffer = '';
			}

			this.emit('end');
		});
	}

	get isDone(): boolean {
		return this.doneDetected;
	}

	private addLine(line: string): void {
		this.lines.push(line);

		// Keep rolling buffer
		if (this.lines.length > MAX_BUFFER_LINES) {
			this.lines.shift();
		}

		this.emit('line', line);

		if (line.includes(DONE_SIGNAL)) {
			this.doneDetected = true;
			this.emit('done');
		}
	}
}
