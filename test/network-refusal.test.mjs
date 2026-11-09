// 2026-11-09: the Mac mini's ethernet dropped. MemTree was unreachable (getaddrinfo
// ENOTFOUND), so compression failed and an over-budget turn was refused with "MemTree
// couldn't fit this request in the model's context window ... run /ccc:memtree-compact or
// /clear": the network was down, not the fit. A refusal while MemTree can't be reached
// says so, stays retryable, and never asks the user to compact or clear.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import {
  NETWORK_FAILURE_FRESH_MS, freshFailure, networkFailureOf,
} from "../dist/network-failure.js";

const MEMTREE_URL = "http://memtree.test";
const realFetch = globalThis.fetch;

/** fetch to MemTree answered by `answer` (a Response, or a thrown network error). */
function stubMemtree(answer) {
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(MEMTREE_URL)) return realFetch(url, init);
    return answer();
  };
}

/** What undici throws when it cannot connect: TypeError("fetch failed") with the cause's code. */
function fetchFailed(code, hostname = "memtree.test") {
  const syscall = code === "ENOTFOUND" || code === "EAI_AGAIN" ? "getaddrinfo" : "connect";
  const cause = Object.assign(new Error(`${syscall} ${code} ${hostname}`),
    { code, syscall, hostname });
  return new TypeError("fetch failed", { cause });
}

function unfitAnswer() {
  const content = "y".repeat(900_000);
  return new Response(JSON.stringify({ compressed: true, messages: [{ role: "user", content }],
    flattened_messages: [{ role: "user", content }] }),
  { status: 200, headers: { "content-type": "application/json" } });
}

async function closedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fitAnswer() {
  const content = "saved memory ".repeat(200);
  return new Response(JSON.stringify({ compressed: true, messages: [{ role: "user", content }],
    flattened_messages: [{ role: "user", content }],
    usage: { indexed_tokens: 220_000, raw_prompt_tokens: 230_000 } }),
  { status: 200, headers: { "content-type": "application/json" } });
}

async function harness(options = {}) {
  const { upstreamDown = false, indexing = false, budget = 1000 } = options;
  // A tool turn compresses only with compaction on (an undefined target: budget/2).
  const compactTarget = "compactTarget" in options ? options.compactTarget : null;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (options.countTokens !== undefined && req.url.includes("count_tokens")) {
        res.end(JSON.stringify({ input_tokens: options.countTokens }));
        return;
      }
      seen.push(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstreamDown ? await closedPort() : upstream.address().port;
  const memtree = new MemtreeClient({ baseUrl: MEMTREE_URL, apiKey: "offline" });
  if (!indexing) memtree.indexInBackground = () => {};
  const records = [];
  const proxy = await startProxy({ memtree, upstreamOrigin: `http://127.0.0.1:${port}`,
    budgetTokensOverride: budget, defaultCompactTarget: compactTarget,
    ...(options.countTokens !== undefined ? { countTokens: true } : {}),
    reqlog: { log: record => records.push(structuredClone(record)) } });
  return { proxy, memtree, seen, records, close() { proxy.close(); upstream.close(); globalThis.fetch = realFetch; } };
}

function request(proxy, raw, session = "net-session") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: "/v1/messages",
      method: "POST", headers: { "content-type": "application/json",
        "content-length": Buffer.byteLength(raw), "x-claude-code-session-id": session } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(raw);
  });
}

const body = (text) => JSON.stringify({ model: "claude-x", max_tokens: 100, messages: [
  { role: "user", content: text }, { role: "assistant", content: "prior answer" },
  { role: "user", content: "next" }] });
const oversized = () => body("x".repeat(900_000));
const toolBody = (result = "done") => JSON.stringify({ model: "claude-x", max_tokens: 100,
  messages: [{ role: "user", content: "x".repeat(900_000) },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: result }] }] });
const message = (response) => JSON.parse(response.body).error.message;

function assertNetworkRefusal(response, pattern) {
  assert.equal(response.status, 503, "a retryable status: Claude Code retries it");
  assert.equal(response.headers["x-should-retry"], "true");
  const text = message(response);
  assert.match(text, pattern);
  assert.match(text, /check your (internet )?connection and retry/i);
  assert.doesNotMatch(text, /couldn't fit|memtree-compact|\/clear/);
}

for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET",
  "ENETUNREACH", "EHOSTUNREACH"]) {
  test(`MemTree unreachable (${code}): an over-budget turn says so, never "couldn't fit"`,
    async () => {
      const h = await harness();
      stubMemtree(() => { throw fetchFailed(code); });
      try {
        // Past the three-strike episode: every retry still says why.
        for (let retry = 0; retry < 5; retry++) {
          const response = await request(h.proxy, oversized());
          assertNetworkRefusal(response, new RegExp(`can't reach MemTree \\(memtree\\.test: ${code}\\)`));
        }
        assert.equal(h.seen.length, 0, "the oversized history is never forwarded");
      } finally { h.close(); }
    });
}

test("MemTree on a closed port (a real ECONNREFUSED) is a network refusal", async () => {
  const port = await closedPort();
  const memtree = new MemtreeClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "offline" });
  memtree.indexInBackground = () => {};
  const proxy = await startProxy({ memtree, upstreamOrigin: "http://127.0.0.1:1",
    budgetTokensOverride: 1000, defaultCompactTarget: null });
  try {
    assertNetworkRefusal(await request(proxy, oversized()), /can't reach MemTree/);
  } finally { proxy.close(); }
});

test("network refusals spend no strikes: once MemTree answers, a real misfit refuses as before",
  async () => {
    const h = await harness();
    stubMemtree(() => { throw fetchFailed("ENOTFOUND"); });
    try {
      for (let retry = 0; retry < 3; retry++) {
        assertNetworkRefusal(await request(h.proxy, oversized()), /can't reach MemTree/);
      }
      stubMemtree(unfitAnswer);
      const statuses = [];
      let last;
      for (let retry = 0; retry < 3; retry++) {
        last = await request(h.proxy, oversized());
        statuses.push(last.status);
      }
      assert.deepEqual(statuses, [503, 503, 400]);
      assert.match(message(last), /couldn't fit this request.*\/ccc:memtree-compact or \/clear/);
    } finally { h.close(); }
  });

// The incident's own path: a main-lane tool turn whose compress failed in 9 ms, then the
// lane's growth backoff refused its retries without asking MemTree (400 attempt 3).
test("a tool turn in its lane's backoff says MemTree can't be reached, then delivers once it can",
  async () => {
    const h = await harness({ indexing: true, budget: 20_000, compactTarget: undefined });
    stubMemtree(() => { throw fetchFailed("ENOTFOUND"); });
    try {
      for (let retry = 0; retry < 4; retry++) {
        assertNetworkRefusal(await request(h.proxy, toolBody()), /can't reach MemTree/);
      }
      stubMemtree(fitAnswer);
      const statuses = [];
      for (let retry = 0; retry < 4 && statuses.at(-1) !== 200; retry++) {
        const response = await request(h.proxy, toolBody(`done ${retry}`));
        statuses.push(response.status);
        if (response.status !== 200) {
          // Retryable, never the fit: a background index call may answer mid-request.
          assert.equal(response.status, 503);
          assert.doesNotMatch(message(response), /couldn't fit|memtree-compact|\/clear/);
          // A background index call answers meanwhile: MemTree is reachable again.
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      assert.equal(statuses.at(-1), 200, `delivered once MemTree answers (${statuses})`);
    } finally { h.close(); }
  });

test("Anthropic unreachable: the forward's 502 says ccc can't reach Anthropic", async () => {
  const h = await harness({ upstreamDown: true });
  stubMemtree(unfitAnswer);
  try {
    const response = await request(h.proxy, body("small history"));
    assert.equal(response.status, 502, "502 stays retryable for Claude Code");
    assert.match(message(response), /can't reach Anthropic \(127\.0\.0\.1: ECONNREFUSED\)/);
    assert.match(message(response), /check your internet connection and retry/i);
  } finally { h.close(); }
});

test("MemTree and Anthropic both unreachable: ccc can't reach the internet", async () => {
  const h = await harness({ upstreamDown: true });
  stubMemtree(() => { throw fetchFailed("ENOTFOUND"); });
  try {
    await request(h.proxy, body("small history"));
    const response = await request(h.proxy, oversized());
    assertNetworkRefusal(response, /can't reach the internet/);
    assert.doesNotMatch(message(response), /couldn't fit/);
  } finally { h.close(); }
});

// Codex r1 P2: a lane backing off after MemTree answered with a result too large keeps its
// fit refusal when another request then fails to connect.
test("a lane backing off after a misfit answer keeps the fit refusal through another's outage",
  async () => {
    const h = await harness({ budget: 20_000, compactTarget: undefined });
    stubMemtree(unfitAnswer);
    try {
      const raw = toolBody();
      assert.equal((await request(h.proxy, raw)).status, 503);
      stubMemtree(() => { throw fetchFailed("ENOTFOUND"); });
      assertNetworkRefusal(await request(h.proxy, oversized(), "other-session"),
        /can't reach MemTree/);
      const second = await request(h.proxy, raw);
      assert.equal(h.records.at(-1).routeRecovery?.outcome, "backoff");
      const third = await request(h.proxy, raw);
      assert.deepEqual([second.status, third.status], [503, 400]);
      assert.match(message(third), /couldn't fit this request/);
    } finally { h.close(); }
  });

// Codex r2 P2: that marker must not hide the request's own later compress failing to connect.
test("a backed-off turn whose own late recompression can't connect is a network refusal",
  async () => {
    const h = await harness({ budget: 20_000, compactTarget: undefined, countTokens: 300_000 });
    stubMemtree(unfitAnswer);
    try {
      const raw = toolBody();
      assert.equal((await request(h.proxy, raw)).status, 503);
      stubMemtree(() => { throw fetchFailed("ENOTFOUND"); });
      // The next tool round (a new history, so no cached answer), still within the backoff.
      const response = await request(h.proxy, toolBody("done again"));
      const decision = h.records.at(-1);
      assert.equal(decision.routeRecovery?.outcome, "backoff");
      assert.equal(decision.compress?.ok, false, "delivery recompressed and failed to connect");
      assertNetworkRefusal(response, /can't reach MemTree/);
    } finally { h.close(); }
  });

test("a connection reset mid-call is no network refusal: the strikes run as before", async () => {
  const h = await harness();
  // A reset on a connection that was up (syscall "read"): the server may have the call.
  stubMemtree(() => { throw Object.assign(fetchFailed("ECONNRESET"),
    { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }) }); });
  try {
    const statuses = [];
    let last;
    for (let retry = 0; retry < 3; retry++) {
      last = await request(h.proxy, oversized());
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [503, 503, 400]);
    assert.match(message(last), /couldn't fit this request/);
  } finally { h.close(); }
});

// Review r1 P1: a background index call failing to connect after this request's compress
// answered must not turn its fit refusal into "can't reach MemTree".
test("an index-only connection failure after a compress answered keeps the fit refusal",
  async () => {
    const h = await harness({ indexing: true });
    stubMemtree(unfitAnswer);
    try {
      const raw = oversized();
      assert.equal((await request(h.proxy, raw)).status, 503);
      stubMemtree(() => { throw fetchFailed("ENOTFOUND"); });
      h.memtree.indexInBackground("index-only-hash",
        [{ role: "user", content: "w".repeat(200_000) }], 200_000);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(h.memtree.unreachable, undefined, "an index call is no request's evidence");
      // The retries are answered from the compress cache: no live call.
      const second = await request(h.proxy, raw);
      const third = await request(h.proxy, raw);
      assert.deepEqual([second.status, third.status], [503, 400]);
      assert.match(message(third), /couldn't fit this request/);
    } finally { h.close(); }
  });

test("a non-messages forward (streamed pass-through) says ccc can't reach Anthropic", async () => {
  const h = await harness({ upstreamDown: true });
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h.proxy.port, path: "/v1/models",
        method: "GET" }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode,
          body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(response.status, 502);
    assert.match(message(response), /can't reach Anthropic \(127\.0\.0\.1: ECONNREFUSED\)/);
  } finally { h.close(); }
});

test("a connection failure explains refusals for two minutes, no longer", () => {
  const failure = networkFailureOf(fetchFailed("ENOTFOUND"), "h", 1_000);
  assert.equal(freshFailure(failure, 1_000 + NETWORK_FAILURE_FRESH_MS), failure);
  assert.equal(freshFailure(failure, 1_001 + NETWORK_FAILURE_FRESH_MS), undefined);
});

test("networkFailureOf reads undici's cause and ignores aborts and HTTP answers", () => {
  assert.equal(networkFailureOf(fetchFailed("ENOTFOUND"), "h")?.code, "ENOTFOUND");
  assert.equal(networkFailureOf(Object.assign(new Error("connect ECONNRESET"),
    { code: "ECONNRESET", syscall: "connect" }), "h")?.code, "ECONNRESET");
  assert.equal(networkFailureOf(Object.assign(new Error("read ECONNRESET"),
    { code: "ECONNRESET", syscall: "read" }), "h"), undefined, "a reset once connected");
  const attempt = () => Object.assign(new Error("connect ETIMEDOUT"),
    { code: "ETIMEDOUT", syscall: "connect" });
  assert.equal(networkFailureOf(Object.assign(new AggregateError([attempt(), attempt()]),
    { code: "ETIMEDOUT" }), "h")?.code, "ETIMEDOUT", "happy eyeballs: every attempt's connect");
  assert.equal(networkFailureOf(Object.assign(new Error("x"), { code: "EPIPE" }), "h"),
    undefined);
  assert.equal(networkFailureOf(new DOMException("aborted", "AbortError"), "h"), undefined);
  assert.equal(networkFailureOf(Object.assign(new Error("context_memory 503"),
    { status: 503 }), "h"), undefined);
  assert.equal(networkFailureOf(Object.assign(new Error("x"), { code: "EACCES" }), "h"),
    undefined);
});
