// Subagent lanes' own budget (CCC_AGENT_BUDGET_TOKENS / CCC_AGENT_TARGET_TOKENS) and
// compress on a cold cache (CCC_COMPRESS_ON_COLD_CACHE=1): both off by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy } from '../dist/proxy.js';
import { MemtreeClient } from '../dist/memtree.js';
import { agentLaneBudgetFromEnv } from '../dist/cli-args.js';
import {
  DEFAULT_CACHE_TTL_MS, LONG_CACHE_TTL_MS, LaneCacheClock, cacheTtlMs, coldCacheSample,
  coldCacheWorthCompressing,
} from '../dist/cold-cache.js';

const OPUS = 'claude-opus-5-5';
const MINUTE = 60_000;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function readJson(req, onBody) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => onBody(JSON.parse(raw), raw));
}

/** A proxy on a 1M window whose upstream reports bytes/4 and whose MemTree compresses to 10k. */
async function harness(options = {}) {
  const forwards = [], compressions = [], records = [];
  const upstream = await listen((req, res) => readJson(req, (body, raw) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/count_tokens')) {
      res.end(JSON.stringify({ input_tokens: Math.floor(raw.length / 4) }));
      return;
    }
    forwards.push(body);
    res.end(JSON.stringify({ type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: Math.floor(raw.length / 4), output_tokens: 1 } }));
  }));
  const memory = await listen((req, res) => readJson(req, (body) => {
    if (!body.index_only) compressions.push(body);
    const forced = !body.index_only && body.compression_target_tokens !== undefined;
    const messages = forced ? [{ role: 'user', content: 'memory ' + 'm'.repeat(40_000) }]
      : body.messages;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages, flattened_messages: messages, compressed: forced,
      index_only: body.index_only, model_budget_tokens: 960_000,
      usage: { prompt_tokens: 100, completion_tokens: 100 } }));
  }));
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memory.origin, apiKey: 'mock-secret' }),
    upstreamOrigin: upstream.origin, countTokens: true, nativeOneMillionContext: true,
    reqlog: { log: record => records.push(structuredClone(record)) },
    ...options,
  });
  async function post(messages, { agent = 'a', at } = {}) {
    const realNow = Date.now;
    if (at !== undefined) Date.now = () => realNow() + at;
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-claude-code-session-id': 's', 'x-claude-code-agent-id': agent },
        body: JSON.stringify({ model: OPUS, max_tokens: 64, messages }),
      });
      await response.text();
      return response.status;
    } finally { Date.now = realNow; }
  }
  const messageRecords = () => records.filter(r => r.kind === 'messages');
  return { post, forwards, compressions, messageRecords, close() {
    proxy.close();
    for (const { server } of [upstream, memory]) { server.closeAllConnections(); server.close(); }
  } };
}

/** A tool round whose result is `chars` long (~chars/4 tokens), optionally cache-marked. */
function toolRound(id, chars, ttl) {
  const result = { type: 'tool_result', tool_use_id: id, content: 'y'.repeat(chars) };
  if (ttl !== undefined) result.cache_control = ttl === '5m' ? { type: 'ephemeral' }
    : { type: 'ephemeral', ttl };
  return [{ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
    { role: 'user', content: [result] }];
}

/** A conversation of one task and tool rounds; only the newest round carries the marker. */
function toolLoop(rounds, ttl) {
  const messages = [{ role: 'user', content: 'task' }];
  rounds.forEach(([id, chars], index) =>
    messages.push(...toolRound(id, chars, index === rounds.length - 1 ? ttl : undefined)));
  return messages;
}

test('agent lane budget env: off unless set, target half by default, bad values warned', () => {
  const parse = (text) => {
    const m = /^(\d+)(k?)$/i.exec(text.trim());
    return m ? Number(m[1]) * (m[2] ? 1000 : 1) : undefined;
  };
  assert.deepEqual(agentLaneBudgetFromEnv(undefined, '100k', parse, 20_000),
    { value: undefined, warnings: [] });
  assert.deepEqual(agentLaneBudgetFromEnv('200k', undefined, parse, 20_000),
    { value: { budget: 200_000, target: 100_000 }, warnings: [] });
  assert.deepEqual(agentLaneBudgetFromEnv('100k', '40k', parse, 20_000),
    { value: { budget: 100_000, target: 40_000 }, warnings: [] });
  const small = agentLaneBudgetFromEnv('30k', undefined, parse, 20_000);
  assert.equal(small.value, undefined);
  assert.match(small.warnings[0], /ignoring CCC_AGENT_BUDGET_TOKENS=30k/);
  for (const target of ['200k', '300k', '5k', 'lots']) {
    const bad = agentLaneBudgetFromEnv('200k', target, parse, 20_000);
    assert.deepEqual(bad.value, { budget: 200_000, target: 100_000 }, target);
    assert.match(bad.warnings[0], new RegExp(`ignoring CCC_AGENT_TARGET_TOKENS=${target}`));
  }
});

test('cache TTL: the last marker decides, 1h only when it says so, none without markers', () => {
  assert.equal(cacheTtlMs({ messages: [{ role: 'user', content: 'x' }] }), undefined);
  assert.equal(cacheTtlMs({ messages: toolLoop([['t', 10]], '5m') }), DEFAULT_CACHE_TTL_MS);
  assert.equal(cacheTtlMs({ messages: toolLoop([['t', 10]], '1h') }), LONG_CACHE_TTL_MS);
  // A 1h system marker before a 5m message marker: the conversation lives 5 minutes.
  assert.equal(cacheTtlMs({
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: toolLoop([['t', 10]], '5m') }), DEFAULT_CACHE_TTL_MS);
  assert.equal(cacheTtlMs({
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: 'x' }] }), LONG_CACHE_TTL_MS);
});

test('lane cache clock: the gap since each lane\'s own previous request', () => {
  let now = 1_000;
  const clock = new LaneCacheClock(() => now);
  assert.equal(clock.touch('main'), undefined);
  now += 7 * MINUTE;
  assert.equal(clock.touch('agent'), undefined, 'another lane has its own clock');
  assert.equal(clock.touch('main'), 7 * MINUTE);
  now += 1_000;
  assert.equal(clock.touch('main'), 1_000);
  const body = { messages: toolLoop([['t', 10]], '5m') };
  assert.deepEqual(coldCacheSample(6 * MINUTE, body),
    { gapMs: 6 * MINUTE, ttlMs: DEFAULT_CACHE_TTL_MS, cold: true });
  assert.deepEqual(coldCacheSample(4 * MINUTE, body),
    { gapMs: 4 * MINUTE, ttlMs: DEFAULT_CACHE_TTL_MS, cold: false });
  assert.equal(coldCacheSample(undefined, body), undefined);
  assert.equal(coldCacheSample(6 * MINUTE, { messages: [] }), undefined);
  assert.equal(coldCacheWorthCompressing(110_000, 100_000), false, 'within 10% of the target');
  assert.equal(coldCacheWorthCompressing(110_001, 100_000), true);
});

test('agent lane budget: a subagent compresses at its own budget to its own target', async () => {
  const h = await harness({ agentLaneBudget: { budget: 200_000, target: 100_000 } });
  try {
    // ~250k tokens: past the agent budget, far under the main lane's 960k.
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]])), 200);
    assert.equal(h.compressions.length, 1, 'the subagent compressed');
    assert.equal(h.compressions[0].compression_target_tokens, 100_000);
    const agent = h.messageRecords().at(-1);
    assert.equal(agent.routeLane, 'agent');
    assert.equal(agent.compaction.budgetTokens, 200_000);
    assert.equal(agent.compaction.budgetSource, 'agent');
    assert.equal(agent.compaction.targetTokens, 100_000);
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /memory m/);

    // The main lane at the same size keeps the model budget: no compression.
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]]), { agent: '' }), 200);
    assert.equal(h.compressions.length, 1, 'the main lane passed through');
    const main = h.messageRecords().at(-1);
    assert.equal(main.routeLane, 'main');
    assert.equal(main.compaction.budgetTokens, 960_000);
    assert.notEqual(main.compaction.budgetSource, 'agent');
  } finally { h.close(); }
});

test('agent lane budget off (the default): a 250k subagent passes through', async () => {
  const h = await harness();
  try {
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]])), 200);
    assert.equal(h.compressions.length, 0);
    assert.equal(h.messageRecords().at(-1).compaction.budgetTokens, 960_000);
  } finally { h.close(); }
});

/** Two agent tool turns ~150k tokens, the second `gapMs` after the first. */
async function agentTurnsAfterGap(options, { gapMs, ttl = '5m', chars = 600_000 } = {}) {
  const h = await harness({ agentLaneBudget: { budget: 200_000, target: 100_000 }, ...options });
  assert.equal(await h.post(toolLoop([['t1', chars]], ttl)), 200);
  assert.equal(h.compressions.length, 0, 'under the agent budget');
  assert.equal(await h.post(toolLoop([['t1', chars], ['t2', 400]], ttl), { at: gapMs }), 200);
  return h;
}

test('cold cache: an agent idle past its 5 min TTL compresses to its target', async () => {
  const h = await agentTurnsAfterGap({ compressOnColdCache: true }, { gapMs: 6 * MINUTE });
  try {
    assert.equal(h.compressions.length, 1, 'compressed on the cold gap');
    assert.equal(h.compressions[0].compression_target_tokens, 100_000);
    assert.equal(h.compressions[0].compression_threshold_tokens, undefined,
      'a bare target: a threshold would let the server pass it through');
    const rec = h.messageRecords().at(-1);
    assert.equal(rec.compaction.reason, 'cold-cache');
    assert.deepEqual(rec.coldCache, { gapMs: rec.coldCache.gapMs, ttlMs: 300_000, cold: true });
    assert.ok(rec.coldCache.gapMs >= 6 * MINUTE);
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
    // The next turn, right away, is warm and rides the new route.
    assert.equal(await h.post(toolLoop([['t1', 600_000], ['t2', 400], ['t3', 400]], '5m'),
      { at: 6 * MINUTE + 1_000 }), 200);
    assert.equal(h.compressions.length, 1, 'no second compression');
    assert.equal(h.messageRecords().at(-1).coldCache.cold, false);
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
  } finally { h.close(); }
});

for (const [name, options, shape] of [
  ['inside the TTL', { compressOnColdCache: true }, { gapMs: 4 * MINUTE }],
  ['inside a 1h TTL', { compressOnColdCache: true }, { gapMs: 6 * MINUTE, ttl: '1h' }],
  ['within 10% of the target', { compressOnColdCache: true },
    { gapMs: 6 * MINUTE, chars: 420_000 }],
  ['with the switch off (default)', {}, { gapMs: 6 * MINUTE }],
]) {
  test(`cold cache: no compression ${name}`, async () => {
    const h = await agentTurnsAfterGap(options, shape);
    try {
      assert.equal(h.compressions.length, 0);
      const rec = h.messageRecords().at(-1);
      assert.notEqual(rec.compaction.reason, 'cold-cache');
      if (options.compressOnColdCache) assert.ok(rec.coldCache);
      else assert.equal(rec.coldCache, undefined, 'not measured with the switch off');
    } finally { h.close(); }
  });
}

test('cold cache: the main lane idle past its 1h TTL compresses to half the budget', async () => {
  const h = await harness({ compressOnColdCache: true });
  try {
    // ~600k tokens: under the 960k budget, above the 480k target.
    assert.equal(await h.post(toolLoop([['t1', 2_400_000]], '1h'), { agent: '' }), 200);
    assert.equal(await h.post(toolLoop([['t1', 2_400_000], ['t2', 400]], '1h'),
      { agent: '', at: 30 * MINUTE }), 200);
    assert.equal(h.compressions.length, 0, 'warm after 30 min on a 1h cache');
    assert.equal(await h.post(toolLoop([['t1', 2_400_000], ['t2', 400], ['t3', 400]], '1h'),
      { agent: '', at: 92 * MINUTE }), 200);
    assert.equal(h.compressions.length, 1);
    assert.equal(h.compressions[0].compression_target_tokens, 480_000);
    assert.equal(h.compressions[0].compression_threshold_tokens, undefined);
    const rec = h.messageRecords().at(-1);
    assert.equal(rec.compaction.reason, 'cold-cache');
    assert.equal(rec.coldCache.ttlMs, 3_600_000);
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
  } finally { h.close(); }
});

test('cold cache: a main human turn after an hour away compresses before it is sent', async () => {
  const h = await harness({ compressOnColdCache: true });
  const turn = (extra, ttl) => [{ role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_400_000) }] },
    { role: 'assistant', content: 'answer2' },
    { role: 'user', content: [{ type: 'text', text: extra,
      cache_control: { type: 'ephemeral', ttl } }] }];
  try {
    assert.equal(await h.post(turn('next', '1h'), { agent: '' }), 200);
    const before = h.compressions.filter(c => c.compression_target_tokens !== undefined).length;
    assert.equal(before, 0, 'the first followup lets the server decide');
    const later = [...turn('next', '1h').slice(0, -1),
      { role: 'user', content: 'next' }, { role: 'assistant', content: 'answer3' },
      { role: 'user', content: [{ type: 'text', text: 'back',
        cache_control: { type: 'ephemeral', ttl: '1h' } }] }];
    assert.equal(await h.post(later, { agent: '', at: 61 * MINUTE }), 200);
    const forced = h.compressions.filter(c => c.compression_target_tokens !== undefined);
    assert.equal(forced.length, 1);
    assert.equal(forced[0].compression_target_tokens, 480_000);
    assert.equal(forced[0].compression_threshold_tokens, undefined);
    const rec = h.messageRecords().at(-1);
    assert.equal(rec.compaction.reason, 'cold-cache');
    assert.match(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
  } finally { h.close(); }
});
