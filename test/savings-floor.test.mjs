import assert from 'node:assert/strict';
import test from 'node:test';
import {accountSavingsTurn,createSavingsState} from '../dist/savings.js';
import {SavingsObservation} from '../dist/savings-turn.js';
import {randomUUID} from 'node:crypto';

const req = {model:'claude-sonnet-4-6',cache_control:{type:'ephemeral'},
  messages:[{role:'user',content:'word'.repeat(30000)}]};
const common = {request:req,requestModified:true,originalInputTokens:30000,contextWindow:200000,
  nowMs:1000,usage:{input_tokens:900,output_tokens:1}};
const run = (state,input={}) => accountSavingsTurn(state,{...common,...input});
const append = content => ({...req,messages:[...req.messages,{role:'assistant',content}]});

test('r8 low-density append without Count Tokens remains pending',()=>{
  const first=run(createSavingsState());
  const next=run(first.state,{request:append(' '.repeat(120000)),originalInputTokens:undefined});
  assert.equal(next.turn.plain_tokens,null);
  assert.equal(next.turn.actual_tokens.input,900);
});
test('r8 changes to encodings, settings and the history itself keep existing positions as reads',()=>{
  const first=run(createSavingsState());
  for(const content of [[{type:'text',text:req.messages[0].content}], 'edited']) {
    const request={...req,tool_choice:{type:'auto'},thinking:{type:'enabled',budget_tokens:2000},
      messages:[{role:'user',content}]};
    const next=run(first.state,{request});
    assert.equal(next.turn.plain_tokens.cache_read,30000);
  }
});
test('r8 changed framing and unobserved history cannot inflate the measured append',()=>{
  const first=run(createSavingsState());
  const messages=[...req.messages,{role:'assistant',content:'unobserved'},
    {role:'user',content:'earlier'},{role:'assistant',content:'new answer'},{role:'user',content:'new'}];
  const next=run(first.state,{originalInputTokens:51000,request:{...req,messages,system:'new system'},
    prefixCount:{messages:3,tokens:50990}});
  assert.equal(next.turn.plain_tokens,null,'the unseen request could already have compacted');
  const observed=run(first.state,{request:{...req,messages:messages.slice(0,3)},
    originalInputTokens:43000,prefixCount:{messages:1,tokens:30000}});
  const priced=run(observed.state,{originalInputTokens:51000,request:{...req,messages,system:'new system'},
    prefixCount:{messages:3,tokens:50990}});
  assert.equal(priced.turn.plain_tokens.cache_read,50990);
  assert.equal(priced.turn.plain_tokens.cache_creation_5m,10);
  assert.equal(next.turn.floor_read_max_gap_seconds,null);
});
test('r8 passthrough uses the 17024-token compacted conversation and full actual usage',()=>{
  const first=run(createSavingsState(),{originalInputTokens:170000});
  const next=run(first.state,{requestModified:false,usage:{input_tokens:170000,output_tokens:1}});
  assert.equal(next.turn.plain_tokens.cache_read,17024);
  assert.equal(next.turn.plain_input_tokens,17024);
  assert.equal(next.turn.actual_tokens.input,170000);
});
test('r8 byte-identical retry before settlement with no count stays pending',async()=>{
  const session=randomUUID(),scope=randomUUID(),reports=new Map();
  const observe=()=>new SavingsObservation(session,r=>reports.set(r.turn_id,r),scope);
  const one=observe(),two=observe();
  one.dispatched({...common,requestModified:false,originalInputTokens:undefined});
  const retry={...common,originalInputTokens:undefined,nowMs:1100};
  two.dispatched(retry);
  await one.settle({...common,requestModified:false,usage:{input_tokens:3200,output_tokens:1}},200);
  await two.settle(retry,200);
  assert.equal(reports.get(two.id).plain,null);
});
test('unbilled 529 is zero and an interrupted successful stream carries its reason',async()=>{
  const observe=async(status,interruptedStream)=>{
    let report;
    const o=new SavingsObservation(randomUUID(),v=>report=v,randomUUID());
    await o.settle({...common,usage:null,interruptedStream},status);
    return report;
  };
  const refused=await observe(529,false);
  assert.deepEqual(Object.values(refused.actual),[0,0,0,0,0]);
  assert.deepEqual(refused.plain,refused.actual);
  const esc=await observe(200,true);
  assert.equal(esc.plain,null);
  assert.equal(esc.incomplete_reason,'interrupted_stream');
});

test('moving the system into the message list cannot create an append on a retry',()=>{
  const first=run(createSavingsState(),{request:{...req,system:'frame'}});
  const retry=run(first.state,{request:{...req,messages:[
    {role:'system',content:'frame'},...req.messages]}});
  assert.equal(retry.turn.plain_tokens.cache_read,30000);
});

test('a retained-message count includes interleaved and trailing request framing',async()=>{
  const {savingsRetainedRequest}=await import('../dist/savings.js');
  const system={role:'system',content:'frame'},developer={role:'developer',content:'settings'};
  const request={...append('answer'),messages:[system,...req.messages,{role:'assistant',content:'answer'},developer]};
  assert.deepEqual(savingsRetainedRequest(request,1),{...request,messages:[system,...req.messages,developer]});
});

test('an older dispatch registered late cannot rewind the structural cursor',()=>{
  const later=run(createSavingsState(),{request:{...req,messages:[...req.messages,...req.messages]},nowMs:2000});
  const older=run(later.state,{nowMs:1000});
  const [lane]=Object.values(older.state.lanes);
  assert.equal(lane.at,2000);
  assert.equal(lane.messages,2);
  assert.equal(older.turn.plain_tokens,null);
  const next=run(older.state,{nowMs:3000,request:append('already sent')});
  assert.ok(next.turn.plain_tokens===null || next.turn.plain_tokens.cache_creation_5m===0);
});
