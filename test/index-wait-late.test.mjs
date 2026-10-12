// Late exact-count recovery (Codex cycle 2): a ride that looked small at
// planning but counts over the window gets one late compression. When that
// compression says MemTree's index is behind (index_pending), the refusal must
// wait for the index and later retries must ask MemTree again.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

async function listen(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => handler(req, res, raw ? JSON.parse(raw) : {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

const reply = (content, extra = {}) => {
  const messages = [{ role: "user", content }];
  return { compressed: true, messages, flattened_messages: messages, ...extra };
};

/** Phases: "install" builds the route; "lag" makes the ride count over the
 * window and compress answer from a lagging index; "ready" compresses small. */
async function harness() {
  const h = { phase: "install", compressCalls: 0, delivered: 0, records: [] };
  const upstream = await listen((req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/count_tokens")) {
      const text = JSON.stringify(body);
      const huge = text.includes("x".repeat(100)) || text.includes("y".repeat(100)) ||
        (h.phase !== "install" && text.includes("m".repeat(100)));
      return res.end(JSON.stringify({ input_tokens: huge ? 300_000 : Math.ceil(text.length / 4) }));
    }
    h.delivered++;
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const memory = await listen((req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (body.index_only) return res.end(JSON.stringify({ messages: [], index_only: true }));
    h.compressCalls++;
    res.end(JSON.stringify(h.phase === "install" ? reply("memory " + "m".repeat(200_000))
      : h.phase === "lag" ? reply("y".repeat(900_000), { index_pending: true })
        : reply("saved memory ".repeat(200))));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: "offline" });
  h.proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin,
    budgetTokensOverride: 100_000, countTokens: true, indexWaitRefreshMs: 0,
    reqlog: { log: record => h.records.push(structuredClone(record)) } });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

async function post(h, messages) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "s" },
    body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }),
  });
  await response.text();
  return { status: response.status, retryAfter: response.headers.get("retry-after") };
}

const original = [{ role: "user", content: "first" }, { role: "assistant", content: "answer" },
  { role: "user", content: "x".repeat(1_200_000) }];
const suffixes = {
  main: [{ role: "assistant", content: "answer2" }, { role: "user", content: "next" }],
  tool: [{ role: "assistant", content: [{ type: "tool_use", id: "n", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "n", content: "next" }] }],
};

for (const [lane, suffix] of Object.entries(suffixes)) {
  test(`${lane}: a lagging late-count recovery waits for the index, then delivers`, async () => {
    const h = await harness();
    try {
      assert.equal((await post(h, original)).status, 200, "route installed");
      h.phase = "lag";
      const before = h.compressCalls;
      for (let retry = 0; retry < 3; retry++) {
        const response = await post(h, [...original, ...suffix]);
        assert.equal(response.status, 503, `retry ${retry} waits for the index`);
        assert.equal(response.retryAfter, "30");
        const rec = h.records.filter(r => r.kind === "messages").at(-1);
        assert.equal(rec.lateCountRecovery?.outcome, "refused");
        assert.equal(rec.indexBehind, true);
      }
      assert.equal(h.compressCalls - before, 3, "each paced retry asks MemTree again");
      h.phase = "ready";
      assert.equal((await post(h, [...original, ...suffix])).status, 200);
      assert.equal(h.delivered, 2);
    } finally { h.close(); }
  });
}
