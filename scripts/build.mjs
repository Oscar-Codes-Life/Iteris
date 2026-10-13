import {execFileSync} from 'node:child_process';
import {chmodSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);
// Prevent files from deleted or renamed modules leaking into release packages.
rmSync(new URL('dist/', root), {recursive: true, force: true});
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root))], {
  cwd: fileURLToPath(root), stdio: 'inherit',
});
const entry = new URL('dist/index.js', root);
writeFileSync(entry, '#!/usr/bin/env node\n' + readFileSync(entry, 'utf8'));
chmodSync(entry, 0o755);
