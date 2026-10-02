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
