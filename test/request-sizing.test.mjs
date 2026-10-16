import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestSizing, fitsMeasured } from '../dist/request-sizing.js';

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
  test(`failed or disabled count uses final conservative byte fallback (${enabled})`, async () => {
    // No model: 2.8 bytes per token (token-estimate.ts). 500 bytes -> 179 tokens,
    // which fits 200 with 10 output; 600 bytes -> 215 does not, although
    // bytes/4 (150) used to admit it.
    const counts = fakeCounts();
    const sizing = new RequestSizing(counts, enabled);
    const candidate = sizing.register(Buffer.from('x'.repeat(500)), 'original',
      { tokens: 360, forwardedBytes: 400 });
    await sizing.measure(candidate, limits, 'plan');
    assert.ok(sizing.plan(candidate).tokens > 200, 'advisory estimate still requests compression');
    const selected = await sizing.select(candidate, limits);
    assert.equal(selected.candidate, candidate);
    assert.equal(selected.measurement.tokens, 179);
    assert.equal(selected.measurement.source, 'bytes');
    assert.equal(counts.calls.length, enabled ? 1 : 0);

    const alone = new RequestSizing(fakeCounts(), enabled);
    const loose = alone.register(Buffer.from('y'.repeat(600)), 'original',
      { tokens: 360, forwardedBytes: 400 });
    assert.equal(await alone.select(loose, limits), undefined,
      'a body that fits only by bytes/4 is not delivered on an estimate');
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

test('a body over the 64 MiB request limit is known not to fit natively: no count', async () => {
  const counts = fakeCounts();
  const sizing = new RequestSizing(counts, true, 'claude-opus-5-5');
  const big = { budget: 800_000, context: 1_000_000, output: 64 };
  // Image-like filler: a bound or a learned sample could call it small.
  const huge = sizing.register(Buffer.alloc(64 * 1024 * 1024 + 1, 0x20), 'original',
    { tokens: 100_000, forwardedBytes: 60_000_000 });
  assert.equal(sizing.exceedsRequestLimit(huge), true);
  assert.equal(sizing.boundFits(huge, big), false);
  assert.equal(sizing.canCount(huge), false);
  await sizing.countIfOverBound(huge, big);
  const measured = await sizing.measure(huge, big);
  assert.equal(counts.calls.length, 0, 'Count Tokens would answer 413');
  assert.equal(measured.source, 'bytes');
  assert.equal(measured.tooLarge, true);
  assert.equal(fitsMeasured(measured, big), false);
  assert.equal(await sizing.select(huge, big), undefined);
});

test('an uncalibrated byte estimate never exceeds the image-aware bound', () => {
  const sizing = new RequestSizing(fakeCounts(), true, 'claude-opus-5-5');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_000_000) } };
  const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, image] }] }));
  // A dropped sample (4,000 tokens for ~1 MB is below the plausible ratio).
  const candidate = sizing.register(body, 'ride', { tokens: 4_000, forwardedBytes: body.length });
  assert.equal(candidate.sample, undefined);
  assert.ok(candidate.conservativeTokens < 5_000);
  assert.deepEqual(sizing.plan(candidate), { tokens: candidate.conservativeTokens, source: 'bytes' });
  // Text: bytes/4 is below the bound, so it stays the estimate.
  const text = sizing.register(Buffer.from('x'.repeat(4_000)), 'original');
  assert.deepEqual(sizing.plan(text), { tokens: 1_000, source: 'bytes' });
});

test('exactTokensFor reads a completed count for the bytes and never counts', async () => {
  const counts = fakeCounts(new Map([['body', 150]]));
  const sizing = new RequestSizing(counts, true);
  assert.equal(sizing.exactTokensFor(Buffer.from('body')), undefined);
  assert.equal(counts.calls.length, 0);
  await sizing.countIfOverBound(sizing.register(Buffer.from('body'), 'replacement'),
    { budget: 1, context: 1, output: 0 });
  assert.equal(sizing.exactTokensFor(Buffer.from('body')), 150);
});
