import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  countTokensBody,
  countTokensPath,
  countUpstreamTokens,
  plausibleSample,
  shouldCountTokens,
} from "../dist/count-tokens.js";

test("plausibleSample: tokens per byte must be within 0.02-1", () => {
  assert.equal(plausibleSample({ tokens: 30_000, forwardedBytes: 100_000 }), true);
  assert.equal(plausibleSample({ tokens: 5_000, forwardedBytes: 100_000 }), true, "image-heavy");
  assert.equal(plausibleSample({ tokens: 100_000, forwardedBytes: 100_000 }), true);
  // 2026-10-05: a 979-byte web-search helper reported 12,040 tokens.
  assert.equal(plausibleSample({ tokens: 12_040, forwardedBytes: 979 }), false);
  assert.equal(plausibleSample({ tokens: 1_999, forwardedBytes: 100_000 }), false);
  assert.equal(plausibleSample({ tokens: 0, forwardedBytes: 100 }), false);
  assert.equal(plausibleSample(undefined), false);
});

test("shouldCountTokens: unknown sizes near a real share of the budget, else only jumps near it", () => {
  const budget = 800_000;
  assert.equal(shouldCountTokens(undefined, 4_000, 1_000, budget), false, "small and unknown");
  assert.equal(shouldCountTokens(undefined, 1_400_000, 350_000, budget), true, "unknown, 44% of budget");
  const skewed = { tokens: 12_040, forwardedBytes: 979 };
  assert.equal(shouldCountTokens(skewed, 1_400_000, 350_000, budget), true, "implausible = unknown");
  const sample = { tokens: 700_000, forwardedBytes: 2_100_000 };
  assert.equal(shouldCountTokens(sample, 2_110_000, 703_000, budget), false, "small growth near budget");
  assert.equal(shouldCountTokens(sample, 2_800_000, 875_000, budget), true, "175k jump near budget");
  const low = { tokens: 100_000, forwardedBytes: 300_000 };
  assert.equal(shouldCountTokens(low, 600_000, 200_000, budget), false, "jump far under budget");
  assert.equal(shouldCountTokens(undefined, 1_400_000, 350_000, 0), false, "no budget");
});

test("countTokensPath and countTokensBody", () => {
  assert.equal(countTokensPath("/v1/messages?beta=true"), "/v1/messages/count_tokens?beta=true");
  assert.equal(countTokensPath(undefined), "/v1/messages/count_tokens");
  const body = Buffer.from(JSON.stringify({
    model: "m", max_tokens: 5, stream: true, metadata: {}, system: "s",
    messages: [{ role: "user", content: "hi" }], tools: [], thinking: { type: "enabled" },
  }));
  assert.deepEqual(JSON.parse(countTokensBody(body).toString()), {
    model: "m", messages: [{ role: "user", content: "hi" }], system: "s", tools: [],
    thinking: { type: "enabled" },
  });
  assert.equal(countTokensBody(Buffer.from("not json")), null);
  assert.equal(countTokensBody(Buffer.from("{}")), null);
});

async function countServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream = { module: http, host: "127.0.0.1", port: server.address().port };
  return { upstream, seen, close: () => server.close() };
}

const messagesBody = Buffer.from(JSON.stringify({ model: "m", max_tokens: 1, messages: [] }));

test("countUpstreamTokens: sends the caller's credentials, reads input_tokens", async () => {
  const srv = await countServer((_req, res) => res.end(JSON.stringify({ input_tokens: 42 })));
  try {
    const result = await countUpstreamTokens({
      upstream: srv.upstream,
      headers: { authorization: "Bearer t", "anthropic-version": "2023-06-01", "content-length": "9" },
      requestUrl: "/v1/messages?beta=true",
      body: messagesBody,
    });
    assert.equal(result.tokens, 42);
    assert.equal(result.status, 200);
    assert.equal(srv.seen[0].url, "/v1/messages/count_tokens?beta=true");
    assert.equal(srv.seen[0].headers.authorization, "Bearer t");
    assert.equal(srv.seen[0].headers["content-length"], String(Buffer.byteLength(srv.seen[0].body)));
  } finally {
    srv.close();
  }
});

test("countUpstreamTokens: errors, bad bodies and timeouts resolve without tokens", async () => {
  const failing = await countServer((_req, res) => { res.statusCode = 500; res.end("{}"); });
  const hanging = await countServer(() => {});
  try {
    const base = { headers: {}, requestUrl: "/v1/messages", body: messagesBody };
    assert.equal((await countUpstreamTokens({ ...base, upstream: failing.upstream })).tokens, undefined);
    const slow = await countUpstreamTokens({ ...base, upstream: hanging.upstream, timeoutMs: 50 });
    assert.equal(slow.tokens, undefined);
    assert.equal((await countUpstreamTokens({
      ...base, upstream: failing.upstream, body: Buffer.from("x"),
    })).tokens, undefined);
  } finally {
    failing.close();
    hanging.close();
  }
});
