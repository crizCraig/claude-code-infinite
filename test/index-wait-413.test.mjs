// MemTree's 413 while its index catches up (2026-11-09 incident): a resumed session's
// compress got "indexing time left ~240s" with Retry-After, ccc spent its three strikes
// in seconds and refused the turn ("couldn't fit ... wait a minute and retry") until
// 00:34Z; the index landed at 00:35Z. An indexing 413 now holds the turn, re-asking at
// the server's pace, and tells Claude Code to retry with how long is left, up to a cap.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { indexWaitFrom413, retryAfterSeconds } from "../dist/index-wait-413.js";
import {
  FINAL_REFUSAL_MESSAGE, INDEX_WAIT_MAX_MS, RouteFallbackFailures, indexWaitStatus,
} from "../dist/route-fallback.js";

const OVER_CONTEXT = "Memory for this conversation is being compressed in the background to " +
  "fit within the model's input limit.";
const MEMTREE_MSG = "This message was produced by the MemTree API.";
const todays = (left) => JSON.stringify({
  detail: `${OVER_CONTEXT} Estimated indexing time left: ${left}. ${MEMTREE_MSG}` });

test("today's indexing 413: Retry-After, else the time in its text", () => {
  assert.equal(indexWaitFrom413(413, todays("about 4 minutes"), "240"), 240);
  assert.equal(indexWaitFrom413(413, todays("about 4 minutes"), null), 240);
  assert.equal(indexWaitFrom413(413, todays("about 1.5 hours"), undefined), 5400);
  // Before 2026-11-02 the text gave a range (its upper end counts) or "< 1 minute".
  assert.equal(indexWaitFrom413(413, JSON.stringify({ detail: `${OVER_CONTEXT} 5 to 9.9 hours. x` }),
    null), 9.9 * 3600);
  assert.equal(indexWaitFrom413(413, JSON.stringify({ detail: `${OVER_CONTEXT} < 1 minute. x` }),
    null), 60);
  // The hopeless-wait refusal also says its time and sends it as Retry-After.
  const hopeless = JSON.stringify({ detail: `${OVER_CONTEXT} MemTree has indexed 3 of 9 ` +
    "messages ... about 50 minutes remaining. Retry after that, or continue in a new session." });
  assert.equal(indexWaitFrom413(413, hopeless, "3000"), 3000);
});

test("an explicit index_pending decides, with the body's seconds when no header", () => {
  const pending = (detail) => JSON.stringify(detail);
  assert.equal(indexWaitFrom413(413, pending({ detail: "x", index_pending: true,
    retry_after_seconds: 90 }), null), 90);
  assert.equal(indexWaitFrom413(413, pending({ detail: { message: "x", index_pending: true } }),
    null), 60, "behind, time unknown: a minute");
  assert.equal(indexWaitFrom413(413, pending({ detail: { message: "x", index_behind: true } }),
    "120"), 120);
  assert.equal(indexWaitFrom413(413, pending({ detail: OVER_CONTEXT, index_pending: false }), "240"),
    undefined, "the server says waiting will not help");
});

test("a 413 that waiting cannot fix, or another status, is no index wait", () => {
  for (const detail of [
    "Request too large: 11000000 un-indexed tokens exceeds the maximum of 10000000",
    "The most recent message is too large to fit in the model's context window",
    "Request exceeds the context window after compression",
  ]) {
    assert.equal(indexWaitFrom413(413, JSON.stringify({ detail }), null), undefined, detail);
  }
  assert.equal(indexWaitFrom413(503, todays("about 4 minutes"), "240"), undefined);
  assert.equal(indexWaitFrom413(413, "not json", null), undefined);
});

test("Retry-After as seconds or an HTTP date", () => {
  assert.equal(retryAfterSeconds("30"), 30);
  assert.equal(retryAfterSeconds(new Date(61_000).toUTCString(), 1_000), 60);
  for (const bad of ["", "soon", "0", "-5", null, undefined]) {
    assert.equal(retryAfterSeconds(bad), undefined, String(bad));
  }
});

test("a stated wait: estimate plus margin, extended by later estimates up to the cap", () => {
  const failures = new RouteFallbackFailures();
  const fail = (now, indexSecondsLeft) =>
    failures.fail("s/main", { awaitingIndex: true, indexSecondsLeft, now });
  const first = fail(0, 240);
  assert.equal(first.status, 503);
  assert.equal(first.headers["retry-after"], "30");
  assert.equal(first.body.error.message, indexWaitStatus(240));
  assert.match(first.body.error.message, /catching up on this session's index, about 4 minutes left/);
  // 240 s + half again + 2 min = 480 s.
  assert.equal(fail(479_000).status, 503);
  // The job still running says 30 s left: the wait goes on past the first deadline...
  assert.equal(fail(470_000, 30).status, 503);
  assert.equal(fail(600_000, 30).status, 503);
  assert.match(fail(600_000, 30).body.error.message, /about 1 minute left/);
  // ...but never past the cap from its start.
  assert.equal(fail(INDEX_WAIT_MAX_MS - 1, 30).status, 503);
  const refused = fail(INDEX_WAIT_MAX_MS, 30);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.message, FINAL_REFUSAL_MESSAGE);
  assert.equal(fail(INDEX_WAIT_MAX_MS + 1, 30).status, 400, "refused until a delivery");
  failures.succeeded("s/main");
  assert.equal(fail(INDEX_WAIT_MAX_MS + 2, 30).status, 503, "a delivery ends the episode");
});

test("a stated time past the cap refuses at once; a short one retries sooner", () => {
  const failures = new RouteFallbackFailures();
  const hopeless = failures.fail("a", { awaitingIndex: true, indexSecondsLeft: 3600, now: 0 });
  assert.equal(hopeless.status, 400);
  assert.equal(failures.fail("a", { awaitingIndex: true, indexSecondsLeft: 60, now: 1 }).status,
    400, "the lane stays refused until a delivery");
  const soon = failures.fail("b", { awaitingIndex: true, indexSecondsLeft: 5, now: 0 });
  assert.equal(soon.headers["retry-after"], "5");
});

// --- through the proxy and the real MemtreeClient ---------------------------------------

const big = "x".repeat(900_000);
const humanMessages = [{ role: "user", content: big }, { role: "assistant", content: "prior" },
  { role: "user", content: "next" }];
const toolMessages = [{ role: "user", content: big },
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }];
const ready = () => {
  const messages = [{ role: "user", content: "saved memory ".repeat(200) }];
  return { compressed: true, messages, flattened_messages: messages,
    usage: { indexed_tokens: 220_000, raw_prompt_tokens: 230_000 } };
};

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => handler(req, res, raw ? JSON.parse(raw) : {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

/** `refusals`: how many compress calls MemTree refuses, with what (413 status/body/headers). */
async function harness(refusal, options = {}) {
  const h = { refusals: Infinity, refusal, compressCalls: 0, delivered: 0, records: [] };
  const upstream = await serve((req, res) => {
    h.delivered++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const memory = await serve(async (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 202; return res.end("{}"); }
    if (body.index_only) return res.end(JSON.stringify({ messages: [], index_only: true }));
    h.compressCalls++;
    const delay = h.delays?.[h.compressCalls - 1] ?? 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (res.destroyed) return;
    if (h.answers?.[h.compressCalls - 1]) {
      const { status, body: answer, headers = {} } = h.answers[h.compressCalls - 1];
      res.writeHead(status, { "content-type": "application/json", ...headers });
      return res.end(answer);
    }
    if (h.compressCalls <= h.refusals) {
      res.writeHead(413, { "content-type": "application/json", ...(h.refusal.headers ?? {}) });
      return res.end(h.refusal.body);
    }
    res.end(JSON.stringify(ready()));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  h.proxy = await startProxy({ memtree, upstreamOrigin: upstream.url,
    budgetTokensOverride: 20_000, indexPollMaxMs: 20, indexHoldMs: 2_000,
    reqlog: { log: (rec) => h.records.push(rec) }, ...options });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

async function post(h, messages, signal) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-claude-code-session-id": "s" },
    body: JSON.stringify({ model: "claude-x", max_tokens: 100, messages }),
  });
  const text = await response.text();
  return { status: response.status, retryAfter: response.headers.get("retry-after"),
    message: text ? JSON.parse(text).error?.message : undefined };
}

const indexing = (seconds) => ({ body: todays(`about ${Math.ceil(seconds / 60)} minutes`),
  headers: { "retry-after": String(seconds) } });

for (const [lane, messages] of [["human", humanMessages], ["tool", toolMessages]]) {
  test(`${lane}: an indexing 413 holds the turn and delivers once the index lands`, async () => {
    const h = await harness(indexing(240));
    h.refusals = 3;
    try {
      const response = await post(h, messages);
      assert.equal(response.status, 200, response.message);
      assert.equal(h.compressCalls, 4, "asked again until MemTree answered");
      assert.equal(h.delivered, 1);
      const rec = h.records.find((r) => r.kind === "messages" && r.indexWait);
      assert.equal(rec.indexWait.asks, 3);
      assert.equal(rec.indexWait.secondsLeft, 240);
    } finally { h.close(); }
  });

  test(`${lane}: past one request's hold, Claude Code retries with the time left`, async () => {
    const h = await harness(indexing(240), { indexHoldMs: 60 });
    try {
      const first = await post(h, messages);
      assert.equal(first.status, 503);
      assert.equal(first.retryAfter, "30");
      assert.match(first.message, /MemTree is catching up on this session's index, about 4 minutes left/);
      h.refusal = indexing(50);
      const second = await post(h, messages);
      assert.equal(second.status, 503);
      assert.match(second.message, /about 1 minute left/, "the status follows the server");
      h.refusals = 0;
      assert.equal((await post(h, messages)).status, 200, "delivery once the index lands");
    } finally { h.close(); }
  });

  test(`${lane}: a 413 waiting cannot fix still refuses within three strikes`, async () => {
    const h = await harness({ body: JSON.stringify({
      detail: "Request exceeds the context window after compression" }) });
    try {
      const statuses = [];
      for (let retry = 0; retry < 3; retry++) statuses.push((await post(h, messages)).status);
      assert.deepEqual(statuses, [503, 503, 400]);
      // No hold: at most one ask per request (a tool lane's growth backoff skips more).
      assert.ok(h.compressCalls <= 3, `${h.compressCalls} asks`);
      assert.equal(h.records.filter((r) => r.indexWait).length, 0);
    } finally { h.close(); }
  });

  test(`${lane}: an estimate past the cap refuses at once`, async () => {
    const h = await harness(indexing(3600));
    try {
      const response = await post(h, messages);
      assert.equal(response.status, 400);
      assert.equal(response.message, FINAL_REFUSAL_MESSAGE);
      assert.equal(h.compressCalls, 1);
    } finally { h.close(); }
  });
}

test("a held turn stops asking once Claude Code leaves", async () => {
  const h = await harness(indexing(240), { indexHoldMs: 10_000 });
  try {
    const controller = new AbortController();
    const pending = post(h, humanMessages, controller.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const calls = h.compressCalls;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(h.compressCalls, calls, "no more asks after the client left");
  } finally { h.close(); }
});

test("existing waits: a later estimate past the cap refuses; a full table keeps it refused", () => {
  const failures = new RouteFallbackFailures();
  assert.equal(failures.fail("a", { awaitingIndex: true, indexSecondsLeft: 60, now: 0 }).status, 503);
  assert.equal(failures.fail("a", { awaitingIndex: true, indexSecondsLeft: 3600, now: 1 }).status,
    400, "the estimate grew past the cap");
  assert.equal(failures.fail("a", { awaitingIndex: true, indexSecondsLeft: 60, now: 2 }).status, 400);
  // Capacity one, its strike slot taken: an ended wait cannot move to the strike table.
  const full = new RouteFallbackFailures(1, 1_000);
  full.fail("x");
  assert.equal(full.fail("b", { awaitingIndex: true, indexSecondsLeft: 1, now: 0 }).status, 503);
  assert.equal(full.fail("b", { awaitingIndex: true, now: 200_000 }).status, 400);
  assert.equal(full.fail("b", { awaitingIndex: true, indexSecondsLeft: 1, now: 200_001 }).status,
    400, "never revived by a later estimate");
  assert.equal(full.indexWaitOpen("b", 1, 200_002), false);
});

test("a held request's lane wait starts at the first indexing 413 and closes at its deadline", () => {
  const failures = new RouteFallbackFailures();
  assert.equal(failures.indexWaitOpen("lane", 10, 0), true);
  // 10 s + 5 s + 2 min.
  assert.equal(failures.indexWaitOpen("lane", undefined, 134_999), true);
  assert.equal(failures.indexWaitOpen("lane", undefined, 135_000), false);
  assert.equal(failures.fail("lane", { awaitingIndex: true, now: 135_001 }).status, 400);
});

test("a hold never runs past its bound, even when a later ask is slow", async () => {
  const h = await harness(indexing(240), { indexHoldMs: 600 });
  h.delays = [0, 0, 5_000];
  try {
    const started = Date.now();
    const response = await post(h, humanMessages);
    const elapsed = Date.now() - started;
    assert.equal(response.status, 503);
    assert.match(response.message, /about 4 minutes left/, "still waiting for the index");
    assert.ok(elapsed < 1_500, `${elapsed} ms`);
  } finally { h.close(); }
});

test("an ask answered otherwise ends the wait: no stale index status", async () => {
  const h = await harness(indexing(240));
  h.answers = [undefined, { status: 413, body: JSON.stringify({
    detail: "Request exceeds the context window after compression" }) }];
  h.refusals = 1;
  try {
    const response = await post(h, humanMessages);
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.message, /catching up/);
    const rec = h.records.find((r) => r.kind === "messages" && r.indexWait);
    assert.equal(rec.indexWait.ended, true);
    assert.equal(rec.indexBehind, undefined);
  } finally { h.close(); }
});

test("concurrent retries joining one indexing 413 both wait for the index", async () => {
  const h = await harness(indexing(240), { indexHoldMs: 60 });
  h.delays = [150];
  try {
    const [a, b] = await Promise.all([post(h, humanMessages), post(h, humanMessages)]);
    for (const response of [a, b]) {
      assert.equal(response.status, 503);
      assert.match(response.message, /catching up on this session's index/);
    }
  } finally { h.close(); }
});

test("a hold never pauses or asks past the lane's wait (Codex r2)", async () => {
  const h = await harness(indexing(0.2), { indexHoldMs: 5_000, indexPollMaxMs: 1_000,
    indexWaitMaxMs: 300 });
  try {
    const started = Date.now();
    const response = await post(h, humanMessages);
    assert.ok(Date.now() - started < 900, `${Date.now() - started} ms`);
    assert.equal(h.compressCalls, 1, "no ask after the lane's wait ends");
    assert.equal(response.status, 503, "the lane's wait is still open for Claude Code's retry");
  } finally { h.close(); }
});

test("indexWaitDeadline: the lane's deadline while open, undefined once closed", () => {
  const failures = new RouteFallbackFailures();
  assert.equal(failures.indexWaitDeadline("l", 10, 0), 135_000);
  assert.equal(failures.indexWaitDeadline("l", undefined, 135_000), undefined);
});
