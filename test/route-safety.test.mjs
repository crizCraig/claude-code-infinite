import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

async function harness(budget = 1000, extraOptions = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "offline" });
  memtree.compress = async () => null;
  memtree.indexInBackground = () => {};
  const proxy = await startProxy({ memtree, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, budgetTokensOverride: budget, defaultCompactTarget: null, ...extraOptions });
  return { proxy, memtree, seen, close() { proxy.close(); upstream.close(); } };
}

function request(proxy, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-claude-code-session-id": "safe-session" } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(raw);
  });
}
const body = (text, max_tokens = 100) => JSON.stringify({ model: "claude-x", max_tokens, messages: [{ role: "user", content: text }, { role: "assistant", content: "prior answer" }, { role: "user", content: "next" }] }, null, 2);

test("failed rebuilding forwards an under-budget original byte-for-byte", async () => {
  const h = await harness();
  try {
    const raw = body("small history");
    assert.equal((await request(h.proxy, raw)).status, 200);
    assert.deepEqual(h.seen, [raw]);
  } finally { h.close(); }
});

test("failed oversized rebuilding retries twice then terminates, never forwarding history", async () => {
  const h = await harness();
  try {
    const raw = body("x".repeat(8000));
    for (const expected of [503, 503, 400, 400]) {
      const response = await request(h.proxy, raw);
      assert.equal(response.status, expected);
      assert.equal(response.headers["x-should-retry"], expected === 503 ? "true" : "false");
      if (expected === 503) assert.equal(response.headers["retry-after"], "1");
    }
    assert.equal(h.seen.length, 0);
    assert.equal((await request(h.proxy, body("new short conversation"))).status, 200);
    assert.equal((await request(h.proxy, raw)).status, 503, "successful delivery resets the failure episode");
  } finally { h.close(); }
});

test("fallback compares input with the budget and reserves output against the window", async () => {
  const h = await harness();
  try {
    // Under the budget by input (as the server judges it, so it will not compress),
    // and it fits the window with its output: it goes out unchanged. 2026-10-03:
    // refusing this for the output reservation failed every session past ~672k.
    assert.equal((await request(h.proxy, body("small history", 1000))).status, 200);
    assert.equal(h.seen.length, 1);
    // An over-budget input that could not be compressed is still refused.
    assert.equal((await request(h.proxy, body("x".repeat(8000), 100))).status, 503);
    assert.equal(h.seen.length, 1);
  } finally { h.close(); }
});

test("a transport that ignores cancellation cannot hold rebuilding open indefinitely", async () => {
  const h = await harness();
  try {
    Object.defineProperty(h.memtree, "compressBudgetMs", { get: () => 20 });
    h.memtree.compress = () => new Promise(() => {});
    const started = performance.now();
    assert.equal((await request(h.proxy, body("x".repeat(8000)))).status, 503);
    assert.ok(performance.now() - started < 1000);
  } finally { h.close(); }
});

for (const lane of ["human", "tool"]) {
  test(`compression exceptions keep a validated prefix on the ${lane} path`, async () => {
    let broken = false;
    const h = await harness(20_000, { defaultCompactTarget: undefined,
      transcriptUsage: { usageFor() { if (broken) throw Error("usage unavailable"); return {}; } } });
    const summary = "saved memory ".repeat(250);
    h.memtree.compress = async () => ({
      messages: [{ role: "user", content: summary }],
      flattened_messages: [{ role: "user", content: summary }],
      usage: { prompt_tokens_details: { cached_tokens: 1 } },
    });
    const send = messages => request(h.proxy, JSON.stringify({ model: "claude-x", max_tokens: 100, messages }));
    try {
      const messages = [{ role: "user", content: "q" }, { role: "assistant", content: "a" },
        { role: "user", content: "x".repeat(160_000) }];
      assert.equal((await send(messages)).status, 200);
      const storedPrefix = JSON.parse(h.seen[0]).messages[0];
      broken = true;
      if (lane === "human") {
        await fetch(h.proxy.hookUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "safe-session", prompt: "/memtree-compact" }) });
        messages.push({ role: "assistant", content: "a" }, { role: "user", content: "next" });
      } else {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "z".repeat(80_000) }] });
      }
      assert.equal((await send(messages)).status, 200, "the validated fallback survives a pipeline exception");
      assert.equal(h.seen.length, 2);
      assert.deepEqual(JSON.parse(h.seen[1]).messages[0], storedPrefix, "cached prefix bytes remain unchanged");
      assert.ok(!h.seen[1].includes("x".repeat(1000)), "raw history never replaces the prefix");
    } finally { h.close(); }
  });
}
