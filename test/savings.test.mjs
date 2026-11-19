import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavingsState, accountSavingsTurn, normalizeSavingsUsage } from '../dist/savings.js';
const usage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 50 };
const request = (text = 'a'.repeat(4000)) => ({model:'claude-sonnet-4-6', messages:[{role:'user',content:text}]});
const turn = (state, options={}) => accountSavingsTurn(state,{request:request(),usage,contextWindow:200000,requestModified:true,originalInputTokens:1000,nowMs:1000,...options});
test('usage validates disjoint cache buckets and all required counts',()=>{
 assert.deepEqual(normalizeSavingsUsage(usage),{input:100,cache_read:200,cache_creation_5m:10,cache_creation_1h:20,output:50});
 for(const bad of [{}, {...usage,input_tokens:-1}, {...usage,output_tokens:NaN}, {...usage,cache_creation_input_tokens:31}, {...usage,cache_read_input_tokens:'200'}, {...usage,output_tokens:1.5}]) assert.equal(normalizeSavingsUsage(bad),undefined);
 assert.equal(normalizeSavingsUsage({...usage,cache_creation:undefined}).cache_creation_5m,30);
});
test('an unmarked passthrough uses its measured total and read evidence, with no plain writes',()=>{
 const {state,turn:result}=turn(createSavingsState(),{requestModified:false,originalInputTokens:undefined});
 assert.equal(result.original_input_tokens,330);
 assert.equal(result.input_source,'actual');
 assert.deepEqual(result.plain_tokens,{input:130,cache_read:200,cache_creation_1h:0,cache_creation_5m:0,output:50});
});
test('structural history survives edits, model changes and long gaps and isolates lanes',()=>{
 const cachedRequest={...request('a'.repeat(8000)),cache_control:{type:'ephemeral'}};
 const opts={request:cachedRequest,originalInputTokens:2000,usage:{input_tokens:0,cache_creation_input_tokens:2000,output_tokens:5}};
 const first=turn(createSavingsState(),opts);
 const hit=turn(first.state,{...opts,nowMs:2000});
 assert.equal(hit.turn.plain_tokens.cache_read,2000);
 assert.equal(turn(first.state,{...opts,nowMs:302000}).turn.plain_tokens.cache_read,2000);
 for(const options of [{request:{...cachedRequest,messages:request('b'.repeat(8000)).messages}},{model:'claude-opus-4-6'}]) assert.equal(turn(first.state,{...opts,...options}).turn.plain_tokens.cache_read,2000);
 assert.equal(turn(first.state,{...opts,laneKey:'other'}).turn.plain_tokens.cache_read,0,'separate conversation lane');
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
test('unmeasured original input leaves the plain price pending',()=>{
 const result=turn(createSavingsState(),{originalInputTokens:undefined});
 assert.equal(result.turn.input_source,'unmeasured');
 assert.equal(result.turn.original_input_tokens,null);
 assert.equal(result.turn.plain_tokens,null);
});
test('mixed TTLs affect writes and gap diagnostics, never repeat pricing',()=>{
 const mixed={...request(),system:[{type:'text',text:'x'.repeat(8000),cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:[{type:'text',text:'y'.repeat(8000),cache_control:{type:'ephemeral'}}]}]};
 const args={request:mixed,originalInputTokens:4000,usage:{input_tokens:0,output_tokens:5,
   cache_creation_input_tokens:4000,cache_creation:{ephemeral_1h_input_tokens:2000,ephemeral_5m_input_tokens:2000}}};
 const first=turn(createSavingsState(),args);
 assert.equal(first.turn.plain_tokens.cache_creation_1h,0,'no exact interior token boundary');
 assert.equal(first.turn.plain_tokens.cache_creation_5m+first.turn.plain_tokens.cache_creation_1h,4000);
 const next=turn(first.state,{...args,nowMs:600001});
 assert.equal(next.turn.plain_tokens.cache_read,4000);
 assert.equal(next.turn.plain_tokens.cache_creation_1h,0);
 assert.equal(next.turn.plain_tokens.cache_creation_5m,0);
 const expired=turn(first.state,{...args,nowMs:3601001});
 assert.equal(expired.turn.plain_tokens.cache_read,4000);
 assert.equal(expired.turn.floor_read_possibly_uncached_tokens,4000);
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
 assert.equal(noControls.turn.plain_tokens.input,0);
 assert.equal(noControls.turn.plain_tokens.cache_read,2000);
 assert.equal(noControls.turn.plain_tokens.cache_creation_5m,0);
 const small=turn(createSavingsState(),{...args,originalInputTokens:1000});
 assert.equal(small.turn.plain_tokens.input,1000);
 assert.equal(small.turn.plain_tokens.cache_creation_5m,0);
 const extended={...automatic,messages:[...automatic.messages,{role:'assistant',content:'z'.repeat(4000)}]};
 const append=turn(first.state,{...args,request:extended,prefixCount:{messages:1,tokens:2000},originalInputTokens:3000,nowMs:2000});
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

test('a first passthrough above the ceiling compacts plain and preserves observed actual reads', () => {
 const args = {request:{...request(),cache_control:{type:'ephemeral'}},requestModified:false,
   usage:{input_tokens:1,cache_read_input_tokens:160999,output_tokens:1}};
 const result=turn(createSavingsState(),args);
 assert.equal(result.turn.plain_tokens.cache_creation_5m,17024);
 assert.equal(result.turn.actual_tokens.cache_read,160999);
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

test('21 appended tool calls and results retain the previously sent plain prefix', () => {
 const req={...request('x'.repeat(120000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,originalInputTokens:30000});
 const calls=Array.from({length:21},(_,i)=>({type:'tool_use',id:String(i),name:'test',input:{}}));
 const results=calls.map(call=>({type:'tool_result',tool_use_id:call.id,content:'ok'}));
 const next=turn(first.state,{prefixCount:{messages:1,tokens:30000},originalInputTokens:30500,
   usage:{input_tokens:500,cache_read_input_tokens:30000,output_tokens:10},request:{...req,messages:[...req.messages,
   {role:'assistant',content:calls},{role:'user',content:results}]}});
 assert.ok(next.turn.plain_tokens.cache_read>=29900);
});

test('the first compressed turn can reuse a prefix warmed by a passthrough', () => {
 const req={...request('x'.repeat(120000)),cache_control:{type:'ephemeral'}};
 const first=turn(createSavingsState(),{request:req,requestModified:false,
   usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:1}});
 const next=turn(first.state,{request:{...req,messages:[...req.messages,{role:'assistant',content:'ok'}]},
   prefixCount:{messages:1,tokens:30000},originalInputTokens:30500,usage:{input_tokens:4000,output_tokens:1},nowMs:2000});
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

test('a first observed continuation has unknown history in every conversation lane', () => {
 const messages = [...request('x'.repeat(320000)).messages,
   {role:'assistant',content:'done'},{role:'user',content:'continue'}];
 for (const ttl of ['5m','1h']) for (const laneKey of ['main','away']) {
   const result=turn(createSavingsState(),{laneKey,request:{...request(),messages,cache_control:{type:'ephemeral',ttl}},
     originalInputTokens:80010,usage:{input_tokens:2000,output_tokens:5}});
   assert.equal(result.turn.plain_tokens,null);
   assert.equal(result.turn.floor_read_max_gap_seconds,null);
 }
});

test('replacing all earlier messages or editing a block adds no new positions', () => {
  const prompt = (head, tail) => ({...request(), cache_control:{type:'ephemeral'},
    messages:[{role:'user',content:head.repeat(60000)}, {role:'assistant',content:tail.repeat(60000)}]});
  const initial = turn(createSavingsState(),{request:request('a'),originalInputTokens:15000});
  const first = turn(initial.state, {request:prompt('a','b'), prefixCount:{messages:1,tokens:15000}, requestModified:false,
    usage:{input_tokens:0, cache_creation_input_tokens:30000, output_tokens:1}});
  const next = request => turn(first.state, {request, originalInputTokens:30000, nowMs:11000}).turn.plain_tokens;
  const replaced = next(prompt('c','d'));
  assert.deepEqual([replaced.cache_read,replaced.cache_creation_5m], [30000,0]);
  const edited = next(prompt('a','d'));
  assert.equal(edited.cache_read,30000,'the interior boundary has no measured count');
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
  assert.equal(next.turn.plain_tokens.cache_read,12000);
});

test('changing from five minutes to one hour only affects newly sent tokens', () => {
  const req = {...request('a'.repeat(120000)),cache_control:{type:'ephemeral'}};
  const first = turn(createSavingsState(),{request:req,requestModified:false,
    usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:0}});
  const next = turn(first.state,{nowMs:601000,prefixCount:{messages:1,tokens:30000},originalInputTokens:31000,
    request:{...req,cache_control:{type:'ephemeral',ttl:'1h'},
      messages:[...req.messages,{role:'assistant',content:'new'}]}});
  assert.equal(next.turn.plain_tokens.cache_read,30000);
  assert.equal(next.turn.plain_tokens.cache_creation_1h,1000);
  assert.equal(next.turn.floor_read_possibly_uncached_tokens,30000);
  assert.equal(next.turn.floor_read_max_gap_seconds,600);
});

test('a passthrough reports measured usage and preserves plain compaction for the next ride', () => {
  const messages = request('x'.repeat(20000)).messages;
  const args = {request:{...request(),messages},contextWindow:5000,originalInputTokens:5000};
  const first = turn(createSavingsState(),args);
  assert.equal(first.turn.compacted,true);
  const pass = turn(first.state,{...args,requestModified:false,usage:{input_tokens:5000,output_tokens:10}});
  assert.equal(pass.turn.actual_tokens.input,5000);
 assert.equal(pass.turn.plain_tokens.cache_read,first.turn.plain_input_tokens);
  const next = turn(pass.state,{...args,request:{...request(),messages:[...messages,{role:'user',content:'next'}]},
    originalInputTokens:5010});
  assert.equal(next.turn.compacted,false);
  assert.equal(next.turn.plain_input_tokens,first.turn.plain_input_tokens+10);
});

test('a rewrite can invalidate the cached suffix after the edited block upstream', () => {
  const prompt = middle => ({...request(),cache_control:{type:'ephemeral'},
    messages:[...request(middle.repeat(4000)).messages,...request('tail'.repeat(2000)).messages]});
  const req = prompt('a');
  const prior = turn(createSavingsState(),{request:req,requestModified:false,
    usage:{input_tokens:0,cache_creation_input_tokens:3000,output_tokens:1}});
  const next = turn(prior.state,{request:req,originalInputTokens:3000,
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

test('round 7 stable compressed five-minute misses read the entire previously sent plain prefix', () => {
  const block = (text, ttl) => ({type:'text',text,cache_control:{type:'ephemeral',ttl}});
  const source = {model:'claude-sonnet-4-6',messages:[{role:'user',content:[
    block('main '.repeat(30000),'1h'),block('tail '.repeat(1000),'5m')]}]};
  const args = {request:source,originalInputTokens:31000,contextWindow:200000};
  const write = turn(createSavingsState(),{...args,requestModified:false,nowMs:1000,
    usage:{input_tokens:0,cache_creation_input_tokens:31000,output_tokens:0,
      cache_creation:{ephemeral_1h_input_tokens:30000,ephemeral_5m_input_tokens:1000}}});
  const compressed = {...args,usage:{input_tokens:0,cache_creation_input_tokens:2000,output_tokens:0}};
  const rewrite = turn(write.state,{...compressed,nowMs:2000});
  const stable = turn(rewrite.state,{...compressed,nowMs:602000}).turn;
  assert.deepEqual(stable.plain_tokens,{input:0,cache_read:31000,cache_creation_5m:0,cache_creation_1h:0,output:0});
  assert.equal(stable.floor_read_possibly_uncached_tokens,1000);
  assert.equal(stable.floor_read_max_gap_seconds,600);
});

test('round 7 low-density append keeps the fully measured 30000-token prefix', () => {
  const block = text => ({type:'text',text,cache_control:{type:'ephemeral'}});
  const original = {model:'claude-sonnet-4-6',messages:[{role:'user',content:[block('word'.repeat(30000))]}]};
  const first = turn(createSavingsState(),{request:original,requestModified:false,
    usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:1}});
  const request = {...original,messages:[...original.messages,{role:'assistant',content:[block(' '.repeat(120000)+'end')]}]};
  const next = turn(first.state,{request,prefixCount:{messages:1,tokens:30000},originalInputTokens:31000,nowMs:2000,usage:{input_tokens:900,output_tokens:1}});
  assert.deepEqual(next.turn.plain_tokens,{input:0,cache_read:30000,cache_creation_5m:1000,cache_creation_1h:0,output:1});
});

test('seen unmarked input and a revisited branch stay reads, including on passthrough', () => {
  const opts = {request:request('m'.repeat(10000)),originalInputTokens:2500,requestModified:false,
    usage:{input_tokens:2500,output_tokens:1}};
  const first = turn(createSavingsState(),opts);
  const sibling = turn(first.state,{...opts,request:request('another branch')});
  const repeat = turn(sibling.state,{...opts,nowMs:601000}).turn;
  assert.equal(repeat.plain_tokens.cache_read,2500);
  assert.equal(repeat.floor_read_possibly_uncached_tokens,2500);
  assert.equal(repeat.floor_read_max_gap_seconds,600);
});

test('after a rewind the next append uses the immediately preceding structural cursor', () => {
  const marker = {type:'ephemeral'};
  const head = {...request('head'),cache_control:marker};
  const full = {...head,messages:[...head.messages,{role:'assistant',content:'tail'}]};
  const measure = (state,req,nowMs,tokens) => turn(state,{request:req,originalInputTokens:tokens,prefixCount:{messages:1,tokens:2000},nowMs});
  const first = measure(createSavingsState(),head,1000,2000);
  const added = measure(first.state,full,2000,2500);
  const refresh = measure(added.state,head,601000,2000);
  const repeat = measure(refresh.state,full,901000,2500).turn;
  assert.equal(repeat.plain_tokens.cache_read,2000);
  assert.equal(repeat.plain_tokens.cache_creation_5m,500);
  assert.equal(repeat.floor_read_possibly_uncached_tokens,0);
  assert.equal(repeat.floor_read_max_gap_seconds,0);
  const late = measure(refresh.state,full,902000,2500).turn;
  assert.equal(late.floor_read_possibly_uncached_tokens,2000);
  assert.equal(late.floor_read_max_gap_seconds,301);
});

test('mixed gap diagnostics with an unmeasured interior boundary stay unknown', () => {
  const request = {model:'claude-sonnet-4-6',messages:[{role:'user',content:[
    {type:'text',text:'long',cache_control:{type:'ephemeral',ttl:'1h'}},
    {type:'text',text:'short',cache_control:{type:'ephemeral'}}]}]};
  const opts = {request,originalInputTokens:31000};
  const first = turn(createSavingsState(),opts);
  const repeat = turn(first.state,{...opts,nowMs:601000}).turn;
  assert.equal(repeat.plain_tokens.cache_read,31000);
  assert.equal(repeat.floor_read_possibly_uncached_tokens,null);
  assert.equal(repeat.floor_read_max_gap_seconds,600);
});
