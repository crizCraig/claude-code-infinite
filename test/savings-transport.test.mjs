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
  model:'claude-sonnet-4-6', expected_memtree_calls:1, fast_mode:false, window_crossing:false, actual:usage,
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
