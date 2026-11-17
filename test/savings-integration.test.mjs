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
    d.reportSavings({schema:1,session_id:'session',sequence:1,plain_api_usd:10,
      actual_api_usd:5,costs_complete:true, turns:1,window_crossings:0,
      token_counts:{input:1,cache_read:2,cache_creation_5m:3,cache_creation_1h:4,output:5},
      content:'never transmit this'});
    await d.flush(); fail=false; await d.flush();
    assert.equal(sent.length, disabled ? 0 : 2);
    if(!disabled){ assert.equal(sent[1].savings.session_id,'session');
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
  tracker.settle(id,input);
  assert.equal(loadSavingsState(dir,id).turns,1);
  assert.equal(reports.length,1);
  tracker.begin(id,420,1000);
  resolveCosts({costs_complete:true,memtree_charged_usd:0,compression_api_usd:0});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(readSavingsView(id,dir).costs_complete,false,'old turn billing cannot validate new turn');
  const resumed=new SavingsTracker({dir});
  resumed.settle(id,input);
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
  const snapshot={schema:1,session_id:'session',sequence:1,plain_api_usd:1,actual_api_usd:1,
    costs_complete:true,turns:1,window_crossings:0,
    token_counts:{input:0,cache_read:0,cache_creation_5m:0,cache_creation_1h:0,output:0}};
  d.reportSavings(snapshot);d.flushNow();
  d.reportSavings({...snapshot,sequence:2});
  const done=d.flush(1000);release();await done;
  assert.deepEqual(sent,[1,2]);
});
