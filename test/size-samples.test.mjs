// Main-thread size samples are per session AND model (2026-10-13): Claude
// Code's WebSearch side request (Haiku, main lane, first-user) reported 9,508
// input tokens for an 885-byte body because search results are injected
// server-side. Keyed by session alone, that sample replaced the Opus one and
// a 2.15 MB Opus turn was estimated at 23M tokens and refused. A request that
// carries server tools, or whose usage shows server tool use, records nothing.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

const OPUS = "claude-opus-x";
const HAIKU = "claude-haiku-x";
const ONE_M = { "anthropic-beta": "context-1m-2025-08-07" };
const WEB_SEARCH = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];

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

/** `usage(body, bytes)` answers each forward's input tokens (and extras). */
async function harness(usage) {
  const h = { forwards: 0, records: [] };
  const upstream = await listen((req, res, raw) => {
    const body = JSON.parse(raw.toString("utf-8"));
    h.forwards++;
    const { tokens, extra = {} } = usage(body, raw.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: tokens, output_tokens: 1, ...extra } }));
  });
  const memory = await listen((req, res, raw) => {
    const body = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: body.messages ?? [], compressed: false,
      index_only: body.index_only, usage: { prompt_tokens: 1 } }));
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memory.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => h.records.push(structuredClone(r)) },
  });
  h.post = async (model, messages, { headers = {}, tools } = {}) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "s",
        ...headers },
      body: JSON.stringify({ model, max_tokens: 64, messages, ...(tools ? { tools } : {}) }),
    });
    await response.text();
    return response.status;
  };
  h.lastRecord = () => h.records.filter((r) => r.kind === "messages").at(-1);
  h.close = () => { proxy.close(); upstream.close(); memory.close(); };
  return h;
}

const firstUser = (bytes) => [{ role: "user", content: "q " + "s".repeat(bytes) }];
const opusToolTurn = () => [{ role: "user", content: "task" },
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t",
    content: "x".repeat(2_150_000) }] }];

/** The 2.15 MB Opus tool turn goes out with no budget compaction. */
async function assertOpusTurnForwarded(h) {
  const before = h.forwards;
  assert.equal(await h.post(OPUS, opusToolTurn(), { headers: ONE_M }), 200);
  const rec = h.lastRecord();
  assert.equal(rec.compaction?.reason, undefined, "no reason=budget");
  assert.ok(rec.compaction.estimatedTokens < 800_000,
    `estimated ${rec.compaction.estimatedTokens} tokens`);
  assert.equal(h.forwards, before + 1, "forwarded");
}

test("a Haiku side request's size sample does not size the Opus turn", async () => {
  const h = await harness((body, bytes) =>
    ({ tokens: body.model === HAIKU ? 9_508 : Math.floor(bytes / 4) }));
  try {
    assert.equal(await h.post(HAIKU, firstUser(800)), 200);
    assert.equal(await h.post(HAIKU, firstUser(10_000)), 200);
    await assertOpusTurnForwarded(h);
  } finally { h.close(); }
});

test("a request carrying server tools records no size sample", async () => {
  const h = await harness((body, bytes) =>
    ({ tokens: body.tools ? 9_508 : Math.floor(bytes / 4) }));
  try {
    assert.equal(await h.post(OPUS, firstUser(10_000), { headers: ONE_M, tools: WEB_SEARCH }),
      200);
    await assertOpusTurnForwarded(h);
  } finally { h.close(); }
});

test("a response showing server tool use records no size sample", async () => {
  const h = await harness((body, bytes) => body.messages.length === 1
    ? { tokens: 9_508, extra: { server_tool_use: { web_search_requests: 1 } } }
    : { tokens: Math.floor(bytes / 4) });
  try {
    assert.equal(await h.post(OPUS, firstUser(10_000), { headers: ONE_M }), 200);
    await assertOpusTurnForwarded(h);
  } finally { h.close(); }
});

test("control: an Opus sample still drives Opus estimates", async () => {
  // 0.5 tokens per byte: denser than bytes/4, so the 2.15 MB turn reaches the
  // 800k budget only through the sample.
  const h = await harness((body, bytes) => ({ tokens: Math.floor(bytes / 2) }));
  try {
    assert.equal(await h.post(HAIKU, firstUser(10_000)), 200);
    assert.equal(await h.post(OPUS, firstUser(100_000), { headers: ONE_M }), 200);
    await h.post(OPUS, opusToolTurn(), { headers: ONE_M });
    const rec = h.lastRecord();
    assert.equal(rec.compaction.sizeSource, "reported");
    assert.ok(Math.abs(rec.compaction.estimatedTokens - 1_075_000) < 2_000,
      `estimated ${rec.compaction.estimatedTokens} tokens`);
    assert.equal(rec.compaction.reason, "budget");
  } finally { h.close(); }
});
