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
/** Anthropic's count in this harness: one token per 4 bytes of text, 1,600 per image. */
const IMAGE_TOKENS = 1_600;
const tokensOf = body => {
  let images = 0;
  const text = JSON.stringify(body, (key, value) => {
    if (value?.type === 'image' && value.source?.data) { images++; return { type: 'image' }; }
    return value;
  });
  return Math.floor(Buffer.byteLength(text) / 4) + images * IMAGE_TOKENS;
};
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
  budget, model = OPUS, oneMillion = true, compress, prepareDelayMs = 0, compressTimeoutMs,
  countHangs = () => false } = {}) {
  const forwards = [], calls = [], records = [], counts = [];
  let aborts = 0;
  const upstream = await listen(async (req, res) => {
    const body = await readJson(req);
    if (req.url.includes('/count_tokens')) {
      counts.push(body);
      // `countHangs` true: this count never answers (Count Tokens is slow).
      if (countHangs(body, counts.length)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: tokensOf(body) }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    forwards.push(body);
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: tokensOf(body), output_tokens: 1 } }));
  });
  const memory = await listen(async (req, res) => {
    // A call ccc gave up on before its answer was written.
    res.on('close', () => { if (!res.writableEnded) aborts++; });
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
      // `headersFirst`: 200 headers go out at once, the body only after `waitFor`.
      if (custom.headersFirst) { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); }
      if (custom.waitFor) await custom.waitFor;
      if (custom.delayMs) await new Promise(resolve => setTimeout(resolve, custom.delayMs));
      custom.done?.();
      if (custom.headersFirst) return res.end(JSON.stringify(custom.body));
      for (const [name, value] of Object.entries(custom.headers ?? {})) res.setHeader(name, value);
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
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: 'mock-secret',
    reqlog: { log: record => records.push(structuredClone(record)) },
    ...(compressTimeoutMs !== undefined ? { compressTimeoutMs } : {}) });
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-outputs-'));
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin,
    toolOutputs: new ToolOutputStore(path.join(outputsDir, 'tool-outputs')),
    countTokens: true, ...(budget !== undefined ? { budgetTokensOverride: budget } : {}),
    reqlog: { log: record => records.push(structuredClone(record)) } });
  async function post(messages, { session = 'late-session', agent, maxTokens = 32_000 } = {}) {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session,
        ...(agent ? { 'x-claude-code-agent-id': agent } : {}),
        ...(oneMillion ? { 'anthropic-beta': 'context-1m-2025-08-07' } : {}) },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
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
    post, forwards, calls, records, counts, currentPage, command, drain: ms => proxy.drain(ms),
    aborts: () => aborts,
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

test('a screenshot landing at the limit: an oversized compression is redone smaller in the same request', async () => {
  // Coordinator's staging case (2026-10-23): Reading a 216 KB PNG near the
  // limit got "MemTree couldn't fit this request" until the user typed again.
  // Here the first compression comes back too large (a verbatim tail), and the
  // proxy recompresses at once to a smaller target instead of refusing.
  const h = await harness({ prepares: false, blockingDelayMs: 0,
    compress: (body) => body.prepare ? undefined
      : body.compression_target_tokens >= 480_000 ? { body: compressedReply(990_000) }
        : { body: compressedReply(400_000), headers: { 'x-polychat-memtree-url': 'https://app/m/redo-s',
          'x-polychat-memtree-index': 'redo' } } });
  try {
    const conv = session(950_000);
    assert.equal((await h.post(conv)).status, 200);
    await growTo(h, conv, 958_000);
    conv.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'Read',
      input: { file_path: '/tmp/screen.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png',
        data: 'iVBORw0KGgo'.repeat(26_200) } },
      { type: 'text', text: 'line of output\n'.repeat(400) }] }] });
    const shot = await h.post(conv);
    assert.equal(shot.status, 200, 'no 400');
    const blocking = h.blockingCalls();
    assert.equal(blocking.length, 2, 'compressed, then compressed again smaller');
    assert.ok(blocking[1].compression_target_tokens < blocking[0].compression_target_tokens,
      `${blocking[0].compression_target_tokens} then ${blocking[1].compression_target_tokens}`);
    assert.ok(tokensOf(h.forwards.at(-1)) <= 960_000, `${tokensOf(h.forwards.at(-1))} sent`);

    // The smaller compression is installed like any other: the next tool turn
    // rides it (no compress call) and its page is the session's memory source.
    const redone = h.forwards.at(-1).messages[0];
    addRound(conv, 'after-shot', 2_000);
    const next = await h.post(conv);
    assert.equal(next.status, 200);
    assert.equal(h.blockingCalls().length, 2, 'rides the redone prefix');
    assert.deepEqual(h.forwards.at(-1).messages[0], redone);
    assert.equal(await h.currentPage(), 'redo-s');
  } finally { h.close(); }
});

/** Base64 of a PNG whose header says `width` x `height`, padded to `chars` characters. */
function screenshot(width, height, chars) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 6, 0, 0, 0], 24);
  const filler = Buffer.alloc(Math.ceil(chars * 3 / 4) - header.length, 0x5a);
  return Buffer.concat([header, filler]).toString('base64').slice(0, chars);
}

function addScreenshot(conv, id, data) {
  conv.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read',
    input: { file_path: `/tmp/${id}.png` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] });
}

test('replay: 849k + a 295 KB screenshot, cooldown armed, Count Tokens slow: delivered, not refused', async () => {
  // The coordinator's staging 400 (agent-bus image-overflow-400/REPORT.md):
  // ~850k real, the 574x551 PNG (420 tokens) estimated as ~74k of text, the
  // count timed out, and the tool-recovery cooldown (armed by compress
  // timeouts while MemTree was healthy) skipped compression.
  let blocking = 0;
  let hung = 0;
  const h = await harness({ compressTimeoutMs: 200,
    countHangs: body => JSON.stringify(body).includes('"image"') && hung++ === 0,
    compress: body => body.prepare ? { status: 500, body: { error: 'prepare down' } }
      : ++blocking === 1 ? { delayMs: 20_000, body: compressedReply(480_000) }
        : { body: compressedReply(480_000) } });
  try {
    const conv = session(845_000);
    assert.equal((await h.post(conv)).status, 200);
    await growTo(h, conv, 849_000);
    // A human turn's compress times out (MemTree slow to reply): the cooldown arms.
    await h.command('/memtree-compact');
    conv.push({ role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Now look at the screenshot.' });
    const human = await h.post(conv);
    assert.equal(human.status, 200);
    assert.equal(human.record.compress.timedOut, true);
    assert.ok(human.record.compress.ms > 200 + 3_000,
      `the budget grew with the upload (${human.record.compress.ms}ms)`);

    addScreenshot(conv, 'shot', screenshot(574, 551, 295_000));
    const shot = await h.post(conv);
    assert.equal(shot.status, 200, 'delivered, not refused');
    assert.equal(shot.record.refusal, undefined);
    assert.ok(shot.record.compaction.estimatedTokens < 860_000,
      `the image is 420 tokens, not ~74k (${shot.record.compaction.estimatedTokens})`);
    const outcomes = shot.record.countTokens.map(c => c.statusClass);
    assert.ok(outcomes.includes('success') && outcomes.some(o => o === 'timeout' || o === 'deadline'),
      `the timed-out count was retried (${outcomes})`);
    // In the cooldown it still compressed: over the window by its uncounted
    // bound with no prefix to ride, a skip could only have refused it.
    assert.notEqual(shot.record.routeRecovery?.outcome, 'cooldown');
    assert.ok(blocking >= 2, `${blocking} compress calls`);
    assert.ok(tokensOf(h.forwards.at(-1)) <= 960_000, `${tokensOf(h.forwards.at(-1))} sent`);
  } finally { h.close(); }
});

test('a late recovery does not compress beside a same-lane compression in flight', async () => {
  let blocking = 0;
  const h = await harness({ prepares: false, compress: body => body.prepare
    ? { status: 500, body: {} }
    : { delayMs: ++blocking === 1 ? 1_500 : 0, body: compressedReply(480_000) } });
  try {
    const conv = session(900_000);
    assert.equal((await h.post(conv)).status, 200);
    addRound(conv, 'big', 120_000 * 4);
    const first = h.post(conv);
    await until(() => blocking === 1);
    const again = [...conv];
    addRound(again, 'more', 2_000);
    const second = await h.post(again);
    assert.equal(second.record.routeRecovery.outcome, 'in-flight');
    assert.equal((await first).status, 200);
    assert.equal(blocking, 1, 'one compression of this history, not a second at another target');
  } finally { h.close(); }
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
    // Too large as it is; shortened, the prepared prefix carries the turn (it is smaller than
    // the whole history) and becomes the session's prefix.
    assert.equal(overflow.record.compaction.prepared, 'truncated');
    assert.equal(h.blockingCalls().length, 1, 'compression first: it cannot fit the result either');
    const sent = h.forwards.at(-1);
    assert.match(sent.messages[0].content[0]?.text ?? sent.messages[0].content, /^memory m/);
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

    // The next turn (Claude Code reading the file, say) resends the whole
    // result: it rides the installed prefix and is shortened again, rather than refused.
    addRound(conv, 'read-back', 4_000);
    const next = await h.post(conv);
    assert.equal(next.status, 200, 'the turn after it is sent too');
    const again = h.forwards.at(-1).messages.find(m => Array.isArray(m.content) &&
      m.content[0]?.tool_use_id === 'huge')?.content[0].content;
    assert.match(JSON.stringify(h.forwards.at(-1).messages[0]), /memory m/, 'on the prefix');
    assert.ok(again.startsWith(head) && again.endsWith(tail), 'head and tail kept again');
    assert.match(again, /output truncated by MemTree to fit the context window/);
  } finally { h.close(); }
});

test('a prepared prefix too large as it is carries the turn shortened when the history cannot', async () => {
  // With a 95k reply reserved, the whole history shortened cannot fit the window, while the
  // prepared prefix shortened fits at ~925k: it is sent, and becomes the session's prefix.
  const h = await harness({ preparedTokens: 700_000, compress: body => body.prepare ? undefined
    : { status: 413, body: { detail: 'Request exceeds the context window after compression' } } });
  try {
    const conv = session(880_000);
    assert.equal((await h.post(conv, { maxTokens: 95_000 })).status, 200);
    await until(() => h.prepareCalls().length === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    addRound(conv, 'huge', 300_000 * 4, { head: 'HEAD\n', tail: '\nTAIL' });
    const overflow = await h.post(conv, { maxTokens: 95_000 });
    assert.equal(overflow.status, 200, 'sent, not refused');
    assert.equal(overflow.record.compaction.prepared, 'truncated');
    const sent = h.forwards.at(-1);
    assert.match(JSON.stringify(sent.messages[0]), /memory m/);
    assert.ok(tokensOf(sent) <= 960_000, `${tokensOf(sent)} tokens sent`);
  } finally { h.close(); }
});

test('a compress body over the size limit, never sent, is no refusal: nothing is truncated', async () => {
  // ccc skips a compress body over 30 MiB itself (memtree-body.ts) with a local 413; only
  // MemTree's own 413 says compression cannot fit the request, which allows the safety net.
  const h = await harness();
  try {
    const conv = [{ role: 'user', content: 'Summarize the dump.' }];
    addRound(conv, 'dump', 31 * 1024 * 1024, { head: 'HEAD\n', tail: '\nTAIL' });
    const turn = await h.post(conv);
    assert.notEqual(turn.status, 200, 'refused, not shortened');
    assert.equal(turn.record.truncatedToolResult, undefined);
    assert.equal(turn.record.compress?.refused, undefined);
    assert.equal(h.blockingCalls().length, 0, 'the body never reached MemTree');
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

test('under the budget, one background call per conversation; the newest turn waits', async () => {
  // Long-session test, staging: each under-budget turn started its own whole-history
  // background call (16 to 22 s each there), about 12 at once beside the index uploads.
  let inFlight = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const reply = (request) => ({ messages: request.messages, compressed: false,
    model_budget_tokens: 100_000, usage: {} });
  const h = await harness({ model: 'claude-sonnet-4-5', oneMillion: false, budget: 100_000,
    compress: (request, calls) => {
      if (request.compression_target_tokens !== -1) return { body: reply(request) };
      inFlight++; peak = Math.max(peak, inFlight);
      // The first background call answers only once every turn below has been sent.
      const first = calls.filter(c => c.compression_target_tokens === -1).length === 1;
      return { delayMs: first ? 0 : 50, waitFor: first ? gate : undefined,
        body: reply(request), done: () => inFlight-- };
    } });
  try {
    const conv = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: `q2 ${'x'.repeat(40_000)}` }];
    await h.post(conv);
    const background = () => h.calls.filter(c => c.compression_target_tokens === -1);
    for (let i = 3; i <= 6; i++) {
      conv.push({ role: 'assistant', content: `a${i - 1}` }, { role: 'user', content: `q${i}` });
      const turn = await h.post(conv);
      assert.equal(turn.record.turnType, 'followup-under-budget');
    }
    await until(() => background().length === 1, 5_000);
    release();
    await until(() => background().length === 2, 5_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(peak, 1, 'one at a time');
    assert.equal(background().length, 2, 'the first, then only the newest of those that waited');
    assert.equal(background()[1].messages.at(-1).content, 'q6');
  } finally { release(); h.close(); }
});

test('a background compress lane survives Claude Code evicting the first message\'s image', async () => {
  // Past its media caps Claude Code evicts the oldest image (here the first message's): the
  // conversation and the waiting history stay the same, so calls still go one at a time.
  let inFlight = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const reply = (request) => ({ messages: request.messages, compressed: false,
    model_budget_tokens: 100_000, usage: {} });
  const h = await harness({ model: 'claude-sonnet-4-5', oneMillion: false, budget: 100_000,
    compress: (request, calls) => {
      if (request.compression_target_tokens !== -1) return { body: reply(request) };
      inFlight++; peak = Math.max(peak, inFlight);
      const first = calls.filter(c => c.compression_target_tokens === -1).length === 1;
      return { waitFor: first ? gate : undefined, body: reply(request), done: () => inFlight-- };
    } });
  try {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const conv = [{ role: 'user', content: [{ type: 'text', text: 'q1' }, image] },
      { role: 'assistant', content: 'a1' }, { role: 'user', content: `q2 ${'x'.repeat(40_000)}` }];
    await h.post(conv);
    const background = () => h.calls.filter(c => c.compression_target_tokens === -1);
    conv.push({ role: 'assistant', content: 'a2' }, { role: 'user', content: 'q3' });
    await h.post(conv);
    await until(() => background().length === 1, 5_000);
    conv[0] = { role: 'user', content: [{ type: 'text', text: 'q1' }] };
    for (let i = 4; i <= 5; i++) {
      conv.push({ role: 'assistant', content: `a${i - 1}` }, { role: 'user', content: `q${i}` });
      assert.equal((await h.post(conv)).record.turnType, 'followup-under-budget');
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(background().length, 1, 'the evicted turns wait for the call in flight');
    release();
    await until(() => background().length === 2, 5_000);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(peak, 1, 'one at a time');
    assert.equal(background().length, 2);
    assert.equal(background()[1].messages.at(-1).content, 'q5');
  } finally { release(); h.close(); }
});

test('shutdown stops background compresses: the one in flight is aborted, none waiting starts', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reply = (request) => ({ messages: request.messages, compressed: false,
    model_budget_tokens: 100_000, usage: {} });
  const h = await harness({ model: 'claude-sonnet-4-5', oneMillion: false, budget: 100_000,
    compress: (request) => request.compression_target_tokens === -1
      ? { headersFirst: true, waitFor: gate, body: reply(request) } : { body: reply(request) } });
  try {
    const conv = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: `q2 ${'x'.repeat(40_000)}` }];
    await h.post(conv);
    const background = () => h.calls.filter(c => c.compression_target_tokens === -1);
    for (let i = 3; i <= 4; i++) {
      conv.push({ role: 'assistant', content: `a${i - 1}` }, { role: 'user', content: `q${i}` });
      await h.post(conv);
    }
    await until(() => background().length === 1, 5_000);
    assert.equal(await h.drain(1_000), true, 'nothing a request waits for is left');
    await until(() => h.aborts() === 1, 2_000);
    release();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(background().length, 1, 'the waiting call never starts after the drain');
    const cut = h.records.filter(r => r.kind === 'memtree' && !r.indexOnly && !r.ok);
    assert.equal(cut.length, 1);
    assert.equal(cut[0].callerAborted, true, 'a call ccc stopped, not a MemTree failure');
  } finally { release(); h.close(); }
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
    // Past the cap, nothing under an hour old is evicted: a request's 70
    // copies all stay while another ccc process saves (Codex r6-r9).
    // Fixed one minute into a half hour, so the next minute stays in it.
    let clock = 1_800_000 * 1_000_000 + 60_000;
    const pinnedStore = new ToolOutputStore(path.join(dir, 'pinned'), () => clock);
    const first = Array.from({ length: 70 }, (_, i) => pinnedStore.save(`output ${i}`));
    new ToolOutputStore(path.join(dir, 'pinned'), () => clock).save('another request');
    assert.ok(first.every((file) => fs.existsSync(file)), 'every recent copy is still there');
    // Within its half hour an output keeps its path (no rewrite: same bytes).
    clock += 60_000;
    assert.equal(pinnedStore.save('output 3'), first[3]);
    // Later it gets a new path, so an old path is never handed out again and
    // eviction (only of copies over an hour old) cannot race a request.
    clock += 31 * 60_000;
    const later = pinnedStore.save('output 3');
    assert.notEqual(later, first[3]);
    clock += 61 * 60_000;
    pinnedStore.save('one more');
    const count = fs.readdirSync(path.join(dir, 'pinned')).filter((n) => n.endsWith('.txt')).length;
    assert.ok(count <= 64, `${count} files`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
