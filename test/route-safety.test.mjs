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
    const raw = body("x".repeat(900_000));
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

test("a refusal records its details in the request log and prints nothing to the TUI", async () => {
  // Incident 2026-10-16: the "recovery failed" object was printed with console.error,
  // which Claude Code's TUI shows inside the conversation. Only debug output may
  // reach the console; the details belong in requests.jsonl.
  const h = await waitingHarness(60_000);
  h.memtree.compress = async () => unfitResult(false);
  const printed = [];
  const real = { error: console.error, warn: console.warn, log: console.log };
  for (const name of Object.keys(real)) console[name] = (...a) => printed.push(a.join(" "));
  try {
    const response = await request(h.proxy, body("x".repeat(900_000)));
    assert.equal(response.status, 503);
  } finally { Object.assign(console, real); h.close(); }
  assert.deepEqual(printed, [], "nothing printed outside debug");
  const decision = h.records.filter(r => r.kind === "messages").at(-1);
  assert.equal(decision.refusal.attempt, 1);
  assert.equal(decision.refusal.status, 503);
  assert.equal(decision.refusal.indexBehind, false);
  assert.equal(typeof decision.refusal.budgetTokens, "number");
  assert.equal(typeof decision.refusal.modelContextLimit, "number");
});

test("fallback ignores the soft budget but reserves output against the native window", async () => {
  const h = await harness();
  try {
    // Under the budget by input (as the server judges it, so it will not compress),
    // and it fits the window with its output: it goes out unchanged. 2026-10-03:
    // refusing this for the output reservation failed every session past ~672k.
    assert.equal((await request(h.proxy, body("small history", 1000))).status, 200);
    assert.equal(h.seen.length, 1);
    // Input above the soft budget still fits the native window.
    assert.equal((await request(h.proxy, body("x".repeat(8000), 100))).status, 200);
    assert.equal(h.seen.length, 2);
    // Input plus output must fit the actual context window.
    assert.equal((await request(h.proxy, body("x".repeat(8000), 199_000))).status, 503);
    assert.equal(h.seen.length, 2);
  } finally { h.close(); }
});

test("a transport that ignores cancellation cannot hold rebuilding open indefinitely", async () => {
  const h = await harness();
  try {
    Object.defineProperty(h.memtree, "compressBudgetMs", { get: () => 20 });
    h.memtree.compress = () => new Promise(() => {});
    const started = performance.now();
    assert.equal((await request(h.proxy, body("x".repeat(8000)))).status, 200);
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

// 2026-10-12 incident: a broken prefix match left MemTree compressing against a
// stale tree; for ~7 minutes its results kept the unindexed history verbatim and
// did not fit the window. Claude Code's quick retries used the strike budget in
// seconds. While the index is behind, retries must wait for it instead.
const pageUrl = "https://memtree.example/usage/memtree/page-1";
const unfitResult = (pending) => {
  const content = "y".repeat(900_000);
  return { compressed: true, messages: [{ role: "user", content }],
    flattened_messages: [{ role: "user", content }], memtreeUrl: pageUrl,
    ...(pending ? { index_pending: true } : {}) };
};
const fitResult = () => {
  const content = "saved memory ".repeat(200);
  return { compressed: true, messages: [{ role: "user", content }],
    flattened_messages: [{ role: "user", content }], memtreeUrl: pageUrl,
    usage: { indexed_tokens: 220_000, raw_prompt_tokens: 230_000 } };
};
const toolBody = (max_tokens = 100) => JSON.stringify({ model: "claude-x", max_tokens, messages: [
  { role: "user", content: "x".repeat(900_000) },
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }] });

async function waitingHarness(indexWaitDeadlineMs) {
  const records = [];
  const h = await harness(20_000, { indexWaitDeadlineMs, defaultCompactTarget: undefined,
    reqlog: { log: record => records.push(structuredClone(record)) } });
  h.memtree.compress = async () => unfitResult(true);
  return { ...h, records };
}

for (const [lane, send] of [["human", () => body("x".repeat(900_000))], ["tool", toolBody]]) {
  test(`${lane}: an unfit result while the index is behind waits for it, then delivers`, async () => {
    const h = await waitingHarness(60_000);
    try {
      for (let retry = 0; retry < 6; retry++) {
        const response = await request(h.proxy, send());
        assert.equal(response.status, 503, `retry ${retry} waits for the index`);
        assert.equal(response.headers["retry-after"], "30");
        assert.equal(response.headers["x-should-retry"], "true");
      }
      assert.equal(h.seen.length, 0, "the oversized history is never forwarded");
      h.memtree.compress = async () => fitResult();
      assert.equal((await request(h.proxy, send())).status, 200, "delivery resumes once indexed");
      assert.equal(h.seen.length, 1);
      assert.ok(!h.seen[0].includes("y".repeat(1000)));
    } finally { h.close(); }
  });

  test(`${lane}: the index wait is bounded by a wall-clock deadline`, async () => {
    const h = await waitingHarness(150);
    try {
      assert.equal((await request(h.proxy, send())).status, 503);
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await request(h.proxy, send());
      assert.equal(response.status, 400);
      assert.match(JSON.parse(response.body).error.message,
        /couldn't fit this request in the model's context window.*\/ccc:memtree-compact or \/clear/);
    } finally { h.close(); }
  });

  test(`${lane}: an unfit result from a complete index refuses promptly`, async () => {
    const h = await waitingHarness(60_000);
    h.memtree.compress = async () => unfitResult(false);
    try {
      for (const expected of [503, 503, 400]) {
        const response = await request(h.proxy, send());
        assert.equal(response.status, expected);
        if (expected === 503) assert.equal(response.headers["retry-after"], "1");
      }
      const decision = h.records.filter(r => r.kind === "messages").at(-1);
      assert.equal(decision.maxTokens, 100, "max_tokens is logged with the decision");
    } finally { h.close(); }
  });
}
