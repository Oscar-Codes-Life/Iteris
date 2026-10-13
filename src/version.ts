import {readFileSync} from 'node:fs';

// Source and compiled output both live one level below the package manifest.
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
