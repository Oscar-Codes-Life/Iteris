import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdir, readFile, readlink, writeFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {temporary, executable} from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist/index.js');
const installer = path.join(root, 'install.sh');
const {version} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

test('version works outside a project and ignores invalid project configuration', async t => {
  const cwd = await temporary(t);
  assert.equal(execFileSync(process.execPath, [cli, '--version'], {cwd, encoding: 'utf8'}).trim(), version);
  assert.deepEqual(await readdir(cwd), []);
  await writeFile(path.join(cwd, '.iteris.json'), '{invalid');
  assert.equal(execFileSync(process.execPath, [cli, '-V'], {cwd, encoding: 'utf8'}).trim(), version);
  assert.equal(await readFile(path.join(cwd, '.iteris.json'), 'utf8'), '{invalid');
});

async function installFixture(t) {
  const cwd = await temporary(t), repository = path.join(cwd, 'repository'), bin = path.join(cwd, 'bin');
  const install = path.join(cwd, 'installation'), links = path.join(cwd, 'links');
  await Promise.all([repository, bin, links].map(folder => mkdir(folder)));
  const gitPath = execFileSync('which', ['git'], {encoding: 'utf8'}).trim();
  const git = (...args) => execFileSync(gitPath, args, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  git('init', '-q'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'release@example.test');
  for (const release of [version, '99.0.0', '99.1.0']) {
    await writeFile(path.join(repository, 'package.json'), JSON.stringify({version: release}));
    git('add', 'package.json'); git('commit', '-qm', release);
    if (release !== '99.1.0') git('tag', `v${release}`);
  }
  // All Git behavior is real; only the network transport is redirected to a local fixture.
  await executable(bin, 'git', `
    const {spawnSync,execFileSync}=require('node:child_process');
    const args=process.argv.slice(2), actual=${JSON.stringify(gitPath)}, fixture=${JSON.stringify(repository)};
    const clone=args[0]==='clone';
    if(clone) args[args.length-2]=fixture;
    const fetch=args.indexOf('fetch');
    if(fetch>=0) args[args.indexOf('origin',fetch)]=fixture;
    const result=spawnSync(actual,args,{stdio:'inherit'});
    if(clone && result.status===0) execFileSync(actual,['-C',args.at(-1),'remote','set-url','origin','https://github.com/Oscar-Codes-Life/Iteris.git']);
    process.exit(result.status??1);
  `);
  await executable(bin, 'pnpm', `
    const fs=require('node:fs');
    if(process.argv[2]==='run' && process.argv[3]==='build') {
      fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.js','// fixture build');
    }
  `);
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, ITERIS_INSTALL_DIR: install, ITERIS_BIN_DIR: links};
  const run = (...args) => spawnSync('bash', [installer, ...args], {cwd, env, encoding: 'utf8'});
  const installedVersion = async () => JSON.parse(await readFile(path.join(install, 'package.json'), 'utf8')).version;
  return {run, installedVersion, install, links, git};
}

test('installer uses its release tag and can upgrade a detached installation to another tag', async t => {
  const fixture = await installFixture(t);
  let result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await fixture.installedVersion(), version);
  assert.equal(await readlink(path.join(fixture.links, 'iteris')), path.join(fixture.install, 'dist/index.js'));
  assert.equal(fixture.git('-C', fixture.install, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  result = fixture.run('--version', 'v99.0.0');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await fixture.installedVersion(), '99.0.0');
});

test('installer leaves an existing checkout intact when a requested tag is missing', async t => {
  const fixture = await installFixture(t);
  assert.equal(fixture.run().status, 0);
  const result = fixture.run('--version', '98.0.0');
  assert.notEqual(result.status, 0);
  assert.equal(await fixture.installedVersion(), version);
});

test('installer refuses to overwrite source changes or a non-symlink executable', async t => {
  const fixture = await installFixture(t);
  await writeFile(path.join(fixture.links, 'iteris'), 'keep this executable');
  let result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not a symlink/);
  assert.equal(await readFile(path.join(fixture.links, 'iteris'), 'utf8'), 'keep this executable');
  await writeFile(path.join(fixture.install, 'package.json'), 'local changes');
  result = fixture.run('--version', '99.0.0');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Local changes/);
  assert.equal(await readFile(path.join(fixture.install, 'package.json'), 'utf8'), 'local changes');
});

test('installer rejects malformed versions and unknown options before installation', async t => {
  const cwd = await temporary(t);
  for (const args of [['--version'], ['--version', '../main'], ['--version', '1.2.3', 'extra'], ['--unknown']]) {
    const result = spawnSync('bash', [installer, ...args], {cwd, encoding: 'utf8'});
    assert.notEqual(result.status, 0);
  }
  assert.deepEqual(await readdir(cwd), []);
});
