import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavingsState, accountSavingsTurn, normalizeSavingsUsage } from '../dist/savings.js';
const usage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 50 };
const request = (text = 'a'.repeat(4000)) => ({model:'claude-sonnet-4-6', messages:[{role:'user',content:text}]});
const turn = (state, options={}) => accountSavingsTurn(state,{request:request(),usage,contextWindow:200000,requestModified:true,prefixRewritten:true,originalInputTokens:1000,nowMs:1000,...options});
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
 const opts={request:cachedRequest,originalInputTokens:2000,usage:{input_tokens:0,cache_creation_input_tokens:2000,output_tokens:5}};
 const first=turn(createSavingsState(),opts);
 const hit=turn(first.state,{...opts,nowMs:2000});
 assert.equal(hit.turn.plain_tokens.cache_read,2000);
 for(const options of [{nowMs:302000},{request:{...cachedRequest,messages:request('b'.repeat(8000)).messages}},{model:'claude-opus-4-6'}]) assert.equal(turn(first.state,{...opts,...options}).turn.plain_tokens.cache_read,0);
 assert.equal(turn(first.state,{...opts,laneKey:'other'}).turn.plain_tokens.cache_read,0,'no predecessor on the other lane');
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
 const args={request:mixed,originalInputTokens:4000,usage:{input_tokens:0,output_tokens:5,
   cache_creation_input_tokens:4000,cache_creation:{ephemeral_1h_input_tokens:2000,ephemeral_5m_input_tokens:2000}}};
 const first=turn(createSavingsState(),args);
 assert.ok(first.turn.plain_tokens.cache_creation_1h>1900);
 assert.equal(first.turn.plain_tokens.cache_creation_5m+first.turn.plain_tokens.cache_creation_1h,4000);
 const next=turn(first.state,{...args,nowMs:600001});
 assert.equal(next.turn.plain_tokens.cache_read,2000);
 assert.equal(next.turn.plain_tokens.cache_creation_1h,0);
 assert.equal(next.turn.plain_tokens.cache_creation_5m,2000);
 const expired=turn(first.state,{...args,nowMs:3601001});
 assert.equal(expired.turn.plain_tokens.cache_read,0);
 assert.ok(!JSON.stringify(next.state).includes('xxxxx'));
});
test('automatic caching writes then reads only prior eligible prefixes and honors minimums',()=>{
 const uncached={...request('x'.repeat(8000))};
 const automatic={...uncached,cache_control:{type:'ephemeral'}};
 const args={request:automatic,originalInputTokens:2000,usage:{input_tokens:0,cache_creation_input_tokens:2000,output_tokens:5}};
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

test('a stable ride with 21 parallel tool calls and results follows the observed cache hit', () => {
 const req={...request('x'.repeat(120000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,originalInputTokens:30000});
 const calls=Array.from({length:21},(_,i)=>({type:'tool_use',id:String(i),name:'test',input:{}}));
 const results=calls.map(call=>({type:'tool_result',tool_use_id:call.id,content:'ok'}));
 const next=turn(first.state,{originalInputTokens:30500,prefixRewritten:false,
   usage:{input_tokens:500,cache_read_input_tokens:30000,output_tokens:10},request:{...req,messages:[...req.messages,
   {role:'assistant',content:calls},{role:'user',content:results}]}});
 assert.ok(next.turn.plain_tokens.cache_read>=29900);
});

test('a passthrough with no observed cache coverage needs no transcript hashes', () => {
 const req={...request(),get messages(){throw Error('walked the unchanged transcript')}};
 assert.deepEqual(turn(createSavingsState(),{request:req,requestModified:false,usage:{input_tokens:10,output_tokens:0}}).turn.plain_tokens,
   normalizeSavingsUsage({input_tokens:10,output_tokens:0}));
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

test('a first-seen rewrite has no prior cache evidence regardless of lane or marker', () => {
 const messages = [...request('x'.repeat(320000)).messages,
   {role:'assistant',content:'done'},{role:'user',content:'continue'}];
 for (const ttl of ['5m','1h']) for (const laneKey of ['main','away']) {
   const result=turn(createSavingsState(),{laneKey,request:{...request(),messages,cache_control:{type:'ephemeral',ttl}},
     originalInputTokens:80010,usage:{input_tokens:2000,output_tokens:5}});
   assert.equal(result.turn.plain_tokens.cache_read,0);
   assert.equal(result.turn.plain_tokens['cache_creation_'+ttl],80010);
 }
});

test('warm passthrough coverage stops at the last matching content block', () => {
  const prompt = (head, tail) => ({...request(), cache_control:{type:'ephemeral'},
    messages:[{role:'user',content:head.repeat(60000)}, {role:'assistant',content:tail.repeat(60000)}]});
  const first = turn(createSavingsState(), {request:prompt('a','b'), requestModified:false,
    usage:{input_tokens:0, cache_creation_input_tokens:30000, output_tokens:1}});
  const next = request => turn(first.state, {request, originalInputTokens:30000, nowMs:11000}).turn.plain_tokens;
  const replaced = next(prompt('c','d'));
  assert.deepEqual([replaced.cache_read,replaced.cache_creation_5m], [0,30000]);
  const edited = next(prompt('a','d'));
  assert.ok(Math.abs(edited.cache_read - 15000) < 10, JSON.stringify(edited));
  assert.equal(edited.cache_read + edited.cache_creation_5m, 30000);
  assert.equal(next(prompt('a','b')).cache_read, 30000);
});

test('a long passthrough retains its shared head when the rest of the conversation changes', () => {
  const head = request('a'.repeat(24000)).messages[0];
  const prompt = tail => ({...request(), cache_control:{type:'ephemeral'},
    messages:[head, ...Array.from({length:160}, () => ({role:'user',content:tail.repeat(150)}))]});
  const first = turn(createSavingsState(), {request:prompt('b'), requestModified:false,
    usage:{input_tokens:0,cache_creation_input_tokens:12000,output_tokens:0}});
  const next = turn(first.state, {request:prompt('c'), originalInputTokens:12000,nowMs:11000});
  assert.ok(next.turn.plain_tokens.cache_read > 5800 && next.turn.plain_tokens.cache_read < 6100);
});

test('stable compressed rides follow measured reads and writes regardless of gaps and markers', () => {
  const req = {...request(),cache_control:{type:'ephemeral',ttl:'1h'}};
  const args = {request:req,originalInputTokens:1000,prefixRewritten:false};
  const mixed = {input_tokens:0,cache_read_input_tokens:200,cache_creation_input_tokens:300,
    cache_creation:{ephemeral_5m_input_tokens:200,ephemeral_1h_input_tokens:100},output_tokens:7};
  const first = turn(createSavingsState(),{...args,usage:mixed});
  for (const nowMs of [1001,3601001]) {
    const next = turn(first.state,{...args,usage:mixed,nowMs});
    assert.deepEqual(next.turn.plain_tokens,
      {input:0,cache_read:400,cache_creation_5m:400,cache_creation_1h:200,output:7});
    const miss = turn(first.state,{...args,usage:{input_tokens:10,output_tokens:1},nowMs});
    assert.equal(miss.turn.plain_tokens.input,1000);
  }
});

test('a five-minute write followed by a hit cannot become a one-hour entry on rewrite', () => {
  const req = {...request('a'.repeat(120000)),cache_control:{type:'ephemeral'}};
  const args = {request:req,originalInputTokens:30000,requestModified:false};
  const written = turn(createSavingsState(),{...args,usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:0}});
  const hit = turn(written.state,{...args,usage:{input_tokens:0,cache_read_input_tokens:30000,output_tokens:0},nowMs:2000});
  const next = turn(hit.state,{...args,requestModified:true,prefixRewritten:true,nowMs:602000,
    request:{...req,cache_control:{type:'ephemeral',ttl:'1h'}},usage:{input_tokens:2000,output_tokens:1}});
  assert.equal(next.turn.plain_tokens.cache_read,0);
  assert.equal(next.turn.plain_tokens.cache_creation_1h,30000);
});

test('shared system and fresh suffix keep their measured buckets on both a ride and a rewrite', () => {
  // Text lengths include the four characters of each user role in the position estimate.
  const prompt = size => ({...request(),cache_control:{type:'ephemeral'},system:'s'.repeat(2000),
    messages:[...request('x'.repeat(size-4)).messages,...request('z'.repeat(996)).messages]});
  const args = {request:prompt(4000),forwardedRequest:prompt(2000),originalInputTokens:7000,
    usage:{input_tokens:1000,cache_read_input_tokens:4000,output_tokens:11}};
  const ride = turn(createSavingsState(),{...args,prefixRewritten:false});
  assert.deepEqual(ride.turn.plain_tokens,{input:1000,cache_read:6000,cache_creation_1h:0,
    cache_creation_5m:0,output:11});
  const rewrite = turn(createSavingsState(),{...args,prefixRewritten:true});
  assert.deepEqual(rewrite.turn.plain_tokens,{input:1000,cache_read:2000,cache_creation_1h:0,
    cache_creation_5m:4000,output:11});
});

test('a rewrite uses the TTL observed on the preceding wire request', () => {
  const original = {...request('a'.repeat(120000)),cache_control:{type:'ephemeral',ttl:'1h'}};
  for (const ttl of ['5m','1h']) {
    const sent = {...request('z'.repeat(8000)),cache_control:{type:'ephemeral',ttl}};
    const args = {request:original,forwardedRequest:sent,originalInputTokens:30000};
    const first = turn(createSavingsState(),{...args,prefixRewritten:false,
      usage:{input_tokens:0,cache_read_input_tokens:2000,output_tokens:1}});
    const next = turn(first.state,{...args,nowMs:601000,prefixRewritten:true,
      usage:{input_tokens:2000,output_tokens:1}});
    assert.equal(next.turn.plain_tokens.cache_read,ttl === '5m' ? 0 : 30000);
  }
});

test('a passthrough reports measured usage and preserves plain compaction for the next ride', () => {
  const messages = request('x'.repeat(20000)).messages;
  const args = {request:{...request(),messages},contextWindow:5000,originalInputTokens:5000};
  const first = turn(createSavingsState(),args);
  assert.equal(first.turn.compacted,true);
  const pass = turn(first.state,{...args,requestModified:false,usage:{input_tokens:5000,output_tokens:10}});
  assert.deepEqual(pass.turn.plain_tokens,pass.turn.actual_tokens);
  const next = turn(pass.state,{...args,request:{...request(),messages:[...messages,{role:'user',content:'next'}]},
    originalInputTokens:5010,prefixRewritten:false});
  assert.equal(next.turn.compacted,false);
  assert.equal(next.turn.plain_input_tokens,first.turn.plain_input_tokens+10);
});

test('a rewrite can invalidate the cached suffix after the edited block upstream', () => {
  const prompt = middle => ({...request(),cache_control:{type:'ephemeral'},
    messages:[...request(middle.repeat(4000)).messages,...request('tail'.repeat(2000)).messages]});
  const req = prompt('a');
  const prior = turn(createSavingsState(),{request:req,requestModified:false,
    usage:{input_tokens:0,cache_creation_input_tokens:3000,output_tokens:1}});
  const next = turn(prior.state,{request:req,forwardedRequest:prompt('b'),originalInputTokens:3000,
    usage:{input_tokens:0,cache_creation_input_tokens:3000,output_tokens:1},nowMs:2000});
  assert.equal(next.turn.plain_tokens.cache_read,3000);
  assert.equal(next.turn.plain_tokens.cache_creation_5m,0);
});

test('one zero duration count cannot supply a missing creation total', () => {
  for (const present of ['ephemeral_1h_input_tokens','ephemeral_5m_input_tokens']) {
    assert.equal(normalizeSavingsUsage({...usage,cache_creation_input_tokens:null,
      cache_creation:{[present]:0}}),undefined);
  }
});
