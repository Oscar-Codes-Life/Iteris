import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {render} from 'ink';
import {PassThrough} from 'node:stream';
import {Choice} from '../dist/ui/Choice.js';
import {App} from '../dist/ui/App.js';
import {atomicWriteConfig,loadConfig} from '../dist/config.js';
import {temporary,config} from './helpers.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function terminal(t,element) {
 const stdin=new PassThrough();stdin.isTTY=true;stdin.setRawMode=()=>{};stdin.ref=()=>{};stdin.unref=()=>{};
 const stdout=new PassThrough();stdout.columns=160;stdout.rows=60;stdout.isTTY=true;
 let output='';stdout.on('data',chunk=>output+=chunk.toString());
 const view=render(element,{stdin,stdout,stderr:stdout,debug:true,exitOnCtrlC:false,patchConsole:false});
 t.after(()=>{view.unmount();view.cleanup();stdin.destroy();stdout.destroy();});
 return {stdin,view,output:()=>output};
}
test('picker preselects saved value and keyboard selects next option',async t=>{
 let selected;const ui=terminal(t,React.createElement(Choice,{title:'Which effort?',initial:'medium',options:[{value:'low',label:'low'},{value:'medium',label:'medium'},{value:'high',label:'high'}],onSelect:value=>selected=value,onCancel(){}}));
 await wait(50);ui.stdin.write('\u001b[B');await wait(30);ui.stdin.write('\r');await wait(30);assert.equal(selected,'high');
});
test('empty queue renders completion and live slash command persists effort',async t=>{
 const cwd=await temporary(t);const cfg=config();await atomicWriteConfig(cfg,cwd);
 const ui=terminal(t,React.createElement(App,{config:cfg,tickets:[],cwd}));await wait(80);
 assert.match(ui.output(),/All tickets complete/);
 ui.stdin.write('/');await wait(20);ui.stdin.write('effort low');await wait(20);ui.stdin.write('\r');await wait(100);
 assert.equal((await loadConfig(cwd)).harnesses.claude.effort,'low');
 assert.match(ui.output(),/Saved settings for the next ticket/);
});

test('custom picker checks changed completed tasks and allows an empty selection',async t=>{
 const {TicketPicker}=await import('../dist/ui/TicketPicker.js');let selected;
 const tickets=[{number:1,title:'Unchanged',labels:[],custom:{changed:false}},{number:2,title:'Edited',labels:[],custom:{changed:true}}];
 const ui=terminal(t,React.createElement(TicketPicker,{tickets,previousStatuses:new Map([[1,'done'],[2,'done']]),onSelect:value=>selected=value}));
 await wait(50);assert.match(ui.output(),/Changed/);ui.stdin.write('\r');await wait(30);assert.deepEqual(selected.map(t=>t.number),[2]);
 ui.stdin.write('\u001b[B');await wait(30);ui.stdin.write(' ');await wait(30);ui.stdin.write('\r');await wait(30);assert.deepEqual(selected,[]);
});

test('provider picker offers Custom after GitHub and Trello',async t=>{
 const {ProviderPicker}=await import('../dist/ui/ProviderPicker.js');let selected;
 const ui=terminal(t,React.createElement(ProviderPicker,{onSelect:value=>selected=value}));
 await wait(40);ui.stdin.write('\u001b[B');await wait(30);ui.stdin.write('\u001b[B');await wait(30);ui.stdin.write('\r');await wait(30);
 assert.equal(selected,'custom');assert.match(ui.output(),/Custom REST endpoint/);
});

test('the instances view separates tasks that wait by themselves from tasks that need a person',async t=>{
 const {Instances}=await import('../dist/ui/Instances.js');const {stripVTControlCharacters}=await import('node:util');
 const stdin=new PassThrough();stdin.isTTY=true;stdin.setRawMode=()=>{};stdin.ref=()=>{};stdin.unref=()=>{};
 const stdout=new PassThrough();stdout.columns=100;stdout.rows=40;stdout.isTTY=true;const frames=[];stdout.on('data',chunk=>frames.push(stripVTControlCharacters(chunk.toString())));
 const state=(number,status,failureReason)=>({runKey:String(number),ticket:{number,title:`Task ${number}`},branch:`iteris/${number}`,status,failureReason,elapsedMs:0,logLines:[]});
 const reason=`Needs you: ${'The ticket needs two phones and a build installed on each. '.repeat(3)}`;
 const states=[state(1,'blocked',reason),state(2,'waiting','CI Gate: waiting'),state(3,'retrying','Attempt 1 failed'),state(4,'pending')];
 const view=render(React.createElement(Instances,{states,selected:0,workspace:{mode:'worktree',concurrency:3}}),{stdin,stdout,stderr:stdout,debug:true,exitOnCtrlC:false});t.after(()=>view.unmount());
 const last=()=>frames.findLast(frame=>frame.includes('parallel tasks'));
 await wait(80);let frame=last();
 assert.match(frame,/2 waiting/);assert.match(frame,/1 need you/);assert.doesNotMatch(frame,/need attention|Waiting for a task slot/);
 assert.match(frame,/Stopped · waiting for your answer/);assert.match(frame,/Iteris needs your help to continue this task/);assert.ok(frame.replace(/[│\s]+/g,' ').includes(reason.trim().replace('Needs you: ','')),'the whole request is readable');
 assert.match(frame,/iteris answer <task key>/);assert.doesNotMatch(frame,/Task output/);
 view.rerender(React.createElement(Instances,{states,selected:0,workspace:{mode:'worktree',concurrency:3},answer:{draft:null}}));await wait(80);assert.match(last(),/Press Enter to type your answer/);
 view.rerender(React.createElement(Instances,{states,selected:0,workspace:{mode:'worktree',concurrency:3},answer:{draft:'Use the simulators'}}));await wait(80);assert.match(last(),/Your answer · Enter sends · Esc cancels/);assert.match(last(),/› Use the simulators▌/);
 view.rerender(React.createElement(Instances,{states,selected:1,workspace:{mode:'worktree',concurrency:3}}));await wait(80);frame=last();
 assert.match(frame,/No instance running · Iteris checks again by itself/);
 view.rerender(React.createElement(Instances,{states,selected:3,workspace:{mode:'worktree',concurrency:3}}));await wait(80);assert.match(last(),/Waiting for a task slot/);
});

for(const columns of [50,80,120]) test(`instances render long titles and paths within ${columns} columns`,async t=>{
 const {Instances}=await import('../dist/ui/Instances.js');const {Box,Text}=await import('ink');const {stripVTControlCharacters}=await import('node:util');
 const stdin=new PassThrough();stdin.isTTY=true;stdin.setRawMode=()=>{};stdin.ref=()=>{};stdin.unref=()=>{};
 const stdout=new PassThrough();stdout.columns=columns;stdout.rows=24;stdout.isTTY=true;const frames=[];stdout.on('data',chunk=>frames.push(stripVTControlCharacters(chunk.toString())));
 const states=Array.from({length:20},(_,i)=>({runKey:String(i),ticket:{number:i+1,title:`Task ${i+1}: ${'a long descriptive title '.repeat(8)}`},branch:'iteris/a-long-branch-name',workspace:{mode:'worktree',path:`/workspace/project/.iteris/worktrees/${'a'.repeat(64)}`},selection:{harness:'codex',model:'gpt-6-sol',effort:'high'},status:i===0?'running':'pending',elapsedMs:1000,logLines:['output '.repeat(30)]}));
 const view=render(React.createElement(Box,{paddingX:1,flexDirection:'column'},React.createElement(Text,null,'Iteris · Instances'),React.createElement(Instances,{states,selected:0,workspace:{mode:'worktree',concurrency:3}})),{stdin,stdout,stderr:stdout,debug:true,exitOnCtrlC:false});t.after(()=>view.unmount());
 await wait(80);const frame=frames.find(frame=>frame.includes('parallel tasks'));assert.ok(frame);assert.match(frame,/1 running|1 active/);assert.match(frame,/of 20 instances/);assert.match(frame,/Codex output/);
 assert.ok(frame.split('\n').every(line=>[...line].length<=columns),'no horizontal overflow');assert.ok(frame.split('\n').length<=24,'fits terminal height');
 stdout.columns=columns===120?50:120;stdout.emit('resize');await wait(80);assert.ok(frames.length>=2);
});

test('worktree queues open the Instances view with the configured parallel limit',async t=>{
 const cwd=await temporary(t),cfg=config();cfg.workspace={mode:'worktree',concurrency:4};await atomicWriteConfig(cfg,cwd);
 const ui=terminal(t,React.createElement(App,{config:await loadConfig(cwd),tickets:[],cwd}));await wait(100);
 assert.match(ui.output(),/Worktrees · up to 4 parallel tasks/);
 assert.match(ui.output(),/No instances yet/);
});

test('live view switches tabs and saves a worktree default for the next queue',async t=>{
 const cwd=await temporary(t),cfg=config();await atomicWriteConfig(cfg,cwd);
 const ui=terminal(t,React.createElement(App,{config:cfg,tickets:[],cwd}));await wait(100);
 ui.stdin.write('\t');await wait(30);assert.match(ui.output(),/No instances yet/);
 ui.stdin.write('/');await wait(20);ui.stdin.write('workspace worktree');await wait(20);ui.stdin.write('\r');await wait(100);
 assert.equal((await loadConfig(cwd)).workspace.mode,'worktree');assert.match(ui.output(),/Next queue: worktree/);
});

test('standalone monitor selects each task with the keyboard without starting a queue',async t=>{
 const {InstanceMonitor}=await import('../dist/ui/InstanceMonitor.js');const {ensureRun,saveRun}=await import('../dist/lifecycle/state.js');const {createRunFolder}=await import('../dist/state/manager.js');const {hasActiveRun}=await import('../dist/state/active.js');
 const cwd=await temporary(t),cfg=config();await atomicWriteConfig(cfg,cwd);
 for(const number of [1,2]) {const ticket={number,title:`Task ${number}`,body:'Implement feature',slug:`task-${number}`,labels:[],htmlUrl:'https://example.com'};const folder=await createRunFolder(cwd,ticket,cfg);await saveRun(cwd,await ensureRun(cwd,ticket,cfg,folder,`iteris/task-${number}`));}
 const ui=terminal(t,React.createElement(InstanceMonitor,{config:cfg,cwd}));await wait(100);
 assert.match(ui.output(),/#1 · Task 1/);ui.stdin.write('\u001b[B');await wait(60);assert.match(ui.output(),/#2 · Task 2/);assert.equal(await hasActiveRun(cwd),false);
});
test('a stopped task shows what it needs and a text field whose answer is saved for the queue',async t=>{
 const {InstanceMonitor}=await import('../dist/ui/InstanceMonitor.js');const {ensureRun,saveRun}=await import('../dist/lifecycle/state.js');const {createRunFolder}=await import('../dist/state/manager.js');
 const {recordAttempt}=await import('../dist/lifecycle/attempts.js');const {answerWaiting,takeAnswer}=await import('../dist/lifecycle/answers.js');
 const cwd=await temporary(t),cfg=config();await atomicWriteConfig(cfg,cwd);
 const ticket={number:1,title:'Device QA',body:'Test on devices',slug:'device-qa',labels:[],htmlUrl:'https://example.com'};
 const run=await ensureRun(cwd,ticket,cfg,await createRunFolder(cwd,ticket,cfg),'iteris/device-qa');
 recordAttempt(run,cfg,{phase:'running',status:'needs-person',kind:'capability',reason:'I need an iPhone and an Android phone with the build installed. Which devices can I use?',needsPerson:true});await saveRun(cwd,run);
 const ui=terminal(t,React.createElement(InstanceMonitor,{config:cfg,cwd}));await wait(150);
 assert.match(ui.output(),/Iteris needs your help to continue this task/);assert.match(ui.output(),/Which devices can I use\?/);assert.match(ui.output(),/Press Enter to type your answer/);assert.match(ui.output(),/Enter answer · q close monitor/);
 ui.stdin.write('\r');await wait(60);assert.match(ui.output(),/Your answer · Enter sends · Esc cancels/);
 // While the field is open, letters that are shortcuts elsewhere are text.
 ui.stdin.write('quit the device part,\njust keep the unit tests');await wait(60);ui.stdin.write('\u007f');await wait(60);ui.stdin.write('s');await wait(60);
 assert.equal(await answerWaiting(cwd,run.key),false);ui.stdin.write('\r');await wait(150);
 assert.match(ui.output(),/Answer saved · run iteris to continue this task/);
 assert.equal(await takeAnswer(cwd,run),true);assert.equal(run.answers[0].text,'quit the device part, just keep the unit tests');assert.match(run.answers[0].question,/^I need an iPhone/);
});
