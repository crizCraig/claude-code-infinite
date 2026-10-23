// Late compression on the 1M-window models (polychat
// docs/context_memory_request_pipeline.md, "Prepared compression"): the 960k
// trigger, the background-prepared prefix the overflow turn rides with no
// blocking compress call, the head-and-tail safety net for a tool result too
// large even after compression, and the under-budget human turn that no
// longer waits for its compress call.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy } from '../dist/proxy.js';
import { MemtreeClient } from '../dist/memtree.js';
import { compressionTrigger, PreparedCompressions, prepareRefreshTokens, prepareStartTokens }
  from '../dist/prepared-compression.js';
import { truncateToolResults } from '../dist/tool-result-truncation.js';
import { ToolOutputStore } from '../dist/tool-output-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPUS = 'claude-opus-5-5';
/** Anthropic's count in this harness: one token per 4 bytes of the body. */
const tokensOf = body => Math.floor(Buffer.byteLength(JSON.stringify(body)) / 4);
const BLOCKING_DELAY_MS = 1_500;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function readJson(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(JSON.parse(raw)));
  });
}

/** A flattened compressed prefix of about `tokens` tokens (bytes/4). */
function compressedReply(tokens, { prepared = false, budget = 960_000 } = {}) {
  const messages = [{ role: 'user', content: `memory ${'m'.repeat(tokens * 4)}` }];
  return { messages, flattened_messages: messages, compressed: true, model_budget_tokens: budget,
    usage: { prompt_tokens: 900_000, completion_tokens: tokens,
      prompt_tokens_details: { cached_tokens: 900_000 }, indexed_tokens: 900_000 },
    ...(prepared ? { prepared: true } : {}) };
}

async function harness({ prepares = true, preparedTokens = 480_000, blockingDelayMs = BLOCKING_DELAY_MS,
  budget, model = OPUS, oneMillion = true, compress, prepareDelayMs = 0 } = {}) {
  const forwards = [], calls = [], records = [];
  const upstream = await listen(async (req, res) => {
    const body = await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/count_tokens')) return res.end(JSON.stringify({ input_tokens: tokensOf(body) }));
    forwards.push(body);
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: tokensOf(body), output_tokens: 1 } }));
  });
  const memory = await listen(async (req, res) => {
    const body = await readJson(req);
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (body.index_only) return reply(200, { index_only: true, messages: [] });
    calls.push(body);
    body.receivedAt = Date.now();
    const custom = compress?.(body, calls);
    if (custom) {
      if (custom.delayMs) await new Promise(resolve => setTimeout(resolve, custom.delayMs));
      return reply(custom.status ?? 200, custom.body);
    }
    if (body.prepare) {
      if (prepareDelayMs) await new Promise(resolve => setTimeout(resolve, prepareDelayMs));
      body.answeredAt = Date.now();
      res.setHeader('x-polychat-memtree-url', `https://app/m/prep${calls.length}-s`);
      res.setHeader('x-polychat-memtree-index', `prep${calls.length}`);
      return reply(200, prepares ? compressedReply(preparedTokens, { prepared: true })
        : compressedReply(preparedTokens));
    }
    await new Promise(resolve => setTimeout(resolve, blockingDelayMs));
    reply(200, compressedReply(480_000));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: 'mock-secret' });
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-outputs-'));
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin,
    toolOutputs: new ToolOutputStore(path.join(outputsDir, 'tool-outputs')),
    countTokens: true, ...(budget !== undefined ? { budgetTokensOverride: budget } : {}),
    reqlog: { log: record => records.push(structuredClone(record)) } });
  async function post(messages, { session = 'late-session', agent } = {}) {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session,
        ...(agent ? { 'x-claude-code-agent-id': agent } : {}),
        ...(oneMillion ? { 'anthropic-beta': 'context-1m-2025-08-07' } : {}) },
      body: JSON.stringify({ model, max_tokens: 32_000, messages }),
    });
    const text = await response.text();
    return { status: response.status, ms: Date.now() - started, text,
      record: records.filter(r => r.kind === 'messages').at(-1) };
  }
  async function currentPage(session = 'late-session') {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/memtree/current?session=${session}`);
    return res.status === 200 ? (await res.json()).id : res.status;
  }
  async function command(prompt, session = 'late-session') {
    await fetch(proxy.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt }) });
  }
  return {
    post, forwards, calls, records, currentPage, command,
    prepareCalls: () => calls.filter(c => c.prepare),
    blockingCalls: () => calls.filter(c => !c.prepare),
    close() {
      proxy.close();
      for (const { server } of [upstream, memory]) { server.closeAllConnections(); server.close(); }
      fs.rmSync(outputsDir, { recursive: true, force: true });
    },
  };
}

async function until(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * A real-shaped Claude Code session: a task, then tool rounds (Read/Bash
 * results of mixed sizes, with assistant narration) up to about `tokens`.
 */
function session(tokens) {
  const conv = [{ role: 'user', content: 'Refactor the indexing pipeline and keep the tests green.' }];
  let i = 0;
  while (tokensOf({ messages: conv }) < tokens) {
    const size = [9_000, 22_000, 4_000, 31_000, 15_000][i % 5] * 4;
    addRound(conv, `t${i++}`, size);
  }
  return conv;
}

function addRound(conv, id, chars, { head = '', tail = '' } = {}) {
  conv.push({ role: 'assistant', content: [{ type: 'text', text: `Checking ${id}.` },
    { type: 'tool_use', id, name: id.length % 2 ? 'Read' : 'Bash', input: { path: `src/${id}.ts` } }] });
  const filler = Math.max(0, chars - head.length - tail.length);
  conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
    content: `${head}${'line of output\n'.repeat(Math.ceil(filler / 15)).slice(0, filler)}${tail}` }] });
  return conv;
}

/** Grow `conv` to about `tokens` and send it, one tool round at a time. */
async function growTo(h, conv, tokens) {
  let last;
  while (tokensOf({ messages: conv }) < tokens) {
    const step = Math.min(40_000, tokens - tokensOf({ messages: conv }) + 1_000);
    addRound(conv, `g${conv.length}`, step * 4);
    last = await h.post(conv);
    assert.equal(last.status, 200);
  }
  return last;
}

test('replay: a 100k tool result landing at 940k rides the prepared prefix with no blocking wait', async () => {
  const h = await harness();
  try {
    const conv = session(700_000);
    assert.equal((await h.post(conv)).status, 200);
    await growTo(h, conv, 840_000);
    assert.equal(h.calls.length, 0, 'nothing below ~850k');

    // Past 850k: one background preparation, forced to half the 960k trigger.
    await growTo(h, conv, 870_000);
    await until(() => h.prepareCalls().length === 1);
    const prep = h.prepareCalls()[0];
    assert.equal(prep.compression_target_tokens, 480_000);
    assert.equal(prep.compression_threshold_tokens, undefined, 'prepared whatever its size');
    assert.equal(h.blockingCalls().length, 0);

    // Refreshed once the session grew ~50k past it, not on every turn.
    await growTo(h, conv, 930_000);
    await until(() => h.prepareCalls().length >= 2);
    const refreshedAt = h.prepareCalls().at(-1).messages.length;
    await growTo(h, conv, 940_000);
    await new Promise(resolve => setTimeout(resolve, 100));
    const prepared = h.prepareCalls().length;
    const coveredMessages = h.prepareCalls().at(-1).messages.filter(m => m.role !== 'system').length;
    assert.ok(h.prepareCalls().at(-1).messages.length >= refreshedAt);

    // A ~100k-token tool result lands at ~940k: past the trigger and the window.
    addRound(conv, 'big', 100_000 * 4);
    assert.ok(tokensOf({ messages: conv }) > 1_000_000);
    const overflow = await h.post(conv);
    assert.equal(overflow.status, 200, 'no 400');
    assert.equal(h.blockingCalls().length, 0, 'no blocking compress call');
    assert.ok(overflow.ms < BLOCKING_DELAY_MS, `overflow turn took ${overflow.ms}ms`);
    assert.equal(overflow.record.compaction.prepared, 'used');
    assert.equal(overflow.record.turnType, 'tool-prefix');
    const sent = h.forwards.at(-1);
    assert.match(sent.messages[0].content[0]?.text ?? sent.messages[0].content, /^memory m/);
    assert.deepEqual(sent.messages.slice(1), conv.slice(coveredMessages),
      'the prepared prefix, then every message after it verbatim');
    assert.ok(tokensOf(sent) < 960_000, `${tokensOf(sent)} tokens sent`);

    // The next tool turn rides the same prefix bytes (prompt-cache read).
    addRound(conv, 'after', 2_000);
    const next = await h.post(conv);
    assert.equal(next.status, 200);
    assert.equal(JSON.stringify(h.forwards.at(-1).messages[0]), JSON.stringify(sent.messages[0]));
    assert.equal(h.blockingCalls().length, 0);
    assert.equal(h.prepareCalls().length, prepared, 'the new ride is far from the trigger again');
    console.log(`# prepared overflow turn: ${overflow.ms}ms, ${prepared} preparations`);
  } finally { h.close(); }
});

test('the overflow turn waits for a preparation still in flight instead of compressing again', async () => {
  const h = await harness({ prepareDelayMs: 700 });
  try {
    const conv = session(880_000);
    assert.equal((await h.post(conv)).status, 200);
    await until(() => h.prepareCalls().length === 1);
    addRound(conv, 'big', 100_000 * 4);
    const overflow = await h.post(conv);
    assert.equal(overflow.status, 200);
    assert.equal(h.blockingCalls().length, 0, 'one compression, the prepared one');
    assert.equal(overflow.record.compaction.prepared, 'used');
    assert.ok(overflow.record.compaction.preparedWaitMs > 0);
    assert.ok(overflow.ms < BLOCKING_DELAY_MS, `${overflow.ms}ms`);
    // Its MemTree page is now the session's memory source (bare node ids resolve there).
    assert.equal(await h.currentPage(), 'prep1-s');
  } finally { h.close(); }
});

test('a /memtree-compact while a preparation is in flight compresses after it, to its own target', async () => {
  const h = await harness({ prepareDelayMs: 800, blockingDelayMs: 0 });
  try {
    const conv = session(880_000);
    assert.equal((await h.post(conv)).status, 200);
    await until(() => h.prepareCalls().length === 1);
    await h.command('/memtree-compact 100k');
    conv.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: 'now compact' });
    const turn = await h.post(conv);
    assert.equal(turn.status, 200);
    const [prep] = h.prepareCalls();
    const [manual] = h.blockingCalls();
    assert.ok(manual, 'the manual compaction ran');
    assert.ok(manual.receivedAt >= prep.answeredAt, 'never beside the preparation');
    assert.equal(manual.compression_target_tokens, 100_000, 'its own target');
    assert.equal(turn.record.compaction.reason, 'manual');
  } finally { h.close(); }
});

test('no truncation without MemTree holding the result, nor on a subagent', async () => {
  for (const [label, status, agent] of [['an auth failure', 401, undefined],
    ['a subagent', 413, 'sub-1']]) {
    const h = await harness({ preparedTokens: 700_000, compress: body => body.prepare ? undefined
      : { status, body: { detail: 'refused' } } });
    try {
      const conv = session(880_000);
      assert.equal((await h.post(conv, { agent })).status, 200);
      await new Promise(resolve => setTimeout(resolve, 200));
      addRound(conv, 'huge', 300_000 * 4);
      const overflow = await h.post(conv, { agent });
      assert.notEqual(overflow.status, 200, `${label}: refused, not truncated`);
      assert.equal(overflow.record.truncatedToolResult, undefined, label);
    } finally { h.close(); }
  }
});

test('replay: without a prepared prefix the overflow turn compresses blocking, as before', async () => {
  const h = await harness({ prepares: false });
  try {
    const conv = session(880_000);
    assert.equal((await h.post(conv)).status, 200);
    await until(() => h.prepareCalls().length === 1);
    await growTo(h, conv, 1_000_000 * 0.95);
    assert.ok(h.prepareCalls().length <= 3, 'a server that does not prepare is asked a few times');
    addRound(conv, 'big', 100_000 * 4);
    const overflow = await h.post(conv);
    assert.equal(overflow.status, 200);
    assert.equal(h.blockingCalls().length, 1);
    assert.ok(overflow.ms >= BLOCKING_DELAY_MS, `blocking overflow took ${overflow.ms}ms`);
    assert.equal(overflow.record.turnType, 'tool-recompressed');
    console.log(`# blocking overflow turn: ${overflow.ms}ms`);
  } finally { h.close(); }
});

test('a rewound session does not ride a prepared prefix of another history', async () => {
  const h = await harness();
  try {
    const conv = session(880_000);
    assert.equal((await h.post(conv)).status, 200);
    await until(() => h.prepareCalls().length === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const rewound = conv.slice(0, conv.length - 2);
    rewound[rewound.length - 1] = { ...rewound.at(-1), content: [{ ...rewound.at(-1).content[0],
      content: 'edited result' }] };
    addRound(rewound, 'big', 140_000 * 4);
    const overflow = await h.post(rewound);
    assert.equal(overflow.status, 200);
    assert.equal(overflow.record.compaction.prepared, 'mismatch');
    assert.equal(h.blockingCalls().length, 1, 'compressed for the history it has');
  } finally { h.close(); }
});

test('replay: a 300k tool result too large even on the compressed prefix keeps its head and tail', async () => {
  // The prepared prefix is weak (an index lagging behind keeps the unindexed
  // tail verbatim): 700k + the turns after it + 300k cannot fit the window,
  // and compressing again cannot fit it either (MemTree's 413: the newest
  // message alone leaves no room).
  const h = await harness({ preparedTokens: 700_000, compress: body => body.prepare ? undefined
    : { status: 413, body: { detail: 'Request exceeds the context window after compression' } } });
  try {
    const conv = session(880_000);
    assert.equal((await h.post(conv)).status, 200);
    await until(() => h.prepareCalls().length === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const head = 'HEAD-OF-OUTPUT: first lines of the build log\n';
    const tail = '\nTAIL-OF-OUTPUT: 3 tests failed';
    addRound(conv, 'huge', 300_000 * 4, { head, tail });
    const overflow = await h.post(conv);
    assert.equal(overflow.status, 200, 'sent, not refused');
    assert.equal(overflow.record.compaction.prepared, 'too-large');
    assert.equal(h.blockingCalls().length, 1, 'compression first: it cannot fit the result either');
    const sent = h.forwards.at(-1);
    const result = sent.messages.at(-1).content[0].content;
    assert.ok(result.startsWith(head), 'the head word for word');
    assert.ok(result.endsWith(tail), 'the tail word for word');
    assert.match(result, /output truncated by MemTree to fit the context window/);
    const saved = result.match(/The full output is saved at (.+?): read the omitted part with the Read tool/)?.[1];
    assert.ok(saved, 'points at the saved copy');
    assert.equal(fs.readFileSync(saved, 'utf-8'), conv.at(-1).content[0].content,
      'the whole result, word for word');
    if (process.platform !== 'win32') assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.ok(tokensOf(sent) <= 960_000, `${tokensOf(sent)} tokens sent`);
    assert.ok(overflow.record.truncatedToolResult.omittedChars > 200_000);
  } finally { h.close(); }
});

test('an under-budget human turn does not wait for a slow MemTree', async () => {
  const h = await harness({ model: 'claude-sonnet-4-5', oneMillion: false, budget: 100_000,
    compress: (request) => ({ delayMs: 3_000, body: { messages: request.messages,
      compressed: false, model_budget_tokens: 100_000, usage: {} } }) });
  try {
    const conv = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: `q2 ${'x'.repeat(40_000)}` }];
    // No usage sample yet: the size is a guess, so the turn still waits.
    const first = await h.post(conv);
    assert.ok(first.ms >= 3_000, `unknown size waits (${first.ms}ms)`);
    assert.equal(first.record.turnType, 'followup-noop');

    conv.push({ role: 'assistant', content: 'a2' }, { role: 'user', content: 'q3' });
    const fast = await h.post(conv);
    assert.ok(fast.ms < 1_000, `under-budget turn took ${fast.ms}ms`);
    assert.equal(fast.record.turnType, 'followup-under-budget');
    assert.deepEqual(h.forwards.at(-1).messages, conv, 'sent whole');
    await until(() => h.calls.length === 2, 5_000);
    assert.equal(h.calls[1].compression_target_tokens, -1,
      'in the background, and never compressing: the turn already went out whole');
    assert.equal(h.calls[1].compression_threshold_tokens, undefined);

    // Near the trigger (over 85% of it) the turn compresses as before.
    conv.push({ role: 'assistant', content: 'a3' },
      { role: 'user', content: `q4 ${'y'.repeat(330_000)}` });
    const near = await h.post(conv);
    assert.ok(near.ms >= 3_000, `near-trigger turn waits (${near.ms}ms)`);
    assert.notEqual(near.record.turnType, 'followup-under-budget');
  } finally { h.close(); }
});

test('compression trigger leaves the reply room below the window', () => {
  assert.equal(compressionTrigger(960_000, 1_000_000), 960_000);
  assert.equal(compressionTrigger(1_000_000, 1_000_000), 960_000);
  assert.equal(compressionTrigger(200_000, 200_000), 160_000);
  assert.equal(compressionTrigger(64_000, 200_000), 64_000);
  // A small window keeps the server's 0.8 share (the window less 40k is lower).
  assert.equal(compressionTrigger(100_000, 100_000), 80_000);
  assert.equal(prepareStartTokens(960_000), 850_000);
  assert.equal(prepareRefreshTokens(960_000), 50_000);
});

test('prepared compressions: one call per session, refreshed by growth, backoff after a failure', () => {
  const prepared = new PreparedCompressions();
  assert.equal(prepared.decide('s', 840_000, 960_000), 'too-small');
  assert.equal(prepared.decide('s', 960_000, 960_000), 'too-small', 'at the trigger it compresses');
  assert.equal(prepared.decide('s', 860_000, 960_000), 'prepare');
  assert.equal(prepared.begin('s', 860_000, 960_000), true);
  assert.equal(prepared.begin('s', 861_000, 960_000), false);
  assert.equal(prepared.decide('s', 880_000, 960_000), 'in-flight');
  prepared.finish('s', { prefix: 'p1', atTokens: 860_000, triggerTokens: 960_000 });
  assert.equal(prepared.get('s').prefix, 'p1');
  assert.equal(prepared.decide('s', 900_000, 960_000), 'fresh');
  assert.equal(prepared.decide('s', 910_000, 960_000), 'prepare');
  prepared.begin('s', 910_000, 960_000);
  prepared.finish('s', undefined);
  assert.equal(prepared.get('s').prefix, 'p1', 'a failed refresh keeps the older prefix');
  assert.equal(prepared.decide('s', 930_000, 960_000), 'fresh', 'and waits for growth');
  prepared.discard('s');
  assert.equal(prepared.get('s'), undefined);
  assert.equal(prepared.decide('s', 930_000, 960_000), 'prepare');
  for (let i = 0; i < 3; i++) prepared.noteServerAnswer(false);
  assert.equal(prepared.decide('t', 900_000, 960_000), 'unsupported');
  prepared.noteServerAnswer(true);
  assert.equal(prepared.decide('t', 900_000, 960_000), 'prepare');
});

test('tool result truncation keeps head and tail and points at MemTree', () => {
  const text = `${'a'.repeat(50_000)}\n${'b'.repeat(50_000)}\n${'c'.repeat(50_000)}`;
  const body = { model: OPUS, messages: [{ role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'small', content: 'tiny' },
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text }] }] }] };
  const saved = [];
  const save = (full) => { saved.push(full); return '/tmp/ccc-outputs/abc.txt'; };
  const plan = truncateToolResults(body, 60_000, save);
  assert.ok(plan);
  const kept = plan.body.messages[2].content[1].content[0].text;
  assert.ok(kept.startsWith('a'.repeat(1_000)) && kept.endsWith('c'.repeat(1_000)));
  assert.ok(kept.length <= text.length - 60_000 + 500, `${kept.length}`);
  assert.match(kept, /The full output is saved at \/tmp\/ccc-outputs\/abc.txt: read the omitted part/);
  assert.equal(saved[0], text, 'the whole text is saved');
  assert.equal(plan.body.messages[2].content[0].content, 'tiny', 'other results untouched');
  assert.equal(body.messages[2].content[1].content[0].text, text, 'input not mutated');
  // Deterministic: the same cut gives the same bytes (a prompt-cache hit next time).
  assert.equal(JSON.stringify(truncateToolResults(body, 60_000, save).body),
    JSON.stringify(plan.body));
  assert.equal(truncateToolResults({ messages: [{ role: 'user', content: 'plain' }] }, 10, save),
    null);
  assert.equal(truncateToolResults(body, 60_000, () => undefined), null,
    'never shortened when the copy cannot be saved');
  // A cut past the whole result keeps the minimum head and tail.
  const minimal = truncateToolResults(body, 10_000_000, save);
  const minimalText = minimal.body.messages[2].content[1].content[0].text;
  assert.ok(minimalText.startsWith('a'.repeat(900)) && minimalText.endsWith('c'.repeat(900)));
  assert.ok(minimal.omittedChars > text.length - 3_000, `${minimal.omittedChars}`);
  // Several large texts in one result: shortened largest first until enough is cut.
  const two = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm',
    content: [{ type: 'text', text: 'p'.repeat(100_000) }, { type: 'text', text: 'q'.repeat(90_000) }] }] }] };
  const both = truncateToolResults(two, 150_000, save);
  const parts = both.body.messages[0].content[0].content;
  assert.ok(parts[0].text.length < 60_000 && parts[1].text.length < 60_000, 'both shortened');
  assert.ok(both.omittedChars >= 150_000 && both.savedAt.length === 2);
  assert.equal(truncateToolResults(two, 1_000, save).savedAt.length, 1, 'only as many as needed');
  const short = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't',
    content: 'z'.repeat(3_000) }] }] };
  assert.equal(truncateToolResults(short, 10, save), null, 'too short to shorten');
});

test('tool output store: one private file per distinct output, same path every time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-store-'));
  try {
    const store = new ToolOutputStore(path.join(dir, 'tool-outputs'));
    const a = store.save('first output');
    assert.equal(store.save('first output'), a);
    assert.notEqual(store.save('second output'), a);
    assert.equal(fs.readFileSync(a, 'utf-8'), 'first output');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(a)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(a).mode & 0o777, 0o600);
    }
    // Past the cap, recent copies (by mtime) are kept: a request's 70 copies all
    // stay while another request saves (Codex r6: concurrent eviction).
    let clock = 1_000;
    const pinnedStore = new ToolOutputStore(path.join(dir, 'pinned'), () => clock);
    const first = Array.from({ length: 70 }, (_, i) => pinnedStore.save(`output ${i}`));
    // Another ccc process sharing the directory saves meanwhile.
    new ToolOutputStore(path.join(dir, 'pinned'), () => clock).save('another request');
    assert.ok(first.every((file) => fs.existsSync(file)), 'every pinned copy is still there');
    // An hour later the pins have expired and the cap holds again.
    clock += 61 * 60 * 1000;
    pinnedStore.save('one more');
    const count = fs.readdirSync(path.join(dir, 'pinned')).filter((n) => n.endsWith('.txt')).length;
    assert.ok(count <= 65, `${count} files`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
