// Image-heavy agent lanes (2026-11-12, ai-safety-sim session cf649598): a video agent
// sent 15-27 MB requests that were almost all base64 JPEG contact sheets (~470 KB,
// ~2000x1354 each). Anthropic counted the lane at 491k tokens, but the conservative
// bound read every non-image byte at 1.9 bytes per token, so it sat over the 1M window:
// every turn was counted (a second 22 MB upload), and when a count timed out the lane
// was compressed half full. These tests use real-sized payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { bodyImages, imageDimensions, visualTokens } from '../dist/image-tokens.js';
import { RequestSizing, anchoredBound, ANCHOR_MARGIN } from '../dist/request-sizing.js';
import { shouldCountTokens } from '../dist/count-tokens.js';
import { conservativeBodyTokens } from '../dist/token-estimate.js';

const MODEL = 'claude-opus-5-5';
const SHEET_BASE64_CHARS = 470_000;

/** A baseline JPEG of `width` x `height`: APP0, then `iccBytes` of APP2 ICC segments
 * (up to 64 KB each, so the frame header can sit past the first 48 KB), DQT, SOF0,
 * then random scan data up to `chars` base64 characters. */
function jpeg(width, height, { chars = SHEET_BASE64_CHARS, iccBytes = 0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')));
  for (let left = iccBytes; left > 0; left -= 65_000) {
    parts.push(segment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'),
      randomBytes(Math.min(left, 65_000))])));
  }
  parts.push(segment(0xdb, Buffer.alloc(65, 1)));
  const sof = Buffer.from([0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  parts.push(segment(0xc0, sof));
  const head = Buffer.concat(parts);
  const scan = randomBytes(Math.max(0, Math.ceil(chars * 3 / 4) - head.length));
  return Buffer.concat([head, scan]).toString('base64').slice(0, chars);
}

function segment(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** A Claude Code-shaped agent body: `images` contact sheets in tool results, assistant
 * turns carrying thinking signatures (base64 that is not an image), and plain text. */
function agentBody({ images = 46, textChars = 800_000, signatureChars = 800_000, sheet } = {}) {
  const data = sheet ?? jpeg(1999, 1354);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(textChars) }] }];
  const perTurn = Math.ceil(signatureChars / Math.max(1, images));
  for (let i = 0; i < images; i++) {
    messages.push({ role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: randomBytes(perTurn * 3 / 4).toString('base64') },
      { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/tmp/sheet${i}.jpg` } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] }] });
  }
  return Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 128_000, messages }));
}

function fakeCounts() {
  const calls = [];
  return { calls, peek: () => undefined, async count(body) {
    calls.push(body.length);
    return { outcome: 'timeout', ms: 25_000 };
  } };
}

const WINDOW = { budget: 960_000, context: 1_000_000, output: 16_000, recountOutput: 128_000 };

test('a real-sized contact sheet is sized by its dimensions, even past large ICC segments', () => {
  const sheet = jpeg(1999, 1354);
  assert.ok(sheet.length >= 469_000, 'a ~470 KB base64 image');
  assert.deepEqual(imageDimensions(sheet), [1999, 1354]);
  // 200 KB of ICC profile puts the frame header well past the decoded header window.
  const late = jpeg(1940, 1320, { iccBytes: 200_000 });
  assert.deepEqual(imageDimensions(late), [1940, 1320]);
  const body = agentBody({ images: 3, sheet: late, textChars: 10, signatureChars: 0 });
  assert.equal(bodyImages(body, MODEL).imageTokens, 3 * visualTokens(1940, 1320));
  assert.ok(visualTokens(1999, 1354) < 4_000, `${visualTokens(1999, 1354)} tokens, not ~117k`);
});

test('a JPEG walk that meets non-base64 characters stops rather than read shifted bytes', () => {
  const late = jpeg(1940, 1320, { iccBytes: 200_000 });
  const broken = late.slice(0, 70_000) + '\n' + late.slice(70_000);
  assert.equal(imageDimensions(broken), undefined, 'unreadable: the tier cap applies');
});

test('the 2026-11-12 lane: anchored on its last count the bound fits, so no re-upload', async () => {
  const body = agentBody();
  assert.ok(body.length > 20_000_000, `${body.length} bytes`);
  const images = bodyImages(body, MODEL);
  assert.equal(images.imageTokens, 46 * visualTokens(1999, 1354));
  // The plain bound: over the window with max_tokens, though the lane is about half full.
  assert.ok(conservativeBodyTokens(body, MODEL) + 128_000 > 1_000_000,
    `${conservativeBodyTokens(body, MODEL)}: the plain bound is over the window`);
  // The previous turn of the lane, 1 image and some text smaller, counted by Anthropic.
  const previous = agentBody({ images: 45, textChars: 790_000, signatureChars: 790_000 });
  const prevImages = bodyImages(previous, MODEL);
  const sample = { tokens: 480_000, forwardedBytes: previous.length, ...prevImages };
  const counts = fakeCounts();
  const sizing = new RequestSizing(counts, true, MODEL);
  const candidate = sizing.register(body, 'original', sample);
  assert.ok(candidate.conservativeTokens + 128_000 <= 1_000_000,
    `${candidate.conservativeTokens}: the anchored bound fits`);
  assert.equal(sizing.boundFits(candidate, WINDOW), true);
  await sizing.countIfOverBound(candidate, WINDOW);
  const measured = await sizing.measure(candidate, WINDOW);
  assert.equal(counts.calls.length, 0, 'no Count Tokens upload of the 22 MB body');
  assert.ok(measured.tokens < WINDOW.budget, `${measured.tokens}: under the budget, not compressed`);
});

test('near the window the anchored bound no longer fits and the body is counted', async () => {
  const body = agentBody();
  const previous = agentBody({ images: 45, textChars: 790_000, signatureChars: 790_000 });
  const sample = { tokens: 820_000, forwardedBytes: previous.length, ...bodyImages(previous, MODEL) };
  const counts = fakeCounts();
  const sizing = new RequestSizing(counts, true, MODEL);
  const candidate = sizing.register(body, 'original', sample);
  assert.equal(sizing.boundFits(candidate, WINDOW), false);
  await sizing.countIfOverBound(candidate, WINDOW);
  assert.equal(counts.calls.length, 1, 'counted once when it may not fit');
});

test('the anchor applies only to a grown body its sample mostly measured', () => {
  const images = { imageBytes: 1_000_000, imageTokens: 3_000 };
  const sample = { tokens: 103_000, forwardedBytes: 1_400_000, imageBytes: 1_000_000,
    imageTokens: 3_000 };
  // 400 KB of text measured at 100k; 100 KB more is bounded at 1.9 bytes per token.
  assert.equal(anchoredBound(sample, 1_500_000, images, MODEL),
    Math.ceil(100_000 * (1 + ANCHOR_MARGIN)) + Math.ceil(100_000 / 1.9) + 3_000);
  assert.equal(anchoredBound(sample, 1_300_000, images, MODEL), undefined, 'text shrank');
  assert.equal(anchoredBound(sample, 1_000_000 + 600_000, images, MODEL), undefined,
    'the sample measured under 75% of the text');
  assert.equal(anchoredBound({ tokens: 103_000, forwardedBytes: 1_400_000 }, 1_500_000, images,
    MODEL), undefined, 'a sample without its images cannot anchor');
  assert.equal(anchoredBound(undefined, 1_500_000, images, MODEL), undefined);
});

test('adding a contact sheet is not a jump of new content: its tokens are visual', () => {
  const sample = { tokens: 850_000, forwardedBytes: 21_000_000, imageBytes: 20_000_000,
    imageTokens: 150_000 };
  const images = { imageBytes: 20_470_000, imageTokens: 153_500 };
  assert.equal(shouldCountTokens(sample, 21_475_000, 880_000, 960_000, images), false);
  // Without image totals the 470 KB of base64 reads as ~117k new tokens: a jump.
  assert.equal(shouldCountTokens(sample, 21_475_000, 880_000, 960_000), true);
  // A real jump of text is still counted near the budget.
  assert.equal(shouldCountTokens(sample, 21_475_000 + 400_000, 880_000, 960_000,
    { imageBytes: 20_470_000, imageTokens: 153_500 }), true);
});
