import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy } from '../dist/proxy.js';
import { MemtreeClient } from '../dist/memtree.js';
import { AWAY_SUMMARY_PROMPT_PREFIX } from '../dist/turns.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const HANG = Symbol('hang');

async function harness({ count = () => ({ input_tokens: 10_000 }), usage = () => 10_000,
  countStatus = 200, budget = 200_000, enabled = true, compress, timeout = false,
  compressBudgetMs, longCompressBudgetMs } = {}) {
  const counts = [], forwards = [], compressions = [], records = [];
  const upstream = await listen((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (req.url.includes('/count_tokens')) {
        counts.push(body);
        if (timeout) return;
        // `count` may answer HANG: that one call never answers (a timeout).
        const result = count(body, counts.length);
        if (result === HANG) return;
        res.writeHead(countStatus, { 'content-type': 'application/json' });
        res.end(typeof result === 'string' ? result : JSON.stringify(result));
      } else {
        forwards.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: usage(body, raw.length), output_tokens: 1 } }));
      }
    });
  });
  const memory = await listen((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      if (!body.index_only) compressions.push(body);
      const custom = !body.index_only && compress ? await compress(body) : undefined;
      res.writeHead(custom?.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(custom?.body ?? { messages: body.messages, compressed: false,
        index_only: body.index_only, model_budget_tokens: budget,
        usage: { prompt_tokens: 100, completion_tokens: 100 } }));
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: 'mock-secret' });
  if (compressBudgetMs !== undefined) {
    Object.defineProperty(memtree, 'compressBudgetMs', { get: () => compressBudgetMs });
  }
  if (longCompressBudgetMs !== undefined) {
    Object.defineProperty(memtree, 'longCompressBudgetMs', { get: () => longCompressBudgetMs });
  }
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin, budgetTokensOverride: budget, countTokens: enabled,
    reqlog: { log: record => records.push(structuredClone(record)) },
  });
  async function post(bytes, { agent = 'a', oneMillion = false, text = 'x',
    session = 's', messages: suppliedMessages, model = 'claude-x', maxTokens = 64 } = {}) {
    const messages = suppliedMessages ?? [{ role: 'user', content: 'task' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text.repeat(bytes) }] }];
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-claude-code-session-id': session, 'x-claude-code-agent-id': agent,
        ...(oneMillion ? { 'anthropic-beta': 'context-1m-2025-08-07' } : {}) },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    });
    await response.text();
    return response.status;
  }
  return { post, counts, forwards, compressions, records, close() {
    proxy.close();
    for (const { server } of [upstream, memory]) { server.closeAllConnections(); server.close(); }
  } };
}

for (const mode of ['disabled', '500', '401', '403', 'malformed', 'timeout']) {
  test(`failed or disabled count ${mode}: plausible stale sample cannot refuse a fitting body`, async () => {
    const h = await harness({ enabled: mode !== 'disabled',
      usage: (_body, bytes) => bytes < 20_000 ? Math.floor(bytes * 0.9) : 100_000,
      countStatus: /^\d+$/.test(mode) ? Number(mode) : 200,
      count: () => mode === 'malformed' ? '{broken' : { input_tokens: 100_000 },
      timeout: mode === 'timeout' });
    try {
      assert.equal(await h.post(10_000), 200);
      const start = Date.now();
      // 300 kB fits the 200k window by its conservative bound (bytes/1.9,
      // token-estimate.ts) while the stale 0.9 tokens/byte sample says 270k.
      // (469,550 bytes, the size this test used under bytes/4, no longer does.)
      assert.equal(await h.post(300_000), 200);
      assert.ok(Date.now() - start < 4_000, 'one total 3s Count deadline');
      assert.equal(h.forwards.length, 2);
      assert.ok(h.counts.length <= 1, 'failed count not immediately retried');
      assert.ok(h.records.filter(r => r.kind === 'messages').at(-1).overBudgetForward);
    } finally { h.close(); }
  });
}

test('soft budget attempts compression, no-ready-tree 413 forwards original within native window', async () => {
  const h = await harness({ budget: 100_000, enabled: false,
    compress: () => ({ status: 413, body: { detail: 'Memory indexing in background' } }) });
  try {
    // Over the 100k budget by bytes/4 (the uncalibrated planning estimate),
    // inside the 200k window by the conservative bound: 450 kB is 188k on
    // Haiku 4.5's tokenizer (2.4 bytes/token); the 4.7+ bound (1.9) is 237k.
    assert.equal(await h.post(450_000, { model: 'claude-haiku-4-5' }), 200);
    assert.equal(h.compressions.length, 1);
    assert.equal(h.forwards.length, 1);
    assert.ok(h.records.find(r => r.kind === 'messages').overBudgetForward);
  } finally { h.close(); }
});

test('exact low-ratio count stays authoritative for an image-sized request', async () => {
  const h = await harness({ budget: 800_000,
    count: (_body, attempt) => attempt === 1 ? { input_tokens: 10_000 } : '{broken' });
  try {
    assert.equal(await h.post(5_000_000, { oneMillion: true }), 200);
    assert.equal(h.counts.length, 1);
    assert.equal(h.compressions.length, 0);
    const rec = h.records.find(r => r.kind === 'messages');
    assert.equal(rec.compaction.estimatedTokens, 10_000);
    assert.equal(rec.overBudgetForward, undefined, 'known exact input fits the soft budget');
    assert.deepEqual(Object.keys(rec.countTokens[0]).sort(), ['bytes', 'ms', 'statusClass', 'timeoutMs']);
  } finally { h.close(); }
});

test('concurrent lane sample cannot replace this request exact over-window count', async () => {
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  // The concurrent 900 kB request is over its conservative byte bound
  // (token-estimate.ts), so it is counted too (90k: fits) rather than sent on
  // the large request's learned ratio.
  const h = await harness({ count: body => ({
    input_tokens: JSON.stringify(body).length > 950_000 ? 210_000 : 90_000 }),
  usage: () => 90_000,
  compress: async () => { reached(); await new Promise(resolve => { release = resolve; }); } });
  try {
    const large = h.post(1_000_000);
    await waiting;
    assert.equal(await h.post(900_000), 200);
    release();
    assert.equal(await large, 503);
    assert.equal(h.forwards.length, 1);
    assert.equal(h.counts.length, 2, 'one count per request; the large one is not recounted');
  } finally { release?.(); h.close(); }
});

test('2026-10-05 20:04 UTC pid84669: 469801-byte subagent formerly 5778216 tokens forwards', async () => {
  // The real request counted 117,450 tokens. Its conservative byte bound
  // (247k on a 200k window) no longer admits it uncounted, so Count Tokens
  // runs and admits it; the skewed 12 tokens/byte helper sample still cannot
  // refuse it.
  const h = await harness({ budget: 800_000, count: () => ({ input_tokens: 117_450 }),
    usage: (_body, bytes) => bytes < 2_000 ? 12_040 : 117_450 });
  try {
    await h.post(728);
    assert.equal(await h.post(469_550), 200);
    const rec = h.records.filter(r => r.kind === 'messages').at(-1);
    assert.equal(rec.requestBytes, 469_801);
    assert.equal(rec.forwardedBytes, 469_801);
  } finally { h.close(); }
});

test('compressed body gets its own count; original exact count never sizes the replacement', async () => {
  const memory = [{ role: 'user', content: 'memory ' + 'm'.repeat(500_000) }];
  const h = await harness({ budget: 100_000,
    count: (_body, attempt) => ({ input_tokens: attempt === 1 ? 210_000 : 90_000 }),
    compress: () => ({ body: { messages: memory, flattened_messages: memory,
      compressed: true, model_budget_tokens: 100_000,
      usage: { prompt_tokens: 210_000, completion_tokens: 90_000,
        prompt_tokens_details: { cached_tokens: 120_000 } } } }) });
  try {
    assert.equal(await h.post(1_000_000), 200);
    assert.equal(h.counts.length, 2);
    assert.notDeepEqual(h.counts[0].messages, h.counts[1].messages);
    assert.deepEqual(h.forwards[0].messages, h.counts[1].messages);
    const rec = h.records.find(r => r.kind === 'messages');
    assert.equal(rec.compaction.estimatedTokens, 210_000);
    assert.equal(rec.countTokens.length, 2);
    assert.equal(rec.overBudgetForward, undefined, 'compressed body fits soft budget');
    assert.ok(rec.countTokens.every(r => Object.keys(r).sort().join() === 'bytes,ms,statusClass,timeoutMs'));
  } finally { h.close(); }
});

function compressedReply(chars, budget = 100_000) {
  const memory = [{ role: 'user', content: 'memory ' + 'm'.repeat(chars) }];
  return { body: { messages: memory, flattened_messages: memory, compressed: true,
    model_budget_tokens: budget, usage: { prompt_tokens: 300_000, completion_tokens: 50_000,
      prompt_tokens_details: { cached_tokens: 250_000 } } } };
}

for (const lane of ['main', 'agent', 'away', 'sessionless']) {
  test(`calibrated ordinary ${lane} followup supplies its own client_input_tokens`, async () => {
    const h = await harness({ budget: 100_000, count: () => ({ input_tokens: 151_000 }),
      compress: () => compressedReply(4_000) });
    try {
      const options = { agent: lane === 'agent' ? 'a' : '',
        session: lane === 'sessionless' ? '' : 's',
        messages: [{ role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: (lane === 'away' ? AWAY_SUMMARY_PROMPT_PREFIX : '') + 'x'.repeat(600_000) }] };
      assert.equal(await h.post(0, options), 200);
      assert.equal(h.compressions.length, 1);
      assert.equal(h.compressions[0].client_input_tokens, 151_000);
      assert.equal(h.compressions[0].client_input_tokens_exact, true, 'an exact count says so');
    } finally { h.close(); }
  });
}

for (const lane of ['main', 'tool']) {
  test(`byte-heavy ${lane} replacement gets exact count before rejection`, async () => {
    const h = await harness({ budget: 100_000,
      count: (_body, attempt) => ({ input_tokens: attempt === 1 ? 300_000 : 120_000 }),
      compress: () => compressedReply(900_000) });
    try {
      const options = lane === 'tool' ? {} : { agent: '', messages: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'x'.repeat(1_500_000) }] };
      assert.equal(await h.post(1_500_000, options), 200);
      assert.equal(h.counts.length, 2);
      assert.match(JSON.stringify(h.forwards[0].messages), /memory m/);
      assert.equal(h.compressions.length, 1, 'replacement never recursively compresses');
    } finally { h.close(); }
  });
}

for (const lane of ['tool', 'main']) {
  for (const lateTokens of [150_000, 210_000]) {
    test(`late ${lane} ride count ${lateTokens} makes one bounded recovery`, async () => {
      let compressions = 0;
      const h = await harness({ budget: 100_000, usage: () => undefined,
        count: (_body, attempt) => ({ input_tokens: [300_000, 50_000, lateTokens][attempt - 1] ?? 3_000 }),
        compress: () => compressedReply(++compressions === 1 ? 200_000 : 10_000) });
      const original = [{ role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' }, { role: 'user', content: 'x'.repeat(1_200_000) }];
      try {
        assert.equal(await h.post(0, { agent: '', messages: original }), 200);
        const suffix = lane === 'main'
          ? [{ role: 'assistant', content: 'answer2' }, { role: 'user', content: 'next' }]
          : [{ role: 'assistant', content: [{ type: 'tool_use', id: 'next', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'next', content: 'next' }] }];
        assert.equal(await h.post(0, { agent: '', messages: [...original, ...suffix] }), 200);
        assert.equal(h.compressions.length, 2, 'exactly one extra recovery for this turn');
        // Recovery restarts from the ORIGINAL conversation (what the index
        // holds), never from the ride's memory prefix, at a tighter target.
        const recovered = JSON.stringify(h.compressions[1].messages);
        assert.doesNotMatch(recovered, /memory m/, 'never compresses a compressed body');
        assert.match(recovered, /x{1000}/);
        assert.match(recovered, /next/);
        assert.ok(h.compressions[1].compression_target_tokens <
          h.compressions[0].compression_target_tokens, 'tighter target than the ride');
        assert.ok(h.compressions[1].client_input_tokens === undefined ||
          h.compressions[1].client_input_tokens >= lateTokens);
        assert.ok(JSON.stringify(h.forwards[1]).length < 20_000);
        const rec = h.records.filter(r => r.kind === 'messages').at(-1);
        assert.equal(rec.lateCountRecovery.outcome, 'compressed');
        assert.equal(rec.overBudgetForward, undefined);
      } finally { h.close(); }
    });
  }
}

for (const lane of ['main', 'tool']) {
  for (const scenario of ['fits-ride', 'no-fit', 'fits-original', 'fits-replacement-above-budget']) {
    test(`late ${lane} recovery ${scenario} logs the selected outcome and body`, async () => {
      let compressions = 0;
      const lateTokens = scenario === 'fits-ride' ? 150_000 : 210_000;
      const h = await harness({ budget: 100_000, usage: () => undefined,
        count: (_body, attempt) => ({ input_tokens: [300_000, 50_000, lateTokens,
          scenario === 'fits-original' ? 120_000 : scenario === 'fits-replacement-above-budget' ? 150_000 : 300_000][attempt - 1] ?? 300_000 }),
        compress: () => ++compressions === 1 ? compressedReply(200_000)
          : scenario === 'fits-replacement-above-budget' ? compressedReply(180_000) : undefined });
      const original = [{ role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' }, { role: 'user', content: 'x'.repeat(1_200_000) }];
      const suffix = lane === 'main'
        ? [{ role: 'assistant', content: 'answer2' }, { role: 'user', content: 'next' }]
        : [{ role: 'assistant', content: [{ type: 'tool_use', id: 'next', name: 'Read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'next', content: 'next' }] }];
      try {
        assert.equal(await h.post(0, { agent: '', messages: original }), 200);
        assert.equal(await h.post(0, { agent: '', messages: [...original, ...suffix] }),
          scenario === 'no-fit' ? 503 : 200);
        assert.equal(h.compressions.length, 2, 'at most one late compression');
        const rec = h.records.filter(r => r.kind === 'messages').at(-1);
        assert.equal(rec.lateCountRecovery.outcome, scenario === 'no-fit' ? 'refused'
          : scenario === 'fits-replacement-above-budget' ? 'compressed' : 'forwarded');
        if (scenario !== 'no-fit') {
          assert.ok(rec.overBudgetForward, 'chosen body exceeds soft budget');
          const sent = JSON.stringify(h.forwards.at(-1));
          assert.equal(sent.includes('x'.repeat(1000)), scenario === 'fits-original');
        }
      } finally { h.close(); }
    });
  }
}

for (const lane of ['main', 'tool']) {
  test(`truly oversized ${lane} replacement preserves the fitting original fallback`, async () => {
    const h = await harness({ budget: 100_000,
      count: (_body, attempt) => ({ input_tokens: attempt === 1 ? 150_000 : 210_000 }),
      compress: () => compressedReply(900_000) });
    try {
      const options = lane === 'tool' ? {} : { agent: '', messages: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'x'.repeat(1_500_000) }] };
      assert.equal(await h.post(1_500_000, options), 200);
      assert.equal(h.counts.length, 2);
      assert.match(JSON.stringify(h.forwards[0].messages), /x{1000}/);
      assert.equal(h.compressions.length, 1);
    } finally { h.close(); }
  });
}

test('late recovery timeout stays bounded and forwards an already-counted fitting ride', async () => {
  let compressions = 0;
  const h = await harness({ budget: 100_000, usage: () => undefined, compressBudgetMs: 100,
    count: (_body, attempt) => ({ input_tokens: [300_000, 50_000, 150_000][attempt - 1] }),
    compress: () => ++compressions === 1 ? compressedReply(200_000) : new Promise(() => {}) });
  const original = [{ role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' }, { role: 'user', content: 'x'.repeat(1_200_000) }];
  try {
    assert.equal(await h.post(0, { agent: '', messages: original }), 200);
    const start = Date.now();
    assert.equal(await h.post(0, { agent: '', messages: [...original,
      { role: 'assistant', content: 'answer2' }, { role: 'user', content: 'next' }] }), 200);
    assert.ok(Date.now() - start < 1_000, 'late compression does not hold the request indefinitely');
    assert.equal(h.compressions.length, 2);
    assert.equal(h.counts.length, 3, 'one request-local count for the ride, no recount after timeout');
    const rec = h.records.filter(r => r.kind === 'messages').at(-1);
    assert.equal(rec.lateCountRecovery.outcome, 'forwarded');
    assert.equal(rec.overBudgetForward.reason, 'exact-count-fits-window');
  } finally { h.close(); }
});

for (const lane of ['main', 'tool']) {
  test(`exact native-window overflow in byte-fitting ${lane} replacement selects fitting original`, async () => {
    const h = await harness({ budget: 100_000,
      count: (_body, attempt) => ({ input_tokens: attempt === 1 ? 150_000 : 210_000 }),
      compress: () => compressedReply(500_000) });
    try {
      const options = lane === 'tool' ? {} : { agent: '', messages: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'x'.repeat(1_500_000) }] };
      assert.equal(await h.post(1_500_000, options), 200);
      assert.equal(h.counts.length, 2);
      assert.match(JSON.stringify(h.forwards[0].messages), /x{1000}/);
      assert.equal(h.compressions.length, 1);
    } finally { h.close(); }
  });
}

for (const enabled of [true, false]) {
  test(`all registered candidates exceed native window: counting ${enabled}`, async () => {
    const h = await harness({ budget: 100_000, enabled,
      count: (_body, attempt) => ({ input_tokens: attempt === 1 ? 300_000 : 210_000 }),
      compress: () => compressedReply(900_000) });
    try {
      assert.equal(await h.post(1_500_000), 503);
      assert.equal(h.forwards.length, 0);
      assert.equal(h.compressions.length, 1);
      assert.equal(h.counts.length, enabled ? 2 : 0);
    } finally { h.close(); }
  });
}

test('byte-heavy validated agent route survives the next tool turn through request-local sizing', async () => {
  let compressions = 0;
  const h = await harness({ budget: 100_000, usage: () => undefined,
    count: body => ({ input_tokens: JSON.stringify(body.messages).includes('memory m') ? 120_000 : 300_000 }),
    compress: () => ++compressions === 1 ? compressedReply(900_000) : undefined });
  const original = [{ role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(1_500_000) }] }];
  try {
    assert.equal(await h.post(0, { agent: 'wide-route-agent', messages: original }), 200);
    const continued = [...original,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'next result' }] }];
    assert.equal(await h.post(0, { agent: 'wide-route-agent', messages: continued }), 200);
    assert.equal(h.forwards.length, 2);
    assert.ok(JSON.stringify(h.forwards[1]).length > 800_000, 'bytes alone exceed the 200k window');
    assert.match(JSON.stringify(h.forwards[1].messages), /memory m/);
    assert.ok(!JSON.stringify(h.forwards[1].messages).includes('x'.repeat(1000)), 'whole oversized original is not sent');
    assert.ok(h.counts.some(body => JSON.stringify(body.messages).includes('next result') &&
      JSON.stringify(body.messages).includes('memory m')), 'assembled retained route gets its own exact count');
  } finally { h.close(); }
});

for (const lane of ['agent-followup', 'away-fork']) {
  test(`byte-heavy validated ${lane} candidate survives early routing`, async () => {
    let compressions = 0;
    const h = await harness({ budget: 100_000, usage: () => undefined,
      count: body => ({ input_tokens: JSON.stringify(body.messages).includes('memory m') ? 120_000 : 300_000 }),
      compress: () => ++compressions === 1 ? compressedReply(900_000) : undefined });
    const original = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'x'.repeat(1_500_000) }];
    const agent = lane === 'agent-followup' ? 'wide-agent' : '';
    try {
      assert.equal(await h.post(0, { agent, messages: original }), 200);
      const continued = [...original, { role: 'assistant', content: 'next answer' },
        { role: 'user', content: lane === 'away-fork' ? AWAY_SUMMARY_PROMPT_PREFIX : 'next question' }];
      assert.equal(await h.post(0, { agent, messages: continued }), 200);
      assert.equal(h.forwards.length, 2);
      assert.ok(JSON.stringify(h.forwards[1]).length > 800_000);
      assert.match(JSON.stringify(h.forwards[1].messages), /memory m/);
      assert.ok(!JSON.stringify(h.forwards[1].messages).includes('x'.repeat(1000)));
      const rec = h.records.filter(r => r.kind === 'messages').at(-1);
      assert.equal(rec.turnType, lane === 'away-fork' ? 'fork-memory' : 'followup-prefix');
    } finally { h.close(); }
  });
}

for (const lane of ['main', 'tool']) {
  test(`late ${lane} recovery selects a byte-larger replacement whose exact count fits`, async () => {
    let compressions = 0;
    let rideCounts = 0;
    const h = await harness({ budget: 100_000, usage: () => undefined,
      count: body => {
        const serialized = JSON.stringify(body.messages);
        return { input_tokens: serialized.includes('x'.repeat(1000)) ? 300_000
          : serialized.length > 230_000 ? 120_000 : ++rideCounts === 1 ? 50_000 : 210_000 };
      },
      compress: () => compressedReply(++compressions === 1 ? 200_000 : 250_000) });
    const original = [{ role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' }, { role: 'user', content: 'x'.repeat(1_200_000) }];
    const suffix = lane === 'main'
      ? [{ role: 'assistant', content: 'answer2' }, { role: 'user', content: 'next' }]
      : [{ role: 'assistant', content: [{ type: 'tool_use', id: 'next', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'next', content: 'next' }] }];
    try {
      assert.equal(await h.post(0, { agent: '', messages: original }), 200);
      assert.equal(await h.post(0, { agent: '', messages: [...original, ...suffix] }), 200);
      assert.equal(h.compressions.length, 2, 'exactly one bounded late recovery');
      assert.ok(h.compressions[1].client_input_tokens >= 300_000,
        'hint describes the original conversation that is compressed, not the ride');
      assert.doesNotMatch(JSON.stringify(h.compressions[1].messages), /memory m/);
      assert.equal(h.counts.length, 4, 'the larger replacement receives its own exact count');
      assert.deepEqual(h.forwards[1].messages, h.counts[3].messages);
      assert.ok(JSON.stringify(h.forwards[1]).length > JSON.stringify(h.forwards[0]).length);
      assert.match(JSON.stringify(h.forwards[1].messages), /memory m/);
      assert.ok(!JSON.stringify(h.forwards[1].messages).includes('x'.repeat(1000)));
      const rec = h.records.filter(r => r.kind === 'messages').at(-1);
      assert.equal(rec.lateCountRecovery.outcome, 'compressed');
      assert.equal(rec.overBudgetForward.reason, 'exact-count-fits-window');
    } finally { h.close(); }
  });
}

for (const lane of ['main', 'tool']) {
  test(`${lane} compress timeout never forwards an original counted over the window`, async () => {
    const h = await harness({ budget: 100_000, compressBudgetMs: 100, longCompressBudgetMs: 200,
      count: () => ({ input_tokens: 300_000 }), compress: () => new Promise(() => {}) });
    try {
      const options = lane === 'tool' ? {} : { agent: '', messages: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'x'.repeat(1_200_000) }] };
      assert.equal(await h.post(1_200_000, options), 503);
      assert.equal(h.forwards.length, 0, 'a timeout is not a licence to send everything');
      assert.equal(h.compressions.length, 1);
    } finally { h.close(); }
  });
}

for (const lane of ['main', 'tool']) {
  test(`late ${lane} recovery timeout with nothing fitting refuses instead of forwarding`, async () => {
    let rideCounts = 0;
    const h = await harness({ budget: 100_000, usage: () => undefined, compressBudgetMs: 100,
      longCompressBudgetMs: 200,
      count: body => ({ input_tokens: JSON.stringify(body.messages).includes('x'.repeat(1000))
        ? 300_000 : ++rideCounts === 1 ? 50_000 : 210_000 }),
      compress: () => h.compressions.length === 1 ? compressedReply(200_000)
        : new Promise(() => {}) });
    const original = [{ role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' }, { role: 'user', content: 'x'.repeat(1_200_000) }];
    const suffix = lane === 'main'
      ? [{ role: 'assistant', content: 'answer2' }, { role: 'user', content: 'next' }]
      : [{ role: 'assistant', content: [{ type: 'tool_use', id: 'next', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'next', content: 'next' }] }];
    try {
      assert.equal(await h.post(0, { agent: '', messages: original }), 200);
      assert.equal(await h.post(0, { agent: '', messages: [...original, ...suffix] }), 503);
      assert.equal(h.forwards.length, 1, 'neither the over-window ride nor original is sent');
      assert.equal(h.compressions.length, 2);
      assert.doesNotMatch(JSON.stringify(h.compressions[1].messages), /memory m/);
      const rec = h.records.filter(r => r.kind === 'messages').at(-1);
      assert.equal(rec.lateCountRecovery.outcome, 'refused');
    } finally { h.close(); }
  });
}

test('client_input_tokens_exact is omitted for a size projected from a usage sample', async () => {
  // Counting off: a 0.3 tokens/byte sample projects the 400 kB followup at
  // ~120k, over the 100k budget, so ccc sends that projection as a hint, but
  // it is not a count of these bytes and must not loosen the server's sizing.
  const h = await harness({ enabled: false, budget: 100_000,
    usage: (_body, bytes) => Math.floor(bytes * 0.3) });
  try {
    assert.equal(await h.post(200_000), 200);
    await h.post(400_000);
    const call = h.compressions.at(-1);
    assert.ok(call.client_input_tokens > 100_000, `${call.client_input_tokens}`);
    assert.equal(call.client_input_tokens_exact, undefined);
  } finally { h.close(); }
});

// Codex round 2, finding 1: a projected usage sample cannot hide a body whose
// conservative bound is over the window when the body cannot be counted.
for (const mode of ['disabled', 'timeout']) {
  test(`a sampled ~2 MB (Codex: 2,000,260-byte) Opus 5.5 tool turn over its bound compresses when uncountable (${mode})`, async () => {
    const h = await harness({ budget: 800_000, enabled: mode !== 'disabled', timeout: mode === 'timeout',
      usage: (_body, bytes) => Math.floor(bytes / 4) });
    try {
      // 1 MB: bound 526k fits 1M; it goes out and teaches a 0.25 tokens/byte sample.
      assert.equal(await h.post(1_000_000, { model: 'claude-opus-5-5' }), 200);
      assert.equal(h.compressions.length, 0);
      await h.post(2_000_000, { model: 'claude-opus-5-5' });
      const rec = h.records.filter(r => r.kind === 'messages').at(-1);
      assert.ok(rec.requestBytes > 2_000_000, `${rec.requestBytes}`);
      assert.equal(rec.compaction.sizeSource, 'reported');
      assert.ok(rec.compaction.estimatedTokens < 800_000, `${rec.compaction.estimatedTokens}`);
      assert.equal(rec.compaction.uncountedOverWindow, true);
      assert.equal(h.compressions.length, 1, 'compression is attempted, not a pass');
      assert.equal(h.compressions[0].compression_threshold_tokens, undefined, 'forced');
      assert.ok(h.counts.length <= 1, 'at most one count, reused at delivery');
    } finally { h.close(); }
  });
}

test('a sampled over-bound turn is counted once at planning and a fitting count passes', async () => {
  const h = await harness({ budget: 800_000, usage: (_body, bytes) => Math.floor(bytes / 4),
    count: () => ({ input_tokens: 520_000 }) });
  try {
    assert.equal(await h.post(1_000_000, { model: 'claude-opus-5-5' }), 200);
    assert.equal(h.counts.length, 0);
    assert.equal(await h.post(2_000_000, { model: 'claude-opus-5-5' }), 200);
    assert.equal(h.counts.length, 1, 'counted once; delivery reuses it');
    assert.equal(h.compressions.length, 0, 'the exact count fits: no compression');
    assert.equal(h.forwards.length, 2);
  } finally { h.close(); }
});

// Codex round 2, finding 4: with no fallback (the original cannot go out
// uncounted), compression gets the long no-fallback budget.
test('an uncounted over-bound Opus 5.5 tool turn compresses on the long budget', async () => {
  const h = await harness({ budget: 800_000, enabled: false, compressBudgetMs: 100,
    longCompressBudgetMs: 3_000,
    compress: () => new Promise(resolve => setTimeout(() => resolve(compressedReply(4_000, 800_000)), 500)) });
  try {
    assert.equal(await h.post(2_000_000, { model: 'claude-opus-5-5' }), 200);
    assert.equal(h.compressions.length, 1);
    assert.equal(h.forwards.length, 1);
    assert.match(JSON.stringify(h.forwards[0].messages), /memory m/);
  } finally { h.close(); }
});

// Codex round 3: the judged candidate itself is counted at planning, whether
// it is a sampled ride or the original behind a stored route that fails to
// match; if that count fails, its bound sends it to compression, not refusal.
function compressedHistory() {
  return [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'x'.repeat(3_400_000) }];
}
const bigToolStep = (id) => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'y'.repeat(2_000_000) }] }];

for (const stale of [false, true]) {
  test(`a sampled over-bound ${stale ? 'original behind a stale route' : 'ride'} whose count times out compresses`, async () => {
    // The first count (the 3.4 MB human turn) answers bytes/4 (~850k): over
    // the 800k budget, so it compresses and installs a route. Later counts hang.
    const h = await harness({ budget: 800_000, usage: (_body, bytes) => Math.floor(bytes / 4),
      count: (body, n) => n === 1 ? { input_tokens: Math.floor(JSON.stringify(body).length / 4) } : HANG,
      compress: () => compressedReply(4_000, 800_000) });
    try {
      const history = compressedHistory();
      assert.equal(await h.post(0, { agent: '', model: 'claude-opus-5-5', messages: history }), 200);
      assert.equal(h.compressions.length, 1);
      // Stale: an edited, short history the stored route cannot validate; its
      // ~2 MB original is projected at ~500k from the lane's 0.25 sample.
      const next = stale
        ? [{ role: 'user', content: 'first, edited' }, { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'go' }, ...bigToolStep('t1')]
        : [...history, ...bigToolStep('t1')];
      const status = await h.post(0, { agent: '', model: 'claude-opus-5-5', messages: next });
      const rec = h.records.filter(r => r.kind === 'messages').at(-1);
      assert.ok(rec.compaction.estimatedTokens < 800_000, 'planned under budget by its sample');
      assert.equal(rec.compaction.uncountedOverWindow, true, JSON.stringify(rec.compaction));
      assert.equal(h.compressions.length, 2, 'compressed through the normal path, not refused');
      assert.equal(status, 200);
      assert.match(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
    } finally { h.close(); }
  });
}

test('original over the 64 MiB request limit: no count, compressed instead of forwarded', async () => {
  const memory = [{ role: 'user', content: 'memory ' + 'm'.repeat(100_000) }];
  const h = await harness({ budget: 800_000, count: () => ({ input_tokens: 50_000 }),
    compress: () => ({ body: { messages: memory, flattened_messages: memory, compressed: true,
      model_budget_tokens: 800_000, usage: { prompt_tokens: 300_000, completion_tokens: 50_000,
        prompt_tokens_details: { cached_tokens: 250_000 } } } }) });
  try {
    // A learned sample from a cheap image-heavy turn would call it small.
    assert.equal(await h.post(64 * 1024 * 1024 + 1, { oneMillion: true }), 200);
    assert.ok(h.counts.every(c => JSON.stringify(c).length < 1_000_000), 'never counted');
    assert.equal(h.compressions.length, 1);
    assert.equal(h.forwards.length, 1);
    assert.ok(JSON.stringify(h.forwards[0]).length < 200_000, 'the compressed body was sent');
    const rec = h.records.find(r => r.kind === 'messages');
    assert.equal(rec.compaction.uncountedOverWindow, true);
  } finally { h.close(); }
});

function imageFlattenReply(imageChars, budget = 100_000) {
  const memory = [{ role: 'user', content: [{ type: 'text', text: 'memory m' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(imageChars) } }] }];
  return { body: { messages: memory, flattened_messages: memory, compressed: true,
    model_budget_tokens: budget, usage: { prompt_tokens: 300_000, completion_tokens: 50_000 } } };
}

// 'calibrated': the prefix's reported usage is a plausible sample (0.05 tokens
// per byte). 'uncalibrated': 4,000 tokens for ~1 MB is below the plausible
// ratio, so the sample is dropped and only the image-aware bound sizes it.
for (const [turn, sample] of [['human', 'calibrated'], ['tool', 'calibrated'],
  ['human', 'uncalibrated'], ['tool', 'uncalibrated']]) {
  test(`a ${turn} turn rides a prefix that kept images by its sized tokens, not its base64 bytes (${sample})`, async () => {
    let compressions = 0;
    const hasMemory = body => JSON.stringify(body.messages).includes('memory m');
    const h = await harness({ budget: 100_000,
      usage: body => hasMemory(body) ? (sample === 'calibrated' ? 50_000 : 4_000) : 10_000,
      count: body => ({ input_tokens: hasMemory(body) ? 60_000 : 300_000 }),
      compress: () => ++compressions === 1 ? imageFlattenReply(1_000_000) : undefined });
    const original = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'x'.repeat(600_000) }];
    try {
      assert.equal(await h.post(0, { agent: '', messages: original }), 200);
      assert.equal(h.compressions.length, 1);
      const human = [{ role: 'assistant', content: 'next answer' }, { role: 'user', content: 'next question' }];
      const tool = [{ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'next result' }] }];
      // The tool turn follows a human turn on the prefix, so it rides the
      // session's stable prefix (planToolCompaction), not the lane's route.
      assert.equal(await h.post(0, { agent: '', messages: [...original, ...human] }), 200);
      if (turn === 'tool') {
        assert.equal(await h.post(0, { agent: '', messages: [...original, ...human, ...tool] }), 200);
      }
      // bytes/4 of the 1 MB image payload alone (250k) exceeds the 200k window.
      assert.equal(h.compressions.length, 1, 'no recompression from base64 bytes');
      const sent = JSON.stringify(h.forwards.at(-1).messages);
      assert.match(sent, /"type":"image"/);
      assert.match(sent, turn === 'human' ? /next question/ : /next result/);
      const rec = h.records.filter(r => r.kind === 'messages').at(-1);
      assert.match(rec.turnType, turn === 'human' ? /^followup-prefix$/ : /^tool-(memory|prefix)$/);
    } finally { h.close(); }
  });
}

test('a human turn rides an exactly counted prefix that fits with the output floor, not full max_tokens', async () => {
  let compressions = 0;
  const hasMemory = body => JSON.stringify(body.messages).includes('memory m');
  // No usage: the prefix has no sample, so its size is the exact count.
  const h = await harness({ budget: 160_000, usage: () => undefined,
    count: body => ({ input_tokens: hasMemory(body) ? 150_000 : 300_000 }),
    compress: () => ++compressions === 1 ? compressedReply(400_000, 160_000) : undefined });
  const options = { agent: '', model: 'claude-sonnet-4-5', maxTokens: 64_000 };
  const original = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'x'.repeat(600_000) }];
  try {
    assert.equal(await h.post(0, { ...options, messages: original }), 200);
    assert.equal(h.compressions.length, 1);
    const next = [...original, { role: 'assistant', content: 'next answer' },
      { role: 'user', content: 'next question' }];
    assert.equal(await h.post(0, { ...options, messages: next }), 200);
    // 150k counted + 64k max_tokens exceeds the 200k window; + the output floor does not.
    assert.equal(h.compressions.length, 1, 'the counted prefix rides');
    assert.equal(h.records.filter(r => r.kind === 'messages').at(-1).turnType, 'followup-prefix');
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /next question/);
  } finally { h.close(); }
});

test('a human turn counted under the window with the output floor is not forced to the target', async () => {
  const h = await harness({ budget: 160_000, usage: (_body, bytes) => Math.floor(bytes * 0.2),
    count: body => ({ input_tokens: JSON.stringify(body).length > 500_000 ? 145_000 : 80_000 }) });
  const options = { agent: '', model: 'claude-sonnet-4-5', maxTokens: 64_000 };
  const turn = chars => [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'x'.repeat(chars) }];
  try {
    assert.equal(await h.post(0, { ...options, messages: turn(400_000) }), 200);
    await h.post(0, { ...options, messages: turn(625_000) });
    const rec = h.records.filter(r => r.kind === 'messages').at(-1);
    // Counted 145k + the 16k output floor fits the 200k window (+ 64k max_tokens
    // would not), and 145k is under the 160k budget: the server decides.
    assert.equal(rec.compaction.sizeSource, 'reported');
    assert.equal(rec.compaction.estimatedTokens, 145_000);
    assert.equal(rec.compaction.reason, undefined, 'not forced');
    assert.equal(h.compressions.at(-1).compression_threshold_tokens, 160_000);
  } finally { h.close(); }
});

test('a tool turn off its route, counted under the window with the output floor, passes without compression', async () => {
  let compressions = 0;
  const h = await harness({ budget: 160_000, usage: () => undefined,
    count: body => {
      const chars = JSON.stringify(body).length;
      return { input_tokens: JSON.stringify(body.messages).includes('memory m') ? 5_000
        : chars > 650_000 ? 300_000 : 145_000 };
    },
    compress: () => ++compressions === 1 ? compressedReply(4_000, 160_000) : undefined });
  const options = { agent: '', model: 'claude-sonnet-4-5', maxTokens: 64_000 };
  const toolTurn = (task, chars) => [{ role: 'user', content: task },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(chars) }] }];
  try {
    assert.equal(await h.post(0, { ...options, messages: toolTurn('task', 700_000) }), 200);
    assert.equal(h.compressions.length, 1);
    // An edited first message: the route and prefix miss, so the original is
    // planned without the early count rides skip. bytes/4 (~156k) + 64k
    // max_tokens is over the 200k window; its count, 145k + the 16k output
    // floor, fits, and 145k is under the 160k budget: forwarded whole.
    assert.equal(await h.post(0, { ...options, messages: toolTurn('edited task', 625_000) }), 200);
    const rec = h.records.filter(r => r.kind === 'messages').at(-1);
    assert.equal(rec.compaction.estimatedTokens, 145_000);
    assert.equal(h.compressions.length, 1, 'no compress call');
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /edited task/);
  } finally { h.close(); }
});

test('a compressed result with reported usage is judged with the output floor before backing off', async () => {
  const { __testCompressedResultExceedsWindow: exceeds } = await import('../dist/proxy.js');
  const body = { model: 'claude-sonnet-4-5', max_tokens: 64_000 };
  const raw = Buffer.from('m'.repeat(400_000));
  // 150k reported + the 16k floor fits 200k (+ 64k max_tokens would not): no backoff.
  assert.equal(exceeds(body, { usage: { input_tokens: 150_000 } }, raw, 200_000), false);
  assert.equal(exceeds(body, { usage: { input_tokens: 190_000 } }, raw, 200_000), true);
  // No usage: the conservative bound (400k / 2.4 = 167k) with full max_tokens.
  assert.equal(exceeds(body, {}, raw, 200_000), true);
  assert.equal(exceeds({ ...body, max_tokens: 16_000 }, {}, raw, 200_000), false);
});
