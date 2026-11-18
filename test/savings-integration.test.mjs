import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeUsageFromSseEvent, mergeUsageFromJsonBody } from '../dist/reqlog.js';
import { renderSavingsSegment } from '../dist/savings-status.js';
import { renderStatusline } from '../dist/statusline.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-savings-integration-'));
const summary = { net_usd: 4.2, less_usage_percent: 38, costs_complete: true,
  progress_tokens: 410, budget_tokens: 1000, url: 'https://app.polychat.co/usage#savings' };

test('SSE and JSON usage retain 5 minute and 1 hour cache creation separately', () => {
  for (const stream of [true, false]) {
    const rec = { kind: 'messages', turnType: 'first', requestBytes: 0 };
    const usage = { input_tokens: 10, cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
      output_tokens: 1 };
    if (stream) {
      mergeUsageFromSseEvent({type:'message_start',message:{usage}}, rec);
      mergeUsageFromSseEvent({type:'message_delta',usage:{output_tokens:8}}, rec);
    } else mergeUsageFromJsonBody(Buffer.from(JSON.stringify({usage})),rec);
    assert.deepEqual(rec.usage.cache_creation, usage.cache_creation);
    assert.equal(rec.usage.output_tokens, stream ? 8 : 1);
  }
});

test('status shows net dollars and percent; width drops percentage before dollars', () => {
  const wide = renderSavingsSegment(summary, {CCC_STATUSLINE_LINK:'osc8'}, 120);
  assert.match(wide, /🌿 MemTree · \$4\.20 saved · 38% less usage/);
  assert.match(renderSavingsSegment({...summary,less_usage_percent:0.1},
    {CCC_STATUSLINE_LINK:'osc8'},120), /<1% less usage/);
  const narrow = renderSavingsSegment(summary, {CCC_STATUSLINE_LINK:'osc8'}, 45);
  assert.match(narrow, /\$4\.20 saved/);
  assert.doesNotMatch(narrow, /38%/);
  for (const s of [{...summary,net_usd:0}, {...summary,net_usd:-1},
    {...summary,costs_complete:false}, {...summary,net_usd:0.001}]) {
    const line = renderSavingsSegment(s, {}, 120);
    assert.equal(line,'🌿 MemTree [■■■■□□□□□□] 41% to savings');
  }
});

test('a complete protocol is required before usage can support a savings claim', () => {
  const rec={kind:'messages',turnType:'first',requestBytes:0};
  mergeUsageFromSseEvent({type:'message_start',message:{usage:{input_tokens:100,output_tokens:0}}},rec);
  assert.equal(rec.savingsUsageComplete,undefined);
  mergeUsageFromSseEvent({type:'message_delta',usage:{output_tokens:20}},rec);
  assert.equal(rec.savingsUsageComplete,undefined);
  mergeUsageFromSseEvent({type:'message_stop'},rec);
  assert.equal(rec.savingsUsageComplete,true);
});

test('malformed or missing final usage never inherits a valid initial output count', () => {
  for (const finalUsage of [undefined, {}, {output_tokens:'20'}, {output_tokens:null},
    {output_tokens:NaN}, {output_tokens:Infinity}, {output_tokens:-1},
    {output_tokens:1.5}, {output_tokens:Number.MAX_SAFE_INTEGER+1},
    {output_tokens:20,cache_read_input_tokens:'bad'},
    {output_tokens:20,cache_creation:{ephemeral_1h_input_tokens:'bad'}}]) {
    const rec={kind:'messages',turnType:'first',requestBytes:0};
    mergeUsageFromSseEvent({type:'message_start',message:{usage:{input_tokens:100,output_tokens:0}}},rec);
    mergeUsageFromSseEvent({type:'message_delta',usage:finalUsage},rec);
    mergeUsageFromSseEvent({type:'message_stop'},rec);
    assert.notEqual(rec.savingsUsageComplete,true,JSON.stringify(finalUsage));
  }
  const rec={kind:'messages',turnType:'first',requestBytes:0};
  mergeUsageFromSseEvent({type:'message_start',message:{usage:{input_tokens:100,output_tokens:0}}},rec);
  mergeUsageFromSseEvent({type:'message_stop'},rec);
  assert.notEqual(rec.savingsUsageComplete,true,'message_stop alone is insufficient');
  mergeUsageFromSseEvent({type:'message_delta',usage:{output_tokens:10}},rec);
  mergeUsageFromSseEvent({type:'message_delta',usage:{}},rec);
  mergeUsageFromSseEvent({type:'message_stop'},rec);
  assert.notEqual(rec.savingsUsageComplete,true,'earlier numeric output cannot replace missing final output');
});

test('savings JSON completeness requires a message and valid full usage', () => {
  for(const body of [{usage:{input_tokens:100,output_tokens:20}},
    {type:'message',content:[],usage:{input_tokens:100,output_tokens:'20'}},
    {type:'message',content:[],usage:{input_tokens:100}},
    {type:'message',content:[],usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:'invalid'}},
    {type:'error',content:[],usage:{input_tokens:100,output_tokens:20}}]) {
    const rec={kind:'messages',turnType:'first',requestBytes:0};
    mergeUsageFromJsonBody(Buffer.from(JSON.stringify(body)),rec);
    assert.notEqual(rec.savingsUsageComplete,true);
  }
  const rec={kind:'messages',turnType:'first',requestBytes:0};
  mergeUsageFromJsonBody(Buffer.from(JSON.stringify({type:'message',content:[],usage:{input_tokens:100,output_tokens:20}})),rec);
  assert.equal(rec.savingsUsageComplete,true);
});

test('freshly parsed appends reuse a verified large message, edits rebuild it', async () => {
 const {SavingsHistory}=await import('../dist/savings-history.js');
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 const history=new SavingsHistory();
 const make=(char,tail,header)=>({system:'x-anthropic-billing-header: cch='+header+';',
   model:'claude-sonnet-4-6',messages:[{role:'user',content:char.repeat(90000)},...tail],
   cache_control:{type:'ephemeral'}});
 let state=createSavingsState();
 const one=(req,expectedReuse)=>{
   const bytes=Buffer.from(JSON.stringify(req));
   const replay=history.request(sessionId,bytes);
   const input={usage:{input_tokens:10,output_tokens:1},requestModified:true,contextWindow:200000,
     request:JSON.parse(bytes),nowMs:1000};
   const expected=accountSavingsTurn(state,input);
   if(expectedReuse) Object.defineProperty(input.request.messages[0],'content',{
     get(){throw Error('accounting traversed verified history');}});
   const actual=accountSavingsTurn(state,{...input,replay});
   assert.deepEqual(actual,expected);
   state=actual.state;
 };
 const tail=[{role:'assistant',content:'hello'}];
 one(make('x',[],'a'),false);
 one(make('x',tail,'longer-changing-field'),true);
 one(make('y',tail,'again'),false);
});

test('response usage speed overrides requested speed for JSON and SSE', async () => {
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 for(const stream of [true,false]){
   const rec={kind:'messages',turnType:'first',requestBytes:0};
   const usage={input_tokens:100,output_tokens:10,speed:'standard'};
   if(stream){
     mergeUsageFromSseEvent({type:'message_start',message:{usage}},rec);
     mergeUsageFromSseEvent({type:'message_delta',usage:{output_tokens:10}},rec);
     mergeUsageFromSseEvent({type:'message_stop'},rec);
   }else mergeUsageFromJsonBody(Buffer.from(JSON.stringify({type:'message',content:[],usage})),rec);
   const {turn}=accountSavingsTurn(createSavingsState(),{request:{model:'claude-opus-4-6',speed:'fast'},
     requestModified:false,usage:rec.usage,contextWindow:200000});
   assert.equal(turn.fast_mode,false);
 }
});

test('a duplicate messages key cannot lend a digest to a different conversation', async () => {
 const {SavingsHistory}=await import('../dist/savings-history.js');
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 const history=new SavingsHistory();
 const first=[{role:'user',content:'x'.repeat(90000)}];
 const changed=[{role:'user',content:'y'.repeat(30000)}];
 let state=createSavingsState();
 for(const raw of [JSON.stringify({messages:first}), '{"messages":'+JSON.stringify(first)+',"mess\\u0061ges":'+JSON.stringify(changed)+'}']){
   const bytes=Buffer.from(raw);
   const replay=history.request(sessionId,bytes);
   const input={usage:{input_tokens:10,output_tokens:1},requestModified:true,model:'claude-sonnet-4-6',
     contextWindow:200000,request:JSON.parse(raw),nowMs:1000};
   const expected=accountSavingsTurn(state,input);
   const actual=accountSavingsTurn(state,{...input,replay});
   assert.deepEqual(actual,expected);
   state=actual.state;
 }
});

test('terminal width accounts for wide text, combining marks and joined emoji', async () => {
 const {visibleWidth}=await import('../dist/savings-status.js');
 assert.equal(visibleWidth('樹木'),4);
 assert.equal(visibleWidth('e\u0301'),1);
 assert.equal(visibleWidth('👩‍💻'),2);
 assert.equal(visibleWidth('\x1b]8;;https://example.test\x1b\\樹\x1b]8;;\x1b\\'),2);
});

test('a verified append also reuses an unchanged system and tools frame', async () => {
 const {SavingsHistory}=await import('../dist/savings-history.js');
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 const history=new SavingsHistory();
 const req={system:'s'.repeat(90000),messages:[{role:'user',content:'hi'}],tools:[{name:'a'}]};
 const input={requestModified:true,model:'claude-sonnet-4-6',contextWindow:200000,
   usage:{input_tokens:10,output_tokens:1},nowMs:1000};
 let state=createSavingsState();
 for (const append of [false,true]) {
   if(append) req.messages.push({role:'assistant',content:'ok'});
   const bytes=Buffer.from(JSON.stringify(req)),request=JSON.parse(bytes);
   const replay=history.request(sessionId,bytes);
   const expected=accountSavingsTurn(state,{...input,request});
   if(append) Object.defineProperty(request,'system',{get(){throw Error('reread verified system');}});
   const result=accountSavingsTurn(state,{...input,request,replay});
   assert.deepEqual(result,expected);
   state=result.state;
 }
});


const sessionId = '12345678-1234-4123-8123-123456789abc';
const reporter = (report = () => {}) => ({savingsAccount:{},bindSavings:()=>report});
const input = {
  request: {model:'claude-opus-5-5', speed:'fast', messages:[{role:'user',content:'private'}]},
  usage: {input_tokens:100,output_tokens:10}, contextWindow:200000, nowMs:1700000000000,
  requestModified:false,
};

test('each observation reports only that turn, even after resume or under another account', async () => {
  const { SavingsTracker } = await import('../dist/savings-tracker.js');
  const seen=[];
  for (const tokens of [100,200,300]) {
    const tracker=new SavingsTracker({diagnostics:reporter(turn=>seen.push(turn))});
    await tracker.settle(tracker.startTurn(sessionId),{...input,usage:{input_tokens:tokens,output_tokens:10}},200);
  }
  assert.equal(new Set(seen.map(t=>t.turn_id)).size,3);
  assert.deepEqual(seen.map(t=>t.actual.input),[100,200,300]);
  for (const turn of seen) {
    assert.deepEqual(turn.plain,turn.actual);
    assert.equal(turn.requested_at,new Date(input.nowMs).toISOString());
    assert.equal(turn.fast_mode,true);
    assert.doesNotMatch(JSON.stringify(turn),/private|sequence|plain_api_usd/);
  }
});

test('missing usage is recorded as unknown on both sides', async () => {
  const { SavingsTracker } = await import('../dist/savings-tracker.js');
  let report;
  const tracker=new SavingsTracker({diagnostics:reporter(turn=>{report=turn})});
  await tracker.settle(tracker.startTurn(sessionId),{...input,usage:undefined},200);
  assert.equal(report.actual,null);
  assert.equal(report.plain,null);
});

test('only valid session UUIDs reach the outbox and status endpoint', async () => {
  const { SavingsTracker } = await import('../dist/savings-tracker.js');
  let calls=0;
  const tracker=new SavingsTracker({diagnostics:reporter(()=>calls++),
    fetchTotal:async()=>{calls++}});
  for(const id of ['../other','PRIVATE HEADER',sessionId+'\n']) {
    tracker.progress(id,700,1000);
    assert.equal(tracker.startTurn(id),undefined);
    assert.equal(await tracker.view(id),undefined);
  }
  assert.equal(calls,0);
});

test('main progress survives a helper settlement and delayed server response', async () => {
  const { SavingsTracker } = await import('../dist/savings-tracker.js');
  let resolve;
  const tracker=new SavingsTracker({diagnostics:reporter(),
    fetchTotal:()=>new Promise(r=>{resolve=r})});
  tracker.progress(sessionId,100,1000);
  const first=tracker.view(sessionId);
  tracker.progress(sessionId,700,1000);
  await tracker.settle(tracker.startTurn(sessionId),input,200);
  resolve({session_id:sessionId,net_usd:0,net_percent:0,costs_complete:true});
  assert.equal((await first).progress_tokens,700);
  assert.equal((await tracker.view(sessionId)).progress_tokens,700);
});

test('server totals have a ten-second cache and survive a failed refresh', async () => {
  const { SavingsTracker } = await import('../dist/savings-tracker.js');
  let calls=0,now=0;
  const tracker=new SavingsTracker({now:()=>now,fetchTotal:async()=>{
    if (++calls===2) throw Error('offline');
    return {session_id:sessionId,net_usd:calls===1?4.2:-1,net_percent:38,costs_complete:true};
  }});
  tracker.progress(sessionId,410,1000);
  assert.equal((await tracker.view(sessionId)).net_usd,4.2);
  now=9999;
  assert.equal((await tracker.view(sessionId)).net_usd,4.2);
  assert.equal(calls,1);
  now=10001;
  assert.equal((await tracker.view(sessionId)).net_usd,4.2);
  now=21000;
  assert.equal((await tracker.view(sessionId)).net_usd,-1);
  assert.match(renderSavingsSegment(await tracker.view(sessionId)),/41% to savings/);
});

test('status asks its own launcher, fits terminal width and keeps tree last',async () => {
  const dir=tmp();
  try {
    fs.writeFileSync(path.join(dir,sessionId+'.url'),'https://example.test/tree');
    const paths={settings:path.join(dir,'settings'),saved:path.join(dir,'saved'),links:dir};
    const env={ANTHROPIC_BASE_URL:'http://127.0.0.1:4333',_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL:'1',
      CCC_STATUSLINE_LINK:'url',COLUMNS:'200',CCC_SAVINGS_TOKEN:'this-launcher'};
    const fetchView=async (url,init)=>{
      assert.equal(init.headers['x-ccc-savings-token'],'this-launcher');
      assert.equal(String(url),'http://127.0.0.1:4333/memtree/savings?session='+sessionId);
      return Response.json(summary);
    };
    const stdin=JSON.stringify({session_id:sessionId});
    assert.match(await renderStatusline(stdin,paths,env,fetchView),
      /\$4.20 saved.*usage#savings.*https:\/\/example.test\/tree/);
    const {visibleWidth}=await import('../dist/savings-status.js');
    for (let i=1;i<80;i++) for (const view of [summary,{...summary,costs_complete:false}]) {
      const line=await renderStatusline(stdin,paths,{...env,NO_COLOR:'1',COLUMNS:String(i)},
        async()=>Response.json(view));
      assert.ok(visibleWidth(line)<=i);
    }
    assert.doesNotMatch(renderSavingsSegment({...summary,url:'https://bad/\x1b]2;evil'}),/evil/);
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});

test('cold resume can fetch before a request; a slow refresh still returns the cached value',async () => {
  const {SavingsTracker}=await import('../dist/savings-tracker.js');
  let now=0, calls=0, resolve;
  const tracker=new SavingsTracker({now:()=>now,fetchTotal:async()=>{
    calls++;
    if (calls===1) return {session_id:sessionId,net_usd:1,net_percent:11,costs_complete:true};
    return new Promise(r=>{resolve=r});
  }});
  assert.equal((await tracker.view(sessionId)).net_usd,1);
  now=10001;
  const result=await Promise.race([tracker.view(sessionId),new Promise(r=>setTimeout(r,500))]);
  assert.equal(result?.net_usd,1);
  resolve({session_id:sessionId,net_usd:2,net_percent:20,costs_complete:true});
  await new Promise(r=>setImmediate(r));
  assert.equal((await tracker.view(sessionId)).net_usd,2);
});

test('a refused key during compression suspends savings immediately, a gateway 403 does not',async t => {
  const {MemtreeClient}=await import('../dist/memtree.js');
  let suspended=0;
  const messages=[{role:'user',content:'hello'}];
  let status=403;
  t.mock.method(globalThis,'fetch',async()=>new Response('gateway failure',{status}));
  for (status of [403,401]) {
    const client=new MemtreeClient({baseUrl:'https://example.test',apiKey:'key',
      onInvalidKey:()=>suspended++});
    await client.compress(MemtreeClient.hashMessages(messages),messages,200000);
  }
  assert.equal(suspended,1);
});

test('failed dispatch cannot claim savings and local refusals carry no fabricated timestamp',async () => {
  const {SavingsTracker}=await import('../dist/savings-tracker.js');
  const reports=[];
  let enabled=true;
  const account={};
  const tracker=new SavingsTracker({diagnostics:{bindSavings:()=>r=>reports.push(r),
    get savingsAccount(){return enabled ? account : undefined}}});
  assert.equal(tracker.startTurn('../other'),undefined);
  enabled=false;
  assert.equal(tracker.startTurn(sessionId),undefined);
  enabled=true;
  await tracker.settle(tracker.startTurn(sessionId),{...input,nowMs:undefined},0);
  for(const status of [429,0,500]) await tracker.settle(tracker.startTurn(sessionId),input,status);
  assert.equal(reports.length,3);
  assert.ok(Object.values(reports[0].actual).every(n=>n===0));
  assert.deepEqual(reports[0].actual,reports[0].plain);
  assert.deepEqual(reports.slice(1).map(r=>[r.actual,r.plain]),[[null,null],[null,null]]);
});

test('credential rotation cannot move an in-flight turn into the replacement account',async t=>{
  const {SavingsTracker}=await import('../dist/savings-tracker.js');
  const {MemtreeClient}=await import('../dist/memtree.js');
  const reports=[], calls=[];
  const accountA=reports,accountB=[];
  const owner={savingsAccount:accountA,bindSavings(){const out=this.savingsAccount;return r=>out.push(r)}};
  const tracker=new SavingsTracker({diagnostics:owner});
  const observed=tracker.startTurn(sessionId);
  const meta={lane:'main'};
  owner.savingsAccount=accountB;
  t.mock.method(globalThis,'fetch',async (_url,init)=>{
    calls.push(JSON.parse(init.headers['x-client-meta']));
    return Response.json({messages:[{role:'user',content:'ok'}],compressed:true});
  });
  const client=new MemtreeClient({baseUrl:'https://example.test',apiKey:'original-key'});
  const messages=[{role:'user',content:'hello'}];
  await client.compress(MemtreeClient.hashMessages(messages),messages,200000,undefined,{sessionId,clientMeta:meta});
  await tracker.settle(observed,input,200);
  assert.equal(calls[0].savings_turn_id,undefined);
  assert.deepEqual(accountA.map(r=>r.turn_id),[observed.id]);
  assert.deepEqual(accountB,[]);
  assert.equal(tracker.startTurn(sessionId),undefined);
});

test('status recognizes the same uppercase and lowercase session UUID',async()=>{
  const {SavingsTracker}=await import('../dist/savings-tracker.js');
  const tracker=new SavingsTracker({fetchTotal:async id=>({
    session_id:id.toUpperCase(),net_usd:2,net_percent:20,costs_complete:true
  })});
  assert.equal((await tracker.view(sessionId.toUpperCase())).net_usd,2);
});

test('budget progress works without a reporting credential and across UUID case',async () => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const tracker = new SavingsTracker();
  tracker.progress(sessionId.toLowerCase(),70,100);
  const view = await tracker.view(sessionId.toUpperCase());
  assert.equal(view.progress_tokens,70);
  assert.equal(tracker.startTurn(sessionId),undefined);
});

test('nullable cache duration breakdown and zero created tokens are measured', () => {
  const rec = {};
  mergeUsageFromJsonBody(Buffer.from(JSON.stringify({type:'message',content:[],
    usage:{input_tokens:21,output_tokens:4,cache_creation_input_tokens:0,cache_creation:null}})), rec);
  assert.equal(rec.savingsUsageComplete, true);
  assert.equal(rec.usage.cache_creation_input_tokens, 0);
});

test('stream usage can be measured across start and final delta', () => {
  for (const [start,delta,intermediate] of [
    [{input_tokens:21,output_tokens:0}, {input_tokens:null,output_tokens:4,cache_creation:null}],
    [null, {input_tokens:21,output_tokens:4}, {type:'message_delta',usage:null}],
    [{input_tokens:null,output_tokens:0}, {input_tokens:21,output_tokens:4}],
  ]) {
    const rec = {};
    mergeUsageFromSseEvent({type:'message_start',message:{usage:start}}, rec);
    if (intermediate) mergeUsageFromSseEvent(intermediate,rec);
    mergeUsageFromSseEvent({type:'message_delta',usage:delta}, rec);
    mergeUsageFromSseEvent({type:'message_stop'}, rec);
    assert.equal(rec.savingsUsageComplete, true, JSON.stringify([start,delta]));
    assert.deepEqual(rec.usage, {input_tokens:21,output_tokens:4});
  }
});

test('only an authoritative session-unavailable response withdraws a cached total', async () => {
  const {SavingsTracker, sessionSavingsResponse} = await import('../dist/savings-tracker.js');
  const responses = [
    [200, {session_id:sessionId, net_usd:1,costs_complete:true}],
    [404, {detail:'Gateway not found'}],
    [503, {detail:'Session unavailable'}],
    [404, {detail:'Session unavailable'}],
  ];
  let now = 0;
  const tracker = new SavingsTracker({now:()=>now,fetchTotal:async id=>{
    const [status, body] = responses.shift();
    return sessionSavingsResponse(id,status,Buffer.from(JSON.stringify(body)));
  }});
  tracker.progress(sessionId,70,100);
  for (const expected of [1,1,1,null]) {
    const view = await tracker.view(sessionId);
    assert.equal(view.net_usd,expected);
    assert.equal(view.progress_tokens,70);
    now += 10001;
  }
});

test('a nullable creation total with both duration counts remains measured through settlement', async () => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const usage = {input_tokens:21, output_tokens:4, cache_creation_input_tokens:null,
    cache_creation:{ephemeral_5m_input_tokens:10, ephemeral_1h_input_tokens:20}};
  for (const stream of [false, true]) {
    const rec = {};
    if (stream) {
      mergeUsageFromSseEvent({type:'message_start',message:{usage}},rec);
      mergeUsageFromSseEvent({type:'message_delta',usage:{output_tokens:4}},rec);
      mergeUsageFromSseEvent({type:'message_stop'},rec);
    } else mergeUsageFromJsonBody(Buffer.from(JSON.stringify({type:'message',content:[],usage})),rec);
    assert.equal(rec.savingsUsageComplete,true);
    let report;
    const tracker = new SavingsTracker({diagnostics:reporter(value => { report = value; })});
    await tracker.settle(tracker.startTurn(sessionId),{...input,usage:rec.usage},200);
    assert.deepEqual(report.actual,{input:21,cache_read:0,cache_creation_5m:10,cache_creation_1h:20,output:4});
    assert.deepEqual(report.plain, report.actual);
  }
});
