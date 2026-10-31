// 2026-10-30 incident (staging, pid 45207, ccc 1.0.29): a ~23M-char session rode
// its stable prefix up to the 960k budget, and every crossing turn compressed
// blocking. MemTree needed 37-53 s for the 26 MB upload; ccc gave up at 15 s,
// fired the next turn's compress beside the abandoned one, and refused turns for
// ten minutes. These tests replay that shape against a slow mock MemTree.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy } from '../dist/proxy.js';
import { MemtreeClient } from '../dist/memtree.js';

const OPUS = 'claude-opus-5-5';
const tokensOf = body => Math.floor(Buffer.byteLength(JSON.stringify(body)) / 4);

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

function compressedReply(tokens, { prepared = false, n = 0 } = {}) {
  const messages = [{ role: 'user', content: `memory#${n} ${'m'.repeat(tokens * 4)}` }];
  return { messages, flattened_messages: messages, compressed: true, model_budget_tokens: 960_000,
    usage: { prompt_tokens: 900_000, completion_tokens: tokens,
      prompt_tokens_details: { cached_tokens: 900_000 }, indexed_tokens: 900_000 },
    ...(prepared ? { prepared: true } : {}) };
}

/**
 * Anthropic (counts at bytes/4), a MemTree whose every compress takes
 * `compressMs` (`prepareMs` for a preparation), and the proxy.
 */
async function harness({ compressMs = 0, prepareMs = compressMs, compressTimeoutMs,
  longCompressTimeoutMs, prepares = true, perKiB } = {}) {
  const forwards = [], calls = [], records = [], indexCalls = [];
  let aborted = 0;
  const upstream = await listen(async (req, res) => {
    const body = await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/count_tokens')) return res.end(JSON.stringify({ input_tokens: tokensOf(body) }));
    forwards.push(body);
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: tokensOf(body), output_tokens: 1 } }));
  });
  const memory = await listen(async (req, res) => {
    res.on('close', () => { if (!res.writableEnded) aborted++; });
    let body;
    try { body = await readJson(req); } catch { return; }
    if (body.index_only) {
      indexCalls.push({ messages: body.messages.length, agent: req.headers['x-client-meta'] ?? '',
        last: JSON.stringify(body.messages.at(-1)).slice(0, 80) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ index_only: true, messages: [] }));
    }
    const call = { prepare: !!body.prepare, startedAt: Date.now(), messages: body.messages.length };
    calls.push(call);
    const delay = body.prepare ? prepareMs : compressMs;
    await new Promise(resolve => setTimeout(resolve,
      typeof delay === 'function' ? delay(calls.filter(c => !c.prepare).length) : delay));
    call.answeredAt = Date.now();
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(compressedReply(480_000, { prepared: body.prepare && prepares,
      n: calls.indexOf(call) + 1 })));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: 'mock-secret',
    reqlog: { log: record => records.push(structuredClone(record)) },
    ...(compressTimeoutMs !== undefined ? { compressTimeoutMs } : {}),
    ...(longCompressTimeoutMs !== undefined ? { longCompressTimeoutMs } : {}),
    ...(perKiB !== undefined ? { compressTimeoutMsPerKiB: perKiB } : {}) });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin, countTokens: true,
    reqlog: { log: record => records.push(structuredClone(record)) } });
  async function post(messages, { signal, agent, parentAgent } = {}) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'big-session',
        'anthropic-beta': 'context-1m-2025-08-07', ...(agent ? { 'x-claude-code-agent-id': agent } : {}),
        ...(parentAgent ? { 'x-claude-code-parent-agent-id': parentAgent } : {}) },
      body: JSON.stringify({ model: OPUS, max_tokens: 32_000, messages }),
    });
    await response.text();
    return { status: response.status, record: records.filter(r => r.kind === 'messages').at(-1),
      sent: forwards.at(-1) };
  }
  async function hook(input) {
    const res = await fetch(proxy.hookUrl, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'big-session', ...input }) });
    await res.text();
  }
  return { post, hook, calls, records, forwards, indexCalls, aborted: () => aborted,
    drain: ms => proxy.drain(ms),
    blocking: () => calls.filter(c => !c.prepare), preparing: () => calls.filter(c => c.prepare),
    close() {
      proxy.close();
      for (const { server } of [upstream, memory]) { server.closeAllConnections(); server.close(); }
    } };
}

function addRound(conv, id, chars) {
  conv.push({ role: 'assistant', content: [{ type: 'text', text: `Checking ${id}.` },
    { type: 'tool_use', id, name: 'Read', input: { path: `src/${id}.ts` } }] });
  conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
    content: 'line of output\n'.repeat(Math.ceil(chars / 15)).slice(0, chars) }] });
}

/** A long session: a task, then tool rounds of mixed sizes, to about `tokens`. */
function session(tokens) {
  const conv = [{ role: 'user', content: 'Refactor the indexing pipeline and keep the tests green.' }];
  let i = 0;
  while (tokensOf({ messages: conv }) < tokens) {
    addRound(conv, `t${i}`, [9_000, 22_000, 4_000, 31_000, 15_000][i % 5] * 4);
    i++;
  }
  return conv;
}

async function until(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Tool rounds of ~`step` tokens until the request sent (the ride) reaches `tokens`. */
async function rideTo(h, conv, tokens, step = 20_000) {
  let last;
  do {
    addRound(conv, `g${conv.length}`, step * 4);
    last = await h.post(conv);
    assert.equal(last.status, 200, JSON.stringify(last.record));
  } while (tokensOf(last.sent) < tokens);
  return last;
}

test('a session riding its stable prefix prepares from ~850k and crosses 960k on the prepared prefix',
  async () => {
    const h = await harness({ compressMs: 300, prepareMs: 300 });
    try {
      // The first compression installs the stable prefix (~480k).
      const conv = session(990_000);
      const first = await h.post(conv);
      assert.equal(first.status, 200);
      assert.equal(h.blocking().length, 1);
      assert.match(JSON.stringify(first.sent.messages[0]).slice(0, 60), /memory#\d+ m/);
      // Ride it up past ~850k: a background preparation starts there.
      await rideTo(h, conv, 870_000);
      await until(() => h.preparing().length >= 1);
      await until(() => h.preparing().every(c => c.answeredAt));
      await new Promise(resolve => setImmediate(resolve));
      // The crossing turn rides the prepared prefix: no blocking compress.
      const crossing = await rideTo(h, conv, 960_000 - 20_000, 30_000);
      addRound(conv, 'cross', 60_000 * 4);
      const turn = await h.post(conv);
      assert.equal(turn.status, 200, JSON.stringify(turn.record));
      assert.equal(h.blocking().length, 1, 'no second blocking compress');
      assert.equal(turn.record.compaction.prepared, 'used', JSON.stringify(turn.record.compaction));
      assert.ok(tokensOf(turn.sent) < 960_000, `${tokensOf(turn.sent)} sent`);
      void crossing;
    } finally { h.close(); }
  });

test('a session that never compressed (whole requests) prepares from ~850k: its first crossing rides it',
  async () => {
    // 2026-10-30 report: compaction.prepared was never set; that session ran 1.0.29, which
    // had no preparation. Here: the first crossing of a session sent whole until then.
    const h = await harness({ compressMs: 300, prepareMs: 300 });
    try {
      const conv = session(800_000);
      assert.equal((await h.post(conv)).status, 200);
      assert.equal(h.calls.length, 0, 'under the budget: no compression');
      let last;
      do {
        addRound(conv, `w${conv.length}`, 20_000 * 4);
        last = await h.post(conv);
        assert.equal(last.status, 200, JSON.stringify(last.record));
      } while (tokensOf(last.sent) < 880_000);
      await until(() => h.preparing().length >= 1);
      await until(() => h.preparing().every(c => c.answeredAt));
      await new Promise(resolve => setImmediate(resolve));
      addRound(conv, 'cross', 90_000 * 4);
      const turn = await h.post(conv);
      assert.equal(turn.status, 200, JSON.stringify(turn.record));
      assert.equal(h.blocking().length, 0, 'no blocking compress at the crossing');
      assert.equal(turn.record.compaction.prepared, 'used', JSON.stringify(turn.record.compaction));
      assert.ok(tokensOf(turn.sent) < 960_000, `${tokensOf(turn.sent)} sent`);
    } finally { h.close(); }
  });

/** The stable prefix (~480k) from a first compression, then rides up to ~820k: no preparation yet. */
async function stablePrefixAt820k(h) {
  const conv = session(990_000);
  assert.equal((await h.post(conv)).status, 200);
  assert.equal(h.blocking().length, 1);
  await rideTo(h, conv, 820_000, 20_000);
  assert.equal(h.preparing().length, 0, 'under ~850k: nothing prepared');
  return conv;
}

test('a crossing compress that outlasts its wait runs on; the next turn rides it, no second call',
  async () => {
    // The first compression is quick; the crossing one takes 1.5 s against a 300 ms wait.
    const h = await harness({ compressMs: n => (n === 1 ? 0 : 1_500), compressTimeoutMs: 300,
      longCompressTimeoutMs: 10_000, perKiB: 0 });
    try {
      const conv = await stablePrefixAt820k(h);
      // One tool result jumps the ride past 960k (no preparation had started).
      addRound(conv, 'jump', 142_000 * 4);
      const crossing = await h.post(conv);
      assert.equal(crossing.status, 200, JSON.stringify(crossing.record));
      assert.ok(tokensOf(crossing.sent) >= 960_000, `${tokensOf(crossing.sent)} rode`);
      assert.equal(crossing.record.compress.timedOut, true);
      assert.equal(crossing.record.compress.carriedOver, true);
      assert.equal(crossing.record.compaction.keptPrefix, true, 'the old prefix carried the turn');
      // The next turn waits for that same call and rides its answer.
      addRound(conv, 'next', 2_000);
      const next = await h.post(conv);
      assert.equal(next.status, 200, JSON.stringify(next.record));
      assert.equal(next.record.compaction.prepared, 'used', JSON.stringify(next.record.compaction));
      assert.ok(tokensOf(next.sent) < 700_000, `${tokensOf(next.sent)} sent`);
      assert.equal(h.blocking().length, 2, 'one compression for the crossing, not one per turn');
      assert.equal(h.aborted(), 0, 'MemTree finished the call ccc stopped waiting for');
    } finally { h.close(); }
  });

test('a crossing whose turn Claude Code abandoned: the next turn rides its compression', async () => {
  let arrived = 0;
  const h = await harness({ compressMs: n => { arrived = n; return n === 1 ? 0 : 600; },
    compressTimeoutMs: 5_000, perKiB: 0 });
  try {
    const conv = await stablePrefixAt820k(h);
    addRound(conv, 'jump', 142_000 * 4);
    const controller = new AbortController();
    const abandoned = h.post(conv, { signal: controller.signal }).catch(err => err);
    await until(() => arrived === 2);
    controller.abort();
    assert.equal((await abandoned).name, 'AbortError');
    await until(() => h.blocking()[1]?.answeredAt !== undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    addRound(conv, 'next', 2_000);
    const next = await h.post(conv);
    assert.equal(next.status, 200, JSON.stringify(next.record));
    assert.equal(next.record.compaction.prepared, 'used', JSON.stringify(next.record.compaction));
    assert.equal(h.blocking().length, 2, 'its compression was used, not redone');
  } finally { h.close(); }
});

test('replay 2026-10-30: over the window with no fallback, a 3 s compression is waited for', async () => {
  // 1.0.29 gave up at a flat 15 s against MemTree's 37-53 s and refused the turn.
  const h = await harness({ compressMs: n => (n === 1 ? 0 : 3_000), compressTimeoutMs: 300,
    longCompressTimeoutMs: 10_000, perKiB: 0 });
  try {
    const conv = await stablePrefixAt820k(h);
    addRound(conv, 'jump', 170_000 * 4);
    const crossing = await h.post(conv);
    assert.equal(crossing.status, 200, JSON.stringify(crossing.record));
    assert.equal(crossing.record.compress.ok, true);
    assert.equal(h.blocking().length, 2);
    assert.ok(tokensOf(crossing.sent) < 960_000);
  } finally { h.close(); }
});

test('a subagent is indexed once when it ends, per turn only past half its budget', async () => {
  const h = await harness();
  try {
    const conv = [{ role: 'user', content: 'You are implementing Phase 3: refactor the parser.' }];
    for (let i = 0; i < 6; i++) {
      addRound(conv, `a${i}`, 20_000 * 4);
      assert.equal((await h.post(conv, { agent: 'agent-1' })).status, 200);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(h.indexCalls.length, 0, 'a subagent under half its budget: no index per turn');
    // It ends: one index of its whole history.
    await h.hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-1' });
    await until(() => h.indexCalls.length === 1);
    assert.equal(h.indexCalls[0].messages, conv.length);
    await h.hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-1' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.indexCalls.length, 1, 'nothing more to send');

    // A long subagent past half its 960k budget is indexed per turn, like the main thread.
    const long = session(500_000);
    long[0] = { role: 'user', content: 'You are auditing the whole repository.' };
    for (let i = 0; i < 2; i++) {
      addRound(long, `b${i}`, 20_000 * 4);
      assert.equal((await h.post(long, { agent: 'agent-2' })).status, 200);
      await until(() => h.indexCalls.length === 2 + i);
    }

    // A subagent still running at exit gets its one index inside the drain.
    const third = [{ role: 'user', content: 'You are reviewing the diff.' }];
    addRound(third, 'c0', 20_000 * 4);
    assert.equal((await h.post(third, { agent: 'agent-3' })).status, 200);
    const before = h.indexCalls.length;
    await h.drain(2_000);
    await until(() => h.indexCalls.length === before + 1);
  } finally { h.close(); }
});

test('subagent deferral: per conversation of an agent, and never for a parent-id-only request', async () => {
  const h = await harness();
  try {
    const own = [{ role: 'user', content: 'You are implementing Phase 3.' }];
    const side = [{ role: 'user', content: 'Summarize this file for the subagent.' }];
    addRound(own, 'o0', 20_000 * 4);
    addRound(side, 's0', 20_000 * 4);
    assert.equal((await h.post(own, { agent: 'agent-7' })).status, 200);
    assert.equal((await h.post(side, { agent: 'agent-7' })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(h.indexCalls.length, 0);
    await h.hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-7' });
    await until(() => h.indexCalls.length === 2);
    assert.deepEqual(h.indexCalls.map(c => c.messages).sort(), [own.length, side.length].sort(),
      'both of its conversations, not only the newest');
    // Attributed by its parent's id only: indexed per turn, as before.
    const helper = [{ role: 'user', content: 'A helper request.' }];
    addRound(helper, 'p0', 20_000 * 4);
    assert.equal((await h.post(helper, { parentAgent: 'agent-8' })).status, 200);
    await until(() => h.indexCalls.length === 3);
  } finally { h.close(); }
});

test('an abandoned crossing whose prefix another turn replaced meanwhile is not ridden', async () => {
  let arrived = 0;
  // Call 2 (the abandoned crossing) takes 1.5 s; call 3 (the next crossing) answers at once.
  const h = await harness({ compressMs: n => { arrived = n; return n === 2 ? 1_500 : 0; },
    compressTimeoutMs: 5_000, perKiB: 0 });
  try {
    const conv = await stablePrefixAt820k(h);
    addRound(conv, 'jump', 142_000 * 4);
    const controller = new AbortController();
    const abandoned = h.post(conv, { signal: controller.signal }).catch(err => err);
    await until(() => arrived === 2);
    controller.abort();
    await abandoned;
    // The user's next message crosses too, compresses (call 3) and installs its prefix.
    conv.push({ role: 'assistant', content: [{ type: 'text', text: 'Interrupted.' }] },
      { role: 'user', content: 'Carry on.' });
    const replaced = await h.post(conv);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.record));
    assert.match(JSON.stringify(replaced.sent.messages[0]).slice(0, 60), /memory#3 /);
    await until(() => h.blocking()[1]?.answeredAt !== undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    addRound(conv, 'next', 2_000);
    const next = await h.post(conv);
    assert.equal(next.status, 200);
    assert.equal(next.record.compaction.prepared, undefined, JSON.stringify(next.record.compaction));
    assert.match(JSON.stringify(next.sent.messages[0]).slice(0, 60), /memory#3 /,
      'the newer prefix, not call 2');
  } finally { h.close(); }
});
