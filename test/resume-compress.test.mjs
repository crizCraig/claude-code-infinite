// First turn after `--resume` (2026-10-13): ccc holds no compressed prefix, the
// whole history is far over the window, and the server's compress takes longer
// than the normal 15 s budget. With nothing else that could be sent, the
// compress gets a long budget, and Claude Code's retries join the compress
// already running instead of each starting (and billing) a new one. Whenever a
// fallback exists (an old prefix to ride, or a raw request that fits), the
// short budget still applies.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

const SHORT_MS = 100;
const LONG_MS = 3_000;
const SLOW_MS = 500;
const BIG = (tag, chars) => `${tag} ` + "x".repeat(chars);
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

async function listen(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

/** Anthropic stand-in: Count Tokens and usage report `h.tokensPerByte` (bytes/4). */
function upstreamHandler(h) {
  return (req, res, raw) => {
    const tokens = Math.floor(raw.length * h.tokensPerByte);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/count_tokens")) return res.end(JSON.stringify({ input_tokens: tokens }));
    h.forwarded.push(JSON.parse(raw.toString("utf-8")));
    res.end(JSON.stringify({ type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 3, cache_read_input_tokens: tokens - 3, output_tokens: 1 } }));
  };
}

/** MemTree stand-in: compresses anything over its target after `h.delayMs`. */
function memtreeHandler(h) {
  return async (req, res, raw) => {
    res.writeHead(200, { "content-type": "application/json" });
    const body = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
    if (req.method === "GET" || body.index_only) {
      return res.end(JSON.stringify({ messages: [], index_only: true }));
    }
    h.compressCalls++;
    await new Promise((resolve) => setTimeout(resolve, h.delayMs));
    const size = Math.round(JSON.stringify(body.messages).length / 4);
    const threshold = body.compression_threshold_tokens ?? body.compression_target_tokens;
    if (threshold === undefined || (size <= threshold && !(body.client_input_tokens > threshold))) {
      return res.end(JSON.stringify({ messages: body.messages, compressed: false,
        usage: { prompt_tokens: size, prompt_tokens_details: { cached_tokens: 1 } } }));
    }
    const memory = [{ role: "user", content: `memory ${h.compressCalls} ` + "m".repeat(3_000) }];
    res.end(JSON.stringify({ messages: memory, flattened_messages: memory, compressed: true,
      usage: { prompt_tokens: size, completion_tokens: 900,
        prompt_tokens_details: { cached_tokens: size } } }));
  };
}

async function harness({ countTokens = true, tokensPerByte = 0.25 } = {}) {
  const h = { forwarded: [], records: [], compressCalls: 0, delayMs: SLOW_MS, tokensPerByte };
  const upstream = await listen(upstreamHandler(h));
  const memory = await listen(memtreeHandler(h));
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: "k",
    compressTimeoutMs: SHORT_MS, longCompressTimeoutMs: LONG_MS });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin,
    budgetTokensOverride: 20_000, countTokens,
    reqlog: { log: (r) => h.records.push(structuredClone(r)) } });
  h.post = async (messages) => {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "s-resume" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }),
    });
    await response.text();
    return { status: response.status, ms: Date.now() - started };
  };
  h.lastRecord = () => h.records.filter((r) => r.kind === "messages").at(-1);
  h.close = () => { proxy.close(); upstream.close(); memory.close(); };
  return h;
}

// claude-x has a 200k window; ~1 MB of history counts ~250k tokens.
const resumed = () => [user("q1"), assistant("a1"), user(BIG("q2", 1_000_000))];

test("resume: no prefix and a raw request over the window gets the long compress budget",
  async () => {
    const h = await harness();
    try {
      const first = await h.post(resumed());
      assert.equal(first.status, 200, "forwarded compressed, not refused");
      assert.equal(h.compressCalls, 1);
      assert.equal(h.forwarded.length, 1);
      assert.match(JSON.stringify(h.forwarded[0].messages), /memory 1 m/);
      assert.equal(h.lastRecord().turnType, "followup-compressed");
    } finally { h.close(); }
  });

test("resume: a retry sent while the long compress runs joins it", async () => {
  const h = await harness();
  try {
    const first = h.post(resumed());
    await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 2));
    const retry = h.post(resumed());
    const [a, b] = await Promise.all([first, retry]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(h.compressCalls, 1, "one compress for the request and its retry");
  } finally { h.close(); }
});

test("control: a raw request that fits the window keeps the short budget and passes through",
  async () => {
    const h = await harness();
    try {
      // ~75k tokens: over the 20k budget, inside the 200k window.
      const result = await h.post([user("q1"), assistant("a1"), user(BIG("q2", 300_000))]);
      assert.equal(result.status, 200);
      assert.ok(result.ms < SLOW_MS, `short budget (took ${result.ms} ms)`);
      const rec = h.lastRecord();
      assert.equal(rec.turnType, "followup-degraded");
      assert.equal(rec.compress.timedOut, true);
      assert.doesNotMatch(JSON.stringify(h.forwarded[0].messages), /memory \d m/);
    } finally { h.close(); }
  });

test("control: with an old prefix, a compress timeout still rides it", async () => {
  const h = await harness();
  try {
    h.delayMs = 0;
    const conv = [user("q1"), assistant("a1"), user("q2")];
    assert.equal((await h.post(conv)).status, 200);
    conv.push(assistant("a2"), user(BIG("q3", 100_000)));
    assert.equal((await h.post(conv)).status, 200);
    assert.equal(h.lastRecord().turnType, "followup-compressed");
    const prefix = JSON.stringify(h.forwarded.at(-1).messages[0]);

    h.delayMs = SLOW_MS;
    conv.push(assistant("a3"), user(BIG("q4", 100_000)));
    const result = await h.post(conv);
    assert.equal(result.status, 200);
    assert.ok(result.ms < SLOW_MS, `short budget (took ${result.ms} ms)`);
    const rec = h.lastRecord();
    assert.equal(rec.turnType, "followup-prefix");
    assert.equal(rec.compaction.keptPrefix, true);
    assert.equal(rec.compress.timedOut, true);
    assert.equal(JSON.stringify(h.forwarded.at(-1).messages[0]), prefix);
  } finally { h.close(); }
});

test("MemtreeClient: an in-flight compress is shared by a retry that forces no more than it",
  async () => {
    const h = { compressCalls: 0, delayMs: 200 };
    const memory = await listen(memtreeHandler(h));
    const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: "k",
      compressTimeoutMs: 2_000 });
    try {
      const messages = resumed();
      const hash = MemtreeClient.hashMessages(messages);
      const meta = { model: "claude-x", sessionId: "s", compressionTargetTokens: 10_000,
        compressionThresholdTokens: 20_000 };
      const counted = { ...meta, clientInputTokens: 250_000 };
      const first = memtree.compress(hash, messages, 200_000, undefined, counted);
      // A retry whose count failed (no hint) or came out lower joins.
      const retry = memtree.compress(hash, messages, 200_000, undefined, meta);
      const lower = memtree.compress(hash, messages, 200_000, undefined,
        { ...meta, clientInputTokens: 240_000 });
      const [a, b, c] = await Promise.all([first, retry, lower]);
      assert.ok(a && b && c);
      assert.equal(h.compressCalls, 1);
      // A newly counted hint never joins an unhinted call (2026-10-05 invariant).
      const other = [...messages, assistant("a2"), user("q3")];
      const otherHash = MemtreeClient.hashMessages(other);
      const unhinted = memtree.compress(otherHash, other, 200_000, undefined, meta);
      const hinted = memtree.compress(otherHash, other, 200_000, undefined, counted);
      await Promise.all([unhinted, hinted]);
      assert.equal(h.compressCalls, 3);
      // Another session never joins.
      const third = [...other, assistant("a3"), user("q4")];
      const thirdHash = MemtreeClient.hashMessages(third);
      await Promise.all([
        memtree.compress(thirdHash, third, 200_000, undefined, meta),
        memtree.compress(thirdHash, third, 200_000, undefined, { ...meta, sessionId: "t" }),
      ]);
      assert.equal(h.compressCalls, 5);
    } finally { memory.close(); }
  });

test("a calibrated overflow keeps the short budget when delivery could still send it by bytes",
  async () => {
    // Counting off and a 0.5 tokens/byte sample: 600 KB is ~300k calibrated
    // tokens, over the 200k window, but delivery would still send it whole on
    // its bytes/4 estimate (150k), so a timeout is not a refusal.
    const h = await harness({ countTokens: false, tokensPerByte: 0.5 });
    try {
      assert.equal((await h.post([user("q " + "s".repeat(100_000))])).status, 200);
      const result = await h.post([user("q1"), assistant("a1"), user(BIG("q2", 600_000))]);
      assert.equal(result.status, 200);
      assert.ok(result.ms < SLOW_MS, `short budget (took ${result.ms} ms)`);
      const rec = h.lastRecord();
      assert.equal(rec.turnType, "followup-degraded");
      assert.equal(rec.compress.timedOut, true);
    } finally { h.close(); }
  });

test("MemtreeClient: a compress with different tools never joins one in flight", async () => {
  const h = { compressCalls: 0, delayMs: 200 };
  const memory = await listen(memtreeHandler(h));
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: "k",
    compressTimeoutMs: 2_000 });
  try {
    const messages = resumed();
    const hash = MemtreeClient.hashMessages(messages);
    const meta = { model: "claude-x", sessionId: "s", compressionTargetTokens: 10_000,
      compressionThresholdTokens: 20_000, clientInputTokens: 250_000 };
    const tools = [{ name: "Read", input_schema: { type: "object" } }];
    await Promise.all([
      memtree.compress(hash, messages, 200_000, undefined, { ...meta, tools }),
      memtree.compress(hash, messages, 200_000, undefined, meta),
    ]);
    assert.equal(h.compressCalls, 2);
  } finally { memory.close(); }
});
