import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Diagnostics} from '../dist/diagnostics.js';

const usage = {input:100, cache_read:20, cache_creation_5m:3, cache_creation_1h:4, output:25};
const first = {turn_id:'ff0baa4e-c487-465f-87a6-8776d7525bbe',
  session_id:'12345678-1234-4123-8123-123456789abc', requested_at:'2026-11-16T23:59:59.900Z',
  model:'claude-sonnet-4-6', fast_mode:false, window_crossing:false,
  floor_read_possibly_uncached_tokens:12, floor_read_max_gap_seconds:600, actual:usage,
  plain:{...usage, input:1000}};
function ack(ids) { return Response.json({acked_turn_ids:ids}); }
async function harness(t, receive) {
  const configDir = await mkdtemp(join(tmpdir(), 'ccc-savings-'));
  t.after(() => rm(configDir, {recursive:true, force:true}));
  let now = Date.now();
  const posts = [];
  function client(apiKey = 'A', env = {}, baseUrl = 'https://example.test') {
    return new Diagnostics({configDir, baseUrl, apiKey, env, now:() => now,
      clientName:'ccc', clientVersion:'1.0.0', fetchImpl:async (url, init) => {
        const body = JSON.parse(init.body);
        const post = {url, key:init.headers.authorization, ...body};
        posts.push(post);
        return receive ? receive(post, posts.length) : ack(post.turns.map(r => r.turn_id));
      }});
  }
  return {client, posts, configDir, advance:(ms) => { now += ms; }};
}

test('independent writers publish one private JSONL line per turn with no prompt fields', async t => {
  const h = await harness(t, () => ack([]));
  const a = h.client(), b = h.client();
  const turns = [first, {...first, turn_id:randomUUID()}];
  a.reportSavings({...turns[0], conversation:'SECRET', actual:{...usage, text:'SECRET'}});
  b.reportSavings(turns[1]);
  await Promise.all([a.flush(), b.flush()]);
  const files = (await readdir(h.configDir, {recursive:true})).filter(f => f.endsWith('.jsonl'));
  const lines = await Promise.all(files.map(f => readFile(join(h.configDir, f), 'utf8')));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /^[^\n]+\n$/);
    assert.ok(!line.includes('SECRET'));
  }
  assert.deepEqual(lines.map(JSON.parse).sort((a,b) => a.turn_id.localeCompare(b.turn_id)),
    turns.sort((a,b) => a.turn_id.localeCompare(b.turn_id)));
});

test('legacy turns and nullable floor diagnostics survive replay; malformed metadata stays local', async t => {
  const h = await harness(t);
  const {floor_read_possibly_uncached_tokens, floor_read_max_gap_seconds, ...legacy} = first;
  const absent = {...legacy, turn_id:randomUUID()};
  const unknown = {...legacy, turn_id:randomUUID(), floor_read_possibly_uncached_tokens:null, floor_read_max_gap_seconds:null};
  const invalid = {...legacy, turn_id:randomUUID()};
  const client = h.client();
  client.reportSavings(absent);
  client.reportSavings(unknown);
  client.reportSavings({...invalid, floor_read_possibly_uncached_tokens:21, floor_read_max_gap_seconds:'SECRET'});
  await client.flush();
  const ordered = records => records.sort((a,b) => a.turn_id.localeCompare(b.turn_id));
  assert.deepEqual(ordered(h.posts.flatMap(p => p.turns)), ordered([absent, unknown, invalid]));
});

test('cancelling during a billable compression publishes no upstream turn', async t => {
  const {MemtreeClient} = await import('../dist/memtree.js');
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t);
  const diagnostics = h.client();
  const tracker = new SavingsTracker({diagnostics});
  const turn = tracker.startTurn(first.session_id);
  let workTime = Date.parse(first.requested_at);
  t.mock.method(Date, 'now', () => workTime);
  let finish, started;
  const sent = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    started();
    return new Promise(resolve => { finish = () => resolve(Response.json({compressed:true,messages:[]})); });
  });
  const client = new MemtreeClient({baseUrl:'https://example.test', apiKey:'A'});
  const messages = [{role:'user', content:'private'}];
  const metadata = {lane:'main'};
  const compression = client.compress(MemtreeClient.hashMessages(messages), messages, 200000, undefined,
    {sessionId:first.session_id, clientMeta:metadata});
  await sent;
  workTime += 10000; // Settlement after midnight still describes the submitted work.
  const input = {request:{messages}, requestModified:true, contextWindow:200000};
  await tracker.settle(turn, input, 0);
  await tracker.settle(turn, input, 0);
  finish();
  await compression;
  await diagnostics.flush();
  assert.deepEqual(h.posts, []);
});

test('only named turns are removed after a committed ack; truncated replies survive restart and age', async t => {
  const second = {...first, turn_id:randomUUID()};
  const h = await harness(t, (p,n) => n === 1 ? ack([second.turn_id, randomUUID()])
    : n === 2 ? new Response('{') : ack(p.turns.map(r => r.turn_id)));
  const writer = h.client();
  writer.reportSavings(first);
  writer.reportSavings(second);
  await writer.flush(); // partial ack
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].turns.length, 2);
  await h.client().flush();
  assert.equal(h.posts.length, 1, 'backoff survives restart');
  h.advance(5*3600_000);
  await h.client().flush(); // unreadable response
  h.advance(5*3600_000);
  await h.client().flush(); // valid ack
  await h.client().flush();
  assert.deepEqual(h.posts.slice(1).map(p => p.turns), [[first],[first]]);
});

test('a credential switch during queued writes or a pending acknowledgement cannot transfer turns', async t => {
  let release, started;
  const sending = new Promise(r => started = r);
  const wait = new Promise(r => release = r);
  const h = await harness(t, async (post, n) => {
    if (n === 1) { started(); await wait; }
    return ack(post.turns.map(r => r.turn_id));
  });
  const client = h.client();
  client.reportSavings(first);
  // Force disk publication before switching key while the original POST is in flight.
  const flush = client.flush();
  await Promise.race([sending, flush]);
  client.setApiKey('B');
  const second = {...first, turn_id:randomUUID(), actual:{...usage,input:200}};
  client.reportSavings(second);
  release();
  await Promise.all([flush, client.flush()]);
  await h.client('A').flush();
  await h.client('B').flush();
  assert.deepEqual(h.posts.map(p => [p.key,p.turns]), [['Bearer A',[first]],['Bearer B',[second]]]);
});

test('retries have a bounded delay and a rejected key suspends writing and draining', async t => {
  const h = await harness(t, (_post,n) => new Response(null,{status:n < 4 ? 503 : 401}));
  const client = h.client();
  client.reportSavings(first);
  for (let i = 0; i < 100; ++i) {
    await client.flush();
    h.advance(60_000);
  }
  assert.equal(h.posts.length, 4);
  client.reportSavings({...first,turn_id:randomUUID()});
  const files = (await readdir(h.configDir,{recursive:true})).filter(f => f.endsWith('.jsonl'));
  assert.equal(files.length,1);
});

test('invalid ids and model text, missing credentials, and opted-out sessions create no outbox', async t => {
  const h = await harness(t);
  for (const [client,record] of [
    [h.client(), {...first,session_id:'free text'}], [h.client(), {...first,model:'private text'}],
    [h.client(''), first], [h.client('A',{NO_COLOR:'1',DO_NOT_TRACK:'1'}), first],
  ]) { client.reportSavings(record); await client.flush(); }
  assert.deepEqual(h.posts,[]);
  assert.deepEqual((await readdir(h.configDir,{recursive:true})).filter(f => f.endsWith('.jsonl')),[]);
});

test('a process restart drains independent writers in bounded batches and replays only unacked ids', async t => {
  const {spawn} = await import('node:child_process');
  const h = await harness(t);
  const worker = `
    import {Diagnostics} from './dist/diagnostics.js';
    import {randomUUID} from 'node:crypto';
    const client = new Diagnostics({baseUrl:'https://example.test', apiKey:'A',
      clientName:'ccc', clientVersion:'1.0.0', configDir:process.argv[1], env:{},
      fetchImpl:async () => Response.json({acked_turn_ids:[]})});
    const record = JSON.parse(process.argv[2]);
    for (let i=0; i<30; ++i) client.reportSavings({...record,turn_id:randomUUID()});
    await client.flush(10_000);
  `;
  const spawnWriter = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',worker,h.configDir,JSON.stringify(first)],
      {cwd:new URL('../', import.meta.url), stdio:'inherit'});
    child.once('error', reject);
    child.once('exit', (status) => status === 0 ? resolve() : reject(Error('writer exit ' + status)));
  });
  await Promise.all([spawnWriter(), spawnWriter(), spawnWriter()]);
  h.advance(3600_000);
  await h.client('A',{},'https://other.test').flush();
  await h.client('B').flush();
  assert.deepEqual(h.posts,[]);
  await h.client().flush(10_000);
  assert.deepEqual(h.posts.map(p => p.turns.length),[50,40]);
  assert.equal(new Set(h.posts.flatMap(p => p.turns.map(r => r.turn_id))).size,90);
  await h.client().flush();
  assert.equal(h.posts.length,2);
});

test('the client and server share the authenticated savings HTTP contract', {
  skip:!process.env.POLYCHAT_CHECKOUT && 'set POLYCHAT_CHECKOUT to exercise the companion ASGI route',
}, async t => {
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const root = process.env.POLYCHAT_CHECKOUT;
  const fixture = JSON.parse(await readFile(new URL('./fixtures/savings-contract.json',import.meta.url)));
  assert.deepEqual(JSON.parse(await readFile(join(root,'polychat/savings-contract.json'))),fixture);
  let error;
  const h = await harness(t, p => {
    try {
      assert.equal(new URL(p.url).pathname,'/v1/ccc/savings/turns');
      assert.deepEqual({turns:p.turns},fixture.request);
      const body = execFileSync(process.env.POLYCHAT_PYTHON || 'python',
        [fileURLToPath(new URL('./fixtures/savings-intake.py',import.meta.url))], {
        cwd:root, env:{...process.env, PYTHONPATH:root, POLYCHAT_ENV:'dev', SKIP_RUNTIME_TESTS:'1'},
        input:JSON.stringify({path:new URL(p.url).pathname, headers:{authorization:p.key},
          body:{turns:p.turns}}), encoding:'utf8', timeout:40000});
      const result = JSON.parse(body.trim().split('\n').at(-1));
      assert.equal(result.status,fixture.status);
      assert.deepEqual(result.response,fixture.response);
      return Response.json(result.response,{status:result.status});
    } catch (caught) { error=caught; throw caught; }
  });
  const client = h.client();
  client.reportSavings(first);
  await client.flush(45000);
  if (error) throw error;
  await h.client().flush();
  assert.equal(h.posts.length,1);
});

test('a generic edge 403 cannot suspend savings for a valid account', async t => {
  const h = await harness(t, (p,n) => n === 1 ? new Response('Forbidden', {status:403})
    : ack(p.turns.map(r => r.turn_id)));
  const client = h.client();
  client.reportSavings(first);
  await client.flush();
  h.advance(3600_000);
  await client.flush();
  assert.equal(h.posts.length,2);
});

test('an in-flight turn keeps its original writer across a credential change', async t => {
  const h = await harness(t);
  const d = h.client();
  const writeA = d.bindSavings();
  d.setApiKey('B');
  writeA(first);
  await d.flush();
  // Disk writes continue asynchronously even if the user has already switched accounts.
  for (let i=0; i<50 && !h.posts.length; i++) {
    await h.client('A').flush();
    if (!h.posts.length) await new Promise(resolve => setTimeout(resolve,3));
  }
  assert.deepEqual(h.posts.map(p => [p.key,p.turns]), [['Bearer A',[first]]]);
});

test('shutdown drains a final turn queued while a previous batch is in flight', async t => {
  let started, release;
  const sending = new Promise(resolve => { started = resolve; });
  const firstReply = new Promise(resolve => { release = resolve; });
  const h = await harness(t, async (post, attempt) => {
    if (attempt === 1) { started(); await firstReply; }
    return ack(post.turns.map(r => r.turn_id));
  });
  const client = h.client();
  client.reportSavings(first);
  client.flushNow();
  await sending;
  const last = {...first,turn_id:randomUUID()};
  client.reportSavings(last);
  const shutdown = client.flush();
  release();
  await shutdown;
  assert.deepEqual(h.posts.map(p => p.turns),[[first],[last]]);
});

test('warm and expired conversation cache cost the same across launcher restarts', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const {execFileSync} = await import('node:child_process');
  const h = await harness(t);
  const messages = [{role:'user',content:'x'.repeat(320000)}];
  for (const ttl of ['5m', '1h']) {
    for (const gap of [10000, 300000, 3600000]) {
      const results = [];
      for (const restart of [false, true]) {
        const session = randomUUID();
        const diagnostics = h.client(), tracker = new SavingsTracker({diagnostics});
        const request = {model:first.model, messages, cache_control:{type:'ephemeral', ttl}};
        const input = {request, usage:{input_tokens:0,cache_creation_input_tokens:20000,cache_creation:{
          ephemeral_5m_input_tokens:ttl === '5m' ? 20000 : 0,ephemeral_1h_input_tokens:ttl === '1h' ? 20000 : 0},output_tokens:1},
          contextWindow:200000,originalInputTokens:80000,requestModified:true,nowMs:1000};
        if (restart) {
          execFileSync(process.execPath, ['--input-type=module','-e',`
            import {Diagnostics} from './dist/diagnostics.js';
            import {SavingsTracker} from './dist/savings-tracker.js';
            import {readFileSync} from 'node:fs';
            const [configDir, session, input] = JSON.parse(readFileSync(0,'utf8'));
            const diagnostics = new Diagnostics({configDir, apiKey:'A', baseUrl:'https://example.test',
              env:{}, clientName:'ccc', clientVersion:'1', fetchImpl:async () => Response.json({acked_turn_ids:[]})});
            const tracker = new SavingsTracker({diagnostics});
            await tracker.settle(tracker.startTurn(session), input, 200);
            await diagnostics.flush();
          `], {cwd:new URL('../',import.meta.url),input:JSON.stringify([h.configDir,session,input])});
        } else {
          await tracker.settle(tracker.startTurn(session), input, 200);
          await diagnostics.flush();
        }
        await tracker.settle(tracker.startTurn(session), {...input, nowMs:1000+gap,
          originalInputTokens:80010, request:{...request,messages:[...messages,
            {role:'assistant',content:'done'},{role:'user',content:'continue'}]}}, 200);
        await diagnostics.flush();
        results.push(h.posts.at(-1).turns[0].plain);
      }
      assert.deepEqual(results[0], results[1], ttl + ' gap ' + gap);
      assert.equal(results[0].cache_read,80000);
    }
  }
});

test('late background index refusal leaves the published turn independent of billing', async t => {
  const {MemtreeClient} = await import('../dist/memtree.js');
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t), diagnostics = h.client(), tracker = new SavingsTracker({diagnostics});
  const observation = tracker.startTurn(first.session_id);
  const messages = [{role:'user',content:'background'}];
  let refuse, started;
  const sent = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    started();
    return new Promise(resolve => { refuse = () => resolve(Response.json({}, {status:402})); });
  });
  const client = new MemtreeClient({baseUrl:'https://example.test',apiKey:'A'});
  const metadata = {lane:'main'};
  client.indexInBackground('background',messages,200000,first.session_id,
    metadata,undefined,{force:true});
  await sent;
  await tracker.settle(observation,{request:{model:first.model,messages},requestModified:false,
    usage:{input_tokens:100,output_tokens:1},contextWindow:200000,nowMs:1000},200);
  await diagnostics.flush();
  refuse();
  await client.drainBackground();
  assert.equal(h.posts[0].turns[0].expected_memtree_calls,undefined);
});

test('overlapping launchers use dispatch order and isolate credentials', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t);
  const start = (session, key, at, text) => {
    const diagnostics = h.client(key), tracker = new SavingsTracker({diagnostics});
    const observation = tracker.startTurn(session);
    const request = {model:first.model, cache_control:{type:'ephemeral'}, messages:[
      {role:'user',content:text.repeat(10000)}]};
    const input = {request,requestModified:true,nowMs:at,contextWindow:200000,originalInputTokens:2500};
    observation.dispatched(input);
    return async () => {
      await tracker.settle(observation,{...input,
        usage:{input_tokens:0,cache_creation_input_tokens:2500,output_tokens:1}},200);
      await diagnostics.flush();
      return h.posts.at(-1).turns[0].plain;
    };
  };
  const id = randomUUID();
  const older = start(id, 'A', 1000,'x');
  const later = await start(id, 'A', 301000,'y')();
  assert.equal(later.cache_read,0,'a different prefix is new');
  await older();
  assert.equal((await start(id, 'A', 302000,'y')()).cache_read,2500);
  assert.equal((await start(id, 'A', 603000,'y')()).cache_read,2500);
  assert.equal((await start(id, 'B', 303000,'y')()).cache_read,0,
    'account B cannot reuse account A’s measured write');
});

test('an unreadable or legacy send history cannot turn a possible hit into a write', async t => {
  const {writeFile} = await import('node:fs/promises');
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t), diagnostics = h.client();
  const tracker = new SavingsTracker({diagnostics});
  const session = randomUUID();
  const input = {request:{model:first.model,cache_control:{type:'ephemeral'},
    messages:[{role:'user',content:'old'.repeat(3000)}]},requestModified:true,contextWindow:200000,
    usage:{input_tokens:50,output_tokens:1}, originalInputTokens:2250, nowMs:1000};
  const firstTurn = tracker.startTurn(session);
  await tracker.settle(firstTurn,input,200);
  await diagnostics.flush();
  const paths = await readdir(h.configDir,{recursive:true});
  const file = paths.find(f => f.endsWith('floor-v1.json'));
  await writeFile(join(h.configDir,file), JSON.stringify({at:1000,prefixes:[null],model:first.model}));
  await tracker.settle(tracker.startTurn(session),{...input,nowMs:400000},200);
  await diagnostics.flush();
  assert.equal(h.posts.length,2);
  assert.equal(h.posts[1].turns[0].plain.cache_read,2250);
});

test('dispatch and settlement leave prompt hashing and history updates on the worker', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const {existsSync} = await import('node:fs');
  const h = await harness(t), diagnostics = h.client();
  let reported = false;
  const tracker = new SavingsTracker({diagnostics:{
    savingsCacheDirectory:diagnostics.savingsCacheDirectory,
    savingsAccount:{}, bindSavings:()=>()=>{ reported = true; }
  }});
  const request = {model:first.model,messages:[{role:'user',content:[{type:'image',
    source:{type:'base64',data:'x'.repeat(30 * 1024 * 1024)}}]}]};
  const json = JSON.stringify(request);
  const bytes = Buffer.from(new SharedArrayBuffer(Buffer.byteLength(json)));
  bytes.write(json);
  const observation = tracker.startTurn(first.session_id);
  observation.dispatched({request:bytes,requestModified:true,nowMs:1000,contextWindow:200000});
  // The forwarding stack schedules work and returns before settlement completes.
  const tick = new Promise(resolve => setImmediate(() => resolve(reported)));
  const settled = tracker.settle(observation,{request:bytes,requestModified:true,nowMs:1000,
    usage:{input_tokens:10,output_tokens:1},contextWindow:200000},200);
  assert.equal(await tick,false);
  await settled;
  assert.equal(reported,true);
  assert.ok(existsSync(diagnostics.savingsCacheDirectory));
});

test('a prefix sent before an intervening edit is still a read, even within one clock millisecond', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t), diagnostics = h.client();
  const tracker = new SavingsTracker({diagnostics});
  const prompt = text => ({model:first.model,cache_control:{type:'ephemeral'},messages:[
    {role:'user',content:text.repeat(120000)},{role:'assistant',content:'ok'}]});
  const input = {request:prompt('a'),requestModified:false,contextWindow:200000,nowMs:1000,
    usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:1}};
  for (const request of [prompt('a'),prompt('b')]) {
    await tracker.settle(tracker.startTurn(first.session_id),{...input,request},200);
  }
  await diagnostics.flush();
  await tracker.settle(tracker.startTurn(first.session_id),{...input,requestModified:true,
    originalInputTokens:30000},200);
  await diagnostics.flush();
  assert.equal(h.posts.at(-1).turns[0].plain.cache_read,30000);
});

test('the floor includes matching in-flight sends', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t), diagnostics = h.client();
  const tracker = new SavingsTracker({diagnostics});
  const pending = tracker.startTurn(first.session_id);
  const input = {request:{model:first.model,cache_control:{type:'ephemeral'},messages:[
    {role:'user',content:'b'.repeat(120000)}, {role:'assistant',content:'ok'}]},
    requestModified:true,contextWindow:200000,originalInputTokens:30000,
    usage:{input_tokens:20,output_tokens:1},nowMs:11000};
  pending.dispatched({...input,nowMs:1000});
  await tracker.settle(tracker.startTurn(first.session_id),input,200);
  await diagnostics.flush();
  assert.equal(h.posts.at(-1).turns[0].plain.cache_read,30000);
  await tracker.settle(pending,{...input,nowMs:1000},200);
});

test('a refused dispatch costs zero and its retry reads the prefix in a new launcher', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t);
  const request = {model:first.model,cache_control:{type:'ephemeral'},
    messages:[{role:'user',content:'a'.repeat(120000)}]};
  for (const retryAt of [3000,301000]) {
    const session = randomUUID();
    const send = async (nowMs, status, usage, rewrite = false) => {
      const diagnostics = h.client(), tracker = new SavingsTracker({diagnostics});
      await tracker.settle(tracker.startTurn(session),{request, requestModified:rewrite,
        originalInputTokens:30000, contextWindow:200000, nowMs, usage},status);
      await diagnostics.flush();
      return h.posts.at(-1).turns[0];
    };
    await send(1000,200,{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:0});
    for (const at of [retryAt-2,retryAt-1]) {
      const refused = await send(at,429,undefined,true);
      assert.deepEqual(Object.values(refused.plain),[0,0,0,0,0]);
    }
    const retry = await send(retryAt,200,{input_tokens:2000,output_tokens:1},true);
    assert.equal(retry.plain.cache_read,30000);
    assert.equal(retry.plain.cache_creation_5m,30000-retry.plain.cache_read);
  }
});

test('the measured write, overlapping 429 and compressed retry have identical prices in every settlement order', async t => {
  const {SavingsTracker} = await import('../dist/savings-tracker.js');
  const h = await harness(t);
  const request = {model:first.model,cache_control:{type:'ephemeral'},
    messages:[{role:'user',content:'word'.repeat(30000)}]};
  for (const order of ['012','021','102','120','201','210']) {
    const session = randomUUID(), diagnostics = h.client();
    const tracker = new SavingsTracker({diagnostics});
    const inputs = [
      {nowMs:1000,requestModified:false,usage:{input_tokens:0,cache_creation_input_tokens:30000,output_tokens:1}},
      {nowMs:2000,requestModified:true,originalInputTokens:30000},
      {nowMs:3000,requestModified:true,originalInputTokens:30000,usage:{input_tokens:2000,output_tokens:1}},
    ].map(input => ({...input,request,contextWindow:200000}));
    const turns = inputs.map(input => {
      const observation = tracker.startTurn(session);
      observation.dispatched(input);
      return observation;
    });
    for (const i of Array.from(order, Number)) {
      await tracker.settle(turns[i],inputs[i],i === 1 ? 429 : 200);
    }
    await diagnostics.flush();
    const reports = h.posts.flatMap(post => post.turns);
    const retry = reports.find(turn => turn.turn_id === turns[2].id);
    const refusal = reports.find(turn => turn.turn_id === turns[1].id);
    assert.equal(retry.plain.cache_read,30000,order);
    assert.equal(retry.plain.cache_creation_5m,0,order);
    assert.deepEqual(Object.values(refusal.plain),[0,0,0,0,0],order);
  }
});

test('a slow independent launcher cannot hide an earlier send from the floor', async t => {
  const {spawn} = await import('node:child_process');
  const {once} = await import('node:events');
  const {SavingsObservation} = await import('../dist/savings-turn.js');
  const h = await harness(t), session = randomUUID();
  const cacheDir = h.client().savingsCacheDirectory;
  const input = {request:{model:first.model, cache_control:{type:'ephemeral'},
    messages:[{role:'user',content:'word'.repeat(30000)}]},requestModified:true,
    nowMs:1000,contextWindow:200000,originalInputTokens:30000};
  const source = `
    import {SavingsObservation} from './dist/savings-turn.js';
    import {once} from 'node:events';
    const [[dir,session,input]] = await once(process,'message');
    const observed = new SavingsObservation(session,()=>{},'child',dir);
    await observed.announce('main');
    process.send('ready');
    // The send has a reservation; its accounting worker has yet to register it.
    process.once('message',async () => {
      observed.dispatched(input);
      await observed.settle(input,429);
      process.disconnect();
    });
  `;
  const child = spawn(process.execPath,['--input-type=module','-e',source],{
    cwd:new URL('../',import.meta.url),
    stdio:['ignore','ignore','inherit','ipc']
  });
  t.after(() => child.kill());
  child.send([cacheDir,session,input]);
  const ready = await Promise.race([once(child,'message'),once(child,'exit')]);
  assert.equal(ready[0],'ready');
  let report;
  const retry = new SavingsObservation(session,r=>report=r,'other',cacheDir);
  await retry.announce('main');
  const rewritten = {...input,nowMs:2000,usage:{input_tokens:2000,output_tokens:1}};
  retry.dispatched(rewritten);
  await retry.settle(rewritten,200);
  assert.equal(report.plain.cache_read,30000);
  assert.equal(report.floor_read_max_gap_seconds,null);
  const exit = once(child,'exit');
  child.send('continue');
  assert.equal((await exit)[0],0);
});

test('a worker accounting failure preserves an incomplete observation for the dispatched turn', async () => {
  const {SavingsObservation} = await import('../dist/savings-turn.js');
  let report;
  const observation = new SavingsObservation(first.session_id,r=>report=r,randomUUID());
  const input = {request:Buffer.from('invalid'),model:first.model,requestModified:true,nowMs:3000,
    contextWindow:200000,usage:{input_tokens:20,output_tokens:1}};
  await observation.settle(input,200);
  assert.equal(report.turn_id,observation.id);
  assert.equal(report.plain,null);
});
