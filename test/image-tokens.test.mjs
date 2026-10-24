// Image-aware sizing (agent-bus image-overflow-400/REPORT.md, fixes 3-5): an
// image costs its visual tokens, not its base64 as text; a compress budget
// grows with its upload; a count that ran out of time is retried once.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bodyImages, imageDimensions, imageTier, visualTokens } from '../dist/image-tokens.js';
import { estimateRequestTokens } from '../dist/request-sizing.js';
import { createCountTokensSession, plausibleSample } from '../dist/count-tokens.js';
import { MemtreeClient, COMPRESS_TIMEOUT_MS_PER_KIB } from '../dist/memtree.js';

function png(width, height, chars = 4_000) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const filler = Buffer.alloc(Math.ceil(chars * 3 / 4) - header.length, 0x41);
  return Buffer.concat([header, filler]).toString('base64').slice(0, chars);
}

function body(images, text = 'hello', model = 'claude-opus-5-5') {
  return Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: [
    { type: 'text', text },
    { type: 'tool_result', tool_use_id: 't', content: images.map(data =>
      ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })) }] }] }));
}

test('visual tokens follow Anthropic\'s rule (polychat image_tokens.py)', () => {
  assert.equal(visualTokens(574, 551), 420, 'the staging screenshot');
  assert.equal(visualTokens(28, 28), 1);
  assert.ok(visualTokens(8_000, 8_000) <= 4_784, 'scaled down to the high-res cap');
  assert.ok(visualTokens(8_000, 8_000, { maxEdge: 1568, maxTokens: 1_568 }) <= 1_568);
  assert.equal(imageTier('claude-opus-5-5').maxTokens, 4_784);
  assert.equal(imageTier('claude-sonnet-4-5').maxTokens, 1_568);
  assert.equal(imageTier(undefined).maxTokens, 4_784, 'unknown is the conservative tier');
});

test('image dimensions come from PNG, GIF, WebP and JPEG headers', () => {
  assert.deepEqual(imageDimensions(png(574, 551)), [574, 551]);
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
  assert.deepEqual(imageDimensions(gif.toString('base64')), [320, 240]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageDimensions(jpeg.toString('base64')), [640, 480]);
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(799, 24, 3);
  webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(imageDimensions(webp.toString('base64')), [800, 600]);
  assert.equal(imageDimensions('not an image'), undefined);
});

test('a body\'s inline images: their bytes and visual tokens, the cap when unreadable', () => {
  const shot = png(574, 551, 295_000);
  const totals = bodyImages(body([shot, 'AAAA']), 'claude-opus-5-5');
  assert.equal(totals.imageBytes, shot.length + 4);
  assert.equal(totals.imageTokens, 420 + 4_784);
  assert.deepEqual(bodyImages(Buffer.from('{"messages":[]}'), undefined),
    { imageBytes: 0, imageTokens: 0 });
});

test('the reported estimate scales only text: a screenshot adds its visual tokens', () => {
  const before = body([], 'x'.repeat(400_000));
  const sample = { tokens: 100_000, forwardedBytes: before.length, imageBytes: 0, imageTokens: 0 };
  const after = body([png(574, 551, 295_000)], 'x'.repeat(400_000));
  const images = bodyImages(after, 'claude-opus-5-5');
  const estimate = estimateRequestTokens(sample, after.length, images);
  assert.equal(estimate.source, 'reported');
  assert.ok(estimate.tokens < 100_000 + 1_000, `${estimate.tokens}: not ~74k more for the image`);
  // Without the image totals its base64 reads as text (the 2026-10-23 refusal).
  assert.ok(estimateRequestTokens(sample, after.length).tokens > 160_000);
  // A sample that carries images is judged on its text.
  const withImage = { tokens: 100_420, forwardedBytes: after.length, ...images };
  assert.ok(plausibleSample(withImage));
  assert.ok(Math.abs(estimateRequestTokens(withImage, after.length, images).tokens - 100_420) <= 1);
  // A sample recorded without its images keeps them as text: an over-estimate.
  const legacy = { tokens: 100_420, forwardedBytes: after.length };
  assert.ok(estimateRequestTokens(legacy, after.length, images).tokens >= 100_420);
});

test('a compress budget grows by 1 ms per KiB of its upload', () => {
  const memtree = new MemtreeClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', compressTimeoutMs: 15_000 });
  assert.equal(COMPRESS_TIMEOUT_MS_PER_KIB, 1);
  assert.equal(memtree.compressBudgetForBytes(0), 15_000);
  assert.equal(memtree.compressBudgetForBytes(21.5 * 1024 * 1024), 15_000 + 22_016);
  assert.equal(memtree.lastCompressSuccessAt, 0);
});

test('a count that ran out of time is retried once with a fresh allowance', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (++calls === 1) return; // the first count never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1_234 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const session = createCountTokensSession({ upstream: { module: http, host: '127.0.0.1',
      port: server.address().port }, headers: {}, requestUrl: '/v1/messages', timeoutMs: 200 });
    const raw = body([]);
    assert.equal((await session.count(raw)).outcome, 'timeout');
    const retried = await session.retry(raw);
    assert.equal(retried.tokens, 1_234);
    assert.equal(session.peek(raw).tokens, 1_234, 'the retry is the body\'s count');
    assert.equal(session.retry(raw), undefined, 'once per request');
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a budget the caller set is not scaled: a preparation and its waiters end together', async () => {
  // Codex r12: a 21.5 MiB preparation scaled to ~142 s outlived the 120 s its
  // overflow turn waits, which then compressed beside it (billed twice).
  const server = http.createServer(req => { req.resume(); }); // never answers
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const memtree = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'k', compressTimeoutMs: 200 });
    const messages = [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }];
    const started = Date.now();
    assert.equal(await memtree.compress('h', messages, 1_000_000, undefined,
      { prepare: true, timeoutMs: 300 }), null);
    const explicit = Date.now() - started;
    assert.ok(explicit < 1_500, `an explicit 300 ms budget took ${explicit} ms`);
    const scaledStart = Date.now();
    assert.equal(await memtree.compress('h2', messages, 1_000_000), null);
    const scaled = Date.now() - scaledStart;
    assert.ok(scaled >= 200 + 3_000, `the default budget grew with the upload (${scaled} ms)`);
  } finally { server.closeAllConnections(); server.close(); }
});
