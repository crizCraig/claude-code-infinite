import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as counting from "../dist/count-tokens.js";
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

test("count body preserves supported context and output configuration", () => {
  const fields = {
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    output_format: { type: "json_schema", schema: { type: "object" } },
    cache_control: { type: "ephemeral" },
    mcp_servers: [{ type: "url", name: "example", url: "https://example.invalid" }],
    speed: "fast",
  };
  const original = { model: "m", messages: [], max_tokens: 1, ...fields };
  const body = Buffer.from(JSON.stringify(original));
  assert.deepEqual(JSON.parse(countTokensBody(body)), { model: "m", messages: [], ...fields });
  assert.deepEqual(JSON.parse(body), original);
});

test("request count session reuses successful and failed body attempts", async () => {
  const srv = await countServer((_req, res) => res.end('{"input_tokens":42}'));
  try {
    const attempts = [];
    const session = counting.createCountTokensSession({
      upstream: srv.upstream, headers: {}, requestUrl: "/v1/messages",
      onAttempt: (result) => attempts.push(result),
    });
    assert.equal(session.peek(messagesBody), undefined);
    const results = await Promise.all([session.count(messagesBody), session.count(Buffer.from(messagesBody))]);
    assert.equal(results[0].tokens, 42);
    assert.equal(results[0], results[1]);
    assert.equal(session.peek(messagesBody).tokens, 42);
    await session.count(Buffer.from('{"model":"m","messages":[{"role":"user","content":"changed"}]}'));
    assert.equal(srv.seen.length, 2);
    assert.equal(attempts.length, 2);
  } finally { srv.close(); }
});

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

for (const credentials of [{ "x-api-key": "fake-api-key" }, { authorization: "Bearer fake-oauth" }]) {
  test(`count preserves credentials, beta and version: ${Object.keys(credentials)[0]}`, async () => {
    const srv = await countServer((_req, res) => res.end('{"input_tokens":0}'));
    try {
      const headers = { ...credentials, "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,context-management-2025-06-27" };
      const original = Buffer.from(messagesBody);
      const result = await countUpstreamTokens({
        upstream: srv.upstream, headers, requestUrl: "/v1/messages?beta=true", body: messagesBody,
      });
      assert.equal(result.outcome, "success");
      assert.equal(result.tokens, 0);
      for (const [key, value] of Object.entries(headers)) assert.equal(srv.seen[0].headers[key], value);
      assert.deepEqual(messagesBody, original);
    } finally { srv.close(); }
  });
}

for (const response of ["invalid json", "{}", '{"input_tokens":-1}',
  '{"input_tokens":1.5}', '{"input_tokens":"42"}', "x".repeat(70_000)]) {
  test(`invalid count response falls back (${response.length} bytes)`, async () => {
    const srv = await countServer((_req, res) => res.end(response));
    try {
      const result = await countUpstreamTokens({
        upstream: srv.upstream, headers: {}, requestUrl: "/v1/messages", body: messagesBody,
      });
      assert.equal(result.tokens, undefined);
      assert.equal(result.outcome, "invalid-response");
    } finally { srv.close(); }
  });
}

test("synchronous transport throws and broken sockets resolve without tokens", async () => {
  const base = { headers: {}, requestUrl: "/v1/messages", body: messagesBody };
  const result = await countUpstreamTokens({ ...base, upstream: {
    module: { request() { throw new Error("fake socket setup failure"); } }, host: "localhost", port: 1,
  } });
  assert.equal(result.outcome, "network-error");
  const srv = await countServer((req) => req.socket.destroy());
  try {
    assert.equal((await countUpstreamTokens({ ...base, upstream: srv.upstream })).outcome, "network-error");
  } finally { srv.close(); }
});

test("request session reuses failure and shares one deadline across changed bodies", async () => {
  const srv = await countServer(() => {});
  try {
    const attempts = [];
    const session = counting.createCountTokensSession({ upstream: srv.upstream, headers: {},
      requestUrl: "/v1/messages", timeoutMs: 50, onAttempt: (r) => attempts.push(r) });
    const started = Date.now();
    const first = await session.count(messagesBody);
    assert.equal(first.outcome, "timeout");
    assert.equal(await session.count(Buffer.from(messagesBody)), first);
    const changed = Buffer.from('{"model":"m","messages":[{"role":"user","content":"changed"}]}');
    assert.equal((await session.count(changed)).outcome, "deadline");
    assert.equal(srv.seen.length, 1);
    assert.equal(attempts.length, 1);
    assert.ok(Date.now() - started < 250, "no second timeout");
  } finally { srv.close(); }
});

test("changed bodies consume only the remaining deadline", async () => {
  const srv = await countServer((_req, res) => {
    if (srv.seen.length === 1) setTimeout(() => res.end('{"input_tokens":42}'), 50);
  });
  try {
    const session = counting.createCountTokensSession({ upstream: srv.upstream, headers: {},
      requestUrl: "/v1/messages", timeoutMs: 100 });
    const started = Date.now();
    assert.equal((await session.count(messagesBody)).tokens, 42);
    const changed = Buffer.from('{"model":"other","messages":[]}');
    const result = await session.count(changed);
    assert.equal(result.outcome, "timeout");
    assert.ok(result.ms < 85, "second attempt gets less than a fresh timeout");
    assert.ok(Date.now() - started < 160);
    assert.equal(srv.seen.length, 2);
  } finally { srv.close(); }
});

for (const status of [401, 403, 429]) {
  test(`${status} cooldown honors Retry-After and isolates credentials and upstream`, async () => {
    const srv = await countServer((_req, res) => {
      res.writeHead(status, { "retry-after": "2" }); res.end("{}");
    });
    const other = await countServer((_req, res) => res.end('{"input_tokens":42}'));
    try {
      let now = 1_000_000;
      const cooldowns = new counting.CountTokensCooldowns(128, () => now);
      const attempts = [];
      const session = (upstream = srv.upstream, secret = "fake-a") => counting.createCountTokensSession({
        upstream, headers: { authorization: `Bearer ${secret}` }, requestUrl: "/v1/messages",
        onAttempt: (result) => attempts.push({ statusClass: result.outcome, ms: result.ms }),
      }, cooldowns);
      assert.equal((await session().count(messagesBody)).outcome, status === 429 ? "rate-limit" : "auth");
      assert.equal((await session().count(messagesBody)).outcome, "cooldown");
      assert.equal(attempts.length, 1);
      assert.equal((await session(srv.upstream, "fake-b").count(messagesBody)).status, status);
      assert.equal((await session(other.upstream).count(messagesBody)).tokens, 42);
      now += 1999;
      assert.equal((await session().count(messagesBody)).outcome, "cooldown");
      now += 1;
      assert.equal((await session().count(messagesBody)).status, status);
      assert.equal(srv.seen.length, 3);
      assert.equal(JSON.stringify(attempts).includes("fake"), false);
      assert.equal(JSON.stringify(attempts).includes("tokens"), false);
    } finally { srv.close(); other.close(); }
  });
}

test("cooldown storage and Retry-After durations are bounded", () => {
  let now = 0;
  const cooldowns = new counting.CountTokensCooldowns(2, () => now);
  for (const key of ["a", "b", "c"]) cooldowns.record(key, {
    status: 429, outcome: "rate-limit", ms: 0, retryAfter: "9999999",
  });
  assert.equal(cooldowns.active("a"), false);
  assert.equal(cooldowns.active("b"), true);
  assert.equal(cooldowns.active("c"), true);
  now = 60_000;
  assert.equal(cooldowns.active("c"), false);
  cooldowns.record("d", { status: 403, outcome: "auth", ms: 0,
    retryAfter: new Date(now + 2000).toUTCString() });
  now += 2000;
  assert.equal(cooldowns.active("d"), false);
});

test("abort and diagnostic callback failure cannot reject or duplicate an attempt", async () => {
  const srv = await countServer((_req, res) => res.end('{"input_tokens":42}'));
  try {
    const controller = new AbortController();
    controller.abort();
    const options = { upstream: srv.upstream, headers: {}, requestUrl: "/v1/messages" };
    assert.equal((await counting.createCountTokensSession({ ...options, signal: controller.signal })
      .count(messagesBody)).outcome, "aborted");
    const session = counting.createCountTokensSession({ ...options,
      onAttempt() { throw new Error("diagnostics failure"); } });
    assert.equal((await session.count(messagesBody)).tokens, 42);
    assert.equal(srv.seen.length, 1);
  } finally { srv.close(); }
});

test("failed HTTP count is cached within its request, without a second upload", async () => {
  const srv = await countServer((_req, res) => { res.writeHead(500); res.end("{}"); });
  try {
    const attempts = [];
    const session = counting.createCountTokensSession({ upstream: srv.upstream, headers: {},
      requestUrl: "/v1/messages", onAttempt: (result) => attempts.push(result) });
    const first = await session.count(messagesBody);
    assert.equal(first.outcome, "server-error");
    assert.equal(first.tokens, undefined);
    assert.equal(await session.count(Buffer.from(messagesBody)), first);
    assert.equal(session.peek(messagesBody), first);
    assert.equal(srv.seen.length, 1);
    assert.equal(attempts.length, 1);
  } finally { srv.close(); }
});

test("aborting an in-flight count releases its wait promptly", async () => {
  const controller = new AbortController();
  const srv = await countServer(() => controller.abort());
  try {
    const result = await countUpstreamTokens({ upstream: srv.upstream, headers: {},
      requestUrl: "/v1/messages", body: messagesBody, signal: controller.signal });
    assert.equal(result.outcome, "aborted");
    assert.equal(result.tokens, undefined);
    assert.ok(result.ms < 500);
  } finally { srv.close(); }
});
