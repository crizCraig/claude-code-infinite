import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

async function harness(budget = 1000) {
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
  const proxy = await startProxy({ memtree, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, budgetTokensOverride: budget, defaultCompactTarget: null });
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

test("fallback budget reserves requested output tokens", async () => {
  const h = await harness();
  try {
    assert.equal((await request(h.proxy, body("small history", 1000))).status, 503);
    assert.equal(h.seen.length, 0);
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
