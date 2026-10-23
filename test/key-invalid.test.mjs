// A wrong or revoked MemTree key (polychat answers 401/403). Until 1.0.28 the startup
// status check treated a 401 like a network error ("unknown") and said nothing, and a
// mid-session 401 showed only "MemTree degraded", so users learned their key was bad
// only by digging. A definite 401/403 now says the key isn't valid and where to get a
// new one; network errors and 5xx stay quiet (no false alarms).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { DEGRADED_NOTICE } from "../dist/notices.js";
import {
  KEY_GATE_PROMPT,
  KEY_PAGE_URL,
  LOCAL_KEY_PAGE_URL,
  fetchKeyStatus,
  keyInvalidLine,
  keyInvalidNoticeText,
  keyInvalidRefusalMessage,
  isKeyRejected,
  keyPageUrl,
  parseKeyChoice,
  resolveInvalidKey,
  runKeyGate,
} from "../dist/key-status.js";

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => handler(req, res, raw));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

const statusServer = (status, body) => serve((req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

function recorder() {
  const events = [];
  return { events, record: (name, fields) => events.push({ name, ...fields }) };
}

// ---------------------------------------------------------------- startup check

test("the key page is polychat's MemTree sign-in (local: the dev front end)", () => {
  assert.equal(KEY_PAGE_URL, "https://polychat.co/auth?memtree=true&utm_source=ccc");
  assert.equal(keyPageUrl("https://api.polychat.co"), KEY_PAGE_URL);
  assert.equal(keyPageUrl("https://polychat-staging-1.us-west2.run.app"), KEY_PAGE_URL);
  assert.equal(keyPageUrl("http://localhost:8080"), LOCAL_KEY_PAGE_URL);
  assert.equal(keyPageUrl("http://127.0.0.1:8080"), LOCAL_KEY_PAGE_URL);
  assert.equal(keyPageUrl("not a url"), KEY_PAGE_URL);
});

test("401, or 403 with polychat's own detail, is a refused key; a bare 403 is not", () => {
  assert.equal(isKeyRejected(401), true);
  assert.equal(isKeyRejected(401, "<html>"), true);
  assert.equal(isKeyRejected(403, '{"detail":"Invalid API key"}'), true);
  assert.equal(isKeyRejected(403, '{"detail": "invalid api key"}'), true);
  assert.equal(isKeyRejected(403), false, "Cloudflare's WAF, a corporate proxy");
  assert.equal(isKeyRejected(403, "<html>Attention Required! | Cloudflare</html>"), false);
  assert.equal(isKeyRejected(403, '{"detail":"Untrusted origin"}'), false);
  assert.equal(isKeyRejected(402, '{"detail":"Invalid API key"}'), false);
  assert.equal(isKeyRejected(undefined), false);
});

test("startup check: a bare 403 (WAF, proxy) stays unknown", async () => {
  const server = await serve((req, res) => {
    res.writeHead(403, { "content-type": "text/html" });
    res.end("<html>Attention Required! | Cloudflare</html>");
  });
  try {
    assert.equal(await fetchKeyStatus(server.url, "k"), null);
  } finally { server.close(); }
});

for (const status of [401, 403]) {
  test(`startup check: ${status} with polychat's detail means the key is invalid`, async () => {
    const server = await statusServer(status, { detail: "Invalid API key" });
    const diagnostics = recorder();
    try {
      assert.equal(await fetchKeyStatus(server.url, "bad", { diagnostics }), "invalid");
      assert.deepEqual(diagnostics.events, [{ name: "key_status", result: "invalid", status }]);
    } finally { server.close(); }
  });
}

for (const status of [400, 403, 404, 405, 429, 500, 502, 503]) {
  test(`startup check: ${status} stays unknown (no false alarm)`, async () => {
    const server = await statusServer(status, { detail: "nope" });
    const diagnostics = recorder();
    try {
      assert.equal(await fetchKeyStatus(server.url, "k", { diagnostics }), null);
      assert.equal(diagnostics.events[0].result, "unknown");
    } finally { server.close(); }
  });
}

test("startup check: a network error stays unknown", async () => {
  const server = await statusServer(200, {});
  const url = server.url;
  server.close();
  const diagnostics = recorder();
  assert.equal(await fetchKeyStatus(url, "k", { diagnostics }), null);
  assert.equal(diagnostics.events[0].name, "error");
});

test("startup check: paid and unpaid bodies parse as before", async () => {
  const paid = await statusServer(200, { email: "a@b.c", paid: true, payment_message: null });
  const unpaid = await statusServer(200, { paid: false, payment_message: "Pay",
    payment_url: "https://x/payment?u=1" });
  try {
    assert.deepEqual(await fetchKeyStatus(paid.url, "k"), { paid: true, message: null, url: null });
    const status = await fetchKeyStatus(unpaid.url, "k");
    assert.equal(status.paid, false);
    assert.equal(status.url, "https://x/payment?u=1&source=ccc");
  } finally { paid.close(); unpaid.close(); }
});

test("the startup line says what is wrong, where to get a key and how to enter it", () => {
  assert.equal(keyInvalidLine(KEY_PAGE_URL, "ccc"),
    "⚠ Your MemTree key isn't valid (revoked or mistyped). Get a new one at " +
    "https://polychat.co/auth?memtree=true&utm_source=ccc and run `ccc` in a terminal to paste it.");
  assert.match(keyInvalidLine(LOCAL_KEY_PAGE_URL, "ccc local"), /run `ccc local` in a terminal/);
});

test("gate answers: Enter or p pastes a key, q quits, anything else continues", () => {
  assert.equal(KEY_GATE_PROMPT,
    "[Enter] paste a new key   [c] use claude without MemTree   [q] quit: ");
  for (const answer of ["", " ", "p", "P", "paste"]) assert.equal(parseKeyChoice(answer), "paste");
  for (const answer of ["q", "quit", "exit"]) assert.equal(parseKeyChoice(answer), "quit");
  for (const answer of ["c", "n", "x"]) assert.equal(parseKeyChoice(answer), "continue");
});

/** Scripted gate: `answers` are typed in order, `checks` answer each pasted key. */
function gateDeps(answers, checks = {}) {
  const log = { asked: [], opened: [], warned: [], said: [], saved: [] };
  return {
    log,
    deps: {
      keyPageUrl: KEY_PAGE_URL,
      ask: async (question) => { log.asked.push(question); return answers.shift() ?? "q"; },
      open: (url) => log.opened.push(url),
      warn: (text) => log.warned.push(text),
      say: (text) => log.said.push(text),
      check: async (key) => checks[key] ?? null,
      saveKey: (key) => log.saved.push(key),
    },
  };
}

test("gate: q quits without saving anything", async () => {
  const { deps, log } = gateDeps(["q"]);
  assert.deepEqual(await runKeyGate(deps), { action: "quit" });
  assert.equal(log.warned.length, 1);
  assert.match(log.warned[0], /isn't valid \(revoked or mistyped\)/);
  assert.match(log.warned[0], /polychat\.co\/auth\?memtree=true/);
  assert.deepEqual(log.saved, []);
});

test("gate: c starts claude without MemTree, as the payment gate does", async () => {
  const { deps, log } = gateDeps(["c"]);
  assert.deepEqual(await runKeyGate(deps), { action: "continue" });
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.saved, []);
});

test("gate: a pasted key that works is saved and its status returned", async () => {
  const paid = { paid: true, message: null, url: null };
  const { deps, log } = gateDeps(["", " good-key "], { "good-key": paid });
  assert.deepEqual(await runKeyGate(deps), { action: "rekeyed", apiKey: "good-key", check: paid });
  assert.deepEqual(log.opened, [KEY_PAGE_URL]);
  assert.deepEqual(log.saved, ["good-key"]);
});

test("gate: an empty paste or another invalid key asks again; the bad key is never saved", async () => {
  const { deps, log } = gateDeps(["", "", "p", "still-bad", "", "ok"], { "still-bad": "invalid" });
  assert.deepEqual(await runKeyGate(deps), { action: "rekeyed", apiKey: "ok", check: null });
  assert.deepEqual(log.saved, ["ok"], "an unknown status (network) still saves the pasted key");
  assert.equal(log.warned.length, 3, "the headline again after each failed attempt");
  assert.deepEqual(log.opened, [KEY_PAGE_URL], "the key page opens once, not per attempt");
  assert.match(log.warned[2], /^⚠ That key isn't valid either\. Get a new one at /);
});

test("print/non-TTY: one stderr line, the run carries on with the old key, no prompt", async () => {
  const { deps, log } = gateDeps([]);
  const lines = [];
  const result = await resolveInvalidKey("invalid", "old", {
    ...deps, interactive: false, command: "ccc", stderrLine: (text) => lines.push(text),
  });
  assert.deepEqual(result, { apiKey: "old", check: "invalid" });
  assert.deepEqual(lines, [keyInvalidLine(KEY_PAGE_URL, "ccc")]);
  assert.deepEqual(log.asked, []);
  assert.deepEqual(log.warned, []);
});

test("resolveInvalidKey: a known status passes through; interactive gates re-key or quit", async () => {
  const none = (text) => assert.fail(`no line expected: ${text}`);
  const paid = { paid: true, message: null, url: null };
  const unpaid = { paid: false, message: null, url: null };
  const base = { interactive: true, command: "ccc", stderrLine: none };
  assert.deepEqual(await resolveInvalidKey(paid, "k", { ...gateDeps([]).deps, ...base }),
    { apiKey: "k", check: paid });
  assert.deepEqual(await resolveInvalidKey(null, "k", { ...gateDeps([]).deps, ...base }),
    { apiKey: "k", check: null });
  assert.equal(await resolveInvalidKey("invalid", "k", { ...gateDeps(["q"]).deps, ...base }), "quit");
  assert.deepEqual(
    await resolveInvalidKey("invalid", "k", { ...gateDeps(["c"]).deps, ...base }),
    { apiKey: "k", check: "invalid" });
  // A new key that is unpaid comes back unpaid, for the payment gate next.
  assert.deepEqual(await resolveInvalidKey("invalid", "k",
    { ...gateDeps(["", "new"], { new: unpaid }).deps, ...base }),
  { apiKey: "new", check: unpaid });
});

// ---------------------------------------------------------------- mid-session

const SESSION = "bad-key-session";
const MODEL = "claude-opus-4-7[1m]";
const history = (tokens) => "x".repeat(tokens * 4);
const humanTurn = (tokens) => [{ role: "user", content: history(tokens) },
  { role: "assistant", content: "prior" }, { role: "user", content: "next" }];

/** Upstream counts and answers; MemTree answers `h.status` until it is 200. */
async function harness(status, extra = {}) {
  const h = { status, delivered: [], calls: [] };
  const upstream = await serve((req, res, raw) => {
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/count_tokens")) {
      return res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
    }
    h.delivered.push(raw);
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "upstream answer" }], stop_reason: "end_turn" }));
  });
  const memory = await serve((req, res, raw) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 202; return res.end("{}"); }
    const indexOnly = raw && JSON.parse(raw).index_only;
    h.calls.push({ status: h.status, indexOnly: Boolean(indexOnly) });
    if (h.status !== 200) {
      res.statusCode = h.status;
      return res.end(h.body ?? JSON.stringify({ detail: h.status === 402
        ? "Payment required" : "Invalid API key" }));
    }
    if (indexOnly) return res.end(JSON.stringify({ messages: [] }));
    const messages = [{ role: "user", content: "saved memory ".repeat(200) }];
    res.end(JSON.stringify({ compressed: true, messages, flattened_messages: messages,
      usage: { indexed_tokens: 990_000, raw_prompt_tokens: 995_000 } }));
  });
  h.memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "revoked" });
  h.proxy = await startProxy({ memtree: h.memtree, upstreamOrigin: upstream.url,
    budgetTokensOverride: 900_000, countTokens: true, ...extra });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

async function post(h, messages) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
    body: JSON.stringify({ model: MODEL, max_tokens: 128_000, messages }),
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function hook(h, input) {
  const res = await fetch(h.proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, ...input }),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

const submit = (h, promptId) =>
  hook(h, { hook_event_name: "UserPromptSubmit", prompt: "next", prompt_id: promptId });
const display = (h, promptId) => hook(h, { hook_event_name: "MessageDisplay",
  turn_id: "t1", message_id: "m1", index: 0, final: true, delta: "upstream answer",
  prompt_id: promptId });

test("the in-session notice: key invalid, the key page bare on its own line, session continues", () => {
  assert.equal(keyInvalidNoticeText(KEY_PAGE_URL),
    "⚠ MemTree is off: your MemTree key isn't valid (revoked or mistyped). " +
    "Get a new one, then run `ccc` in a terminal to paste it:\n" +
    "  https://polychat.co/auth?memtree=true&utm_source=ccc\n" +
    "Your session continues uncompressed.");
});

test("the refusal names the invalid key and the key page, on one line", () => {
  const text = keyInvalidRefusalMessage(KEY_PAGE_URL);
  assert.equal(text,
    "Your MemTree key isn't valid (revoked or mistyped), so this long conversation can't be " +
    "compressed to fit the model's context window. Get a new key at " +
    "https://polychat.co/auth?memtree=true&utm_source=ccc, then run `ccc` in a terminal to paste " +
    "it · " +
    "or start fresh with /clear.");
  assert.ok(!text.includes("\n"));
});

for (const status of [401, 403]) {
  test(`mid-session ${status}: the turn runs uncompressed and says the key is invalid, once`,
    async () => {
      const h = await harness(status);
      try {
        await submit(h, "p1");
        assert.equal((await post(h, humanTurn(1_000))).status, 200);
        assert.equal(h.memtree.keyInvalid, true);
        const shown = await display(h, "p1");
        const text = shown.body.hookSpecificOutput.displayContent;
        assert.match(text, /your MemTree key isn't valid \(revoked or mistyped\)/);
        assert.ok(text.includes(`\n  ${LOCAL_KEY_PAGE_URL}\n`), "key page bare on its own line");
        assert.ok(!text.includes(DEGRADED_NOTICE), text);
        // Throttled like the payment notice: the next turn stays quiet.
        await submit(h, "p2");
        assert.equal((await post(h, humanTurn(1_000))).status, 200);
        assert.equal((await display(h, "p2")).status, 204);
      } finally { h.close(); }
    });

  test(`mid-session ${status} over the window: refused at once naming the invalid key`,
    async () => {
      const h = await harness(status);
      try {
        const refused = await post(h, humanTurn(988_000));
        assert.equal(refused.status, 400, "no pointless 503 retries: a retry cannot fix a key");
        assert.equal(refused.headers.get("x-should-retry"), "false");
        // The fake MemTree is on 127.0.0.1: the local key page.
        assert.equal(JSON.parse(refused.body).error.message,
          keyInvalidRefusalMessage(LOCAL_KEY_PAGE_URL));
        assert.equal(h.delivered.length, 0);
      } finally { h.close(); }
    });
}

test("mid-session: a success after a 401 clears the invalid-key state", async () => {
  const h = await harness(401);
  try {
    await post(h, humanTurn(1_000));
    assert.equal(h.memtree.keyInvalid, true);
    h.status = 200;
    await post(h, humanTurn(1_000));
    assert.equal(h.memtree.keyInvalid, false);
  } finally { h.close(); }
});

test("mid-session 500: still the generic degraded notice (no false alarm)", async () => {
  // Over a 500-token budget: the turn needed compression, so its failure warns.
  const h = await harness(500, { budgetTokensOverride: 500 });
  try {
    await submit(h, "p1");
    await post(h, humanTurn(1_000));
    assert.equal(h.memtree.keyInvalid, false);
    const text = (await display(h, "p1")).body.hookSpecificOutput.displayContent;
    assert.ok(text.includes(DEGRADED_NOTICE));
    assert.doesNotMatch(text, /isn't valid/);
  } finally { h.close(); }
});

test("an invalid-key refusal is not followed by a duplicate key notice", async () => {
  const h = await harness(401);
  try {
    await submit(h, "p1");
    assert.equal((await post(h, humanTurn(988_000))).status, 400);
    assert.equal((await display(h, "p1")).status, 204);
    assert.equal((await hook(h, { hook_event_name: "Stop", prompt_id: "p1" })).status, 204);
    // The refusal counts as shown: a fitting turn inside the interval stays quiet.
    await submit(h, "p2");
    assert.equal((await post(h, humanTurn(1_000))).status, 200);
    assert.equal((await display(h, "p2")).status, 204);
  } finally { h.close(); }
});

test("mid-session bare 403 (WAF, proxy): the generic degraded notice, not a key alarm", async () => {
  // Over a 500-token budget: the turn needed compression, so its failure warns.
  const h = await harness(403, { budgetTokensOverride: 500 });
  h.body = "<html>Attention Required! | Cloudflare</html>";
  try {
    await submit(h, "p1");
    await post(h, humanTurn(1_000));
    assert.equal(h.memtree.keyInvalid, false);
    const text = (await display(h, "p1")).body.hookSpecificOutput.displayContent;
    assert.ok(text.includes(DEGRADED_NOTICE));
  } finally { h.close(); }
});

test("memtree state: the latest answer wins between 402 and 401", async () => {
  const h = await harness(402);
  try {
    await post(h, humanTurn(1_000));
    assert.notEqual(h.memtree.pausedDetail, null);
    assert.equal(h.memtree.keyInvalid, false);
    h.status = 401;
    await post(h, humanTurn(1_000));
    assert.equal(h.memtree.keyInvalid, true);
    assert.equal(h.memtree.pausedDetail, null);
    h.status = 402;
    await post(h, humanTurn(1_000));
    assert.equal(h.memtree.keyInvalid, false);
    assert.notEqual(h.memtree.pausedDetail, null);
  } finally { h.close(); }
});

test("memtree state: a background index call's 401 marks the key invalid", async () => {
  const server = await statusServer(401, { detail: "Invalid API key" });
  const memtree = new MemtreeClient({ baseUrl: server.url, apiKey: "revoked" });
  try {
    memtree.indexInBackground("h1", [{ role: "user", content: "hi" }], 200_000, "s1");
    for (let i = 0; i < 50 && !memtree.keyInvalid; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(memtree.keyInvalid, true);
  } finally { server.close(); }
});

test("memtree state: an aborted call leaves the key state unchanged", async () => {
  let answer = true;
  const server = await serve((req, res) => {
    if (!answer) return; // never answers
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Invalid API key" }));
  });
  const memtree = new MemtreeClient({ baseUrl: server.url, apiKey: "k" });
  try {
    assert.equal(await memtree.compress("h0", [{ role: "user", content: "a" }], 200_000), null);
    assert.equal(memtree.keyInvalid, true);
    answer = false;
    const controller = new AbortController();
    const pending = memtree.compress("h", [{ role: "user", content: "hi" }], 200_000,
      controller.signal);
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(memtree.keyInvalid, true, "an abort says nothing about the key");
  } finally { server.close(); }
});

test("an invalid-key refusal in a subagent's lane keeps the user's key notice due", async () => {
  const h = await harness(401);
  try {
    const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION,
        "x-claude-code-agent-id": "sub-1" },
      body: JSON.stringify({ model: MODEL, max_tokens: 128_000, messages: [
        { role: "user", content: history(988_000) },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
      ] }),
    });
    assert.equal(response.status, 400);
    assert.match(JSON.parse(await response.text()).error.message, /isn't valid/);
    await submit(h, "p1");
    assert.equal((await post(h, humanTurn(1_000))).status, 200);
    const shown = await display(h, "p1");
    assert.match(shown.body.hookSpecificOutput.displayContent, /isn't valid/);
  } finally { h.close(); }
});
