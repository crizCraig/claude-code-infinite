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

/**
 * A proxy on a 1M window whose upstream reports bytes/4 and whose MemTree compresses a forced
 * call to ~10k. `post(.., { at })` runs one request `at` ms in the future (Date.now shifted);
 * a forced compress may fail (`failCompress`) or take `compressAdvanceMs` of that clock.
 */
async function harness(options = {}, { failCompress = false, compressAdvanceMs = 0 } = {}) {
  const forwards = [], compressions = [], records = [];
  const clock = { offset: 0 };
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
    if (forced) clock.offset += compressAdvanceMs;
    if (forced && failCompress) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'MemTree down' }));
      return;
    }
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
  async function post(messages, { agent = 'a', at, model = OPUS } = {}) {
    const realNow = Date.now;
    if (at !== undefined) clock.offset = at;
    Date.now = () => realNow() + clock.offset;
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-claude-code-session-id': 's', 'x-claude-code-agent-id': agent },
        body: JSON.stringify({ model, max_tokens: 64, messages }),
      });
      await response.text();
      return response.status;
    } finally { Date.now = realNow; }
  }
  const messageRecords = () => records.filter(r => r.kind === 'messages');
  const forcedCompressions = () => compressions.filter(c => c.compression_target_tokens !== undefined);
  return { post, forwards, compressions, forcedCompressions, messageRecords, clock, close() {
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
    { value: { budget: 200_000 }, warnings: [] }, 'no target: half the effective budget');
  assert.deepEqual(agentLaneBudgetFromEnv('100k', '40k', parse, 20_000),
    { value: { budget: 100_000, target: 40_000 }, warnings: [] });
  const small = agentLaneBudgetFromEnv('30k', undefined, parse, 20_000);
  assert.equal(small.value, undefined);
  assert.match(small.warnings[0], /ignoring CCC_AGENT_BUDGET_TOKENS=30k/);
  for (const target of ['200k', '300k', '5k', 'lots']) {
    const bad = agentLaneBudgetFromEnv('200k', target, parse, 20_000);
    assert.deepEqual(bad.value, { budget: 200_000 }, target);
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

test('lane cache clock: the gap since each lane last sent, claimed once per gap', () => {
  let now = 1_000;
  const clock = new LaneCacheClock(() => now);
  assert.equal(clock.gap('main'), undefined);
  clock.sent('main');
  now += 7 * MINUTE;
  assert.equal(clock.gap('agent'), undefined, 'another lane has its own clock');
  assert.deepEqual(clock.gap('main'), { gapMs: 7 * MINUTE, basis: 1_000 });
  assert.equal(clock.claim('main', 1_000), true);
  assert.equal(clock.claim('main', 1_000), false, 'one cold compression per gap');
  clock.sent('main');
  assert.deepEqual(clock.gap('main'), { gapMs: 0, basis: 1_000 + 7 * MINUTE });
  assert.equal(clock.claim('main', 1_000 + 7 * MINUTE), true, 'a send starts a new gap');
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
async function agentTurnsAfterGap(options, { gapMs, ttl = '5m', chars = 600_000 } = {},
  memtree = {}) {
  const h = await harness({ agentLaneBudget: { budget: 200_000, target: 100_000 }, ...options },
    memtree);
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

test('cold cache: the clock starts when the request goes out, not when it arrived', async () => {
  // The cold compression itself takes 7 minutes (past the 5 min TTL): the next turn, right
  // after the compressed request went out, is warm and must not force again.
  const h = await agentTurnsAfterGap({ compressOnColdCache: true }, { gapMs: 6 * MINUTE },
    { compressAdvanceMs: 7 * MINUTE });
  try {
    assert.equal(h.forcedCompressions().length, 1);
    assert.equal(await h.post(toolLoop([['t1', 600_000], ['t2', 400], ['t3', 400]], '5m')), 200);
    assert.equal(h.forcedCompressions().length, 1, 'warm: no second compression');
    assert.equal(h.messageRecords().at(-1).coldCache.cold, false);
  } finally { h.close(); }
});

test('cold cache: a failed cold compression goes out as usual and is not retried', async () => {
  const h = await agentTurnsAfterGap({ compressOnColdCache: true }, { gapMs: 6 * MINUTE },
    { failCompress: true });
  try {
    assert.equal(h.forcedCompressions().length, 1, 'tried once');
    assert.equal(h.forwards.length, 2, 'the cold turn still went out');
    assert.doesNotMatch(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
    assert.equal(await h.post(toolLoop([['t1', 600_000], ['t2', 400], ['t3', 400]], '5m')), 200);
    assert.equal(h.forcedCompressions().length, 1, 'the next turn is warm');
  } finally { h.close(); }
});

/**
 * A main conversation: one 250k-token user turn, then `turns` exchanges of ~30k tokens each;
 * earlier messages never change as turns are added (only the newest carries the marker).
 */
function humanTurns(turns, ttl = '1h') {
  const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'assistant', content: `answer ${i}` },
      { role: 'user', content: [{ type: 'text', text: `next ${i} ` + 'z'.repeat(120_000) }] });
  }
  messages.at(-1).content[0].cache_control = { type: 'ephemeral', ttl };
  return messages;
}

test('cold cache: a main human turn on the stable prefix recompresses after an hour away', async () => {
  // A 200k budget (CCC_BUDGET_TOKENS): the first turn compresses and becomes the prefix.
  const h = await harness({ compressOnColdCache: true, budgetTokensOverride: 200_000 });
  try {
    assert.equal(await h.post(humanTurns(1), { agent: '' }), 200);
    assert.equal(h.forcedCompressions().length, 1, 'over the budget: the stable prefix');
    // ~10k prefix + 3-4 x ~30k: under the 200k budget, above 110% of the 100k target.
    assert.equal(await h.post(humanTurns(4), { agent: '', at: 10 * MINUTE }), 200);
    assert.equal(h.forcedCompressions().length, 1, 'warm on a 1h cache: it rides');
    assert.equal(h.messageRecords().at(-1).turnType, 'followup-prefix');
    assert.equal(await h.post(humanTurns(5), { agent: '', at: 75 * MINUTE }), 200);
    const forced = h.forcedCompressions();
    assert.equal(forced.length, 2, 'cold: compressed again');
    assert.equal(forced[1].compression_target_tokens, 100_000);
    assert.equal(forced[1].compression_threshold_tokens, undefined);
    assert.equal(h.messageRecords().at(-1).compaction.reason, 'cold-cache');
  } finally { h.close(); }
});

test('cold cache off (the default): a main human turn after an hour rides its prefix', async () => {
  const h = await harness({ budgetTokensOverride: 200_000 });
  try {
    assert.equal(await h.post(humanTurns(1), { agent: '' }), 200);
    assert.equal(await h.post(humanTurns(5), { agent: '', at: 75 * MINUTE }), 200);
    assert.equal(h.forcedCompressions().length, 1);
    const rec = h.messageRecords().at(-1);
    assert.equal(rec.turnType, 'followup-prefix');
    assert.equal(rec.coldCache, undefined);
  } finally { h.close(); }
});

test('agent lane budget wins over CCC_BUDGET_TOKENS on subagent lanes only', async () => {
  const h = await harness({ budgetTokensOverride: 300_000,
    agentLaneBudget: { budget: 200_000, target: 100_000 } });
  try {
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]])), 200);
    assert.equal(h.messageRecords().at(-1).compaction.budgetTokens, 200_000);
    assert.equal(h.forcedCompressions().at(-1).compression_target_tokens, 100_000);
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]]), { agent: '' }), 200);
    const main = h.messageRecords().at(-1);
    assert.equal(main.compaction.budgetTokens, 300_000);
    assert.equal(main.compaction.budgetSource, 'override');
    assert.equal(h.forcedCompressions().length, 1, '250k is under the main 300k');
  } finally { h.close(); }
});

test('agent lane budget: compaction off (CCC_COMPACT_TARGET=off) still turns subagents off', async () => {
  const h = await harness({ defaultCompactTarget: null,
    agentLaneBudget: { budget: 200_000, target: 100_000 } });
  try {
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]])), 200);
    assert.equal(h.compressions.length, 0);
    assert.equal(h.messageRecords().at(-1).compaction.mode, 'off');
  } finally { h.close(); }
});

test('agent lane budget without a target: half the budget the window allows', async () => {
  // 300k on a 200k-window model: the window caps the trigger, the target is half of that.
  const h = await harness({ agentLaneBudget: { budget: 300_000 } });
  try {
    assert.equal(await h.post(toolLoop([['t1', 1_000_000]]), { model: 'claude-sonnet-4-5' }), 200);
    const rec = h.messageRecords().at(-1);
    assert.ok(rec.compaction.budgetTokens < 200_000, `${rec.compaction.budgetTokens}`);
    assert.equal(rec.compaction.budgetSource, 'agent');
    assert.equal(rec.compaction.targetTokens, Math.floor(rec.compaction.budgetTokens / 2));
  } finally { h.close(); }
});
