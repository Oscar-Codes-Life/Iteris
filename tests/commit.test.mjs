import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {commitSourceChanges} from '../dist/lifecycle/commit.js';
import {reviewRepository} from './helpers.mjs';

for(const ignoreFile of ['.gitignore','.git/info/exclude'])test(`host commits source with ignored Iteris metadata in ${ignoreFile}`,async t=>{
 const {cwd,git}=await reviewRepository(t);
 await writeFile(path.join(cwd,ignoreFile),'/.iteris/\n/.tasks/\n/.iteris.json\n');
 if(ignoreFile==='.gitignore'){git('add','.gitignore');git('commit','-qm','ignore host state');}
 await mkdir(path.join(cwd,'.iteris'),{recursive:true});await mkdir(path.join(cwd,'.tasks'),{recursive:true});
 await writeFile(path.join(cwd,'.iteris','run.json'),'private lifecycle state');
 await writeFile(path.join(cwd,'.tasks','task.json'),'private task');
 await writeFile(path.join(cwd,'.iteris.json'),'private configuration');
 await writeFile(path.join(cwd,'.iteris.json.v2.bak'),'untracked backup');
 await writeFile(path.join(cwd,'feature.txt'),'implemented');
 await mkdir(path.join(cwd,'app','[id]'),{recursive:true});
 const added='app/[id]/literal*\nfile.ts';await writeFile(path.join(cwd,added),'new source');
 commitSourceChanges(cwd,'main','commit source');
 assert.equal(git('show','HEAD:feature.txt'),'implemented');assert.equal(git('show',`HEAD:${added}`),'new source');
 assert.equal(git('ls-files','--','.iteris','.tasks','.iteris.json','.iteris.json.v2.bak'),'');
 assert.equal(git('status','--porcelain').trim(),'?? .iteris.json.v2.bak');
 assert.equal(await readFile(path.join(cwd,'.iteris','run.json'),'utf8'),'private lifecycle state');
});

test('host commits already-staged source deletions and renames without adding nonexistent paths',async t=>{
 const {cwd,git}=await reviewRepository(t);
 await writeFile(path.join(cwd,'delete.txt'),'delete');await writeFile(path.join(cwd,'old.txt'),'rename');git('add','delete.txt','old.txt');git('commit','-qm','seed');
 git('rm','delete.txt');git('mv','old.txt','new.txt');
 commitSourceChanges(cwd,'main','staged changes');
 assert.equal(git('show','HEAD:new.txt'),'rename');assert.equal(git('status','--porcelain'),'');
 assert.equal(git('ls-files','--','delete.txt','old.txt'),'');
});

test('host commits an unstaged deletion and literal pathspec-like filename',async t=>{
 const {cwd,git}=await reviewRepository(t);await writeFile(path.join(cwd,'delete.txt'),'delete');git('add','delete.txt');git('commit','-qm','seed');await rm(path.join(cwd,'delete.txt'));
 const file=':(exclude)feature.txt';await writeFile(path.join(cwd,file),'literal name');
 commitSourceChanges(cwd,'main','literal source paths');
 assert.equal(git('show',`HEAD:${file}`),'literal name');assert.equal(git('ls-files','--','delete.txt'),'');assert.equal(git('status','--porcelain'),'');
});

for(const hostFile of ['.iteris/run.json','.tasks/task.json','.iteris.json'])test(`tracked host metadata remains protected: ${hostFile}`,async t=>{
 const {cwd,git}=await reviewRepository(t);await writeFile(path.join(cwd,'.git/info/exclude'),'');await mkdir(path.dirname(path.join(cwd,hostFile)),{recursive:true});await writeFile(path.join(cwd,hostFile),'original');git('add',hostFile);git('commit','-qm','seed tracked state');
 const before=git('rev-parse','HEAD');await writeFile(path.join(cwd,hostFile),'modified');await writeFile(path.join(cwd,'feature.txt'),'source');
 assert.throws(()=>commitSourceChanges(cwd,'main','reject metadata'),/host-owned/);assert.equal(git('rev-parse','HEAD'),before);
});

test('renaming tracked host metadata into source is rejected before staging',async t=>{
 const {cwd,git}=await reviewRepository(t);await writeFile(path.join(cwd,'.git/info/exclude'),'');await writeFile(path.join(cwd,'.iteris.json'),'state');git('add','.iteris.json');git('commit','-qm','seed tracked state');git('mv','.iteris.json','source.json');
 const before=git('rev-parse','HEAD');assert.throws(()=>commitSourceChanges(cwd,'main','reject renamed state'),/host-owned/);assert.equal(git('rev-parse','HEAD'),before);
});

test('a metadata-only working tree does not create an empty commit',async t=>{
 const {cwd,git}=await reviewRepository(t);const before=git('rev-parse','HEAD');await mkdir(path.join(cwd,'.iteris'));await writeFile(path.join(cwd,'.iteris','state.json'),'state');
 commitSourceChanges(cwd,'main','nothing to commit');assert.equal(git('rev-parse','HEAD'),before);
});

// Someone else merges to the base on the remote; this checkout's refs stay stale until Iteris fetches.
async function upstream(t,remote,file,content){
 const {execFileSync}=await import('node:child_process'),{temporary}=await import('./helpers.mjs');
 const cwd=await temporary(t),git=(...args)=>execFileSync('git',args,{cwd,stdio:'pipe',encoding:'utf8'}).trim();
 execFileSync('git',['clone','-q',remote,cwd]);git('config','user.email','other@example.com');git('config','user.name','Other');
 await writeFile(path.join(cwd,file),content);git('add',file);git('commit','-qm',`upstream ${file}`);git('push','-q','origin','HEAD:main');return git('rev-parse','HEAD');
}
test('a task branch is brought up to date with a base that moved',async t=>{
 const {integrateBase,mergeInProgress,abortMerge,unresolvedConflicts,checkpointPartialWork}=await import('../dist/lifecycle/commit.js');
 const {cwd,git,remote}=await reviewRepository(t);
 // A new branch cut from a stale local base starts from the current base instead.
 const first=await upstream(t,remote,'other.txt','one\n');git('checkout','-qb','iteris/1-feature');
 const forwarded=await integrateBase(cwd,'iteris/1-feature','main');assert.equal(forwarded.status,'fast-forwarded');assert.equal(git('rev-parse','HEAD'),first);
 assert.equal((await integrateBase(cwd,'iteris/1-feature','main')).status,'current');
 // With task commits, a base that moved without touching the same lines is merged by the host.
 await writeFile(path.join(cwd,'feature.txt'),'ticket change\n');git('add','feature.txt');git('commit','-qm','implement');const implemented=git('rev-parse','HEAD');
 const second=await upstream(t,remote,'other.txt','two\n');
 const merged=await integrateBase(cwd,'iteris/1-feature','main');assert.equal(merged.status,'merged');assert.equal(merged.before,implemented);assert.equal(merged.base,second);
 assert.deepEqual(git('rev-list','--parents','-n','1','HEAD').split(' ').slice(1),[implemented,second]);assert.equal(git('status','--porcelain'),'');
 // Overlapping changes stop on conflicts for an instance to resolve; an interrupted resolution is never committed.
 await upstream(t,remote,'feature.txt','upstream change\n');const before=git('rev-parse','HEAD');
 const conflicted=await integrateBase(cwd,'iteris/1-feature','main');assert.equal(conflicted.status,'conflicted');assert.deepEqual(conflicted.files,['feature.txt']);
 assert.ok(mergeInProgress(cwd));assert.deepEqual(unresolvedConflicts(cwd,conflicted.files),['feature.txt']);
 assert.equal(checkpointPartialWork(cwd,'iteris/1-feature','Checkpoint'),false);
 assert.equal(mergeInProgress(cwd),false);assert.equal(git('rev-parse','HEAD'),before);assert.equal(git('status','--porcelain'),'');assert.equal(await readFile(path.join(cwd,'feature.txt'),'utf8'),'ticket change\n');
 abortMerge(cwd);
});
