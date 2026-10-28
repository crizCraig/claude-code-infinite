// What Claude itself is told about context under ccc.
// 2026-10-28, a real session (ccc 1.0.30, ~865k tokens, 93% of the window): Claude told the
// user "this session is nearly out of room… run /compact or start a fresh session", which
// throws away what MemTree keeps. Later, with MemTree paused (402: usage limit reached), the
// user asked why they were still blocked after being given credit, and Claude guessed about
// Anthropic Console credits and Claude plan limits: nothing told the model MemTree was paused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { createSessionNoticePlugin, parseNoticeHookInput } from "../dist/hooks.js";
import { MEMTREE_MCP_INSTRUCTIONS } from "../dist/memtree-mcp.js";
import {
  COMPACT_BLOCKED_REASON,
  COMPACT_CONFIRM_WINDOW_MS,
  MEMTREE_ACTIVE_AGAIN_CONTEXT,
  ModelContextNotices,
  keyInvalidModelContext,
  pausedModelContext,
} from "../dist/model-context.js";

const CHECKOUT_URL =
  "https://app.polychat.co/payment?user_id=u-1&user_email=user%40example.com&price_id=p_1";
const SUBSCRIBE_URL = `${CHECKOUT_URL}&source=ccc`;
const ACCOUNT_LINE = "Payment required for user@example.com on polychat.co for use of MemTree API";
const PAYMENT_DETAIL =
  `${ACCOUNT_LINE}\n\nWe recommend Starter plan for $5/month: ${CHECKOUT_URL}\n\nMemTree compresses.`;
const SESSION = "context-session";

// ------------------------------------------------------------------ durable instruction

test("the MCP instructions say context is MemTree's job: no /compact, /clear or fresh session", () => {
  const text = MEMTREE_MCP_INSTRUCTIONS;
  assert.match(text, /Don't recommend \/compact, \/clear or a fresh session to free context/);
  assert.match(text, /\/ccc:memtree-compact/);
  assert.match(text, /paused or off/, "the exception for a paused MemTree is stated");
});

// ------------------------------------------------------------------ notice texts

test("paused context: MemTree not Claude, why, the account, the fix, and /compact as fallback", () => {
  const text = pausedModelContext(PAYMENT_DETAIL, "free_credit_used");
  assert.match(text, /^ccc: MemTree is paused: the free MemTree credit is used up\./);
  assert.ok(text.includes(`"${ACCOUNT_LINE}"`), "the server's account line, for a wrong-account case");
  assert.match(text, /not Claude, the user's Claude plan or Anthropic credits/);
  assert.ok(text.includes(SUBSCRIBE_URL));
  assert.match(text, /support@polychat\.co/);
  assert.match(text, /\/compact .* fallback/);
  assert.match(pausedModelContext(PAYMENT_DETAIL, "plan_limit"),
    /paused: the MemTree plan's usage limit is reached\./);
  assert.match(pausedModelContext(PAYMENT_DETAIL, null), /paused: MemTree usage limit reached\./);
});

test("paused context strips controls from the server's account line", () => {
  const text = pausedModelContext("Payment required\u001b[31m for x\n\nmore", null);
  assert.ok(!text.includes("\u001b"));
  assert.ok(text.includes('"Payment required [31m for x"'), "first line only, controls blanked");
});

test("key-invalid context names MemTree's key and where to get a new one", () => {
  const text = keyInvalidModelContext("https://polychat.co/auth?memtree=true");
  assert.match(text, /^ccc: MemTree is off: the user's MemTree key was refused/);
  assert.match(text, /https:\/\/polychat\.co\/auth\?memtree=true/);
  assert.match(text, /\/compact .* fallback/);
});

test("the notices are short: they cost context", () => {
  assert.ok(pausedModelContext(PAYMENT_DETAIL, "free_credit_used").length < 700);
  assert.ok(MEMTREE_ACTIVE_AGAIN_CONTEXT.length < 200);
});

// ------------------------------------------------------------------ once per change

test("each session is told once per change: paused, then working again, then nothing", () => {
  const notices = new ModelContextNotices();
  const paused = { kind: "paused", text: "PAUSED link-1" };
  assert.equal(notices.next("s", undefined), undefined, "healthy from the start: nothing to say");
  assert.equal(notices.next("s", paused), "PAUSED link-1");
  assert.equal(notices.next("s", paused), undefined, "already in the transcript");
  assert.equal(notices.next("s", { kind: "paused", text: "PAUSED link-2" }), undefined,
    "a refreshed link alone is no news");
  assert.equal(notices.next("s", { kind: "key-invalid", text: "KEY" }), "KEY");
  assert.equal(notices.next("other", paused), "PAUSED link-1", "per session");
  assert.equal(notices.next("s", undefined), MEMTREE_ACTIVE_AGAIN_CONTEXT);
  assert.equal(notices.next("s", undefined), undefined);
  assert.equal(notices.next("s", paused), "PAUSED link-1", "a new pause is told again");
  notices.forget("s");
  assert.equal(notices.next("s", paused), "PAUSED link-1", "after a compaction the notice is gone");
});

// ------------------------------------------------------------------ /compact interception

test("a manual /compact is blocked once with the MemTree note; again within the window runs", () => {
  let now = 1_000;
  const notices = new ModelContextNotices(() => now);
  assert.equal(notices.blockCompact("s", true), COMPACT_BLOCKED_REASON);
  now += COMPACT_CONFIRM_WINDOW_MS - 1;
  assert.equal(notices.blockCompact("s", true), undefined, "asked twice: the user means it");
  assert.equal(notices.blockCompact("s", true), COMPACT_BLOCKED_REASON, "a later one is new");
  now += COMPACT_CONFIRM_WINDOW_MS;
  assert.equal(notices.blockCompact("s", true), COMPACT_BLOCKED_REASON, "too late to confirm");
  assert.equal(notices.blockCompact("other", true), COMPACT_BLOCKED_REASON, "per session");
  assert.equal(notices.blockCompact("p", false), undefined, "MemTree not compressing: never blocked");
  assert.match(COMPACT_BLOCKED_REASON,
    /^MemTree already keeps this session within its budget; \/compact would discard detail\./);
  assert.match(COMPACT_BLOCKED_REASON, /\/ccc:memtree-compact/);
  assert.match(COMPACT_BLOCKED_REASON, /\/compact again/);
});

test("PreCompact hook input parses; the plugin registers it for manual compaction only", async () => {
  const input = { hook_event_name: "PreCompact", session_id: "s", trigger: "manual",
    custom_instructions: null };
  assert.deepEqual(parseNoticeHookInput(input), input);
  assert.equal(parseNoticeHookInput({ ...input, trigger: 3 }), null);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccc-model-context-"));
  const url = "http://127.0.0.1:12345/_ccc/hooks/x";
  const on = createSessionNoticePlugin(url, { tempRoot });
  const off = createSessionNoticePlugin(url, { tempRoot, interceptCompact: false });
  try {
    const read = async (p) =>
      JSON.parse(await fs.readFile(path.join(p.dir, "hooks", "hooks.json"), "utf-8")).hooks;
    assert.deepEqual((await read(on)).PreCompact,
      [{ matcher: "manual", hooks: [{ type: "http", url, timeout: 5 }] }]);
    assert.equal((await read(off)).PreCompact, undefined);
  } finally {
    on.close();
    off.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ through the proxy

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

/** MemTree answers 402 until `h.paid`, then passes the conversation through. */
async function harness() {
  const h = { paid: false };
  const upstream = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const memory = await serve((req, res, raw) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 202; return res.end("{}"); }
    if (!h.paid) {
      res.statusCode = 402;
      return res.end(JSON.stringify({ detail: PAYMENT_DETAIL }));
    }
    const body = JSON.parse(raw);
    if (body.index_only) return res.end(JSON.stringify({ messages: [] }));
    res.end(JSON.stringify({ messages: body.messages }));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  h.memtree = memtree;
  h.turns = 0;
  h.proxy = await startProxy({ memtree, upstreamOrigin: upstream.url });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

/** A new turn (its background index call reaches MemTree), then MemTree's answer settles. */
async function turn(h) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
    body: JSON.stringify({ model: "claude-opus-4-7", max_tokens: 1000,
      messages: [{ role: "user", content: `hello ${h.turns++}` }] }),
  });
  await response.text();
  for (let i = 0; i < 100 && (h.memtree.paymentRequiredDetail === null) !== h.paid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(h.memtree.paymentRequiredDetail === null, h.paid, "MemTree's answer arrived");
}

async function hook(h, input) {
  const res = await fetch(h.proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, ...input }),
  });
  return res.status === 204 ? null : await res.json();
}

const submit = (h, promptId, extra = {}) =>
  hook(h, { hook_event_name: "UserPromptSubmit", prompt: "why am I blocked?",
    prompt_id: promptId, ...extra });
const context = (body) => body?.hookSpecificOutput?.additionalContext;
const preCompact = (h, extra = {}) =>
  hook(h, { hook_event_name: "PreCompact", trigger: "manual", custom_instructions: null, ...extra });

test("proxy: a paused MemTree is told to Claude on the next prompt, once, then its recovery", async () => {
  const h = await harness();
  try {
    assert.equal(context(await submit(h, "p0")), undefined, "nothing known yet");
    await turn(h);
    const told = await submit(h, "p1");
    assert.equal(told.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(context(told), /^ccc: MemTree is paused: /);
    assert.ok(context(told).includes(ACCOUNT_LINE));
    assert.equal(context(await submit(h, "p2")), undefined, "once per change");
    assert.equal(context(await submit(h, "p3", { agent_id: "a1" })), undefined, "not subagents");
    await hook(h, { hook_event_name: "SessionStart", source: "compact" });
    assert.match(context(await submit(h, "p4")), /MemTree is paused/, "compaction dropped it");
    h.paid = true;
    await turn(h);
    assert.equal(context(await submit(h, "p5")), MEMTREE_ACTIVE_AGAIN_CONTEXT);
    assert.equal(context(await submit(h, "p6")), undefined);
  } finally { h.close(); }
});

test("proxy: manual /compact is blocked while MemTree works, allowed while it's paused", async () => {
  const h = await harness();
  try {
    h.paid = true;
    await turn(h);
    assert.deepEqual(await preCompact(h), { decision: "block", reason: COMPACT_BLOCKED_REASON });
    assert.equal(await preCompact(h), null, "the second /compact runs");
    assert.equal(await preCompact(h, { trigger: "auto" }), null, "never blocks auto-compaction");
    assert.equal(await preCompact(h, { agent_id: "a1" }), null, "a subagent's own compaction");
    h.paid = false;
    await turn(h);
    assert.equal(await preCompact(h, { session_id: "fresh" }), null,
      "paused: Claude Code's /compact is the way on");
  } finally { h.close(); }
});
