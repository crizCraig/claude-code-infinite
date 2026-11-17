import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSavingsState, accountSavingsTurn, savingsSummary, loadSavingsState, saveSavingsState, normalizeSavingsUsage, modelInputPriceUsd } from '../dist/savings.js';
const id = '12345678-1234-4123-8123-123456789abc';
const usage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 50 };
const request = (text = 'a'.repeat(4000)) => ({model:'claude-sonnet-4-6', messages:[{role:'user',content:text}]});
const turn = (state, options={}) => accountSavingsTurn(state,{request:request(),usage,contextWindow:200000,requestModified:true,originalInputTokens:1000,nowMs:1000,...options});
test('usage validates disjoint cache buckets and all required counts',()=>{
 assert.deepEqual(normalizeSavingsUsage(usage),{input:100,cache_read:200,cache_creation_5m:10,cache_creation_1h:20,output:50});
 for(const bad of [{}, {...usage,input_tokens:-1}, {...usage,output_tokens:NaN}, {...usage,cache_creation_input_tokens:31}, {...usage,cache_read_input_tokens:'200'}, {...usage,output_tokens:1.5}]) assert.equal(normalizeSavingsUsage(bad),undefined);
 assert.equal(normalizeSavingsUsage({...usage,cache_creation:undefined}).cache_creation_5m,30);
});
test('actual buckets use Craig multipliers, compression and MemTree charges subtract separately',()=>{
 const {state,turn:result}=turn(createSavingsState(id));
 assert.equal(state.actual_api_usd, (100+20+12.5+40+250)*3/1e6);
 assert.equal(result.original_input_tokens,1000);
 const summary=savingsSummary(state,{memtree_charged_usd:0.001,compression_api_usd:0.0002,costs_complete:true});
 assert.ok(Math.abs(summary.net_usd-(state.plain_api_usd-state.actual_api_usd-0.001-0.0002))<1e-15);
 assert.equal(summary.net_percent,100*summary.net_usd/state.plain_api_usd);
 assert.equal(savingsSummary(state).net_usd,null);
});
test('unmodified request uses actual counts and has exactly zero API savings',()=>{
 const {state,turn:result}=turn(createSavingsState(id),{requestModified:false,originalInputTokens:undefined});
 assert.equal(result.original_input_tokens,330);
 assert.equal(result.input_source,'actual');
 assert.equal(state.plain_api_usd,state.actual_api_usd);
});
test('missing usage and unknown model permanently suppress positive summaries',()=>{
 for(const options of [{usage:{}},{model:'unknown-model'}]){
  let {state}=turn(createSavingsState(id),options);
  state=turn(state).state;
  assert.equal(state.costs_complete,false);
  assert.equal(savingsSummary(state,{memtree_charged_usd:0,compression_api_usd:0,costs_complete:true}).net_usd,null);
 }
});
test('prefix cache matches content and model, expires, and isolates lanes',()=>{
 const cachedRequest={...request('a'.repeat(8000)),cache_control:{type:'ephemeral'}};
 const opts={request:cachedRequest,originalInputTokens:2000};
 const first=turn(createSavingsState(id),opts);
 const hit=turn(first.state,{...opts,nowMs:2000});
 assert.equal(hit.turn.plain_tokens.cache_read,2000);
 for(const options of [{nowMs:302000},{request:{...cachedRequest,messages:request('b'.repeat(8000)).messages}},{model:'claude-opus-4-6'}]) assert.equal(turn(first.state,{...opts,...options}).turn.plain_tokens.cache_read,0);
 assert.equal(turn(first.state,{...opts,laneKey:'other'}).turn.plain_tokens.cache_read,200,'first-observation warm read only');
});
test('finite plain compaction resets growth at window minus reserve',()=>{
 let state=createSavingsState(id); let crossed=false;
 for(let i=1;i<=30;i++){
  const result=turn(state,{request:request('a'.repeat(i*4000)),originalInputTokens:i*1000,contextWindow:5000,outputReserve:1000,nowMs:i*400000});
  state=result.state;
  assert.ok(result.turn.plain_input_tokens<=4000);
  if(result.turn.compacted){crossed=true;assert.ok(result.turn.plain_input_tokens<=1400);}
 }
 assert.ok(crossed);assert.ok(state.window_crossings>1);
});
test('fallback is explicitly estimated and does not use high safety sizing',()=>{
 const result=turn(createSavingsState(id),{originalInputTokens:undefined});
 assert.equal(result.turn.input_source,'estimated');
 assert.ok(result.turn.original_input_tokens<1200);
 assert.ok(result.turn.original_input_tokens>900);
});
test('model prices recognize exact generations and refuse unknown variants',()=>{
 for(const [model,price] of [['claude-opus-5-5',4],['claude-sonnet-5',2],['claude-haiku-5-5',0.1],['claude-fable-5-2',8],['claude-mythos-5-1',10],['claude-opus-4-1',15],['claude-haiku-4-5',1]]) assert.equal(modelInputPriceUsd(model,100000),price);
 assert.equal(modelInputPriceUsd('claude-haiku-5-5',100001),0.5);
 assert.equal(modelInputPriceUsd('claude-opus-99',0),undefined);
});
test('private atomic persistence resumes counters and stores no request content',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccc-savings-'));
 try{
  const state=turn(createSavingsState(id),{request:request('PRIVATE SECRET PAYLOAD'),nowMs:Date.now()}).state;
  assert.equal(saveSavingsState(dir,state),true);
  const saved=loadSavingsState(dir,id);
  assert.deepEqual(saved,state);
  assert.equal(turn(saved).state.sequence,2);
  const file=path.join(dir,`${id}.savings.json`);
  assert.ok(!fs.readFileSync(file,'utf8').includes('PRIVATE SECRET'));
  if(process.platform!=='win32') assert.equal(fs.statSync(file).mode&0o777,0o600);
  fs.writeFileSync(file,'{"schema":1}');assert.equal(loadSavingsState(dir,id),undefined);
  assert.equal(loadSavingsState(dir,'../../escape'),undefined);
  assert.throws(()=>createSavingsState('../../escape'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('mixed TTLs create disjoint buckets and only live prefixes are read',()=>{
 const mixed={...request(),system:[{type:'text',text:'x'.repeat(8000),cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:[{type:'text',text:'y'.repeat(8000),cache_control:{type:'ephemeral'}}]}]};
 const args={request:mixed,originalInputTokens:4000,usage:{input_tokens:10,output_tokens:5}};
 const first=turn(createSavingsState(id),args);
 assert.ok(first.turn.plain_tokens.cache_creation_1h>1900);
 assert.equal(first.turn.plain_tokens.cache_creation_5m+first.turn.plain_tokens.cache_creation_1h,4000);
 const next=turn(first.state,{...args,nowMs:600001});
 assert.equal(next.turn.plain_tokens.cache_read,first.turn.plain_tokens.cache_creation_1h);
 assert.equal(next.turn.plain_tokens.cache_creation_1h,0);
 assert.equal(next.turn.plain_tokens.cache_creation_5m,first.turn.plain_tokens.cache_creation_5m);
 const expired=turn(first.state,{...args,nowMs:3601001});
 assert.equal(expired.turn.plain_tokens.cache_read,0);
 assert.ok(!JSON.stringify(next.state).includes('xxxxx'));
});
test('automatic caching writes then reads only prior eligible prefixes and honors minimums',()=>{
 const uncached={...request('x'.repeat(8000))};
 const automatic={...uncached,cache_control:{type:'ephemeral'}};
 const args={request:automatic,originalInputTokens:2000,usage:{input_tokens:10,output_tokens:5}};
 const first=turn(createSavingsState(id),args);
 assert.equal(first.turn.plain_tokens.cache_creation_5m,2000);
 assert.equal(first.turn.plain_tokens.input,0);
 const next=turn(first.state,{...args,nowMs:2000});
 assert.equal(next.turn.plain_tokens.cache_read,2000);
 assert.equal(next.turn.plain_tokens.cache_creation_5m,0);
 const noControls=turn(first.state,{...args,request:uncached,nowMs:2000});
 assert.equal(noControls.turn.plain_tokens.input,2000);
 assert.equal(noControls.turn.plain_tokens.cache_read,0);
 assert.equal(noControls.turn.plain_tokens.cache_creation_5m,0);
 const small=turn(createSavingsState(id),{...args,originalInputTokens:1000});
 assert.equal(small.turn.plain_tokens.input,1000);
 assert.equal(small.turn.plain_tokens.cache_creation_5m,0);
 const extended={...automatic,messages:[...automatic.messages,{role:'assistant',content:'z'.repeat(4000)}]};
 const append=turn(first.state,{...args,request:extended,originalInputTokens:3000,nowMs:2000});
 assert.ok(append.turn.plain_tokens.cache_read>=1990);
 assert.equal(append.turn.plain_tokens.cache_creation_5m+append.turn.plain_tokens.cache_read,3000);
});
test('compaction cannot reuse the original full-history cache',()=>{
 const req={...request('x'.repeat(20000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(id),{request:req,originalInputTokens:5000,contextWindow:10000});
 const next=turn(first.state,{request:req,originalInputTokens:5000,contextWindow:5000,outputReserve:1000});
 assert.equal(next.turn.compacted,true);
 assert.equal(next.turn.plain_tokens.cache_read,0);
});
test('plain compaction keeps bounded growth for append-only conversations',()=>{
 let state=createSavingsState(id);const messages=[];let crossings=0;let last=0;
 for(let i=1;i<=40;i++){
  messages.push({role:i%2?'user':'assistant',content:'a'.repeat(4000)});
  const result=turn(state,{request:{...request(),messages:[...messages]},originalInputTokens:i*1000,contextWindow:5000,outputReserve:1000,nowMs:i*400000});
  state=result.state;crossings+=Number(result.turn.compacted);
  assert.ok(result.turn.plain_input_tokens<=4000);
  if(!result.turn.compacted && i>1)assert.equal(result.turn.plain_input_tokens-last,1000);
  last=result.turn.plain_input_tokens;
 }
 assert.ok(crossings>3 && crossings<20);
});
test('persistence rejects symlink files and unexpected fields',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccc-savings-'));
 try{
  const state=turn(createSavingsState(id)).state;
  const file=path.join(dir,`${id}.savings.json`);
  fs.writeFileSync(file,JSON.stringify({...state,request:'must not load'}));
  assert.equal(loadSavingsState(dir,id),undefined);
  fs.unlinkSync(file);
  const target=path.join(dir,'target');fs.writeFileSync(target,JSON.stringify(state));
  fs.symlinkSync(target,file);assert.equal(loadSavingsState(dir,id),undefined);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('window crossings count original requests beyond the native window, not early simulated compaction',()=>{
 const early=turn(createSavingsState(id),{originalInputTokens:85000,contextWindow:100000,outputReserve:10000});
 assert.equal(early.turn.compacted,true);
 assert.equal(early.state.window_crossings,0);
 const beyond=turn(early.state,{originalInputTokens:105000,contextWindow:100000,outputReserve:10000});
 assert.equal(beyond.state.window_crossings,1);
});
