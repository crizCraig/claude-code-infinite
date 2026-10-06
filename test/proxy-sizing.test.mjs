import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy } from '../dist/proxy.js';
import { MemtreeClient } from '../dist/memtree.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function harness({ count = () => ({ input_tokens: 10_000 }), usage = () => 10_000,
  countStatus = 200, budget = 200_000, enabled = true, compress, timeout = false } = {}) {
  const counts = [], forwards = [], compressions = [], records = [];
  const upstream = await listen((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (req.url.includes('/count_tokens')) {
        counts.push(body);
        if (timeout) return;
        res.writeHead(countStatus, { 'content-type': 'application/json' });
        const result = count(body, counts.length);
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
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memory.origin, apiKey: 'mock-secret' }),
    upstreamOrigin: upstream.origin, budgetTokensOverride: budget, countTokens: enabled,
    reqlog: { log: record => records.push(structuredClone(record)) },
  });
  async function post(bytes, { agent = 'a', oneMillion = false, text = 'x' } = {}) {
    const messages = [{ role: 'user', content: 'task' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text.repeat(bytes) }] }];
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-claude-code-session-id': 's', 'x-claude-code-agent-id': agent,
        ...(oneMillion ? { 'anthropic-beta': 'context-1m-2025-08-07' } : {}) },
      body: JSON.stringify({ model: 'claude-x', max_tokens: 64, messages }),
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
      assert.equal(await h.post(469_550), 200);
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
    assert.equal(await h.post(500_000), 200);
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
    assert.deepEqual(Object.keys(rec.countTokens[0]).sort(), ['ms', 'statusClass']);
  } finally { h.close(); }
});

test('concurrent lane sample cannot replace this request exact over-window count', async () => {
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const h = await harness({ count: () => ({ input_tokens: 210_000 }), usage: () => 90_000,
    compress: async () => { reached(); await new Promise(resolve => { release = resolve; }); } });
  try {
    const large = h.post(1_000_000);
    await waiting;
    assert.equal(await h.post(900_000), 200);
    release();
    assert.equal(await large, 503);
    assert.equal(h.forwards.length, 1);
    assert.equal(h.counts.length, 1);
  } finally { release?.(); h.close(); }
});

test('2026-10-05 20:04 UTC pid84669: 469801-byte subagent formerly 5778216 tokens forwards', async () => {
  const h = await harness({ budget: 800_000, enabled: false,
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
    assert.ok(rec.countTokens.every(r => Object.keys(r).sort().join() === 'ms,statusClass'));
  } finally { h.close(); }
});
