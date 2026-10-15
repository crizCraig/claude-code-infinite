// Conservative per-model token estimates (src/token-estimate.ts), the
// fallback when no exact Count Tokens result exists. Incident 3bc78182
// (2026-10-15): bytes/4 put a 3,238,930-byte flattened Opus 5.5 body at
// 809,733 tokens and ccc forwarded it to a 1M window; Anthropic counted
// 1,342,572 and refused it ("Context limit reached").
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_4_7_PLUS_BYTES_PER_TOKEN, CLAUDE_LEGACY_BYTES_PER_TOKEN, MAX_IMAGE_TOKENS,
  OTHER_BYTES_PER_TOKEN, bytesPerTokenForModel, conservativeBodyTokens,
  conservativeTokensFromBytes,
} from '../dist/token-estimate.js';
import { RequestSizing } from '../dist/request-sizing.js';

test('model families pick their tokenizer ratio', () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-4-7',
    'claude-sonnet-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-x']) {
    assert.equal(bytesPerTokenForModel(model), CLAUDE_4_7_PLUS_BYTES_PER_TOKEN, model);
  }
  for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-5',
    'claude-sonnet-4.5']) {
    assert.equal(bytesPerTokenForModel(model), CLAUDE_LEGACY_BYTES_PER_TOKEN, model);
  }
  for (const model of ['gpt-5', 'glm-4.6', undefined, '']) {
    assert.equal(bytesPerTokenForModel(model), OTHER_BYTES_PER_TOKEN, String(model));
  }
  assert.equal(conservativeTokensFromBytes(19, 'claude-opus-5-5'), 10);
  assert.equal(conservativeTokensFromBytes(0, 'claude-opus-5-5'), 0);
});

test('incident 3bc78182: the 3,238,930-byte Opus 5.5 body no longer fits 1M uncounted', () => {
  const bytes = 3_238_930;
  assert.equal(Math.round(bytes / 4), 809_733, 'what bytes/4 said');
  const estimate = conservativeTokensFromBytes(bytes, 'claude-opus-5-5');
  assert.ok(estimate > 1_000_000, `${estimate}`);
  assert.ok(estimate >= 1_342_572 * 1.2, 'at or above what Anthropic counted, with margin');
});

const image = (data, order = 'standard') => order === 'standard'
  ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
  : { type: 'image', source: { data, media_type: 'image/png', type: 'base64' } };
const bodyOf = content => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5',
  messages: [{ role: 'user', content }] }));

test('each base64 image payload counts as one maximum-cost image, not as text', () => {
  const data = 'A'.repeat(1_500_000);
  const text = { type: 'text', text: 'look' };
  const one = bodyOf([text, image(data)]);
  const textOnly = conservativeTokensFromBytes(one.length - data.length, 'claude-opus-5-5');
  assert.equal(conservativeBodyTokens(one, 'claude-opus-5-5'), textOnly + MAX_IMAGE_TOKENS);
  // A tiny, very compressible image can still cost the maximum.
  const small = bodyOf([text, image('iVBORw0KGgo=')]);
  assert.equal(conservativeBodyTokens(small, 'claude-opus-5-5'),
    conservativeTokensFromBytes(small.length - 12, 'claude-opus-5-5') + MAX_IMAGE_TOKENS);
  const two = bodyOf([image(data), image(data)]);
  assert.equal(conservativeBodyTokens(two, 'claude-opus-5-5'),
    conservativeTokensFromBytes(two.length - 2 * data.length, 'claude-opus-5-5') +
      2 * MAX_IMAGE_TOKENS);
});

test('images are found by structure: any key order, URL sources, nested in tool results', () => {
  const data = 'A'.repeat(100_000);
  const model = 'claude-opus-5-5';
  const reordered = bodyOf([image(data, 'reordered')]);
  assert.equal(conservativeBodyTokens(reordered, model),
    conservativeTokensFromBytes(reordered.length - data.length, model) + MAX_IMAGE_TOKENS);
  // Codex round 1: a valid 535-byte 2576x1456 PNG costs 4,784 tokens in any key order.
  const tiny = 'B'.repeat(535);
  const eight = bodyOf(Array.from({ length: 8 }, () => image(tiny, 'reordered')));
  assert.ok(conservativeBodyTokens(eight, model) >= 8 * MAX_IMAGE_TOKENS);
  const url = bodyOf([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }]);
  assert.equal(conservativeBodyTokens(url, model),
    conservativeTokensFromBytes(url.length, model) + MAX_IMAGE_TOKENS);
  const nested = bodyOf([{ type: 'tool_result', tool_use_id: 't', content: [image(data)] }]);
  assert.equal(conservativeBodyTokens(nested, model),
    conservativeTokensFromBytes(nested.length - data.length, model) + MAX_IMAGE_TOKENS);
});

test('documents and text that only quotes an image stay text (an over-estimate)', () => {
  const data = 'A'.repeat(100_000);
  const pdf = bodyOf([{ type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data } }]);
  const quoted = bodyOf([{ type: 'text',
    text: `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${data}"}}` }]);
  const broken = Buffer.from(`{"type":"image" ${data}`);
  for (const body of [pdf, quoted, broken]) {
    assert.equal(conservativeBodyTokens(body, 'claude-opus-5-5'),
      conservativeTokensFromBytes(body.length, 'claude-opus-5-5'));
  }
});

function counts(values = new Map()) {
  return { peek: () => undefined, async count(body) {
    const tokens = values.get(body.toString());
    return tokens === undefined ? { outcome: 'timeout', ms: 1 } : { outcome: 'success', ms: 1, tokens };
  } };
}

test('a body fitting only by bytes/4 is not selected when its count fails', async () => {
  const limits = { budget: 800_000, context: 1_000_000, output: 16_000, recountOutput: 64_000 };
  const body = Buffer.from('x'.repeat(3_238_930));
  const failed = new RequestSizing(counts(), true, 'claude-opus-5-5');
  const candidate = failed.register(body, 'original');
  assert.ok(body.length / 4 + 64_000 < 1_000_000, 'bytes/4 used to admit it');
  assert.equal(await failed.select(candidate, limits), undefined);

  const exact = new RequestSizing(counts(new Map([[body.toString(), 900_000]])), true,
    'claude-opus-5-5');
  const selected = await exact.select(exact.register(body, 'original'), limits);
  assert.equal(selected.measurement.source, 'exact');
  assert.equal(selected.measurement.tokens, 900_000);
});

test('with counting disabled the conservative bound decides, per model', async () => {
  const limits = { budget: 100, context: 200, output: 10 };
  const body = Buffer.from('x'.repeat(450));
  const claude = new RequestSizing(counts(), false, 'claude-opus-5-5');
  assert.equal(await claude.select(claude.register(body, 'original'), limits), undefined,
    '450 / 1.9 = 237 tokens');
  const legacy = new RequestSizing(counts(), false, 'claude-haiku-4-5');
  const selected = await legacy.select(legacy.register(body, 'original'), limits);
  assert.equal(selected.measurement.tokens, 188);
  assert.equal(selected.measurement.source, 'bytes');
});

test('image-shaped JSON outside content-block positions stays text (Codex round 2)', () => {
  const model = 'claude-opus-5-5';
  const data = 'A'.repeat(1_200_000);
  const fake = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
  const inToolInput = Buffer.from(JSON.stringify({ model, messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { payload: fake } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] }));
  const inSchema = Buffer.from(JSON.stringify({ model, tools: [{ name: 'x',
    input_schema: { type: 'object', default: fake } }], messages: [{ role: 'user', content: 'go' }] }));
  const inSystem = Buffer.from(JSON.stringify({ model, system: [fake],
    messages: [{ role: 'user', content: 'go' }] }));
  const stray = Buffer.from(JSON.stringify({ model, metadata: { fake },
    messages: [{ role: 'user', content: 'go' }] }));
  for (const body of [inToolInput, inSchema, inSystem, stray]) {
    assert.equal(conservativeBodyTokens(body, model), conservativeTokensFromBytes(body.length, model));
  }
  // Real positions still count: a user content block and a tool_result's content.
  const real = Buffer.from(JSON.stringify({ model, messages: [
    { role: 'user', content: [fake] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [fake] }] }] }));
  assert.equal(conservativeBodyTokens(real, model),
    conservativeTokensFromBytes(real.length - 2 * data.length, model) + 2 * MAX_IMAGE_TOKENS);
});
