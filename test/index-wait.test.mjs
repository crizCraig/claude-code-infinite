// Index waits through the real MemtreeClient and HTTP (2026-10-12 incident):
// a compress result that does not fit because MemTree's index trails the
// conversation must make retries wait for the index, re-asking the server at a
// bounded pace, instead of spending the three-strike refusal budget.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

const PAGE = "https://memtree.example/usage/memtree/page-1";
const big = "x".repeat(900_000);
const humanMessages = [{ role: "user", content: big }, { role: "assistant", content: "prior" },
  { role: "user", content: "next" }];
const toolMessages = [{ role: "user", content: big },
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }];

/** Server answers: "stale" (compressed, unfit, index pending), "legacy" (the
 * same without index_pending), "cold" (no-op, nothing indexed), "ready". */
function answer(state) {
  const fit = state === "ready";
  const content = fit ? "saved memory ".repeat(200) : "y".repeat(900_000);
  const messages = [{ role: "user", content }];
  if (state === "cold") {
    return { compressed: false, messages: humanMessages, usage: { indexed_tokens: 0 } };
  }
  return { compressed: true, messages, flattened_messages: messages,
    ...(state === "stale" ? { index_pending: true } : {}),
    // Billing counters only: they cannot prove the index is complete.
    usage: { indexed_tokens: fit ? 220_000 : 25_000, raw_prompt_tokens: 230_000 } };
}

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => handler(req, res, raw ? JSON.parse(raw) : {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

async function harness(state, options = {}) {
  const h = { state, compressCalls: 0, delivered: 0 };
  const upstream = await serve((req, res) => {
    h.delivered++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const memory = await serve((req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 202; return res.end("{}"); }
    if (body.index_only) return res.end(JSON.stringify({ messages: [], index_only: true }));
    h.compressCalls++;
    res.setHeader("x-polychat-memtree-url", PAGE);
    res.end(JSON.stringify(answer(h.state)));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  h.proxy = await startProxy({ memtree, upstreamOrigin: upstream.url,
    budgetTokensOverride: 20_000, indexWaitRefreshMs: 0, ...options });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

async function post(h, messages) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "s" },
    body: JSON.stringify({ model: "claude-x", max_tokens: 100, messages }),
  });
  const text = await response.text();
  return { status: response.status, retryAfter: response.headers.get("retry-after"), text };
}

for (const [lane, messages] of [["human", humanMessages], ["tool", toolMessages]]) {
  for (const state of ["stale", "cold"]) {
    test(`${lane}/${state}: retries re-ask MemTree and deliver once the index is ready`,
      async () => {
        const h = await harness(state);
        try {
          for (let retry = 0; retry < 4; retry++) {
            const response = await post(h, messages);
            assert.equal(response.status, 503, `retry ${retry} waits for the index`);
            assert.equal(response.retryAfter, "30");
          }
          assert.equal(h.compressCalls, 4, "each paced retry asks the server again");
          h.state = "ready";
          assert.equal((await post(h, messages)).status, 200, "delivery resumes");
          assert.equal(h.delivered, 1);
        } finally { h.close(); }
      });
  }

  test(`${lane}: fresh compress calls are paced while the index is behind`, async () => {
    const h = await harness("stale", { indexWaitRefreshMs: 60_000 });
    try {
      for (let retry = 0; retry < 3; retry++) assert.equal((await post(h, messages)).status, 503);
      assert.equal(h.compressCalls, 1, "retries inside the interval reuse the result");
    } finally { h.close(); }
  });

  test(`${lane}: billing counters alone are no evidence of lag; refuse promptly`, async () => {
    const h = await harness("legacy");
    try {
      const statuses = [];
      for (let retry = 0; retry < 3; retry++) statuses.push((await post(h, messages)).status);
      assert.deepEqual(statuses, [503, 503, 400]);
      assert.equal(h.delivered, 0);
    } finally { h.close(); }
  });
}
