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
