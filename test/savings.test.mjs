import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavingsState, accountSavingsTurn, normalizeSavingsUsage } from '../dist/savings.js';
const id = '12345678-1234-4123-8123-123456789abc';
const usage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 50 };
const request = (text = 'a'.repeat(4000)) => ({model:'claude-sonnet-4-6', messages:[{role:'user',content:text}]});
const turn = (state, options={}) => accountSavingsTurn(state,{request:request(),usage,contextWindow:200000,requestModified:true,originalInputTokens:1000,nowMs:1000,...options});
test('usage validates disjoint cache buckets and all required counts',()=>{
 assert.deepEqual(normalizeSavingsUsage(usage),{input:100,cache_read:200,cache_creation_5m:10,cache_creation_1h:20,output:50});
 for(const bad of [{}, {...usage,input_tokens:-1}, {...usage,output_tokens:NaN}, {...usage,cache_creation_input_tokens:31}, {...usage,cache_read_input_tokens:'200'}, {...usage,output_tokens:1.5}]) assert.equal(normalizeSavingsUsage(bad),undefined);
 assert.equal(normalizeSavingsUsage({...usage,cache_creation:undefined}).cache_creation_5m,30);
});
test('unmodified request uses actual counts and has exactly zero API savings',()=>{
 const {state,turn:result}=turn(createSavingsState(),{requestModified:false,originalInputTokens:undefined});
 assert.equal(result.original_input_tokens,330);
 assert.equal(result.input_source,'actual');
 assert.deepEqual(result.plain_tokens,result.actual_tokens);
});
test('prefix cache matches content and model, expires, and isolates lanes',()=>{
 const cachedRequest={...request('a'.repeat(8000)),cache_control:{type:'ephemeral'}};
 const opts={request:cachedRequest,originalInputTokens:2000};
 const first=turn(createSavingsState(),opts);
 const hit=turn(first.state,{...opts,nowMs:2000});
 assert.equal(hit.turn.plain_tokens.cache_read,2000);
 for(const options of [{nowMs:302000},{request:{...cachedRequest,messages:request('b'.repeat(8000)).messages}},{model:'claude-opus-4-6'}]) assert.equal(turn(first.state,{...opts,...options}).turn.plain_tokens.cache_read,0);
 assert.equal(turn(first.state,{...opts,laneKey:'other'}).turn.plain_tokens.cache_read,200,'first-observation warm read only');
});
test('finite plain compaction resets growth at window minus reserve',()=>{
 let state=createSavingsState(); let crossed=false;
 for(let i=1;i<=30;i++){
  const result=turn(state,{request:request('a'.repeat(i*4000)),originalInputTokens:i*1000,contextWindow:5000,outputReserve:1000,nowMs:i*400000});
  state=result.state;
  assert.ok(result.turn.plain_input_tokens<=4000);
  if(result.turn.compacted){crossed=true;assert.ok(result.turn.plain_input_tokens<=1400);}
 }
 assert.ok(crossed);
});
test('fallback is explicitly estimated and does not use high safety sizing',()=>{
 const result=turn(createSavingsState(),{originalInputTokens:undefined});
 assert.equal(result.turn.input_source,'estimated');
 assert.ok(result.turn.original_input_tokens<1200);
 assert.ok(result.turn.original_input_tokens>900);
});
test('mixed TTLs create disjoint buckets and only live prefixes are read',()=>{
 const mixed={...request(),system:[{type:'text',text:'x'.repeat(8000),cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:[{type:'text',text:'y'.repeat(8000),cache_control:{type:'ephemeral'}}]}]};
 const args={request:mixed,originalInputTokens:4000,usage:{input_tokens:10,output_tokens:5}};
 const first=turn(createSavingsState(),args);
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
 const first=turn(createSavingsState(),args);
 assert.equal(first.turn.plain_tokens.cache_creation_5m,2000);
 assert.equal(first.turn.plain_tokens.input,0);
 const next=turn(first.state,{...args,nowMs:2000});
 assert.equal(next.turn.plain_tokens.cache_read,2000);
 assert.equal(next.turn.plain_tokens.cache_creation_5m,0);
 const noControls=turn(first.state,{...args,request:uncached,nowMs:2000});
 assert.equal(noControls.turn.plain_tokens.input,2000);
 assert.equal(noControls.turn.plain_tokens.cache_read,0);
 assert.equal(noControls.turn.plain_tokens.cache_creation_5m,0);
 const small=turn(createSavingsState(),{...args,originalInputTokens:1000});
 assert.equal(small.turn.plain_tokens.input,1000);
 assert.equal(small.turn.plain_tokens.cache_creation_5m,0);
 const extended={...automatic,messages:[...automatic.messages,{role:'assistant',content:'z'.repeat(4000)}]};
 const append=turn(first.state,{...args,request:extended,originalInputTokens:3000,nowMs:2000});
 assert.ok(append.turn.plain_tokens.cache_read>=1990);
 assert.equal(append.turn.plain_tokens.cache_creation_5m+append.turn.plain_tokens.cache_read,3000);
});
test('compaction cannot reuse the original full-history cache',()=>{
 const req={...request('x'.repeat(20000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,originalInputTokens:5000,contextWindow:10000});
 const next=turn(first.state,{request:req,originalInputTokens:5000,contextWindow:5000,outputReserve:1000});
 assert.equal(next.turn.compacted,true);
 assert.equal(next.turn.plain_tokens.cache_read,0);
});
test('plain compaction keeps bounded growth for append-only conversations',()=>{
 let state=createSavingsState();const messages=[];let crossings=0;let last=0;
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
test('window crossings count original requests beyond the native window, not early simulated compaction',()=>{
 const early=turn(createSavingsState(),{originalInputTokens:85000,contextWindow:100000,outputReserve:10000});
 assert.equal(early.turn.compacted,true);
 assert.equal(early.turn.window_crossing,false);
 const beyond=turn(early.state,{originalInputTokens:105000,contextWindow:100000,outputReserve:10000});
 assert.equal(beyond.turn.window_crossing,true);
});

test('passthroughs use observed buckets on both sides even above the plain ceiling', () => {
 const args = {request:{...request(),cache_control:{type:'ephemeral'}},requestModified:false,
   usage:{input_tokens:1,cache_read_input_tokens:160999,output_tokens:1}};
 for (const previous of [createSavingsState(), turn(createSavingsState()).state]) {
   const result=turn(previous,args);
   assert.deepEqual(result.turn.plain_tokens,result.turn.actual_tokens);
 }
});

test('an attribution change and append keep the plain compaction boundary', () => {
 const history=request('x'.repeat(20000)).messages;
 const withHeader=(n,messages)=>({...request(),messages,system:[{type:'text',
   text:'x-anthropic-billing-header: cc_version=2.1.281; cch='+n+';'}]});
 const first=turn(createSavingsState(),{request:withHeader(1,history),originalInputTokens:5000,contextWindow:5000});
 const next=turn(first.state,{request:withHeader(2,[...history,{role:'assistant',content:'answer'}]),
   originalInputTokens:5010,contextWindow:5000});
 assert.equal(first.turn.compacted,true);
 assert.equal(next.turn.compacted,false);
 assert.equal(next.turn.plain_input_tokens,first.turn.plain_input_tokens+10);
});

test('parallel tool calls and results each occupy one cache lookback position', () => {
 const req={...request('x'.repeat(120000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,originalInputTokens:30000});
 const calls=Array.from({length:21},(_,i)=>({type:'tool_use',id:String(i),name:'test',input:{}}));
 const results=calls.map(call=>({type:'tool_result',tool_use_id:call.id,content:'ok'}));
 const next=turn(first.state,{originalInputTokens:30500,request:{...req,messages:[...req.messages,
   {role:'assistant',content:calls},{role:'user',content:results}]}});
 assert.ok(next.turn.plain_tokens.cache_read>=29900);
});

test('settling an unchanged request never traverses its transcript', () => {
 const req={...request(),get messages(){throw Error('walked the unchanged transcript')}};
 assert.deepEqual(turn(createSavingsState(),{request:req,requestModified:false}).turn.plain_tokens,
   turn(createSavingsState(),{requestModified:false}).turn.actual_tokens);
});

test('the first compressed turn can reuse a prefix warmed by a passthrough', () => {
 const req={...request('x'.repeat(120000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,requestModified:false,
   usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:1}});
 const next=turn(first.state,{request:{...req,messages:[...req.messages,{role:'assistant',content:'ok'}]},
   originalInputTokens:30500,usage:{input_tokens:4000,output_tokens:1},nowMs:2000});
 assert.equal(next.turn.plain_tokens.cache_read,30000);
 assert.equal(next.turn.plain_tokens.cache_creation_5m,500);
});

test('changing the request frame does not replay plain compaction on the same history', () => {
 const req={...request('x'.repeat(20000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,originalInputTokens:5000,contextWindow:5000});
 const next=turn(first.state,{request:{...req,tools:[{name:'additional_tool'}]},
   originalInputTokens:5010,contextWindow:5000});
 assert.equal(first.turn.compacted,true);
 assert.equal(next.turn.compacted,false);
 assert.equal(next.turn.plain_input_tokens,first.turn.plain_input_tokens+10);
});

test('an unknown predecessor uses median lane gap on the existing transcript prefix', () => {
 const messages = [...request('x'.repeat(320000)).messages,
   {role:'assistant',content:'done'},{role:'user',content:'continue'}];
 for(const ttl of ['5m','1h']){
   const result=turn(createSavingsState(),{request:{...request(),messages,cache_control:{type:'ephemeral',ttl}},
     originalInputTokens:80010,usage:{input_tokens:2000,output_tokens:5}});
   assert.ok(result.turn.plain_tokens.cache_read >= 79990);
   assert.ok(result.turn.plain_tokens.cache_read < 80010,'new content still incurs a write');
 }
});

test('unknown away gap exceeds five minutes but fits an hour; a known gap takes precedence', () => {
 const opts = {laneKind:'away', requestModified:true, originalInputTokens:80010,
   nowMs:4000000, usage:{input_tokens:2000,output_tokens:5}};
 const price = (ttl, previousAt) => turn(createSavingsState(), {...opts, previousAt, request:{
   ...request(),messages:[...request('x'.repeat(320000)).messages,{role:'assistant',content:'done'},
     {role:'user',content:'continue'}],cache_control:{type:'ephemeral',ttl}}}).turn.plain_tokens;
 assert.equal(price('5m').cache_read,0);
 assert.ok(price('1h').cache_read>79000);
 assert.ok(price('5m',3999000).cache_read>79000);
 assert.equal(price('1h',1000).cache_read,0);
});
