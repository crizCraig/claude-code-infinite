import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Diagnostics } from '../dist/diagnostics.js';
import { mergeUsageFromSseEvent, mergeUsageFromJsonBody } from '../dist/reqlog.js';
import { renderSavingsSegment, writeSavingsView } from '../dist/savings-status.js';
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

test('status keeps tree after savings and rejects unsafe view URLs/session paths', async () => {
  const dir=tmp();
  writeSavingsView('session', summary, dir);
  fs.writeFileSync(path.join(dir,'session.url'),'https://example.test/tree');
  const line=await renderStatusline('{"session_id":"session"}',
    {settings:path.join(dir,'settings'),saved:path.join(dir,'saved'),links:dir},
    {CCC_STATUSLINE_LINK:'url',COLUMNS:'200'});
  assert.match(line,/\$4.20 saved.*usage#savings.*https:\/\/example.test\/tree/);
  writeSavingsView('../unsafe',summary,dir);
  assert.equal(fs.existsSync(path.join(dir,'..','unsafe.savings-view.json')),false);
  assert.doesNotMatch(renderSavingsSegment({...summary,url:'https://bad/\x1b]2;evil'}, {},200), /evil/);
});

test('savings metadata is allowlisted, authenticated, opt-out respected and retried', async () => {
  for (const disabled of [true,false]) {
    const sent=[];
    let fail=true;
    const d=new Diagnostics({baseUrl:'https://example.test', configDir:tmp(),
      clientName:'ccc',clientVersion:'1.0.0',apiKey:'key',env:{},
      config:{diagnostics:!disabled}, fetchImpl:async(url, init)=>{
        sent.push(JSON.parse(init.body)); if(fail) throw Error('offline');
        return {ok:true,status:202};
      }});
    d.reportSavings({schema:1,session_id:sessionId,sequence:1,plain_api_usd:10,
      actual_api_usd:5,costs_complete:true, turns:1,window_crossings:0,
      token_counts:{input:1,cache_read:2,cache_creation_5m:3,cache_creation_1h:4,output:5},
      content:'never transmit this'});
    await d.flush(); fail=false; await d.flush();
    assert.equal(sent.length, disabled ? 0 : 2);
    if(!disabled){ assert.equal(sent[1].savings.session_id,sessionId);
      assert.equal(JSON.stringify(sent).includes('never transmit'),false); }
  }
});

test('tracker persists totals, reports no content, and rejects stale cost responses', async () => {
  const { SavingsTracker } = await import('../dist/savings-tracker.js');
  const { loadSavingsState } = await import('../dist/savings.js');
  const { readSavingsView } = await import('../dist/savings-status.js');
  const dir=tmp(), id='12345678-1234-4123-8123-123456789abc';
  let resolveCosts; const reports=[];
  const tracker=new SavingsTracker({dir,usageUrl:'https://app.polychat.co/usage',
    diagnostics:{record(){},reportSavings(value){reports.push(value)}},
    fetchCosts:()=>new Promise(resolve=>{resolveCosts=resolve})});
  const input={request:{model:'claude-sonnet-4-6',messages:[{role:'user',content:'private text'}]},
    usage:{input_tokens:100,output_tokens:10},contextWindow:200000,
    originalInputTokens:100000,requestModified:true};
  tracker.begin(id,410,1000);
  assert.equal(readSavingsView(id,dir).costs_complete,false);
  await tracker.settle(id,input);
  assert.equal(loadSavingsState(dir,id).turns,1);
  assert.equal(reports.length,1);
  tracker.begin(id,420,1000);
  resolveCosts({costs_complete:true,memtree_charged_usd:0,compression_api_usd:0});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(readSavingsView(id,dir).costs_complete,false,'old turn billing cannot validate new turn');
  const resumed=new SavingsTracker({dir});
  await resumed.settle(id,input);
  assert.equal(loadSavingsState(dir,id).turns,2);
  assert.equal(fs.readFileSync(path.join(dir,`${id}.savings.json`),'utf8').includes('private text'),false);
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
    {type:'message',content:[],usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:null}},
    {type:'error',content:[],usage:{input_tokens:100,output_tokens:20}}]) {
    const rec={kind:'messages',turnType:'first',requestBytes:0};
    mergeUsageFromJsonBody(Buffer.from(JSON.stringify(body)),rec);
    assert.notEqual(rec.savingsUsageComplete,true);
  }
  const rec={kind:'messages',turnType:'first',requestBytes:0};
  mergeUsageFromJsonBody(Buffer.from(JSON.stringify({type:'message',content:[],usage:{input_tokens:100,output_tokens:20}})),rec);
  assert.equal(rec.savingsUsageComplete,true);
});

test('shutdown drains a newer savings snapshot queued while an older one is sending', async () => {
  const sent=[];let release;
  const d=new Diagnostics({baseUrl:'https://example.test',configDir:tmp(),
    clientName:'ccc',clientVersion:'1.0.0',apiKey:'key',env:{},
    fetchImpl:async(url,init)=>{sent.push(JSON.parse(init.body).savings.sequence);
      if(sent.length===1) await new Promise(resolve=>{release=resolve});
      return {ok:true,status:202};}});
  const snapshot={schema:1,session_id:sessionId,sequence:1,plain_api_usd:1,actual_api_usd:1,
    costs_complete:true,turns:1,window_crossings:0,
    token_counts:{input:0,cache_read:0,cache_creation_5m:0,cache_creation_1h:0,output:0}};
  d.reportSavings(snapshot);d.flushNow();
  d.reportSavings({...snapshot,sequence:2});
  const done=d.flush(1000);release();await done;
  assert.deepEqual(sent,[1,2]);
});

const sessionId='12345678-1234-4123-8123-123456789abc';
test('independent processes beginning together allocate distinct cumulative sequences', async t => {
  const {spawn}=await import('node:child_process');
  const {once}=await import('node:events');
  const {loadSavingsState}=await import('../dist/savings.js');
  const dir=tmp();
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const turns=12;
  const workers=[100,200,300,400].map(tokens=>{
    const script=`
      import {SavingsTracker} from './dist/savings-tracker.js';
      const tracker=new SavingsTracker({dir:process.argv[1],diagnostics:{
        reportSavings(value){process.send(value.sequence)}
      }});
      const id=process.argv[2];
      tracker.begin(id);
      process.once('message',async()=>{
        for (let i=0;i<${turns};i++) await tracker.settle(id,{request:{model:'claude-sonnet-4-6'},requestModified:false,
          usage:{input_tokens:Number(process.argv[3]),output_tokens:1},contextWindow:200000});
        process.disconnect();
      });
      process.send('ready');`;
    const child=spawn(process.execPath,['--input-type=module','-e',script,dir,sessionId,String(tokens)],
      {stdio:['ignore','ignore','inherit','ipc']});
    const sequences=[];
    child.on('message',value=>{if(typeof value==='number') sequences.push(value)});
    const ready=once(child,'message'),done=once(child,'exit');
    t.after(()=>child.kill());
    return {child,ready,done,sequences};
  });
  await Promise.all(workers.map(w=>w.ready));
  workers.forEach(w=>w.child.send('settle'));
  await Promise.all(workers.map(w=>w.done));
  const count=turns*workers.length;
  const sequences=workers.flatMap(w=>w.sequences).sort((a,b)=>a-b);
  assert.deepEqual(sequences,Array.from({length:count},(_,i)=>i+1));
  const state=loadSavingsState(dir,sessionId);
  assert.equal(state.turns,count);
  assert.equal(state.token_counts.input,1000*turns);
});

test('invalid savings IDs never reach either network boundary', async () => {
 const {SavingsTracker}=await import('../dist/savings-tracker.js');
 const {savingsReport}=await import('../dist/savings-report.js');
 const {createSavingsState}=await import('../dist/savings.js');
 const sent=[];
 const tracker=new SavingsTracker({dir:tmp(),fetchCosts:async id=>sent.push(id)});
 for (const id of ['private-text','private identifier','../path']) {
   tracker.begin(id);tracker.cancel(id);await tracker.settle(id,{});
   assert.deepEqual(sent,[]);
   assert.equal(savingsReport({...createSavingsState(sessionId),session_id:id}),undefined);
 }
});

test('only a matching stored acknowledgement clears the final savings report', async () => {
 const {createSavingsState}=await import('../dist/savings.js');
 let sent=0, answer;
 const d=new Diagnostics({baseUrl:'https://example.test',configDir:tmp(),clientName:'ccc',
   clientVersion:'1.0.0',apiKey:'key',env:{},fetchImpl:async()=>{sent++;
     return Response.json(answer,{status:202});}});
 d.reportSavings({...createSavingsState(sessionId),sequence:2});
 for(const [i,ack] of [{accepted:0},{savings_stored:false},
   {savings_stored:{session_id:sessionId,sequence:1}},
   {savings_stored:{session_id:sessionId,sequence:2}}].entries()){
   answer=ack; await d.flush(); assert.equal(sent,i+1);
 }
 await d.flush();assert.equal(sent,4);
});

test('savings and progress stay within every available width', async () => {
 const {visibleWidth}=await import('../dist/savings-status.js');
 const dir=tmp();
 fs.writeFileSync(path.join(dir,'session.url'),'https://example.test/tree');
 for(const view of [summary,{...summary,costs_complete:false}]){
   writeSavingsView('session',view,dir);
   for(let width=1;width<=80;width++){
     const env={NO_COLOR:'1',COLUMNS:String(width)};
     assert.ok(visibleWidth(renderSavingsSegment(view,env,width))<=width);
     const line=await renderStatusline('{"session_id":"session"}',
       {settings:path.join(dir,'settings'),saved:path.join(dir,'saved'),links:dir},env);
     assert.ok(visibleWidth(line)<=width);
   }
 }
});

test('turn settlement does not enumerate retained sessions', async () => {
 const {createSavingsState,saveSavingsState}=await import('../dist/savings.js');
 const dir=tmp(), list=fs.readdirSync;
 let scans=0;
 fs.readdirSync=function(directory,...args){
   if(directory===dir) scans++;
   return list.call(this,directory,...args);
 };
 try {
   for(let i=0;i<3;i++) assert.equal(saveSavingsState(dir,createSavingsState(sessionId)),true);
   assert.equal(scans,0);
 } finally {fs.readdirSync=list;}
});

test('freshly parsed appends reuse a verified large message, edits rebuild it', async () => {
 const {SavingsTracker}=await import('../dist/savings-tracker.js');
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 const tracker=new SavingsTracker({dir:tmp()});
 const make=(char,tail,header)=>({system:'x-anthropic-billing-header: cch='+header+';',
   model:'claude-sonnet-4-6',messages:[{role:'user',content:char.repeat(90000)},...tail],
   cache_control:{type:'ephemeral'}});
 let state=createSavingsState(sessionId);
 const one=(req,expectedReuse)=>{
   const bytes=Buffer.from(JSON.stringify(req));
   const replay=tracker.history.request(sessionId,bytes);
   replay.bodyKey?.(bytes);
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

test('settling a helper preserves the main request progress currently being displayed', async () => {
 const {SavingsTracker}=await import('../dist/savings-tracker.js');
 const {readSavingsView}=await import('../dist/savings-status.js');
 const dir=tmp(),tracker=new SavingsTracker({dir});
 const input={request:{model:'claude-sonnet-4-6'},requestModified:false,
   usage:{input_tokens:10,output_tokens:1},contextWindow:200000};
 await tracker.settle(sessionId,{...input,progress_tokens:100,budget_tokens:1000});
 tracker.begin(sessionId,700,1000);
 tracker.begin(sessionId);
 await tracker.settle(sessionId,{...input,laneKey:'fragment:main'});
 assert.equal(readSavingsView(sessionId,dir).progress_tokens,700);
});

test('an unacknowledged final report retries after restart under the same credential', async () => {
 const {createSavingsState}=await import('../dist/savings.js');
 const sent=[],opts={baseUrl:'https://example.test',configDir:tmp(),clientName:'ccc',
   clientVersion:'1.0.0',apiKey:'key',env:{},fetchImpl:async(url,init)=>{
     sent.push(JSON.parse(init.body).savings.sequence);return Response.json({accepted:0},{status:202});}};
 const first=new Diagnostics(opts);
 first.reportSavings({...createSavingsState(sessionId),sequence:7});await first.flush();
 await new Diagnostics({...opts,apiKey:'different-user'}).flush();
 assert.deepEqual(sent,[7]);
 const resumed=new Diagnostics({...opts,fetchImpl:async(url,init)=>{
   sent.push(JSON.parse(init.body).savings.sequence);
   return Response.json({savings_stored:{session_id:sessionId,sequence:7}},{status:202});}});
 await resumed.flush();
 assert.deepEqual(sent,[7,7]);
 await new Diagnostics(opts).flush();assert.deepEqual(sent,[7,7]);
});

test('response usage speed determines the price for JSON and SSE', async () => {
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 for(const stream of [true,false]){
   const rec={kind:'messages',turnType:'first',requestBytes:0};
   const usage={input_tokens:100,output_tokens:10,speed:'standard'};
   if(stream){
     mergeUsageFromSseEvent({type:'message_start',message:{usage}},rec);
     mergeUsageFromSseEvent({type:'message_delta',usage:{output_tokens:10}},rec);
     mergeUsageFromSseEvent({type:'message_stop'},rec);
   }else mergeUsageFromJsonBody(Buffer.from(JSON.stringify({type:'message',content:[],usage})),rec);
   const {turn}=accountSavingsTurn(createSavingsState(sessionId),{request:{model:'claude-opus-4-6',speed:'fast'},
     requestModified:false,usage:rec.usage,contextWindow:200000});
   assert.equal(turn.actual_api_usd,150*5/1e6);
   assert.equal(turn.costs_complete,true);
 }
});

test('a duplicate messages key cannot lend a digest to a different conversation', async () => {
 const {SavingsTracker}=await import('../dist/savings-tracker.js');
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 const tracker=new SavingsTracker({dir:tmp()});
 const first=[{role:'user',content:'x'.repeat(90000)}];
 const changed=[{role:'user',content:'y'.repeat(30000)}];
 let state=createSavingsState(sessionId);
 for(const raw of [JSON.stringify({messages:first}), '{"messages":'+JSON.stringify(first)+',"mess\\u0061ges":'+JSON.stringify(changed)+'}']){
   const bytes=Buffer.from(raw);
   const replay=tracker.history.request(sessionId,bytes);
   replay.bodyKey?.(bytes);
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
 const {SavingsTracker}=await import('../dist/savings-tracker.js');
 const {accountSavingsTurn,createSavingsState}=await import('../dist/savings.js');
 const tracker=new SavingsTracker({dir:tmp()});
 const req={system:'s'.repeat(90000),messages:[{role:'user',content:'hi'}],tools:[{name:'a'}]};
 const input={requestModified:true,model:'claude-sonnet-4-6',contextWindow:200000,
   usage:{input_tokens:10,output_tokens:1},nowMs:1000};
 let state=createSavingsState(sessionId);
 for (const append of [false,true]) {
   if(append) req.messages.push({role:'assistant',content:'ok'});
   const bytes=Buffer.from(JSON.stringify(req)),request=JSON.parse(bytes);
   const replay=tracker.history.request(sessionId,bytes);
   replay.bodyKey?.(bytes);
   const expected=accountSavingsTurn(state,{...input,request});
   if(append) Object.defineProperty(request,'system',{get(){throw Error('reread verified system');}});
   const result=accountSavingsTurn(state,{...input,request,replay});
   assert.deepEqual(result,expected);
   state=result.state;
 }
});

test('resuming a pre-fix snapshot cannot display its unverified positive delta', async () => {
 const {createSavingsState,loadSavingsState,savingsSummary}=await import('../dist/savings.js');
 const {readSavingsView}=await import('../dist/savings-status.js');
 const dir=tmp();
 const old={...createSavingsState(sessionId),turns:1,sequence:1,plain_api_usd:1,actual_api_usd:.1};
 delete old.has_compressed;
 fs.writeFileSync(path.join(dir,sessionId+'.savings.json'),JSON.stringify(old));
 fs.writeFileSync(path.join(dir,sessionId+'.savings-view.json'),JSON.stringify(summary));
 const state=loadSavingsState(dir,sessionId);
 assert.equal(state.turns,1);
 assert.equal(savingsSummary(state,{costs_complete:true,memtree_charged_usd:0,compression_api_usd:0}).net_usd,null);
 assert.doesNotMatch(renderSavingsSegment(readSavingsView(sessionId,dir),{},120),/saved/);
});
