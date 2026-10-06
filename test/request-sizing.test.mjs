import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestSizing } from '../dist/request-sizing.js';

const limits = { budget: 100, context: 200, output: 10 };
function fakeCounts(values = new Map()) {
  const completed = new Map();
  const calls = [];
  return { calls, peek: body => completed.get(body.toString()), async count(body) {
    const key = body.toString();
    if (!completed.has(key)) {
      calls.push(key);
      const tokens = values.get(key);
      completed.set(key, tokens === undefined
        ? { outcome: 'server-error', ms: 1 }
        : { outcome: 'success', ms: 1, tokens });
    }
    return completed.get(key);
  } };
}

test('body and learned sample snapshots survive concurrent mutations and re-registration', () => {
  const sizing = new RequestSizing(fakeCounts(), true);
  const input = Buffer.from('x'.repeat(400));
  const sample = { tokens: 160, forwardedBytes: 400 };
  const candidate = sizing.register(input, 'original', sample);
  input.fill('y');
  sample.tokens = 20;
  assert.equal(candidate.body.toString(), 'x'.repeat(400));
  assert.deepEqual(sizing.plan(candidate), { tokens: 160, source: 'reported' });
  assert.equal(sizing.register(Buffer.from('x'.repeat(400)), 'replacement', sample), candidate);
  assert.equal(candidate.kind, 'original', 'same bytes are not promoted into a compressed candidate');
});

test('low-ratio exact count is one authoritative result for plan, hint and delivery', async () => {
  const body = Buffer.from('x'.repeat(10_000));
  const counts = fakeCounts(new Map([[body.toString(), 10]]));
  const sizing = new RequestSizing(counts, true);
  const candidate = sizing.register(body, 'original');
  assert.equal((await sizing.measure(candidate, limits, 'plan')).tokens, 10);
  assert.equal(sizing.plan(candidate).tokens, 10);
  assert.equal(sizing.clientInputTokens(candidate), 10);
  assert.equal((await sizing.select(candidate, limits)).candidate, candidate);
  assert.equal(counts.calls.length, 1);
});

for (const enabled of [true, false]) {
  test(`failed or disabled count uses final byte fallback (${enabled})`, async () => {
    const counts = fakeCounts();
    const sizing = new RequestSizing(counts, enabled);
    const candidate = sizing.register(Buffer.from('x'.repeat(600)), 'original',
      { tokens: 360, forwardedBytes: 400 });
    await sizing.measure(candidate, limits, 'plan');
    assert.ok(sizing.plan(candidate).tokens > 200, 'advisory estimate still requests compression');
    const selected = await sizing.select(candidate, limits);
    assert.equal(selected.candidate, candidate);
    assert.equal(selected.measurement.tokens, 150);
    assert.equal(selected.measurement.source, 'bytes');
    assert.equal(counts.calls.length, enabled ? 1 : 0);
  });
}

test('known exact overflow cannot be overwritten by a fitting byte estimate', async () => {
  const body = Buffer.from('x'.repeat(400));
  const sizing = new RequestSizing(fakeCounts(new Map([[body.toString(), 195]])), true);
  const candidate = sizing.register(body, 'original');
  assert.equal(await sizing.select(candidate, limits), undefined, '195 input plus 10 output exceeds 200');
});

test('replacement exact overflow selects known-fitting original without recounting either', async () => {
  const original = Buffer.from('o'.repeat(1_500));
  const replacement = Buffer.from('r'.repeat(500));
  const counts = fakeCounts(new Map([[original.toString(), 150], [replacement.toString(), 210]]));
  const sizing = new RequestSizing(counts, true);
  const source = sizing.register(original, 'original');
  await sizing.measure(source, limits, 'plan');
  const result = sizing.register(replacement, 'replacement');
  assert.equal((await sizing.select(result, limits)).candidate, source);
  assert.equal(counts.calls.length, 2);
});

test('a validated retained ride is preferred over original when fresh replacement fails', async () => {
  const sizing = new RequestSizing(fakeCounts(), false);
  const original = sizing.register(Buffer.from('o'.repeat(400)), 'original');
  const ride = sizing.register(Buffer.from('v'.repeat(200)), 'ride');
  const replacement = sizing.register(Buffer.from('r'.repeat(1000)), 'replacement');
  assert.equal((await sizing.select(replacement, limits)).candidate, ride);
  sizing.excludeFallback(ride);
  assert.equal((await sizing.select(replacement, limits)).candidate, original,
    'route planning can remove an ineligible prefix without losing the original');
});

test('unregistered or excluded rides cannot reappear in an original-only delivery path', async () => {
  const sizing = new RequestSizing(fakeCounts(), false);
  const original = sizing.register(Buffer.from('o'.repeat(1000)), 'original');
  const invalidRide = sizing.register(Buffer.from('v'.repeat(100)), 'ride');
  sizing.excludeFallback(invalidRide);
  assert.equal(await sizing.select(original, limits), undefined);
});

test('validated compressed body wins even when the intended original also fits', async () => {
  const sizing = new RequestSizing(fakeCounts(), false);
  const original = sizing.register(Buffer.from('o'.repeat(400)), 'original');
  const ride = sizing.register(Buffer.from('v'.repeat(200)), 'ride');
  assert.equal((await sizing.select(original, limits)).candidate, ride);
});

test('native admission rounds bytes upward and includes reserved output', async () => {
  const sizing = new RequestSizing(fakeCounts(), false);
  const original = sizing.register(Buffer.from('x'.repeat(401)), 'original');
  assert.equal(await sizing.select(original, { budget: 100, context: 110, output: 10 }), undefined);
});
