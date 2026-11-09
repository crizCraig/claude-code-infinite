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
import { networkFailureOf } from "../dist/network-failure.js";

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

async function harness({ upstreamDown = false } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstreamDown ? await closedPort() : upstream.address().port;
  const memtree = new MemtreeClient({ baseUrl: MEMTREE_URL, apiKey: "offline" });
  memtree.indexInBackground = () => {};
  const proxy = await startProxy({ memtree, upstreamOrigin: `http://127.0.0.1:${port}`,
    budgetTokensOverride: 1000, defaultCompactTarget: null });
  return { proxy, seen, close() { proxy.close(); upstream.close(); globalThis.fetch = realFetch; } };
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

test("networkFailureOf reads undici's cause and ignores aborts and HTTP answers", () => {
  assert.equal(networkFailureOf(fetchFailed("ENOTFOUND"), "h")?.code, "ENOTFOUND");
  assert.equal(networkFailureOf(Object.assign(new Error("x"), { code: "ECONNRESET" }), "h")
    ?.code, "ECONNRESET");
  assert.equal(networkFailureOf(new DOMException("aborted", "AbortError"), "h"), undefined);
  assert.equal(networkFailureOf(Object.assign(new Error("context_memory 503"),
    { status: 503 }), "h"), undefined);
  assert.equal(networkFailureOf(Object.assign(new Error("x"), { code: "EACCES" }), "h"),
    undefined);
});
