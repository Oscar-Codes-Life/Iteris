import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const {version} = JSON.parse(read('package.json'));
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected a stable semantic version');
const tag = `v${version}`;
const args = process.argv.slice(2);
if (args.length) {
  assert.equal(args.length, 2, 'Usage: release:check [--tag vX.Y.Z]');
  assert.equal(args[0], '--tag', 'Usage: release:check [--tag vX.Y.Z]');
  assert.equal(args[1], tag, 'Release tag must match package.json');
}
assert.ok(read('install.sh').includes(`RELEASE_VERSION="${version}"`), 'Installer version must match package.json');
assert.ok(read('CHANGELOG.md').includes(`## [${version}] — `), 'Add a dated changelog entry');
assert.ok(read(`docs/releases/${tag}.md`).startsWith(`# Iteris ${version} — `), 'Add release notes for this version');
assert.ok(read('README.md').includes(`/Iteris/${tag}/install.sh`), 'README must link to the tagged installer');
const output = execFileSync(process.execPath, [fileURLToPath(new URL('dist/index.js', root)), '--version'], {encoding: 'utf8'}).trim();
assert.equal(output, version, 'Built CLI version must match package.json');
execFileSync('bash', ['-n', fileURLToPath(new URL('install.sh', root))]);
console.log(`${tag}: CLI, installer, README, changelog, and release notes agree.`);
