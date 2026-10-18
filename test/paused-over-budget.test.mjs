// MemTree paused (the server answers 402: usage limit reached) on a long session.
// 2026-10-17/18: two paused users (one at ~988k tokens on a 1M window) were refused 47
// times with "couldn't fit … run /ccc:memtree-compact", which also needs MemTree, and
// nothing said MemTree was paused. A paused session must behave like plain Claude Code
// while the request fits the model's window, and say why (and how to resume) once it
// does not.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { PAYMENT_CONTINUES_LINE, PAYMENT_OVER_BUDGET_LINE, PAYMENT_PAUSED_HEADLINE,
  pausedRefusalMessage } from "../dist/payment-notice.js";

const MODEL = "claude-opus-4-7[1m]";
const MAX_TOKENS = 128_000;
const BUDGET = 900_000;
const CHECKOUT_URL =
  "https://app.polychat.co/payment?user_id=u-1&user_email=user%40example.com&price_id=p_1";
const SUBSCRIBE_URL = `${CHECKOUT_URL}&source=ccc`;
const PAYMENT_DETAIL =
  "Payment required for user@example.com on polychat.co for use of MemTree API" +
  `\n\nWe recommend Starter plan for $5/month: ${CHECKOUT_URL}\n\nMemTree compresses.`;
const SESSION = "paused-session";
// Count Tokens reports bytes / 4, so a body's size is chosen by its length.
const history = (tokens) => "x".repeat(tokens * 4);

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

/** Upstream counts and answers; MemTree answers 402 until `h.paid`, then compresses. */
async function harness(extra = {}) {
  const h = { paid: false, down: false, delivered: [], compressCalls: 0 };
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
    if (!indexOnly) h.compressCalls += 1;
    if (h.down) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ detail: "down" }));
    }
    if (!h.paid) {
      res.statusCode = 402;
      return res.end(JSON.stringify({ detail: PAYMENT_DETAIL }));
    }
    if (indexOnly) return res.end(JSON.stringify({ messages: [] }));
    if (h.passthrough) {
      // Nothing compressed yet: the server hands the conversation back, with its page.
      res.setHeader("x-polychat-memtree-url", "https://memtree.example/m/page-1");
      res.setHeader("x-polychat-memtree-index", "index-1");
      return res.end(JSON.stringify({ messages: JSON.parse(raw).messages }));
    }
    const messages = [{ role: "user", content: "saved memory ".repeat(200) }];
    res.end(JSON.stringify({ compressed: true, messages, flattened_messages: messages,
      usage: { indexed_tokens: 990_000, raw_prompt_tokens: 995_000 } }));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  h.memtree = memtree;
  h.proxy = await startProxy({ memtree, upstreamOrigin: upstream.url,
    budgetTokensOverride: BUDGET, countTokens: true, ...extra });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

const humanTurn = (tokens) => [{ role: "user", content: history(tokens) },
  { role: "assistant", content: "prior" }, { role: "user", content: "next" }];
const toolTurn = (tokens) => [{ role: "user", content: history(tokens) },
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }];

async function post(h, messages) {
  const raw = JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages });
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
    body: raw,
  });
  return { raw, status: response.status, headers: response.headers, body: await response.text() };
}

async function hook(h, input) {
  const res = await fetch(h.proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, ...input }),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

const submit = (h, prompt, promptId = "p1") =>
  hook(h, { hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId });
const display = (h, promptId = "p1") => hook(h, { hook_event_name: "MessageDisplay",
  turn_id: "t1", message_id: "m1", index: 0, final: true, delta: "upstream answer",
  prompt_id: promptId });
const stop = (h, promptId = "p1") => hook(h, { hook_event_name: "Stop", prompt_id: promptId });
const errorMessage = (response) => JSON.parse(response.body).error.message;

test("the paused refusal names the pause, the subscribe link and /clear, not memtree-compact", () => {
  const text = pausedRefusalMessage(PAYMENT_DETAIL);
  assert.equal(text,
    "MemTree is paused (usage limit reached), so this long conversation can't be compressed " +
    `to fit the model's context window. Subscribe to resume: ${SUBSCRIBE_URL} · ` +
    "or start fresh with /clear (MemTree keeps what it indexed before the pause).");
  assert.ok(!text.includes("memtree-compact"));
  assert.ok(!text.includes("\n"), "one line");
  // No checkout link in the detail: the pricing page.
  assert.match(pausedRefusalMessage("Payment required"), /resume: https:\/\/polychat\.co\/pricing /);
});

for (const [lane, turn] of [["human", humanTurn], ["tool", toolTurn]]) {
  test(`${lane}: paused and under the native window, the request goes out unchanged`, async () => {
    const h = await harness();
    try {
      // Over the 900k budget, but 977k + the 16k output floor fits 1M.
      const response = await post(h, turn(977_000));
      assert.equal(response.status, 200);
      assert.equal(h.delivered.length, 1);
      assert.equal(h.delivered[0], response.raw, "byte-for-byte, like plain Claude Code");
      assert.ok(h.compressCalls >= 1, "MemTree was asked (and answered 402)");
      assert.notEqual(h.memtree.paymentRequiredDetail, null);
    } finally { h.close(); }
  });

  test(`${lane}: paused and over the native window, refuses at once saying why`, async () => {
    const h = await harness();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await post(h, turn(988_000));
        assert.equal(response.status, 400, `attempt ${attempt}: no pointless 503 retries`);
        assert.equal(response.headers.get("x-should-retry"), "false");
        const message = errorMessage(response);
        assert.equal(message, pausedRefusalMessage(PAYMENT_DETAIL));
        assert.ok(!message.includes("memtree-compact"));
      }
      assert.equal(h.delivered.length, 0, "the oversized history is never forwarded");
    } finally { h.close(); }
  });

  test(`${lane}: once paid, the next request compresses with no restart`, async () => {
    const h = await harness();
    try {
      assert.equal((await post(h, turn(988_000))).status, 400);
      h.paid = true;
      const response = await post(h, turn(988_000));
      assert.equal(response.status, 200);
      assert.equal(h.delivered.length, 1);
      assert.ok(h.delivered[0].length < 100_000, "the compressed history was delivered");
      assert.equal(h.memtree.paymentRequiredDetail, null);
    } finally { h.close(); }
  });
}

test("a paused refusal is not followed by a duplicate paused notice", async () => {
  const h = await harness();
  try {
    await submit(h, "next", "p1");
    const refused = await post(h, humanTurn(988_000));
    assert.equal(refused.status, 400);
    // Whatever hook Claude Code runs after the error, the notice is not repeated.
    assert.equal((await display(h, "p1")).status, 204);
    assert.equal((await stop(h, "p1")).status, 204);
    // The refusal counts as shown: a fitting turn inside the interval stays quiet.
    await submit(h, "smaller", "p2");
    assert.equal((await post(h, humanTurn(977_000))).status, 200);
    assert.equal((await display(h, "p2")).status, 204);
  } finally { h.close(); }
});

test("a fitting paused turn still gets the throttled paused notice", async () => {
  const h = await harness();
  try {
    await submit(h, "next", "p1");
    assert.equal((await post(h, humanTurn(977_000))).status, 200);
    const shown = await display(h, "p1");
    assert.ok(shown.body.hookSpecificOutput.displayContent.includes(PAYMENT_PAUSED_HEADLINE));
    const text = shown.body.hookSpecificOutput.displayContent;
    assert.ok(text.includes(SUBSCRIBE_URL));
    assert.ok(!text.includes("memtree-compact"));
    // Over the budget it is nearing the window: Claude Code's own /compact still works.
    assert.ok(text.includes(PAYMENT_OVER_BUDGET_LINE), text);
    assert.ok(!text.includes(PAYMENT_CONTINUES_LINE), text);
  } finally { h.close(); }
});

test("while paused, /ccc:memtree and /ccc:memtree-compact do not offer compaction", async () => {
  const h = await harness();
  try {
    const before = await submit(h, "/ccc:memtree");
    assert.match(before.body.reason, /memtree-compact/, "offered while not known to be paused");
    assert.equal((await post(h, humanTurn(977_000))).status, 200); // 402: now paused
    const help = await submit(h, "/ccc:memtree");
    assert.ok(!help.body.reason.includes("memtree-compact"), help.body.reason);
    assert.ok(help.body.reason.includes("MemTree is paused"), help.body.reason);
    assert.ok(help.body.reason.includes(SUBSCRIBE_URL), help.body.reason);
    for (const prompt of ["/ccc:memtree-compact", "/memtree-compact 400k"]) {
      const reply = (await submit(h, prompt)).body.reason;
      assert.ok(reply.includes("MemTree is paused"), reply);
      assert.ok(reply.includes(SUBSCRIBE_URL), reply);
      assert.ok(!/compacting:/.test(reply), reply);
    }
    // Turning compaction off needs no MemTree and still works.
    assert.match((await submit(h, "/memtree-compact off")).body.reason, /compaction off/);
    h.paid = true;
    assert.equal((await post(h, humanTurn(977_000))).status, 200); // paid again
    assert.match((await submit(h, "/ccc:memtree")).body.reason, /memtree-compact/);
  } finally { h.close(); }
});

test("an outage after a 402 gets the usual bounded retries, not the paused refusal", async () => {
  const h = await harness();
  try {
    assert.equal((await post(h, humanTurn(988_000))).status, 400); // paused
    h.down = true; // MemTree's latest answer is no longer a 402
    const response = await post(h, humanTurn(988_000));
    assert.equal(response.status, 503);
    assert.ok(!errorMessage(response).includes("paused"));
  } finally { h.close(); }
});

test("a subagent's paused refusal does not use up the user's paused notice", async () => {
  const h = await harness();
  try {
    const raw = JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: toolTurn(988_000) });
    const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
      method: "POST", body: raw, headers: { "content-type": "application/json",
        "x-claude-code-session-id": SESSION, "x-claude-code-agent-id": "agent-1" } });
    assert.equal(response.status, 400);
    assert.match(JSON.parse(await response.text()).error.message, /MemTree is paused/);
    await submit(h, "next", "p1");
    assert.equal((await post(h, humanTurn(977_000))).status, 200);
    const shown = await display(h, "p1");
    assert.ok(shown.body.hookSpecificOutput.displayContent.includes(PAYMENT_PAUSED_HEADLINE));
  } finally { h.close(); }
});

test("the near-window line shows once per session, even inside the throttle", async () => {
  const h = await harness();
  try {
    // A forwarded turn's background index answers 402: paused.
    assert.equal((await post(h, humanTurn(500_000))).status, 200);
    for (let i = 0; i < 100 && h.memtree.paymentRequiredDetail === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(h.memtree.paymentRequiredDetail, null);
    // A resume shows the paused notice and starts the 30-minute throttle.
    const resumed = await hook(h, { hook_event_name: "SessionStart", source: "resume" });
    assert.ok(resumed.body.systemMessage.includes(PAYMENT_PAUSED_HEADLINE));
    assert.ok(!resumed.body.systemMessage.includes(PAYMENT_OVER_BUDGET_LINE));
    // A tool round crosses the budget while it still fits: say /compact works now.
    await submit(h, "go", "p2");
    assert.equal((await post(h, toolTurn(960_000))).status, 200);
    const warned = await display(h, "p2");
    assert.ok(warned.body.hookSpecificOutput.displayContent.includes(PAYMENT_OVER_BUDGET_LINE));
    // Only once.
    assert.equal((await post(h, toolTurn(970_000))).status, 200);
    assert.equal((await display(h, "p2")).status, 204);
  } finally { h.close(); }
});

test("while paused, /ccc:memtree-view drops the /memtree-compact note", async () => {
  const h = await harness();
  try {
    h.paid = true;
    h.passthrough = true;
    await submit(h, "next", "p1");
    assert.equal((await post(h, humanTurn(977_000))).status, 200);
    const before = (await submit(h, "/ccc:memtree-view")).body.reason;
    assert.match(before, /memtree-compact/, "offered while paid");
    h.paid = false;
    await submit(h, "again", "p2");
    assert.equal((await post(h, humanTurn(978_000))).status, 200); // 402: paused
    assert.notEqual(h.memtree.paymentRequiredDetail, null);
    const view = (await submit(h, "/ccc:memtree-view")).body.reason;
    assert.ok(view.includes("memtree.example"), view);
    assert.ok(!view.includes("memtree-compact"), view);
  } finally { h.close(); }
});

for (const [first, firstTurn] of [["tool", toolTurn], ["human", humanTurn]]) {
  for (const refused of [false, true]) {
    test(`${first} near-window line is ${refused ? "withdrawn by" : "shown without"} a refusal`,
      async () => {
        const h = await harness();
        try {
          await submit(h, "go", "p1");
          // Over the budget, still fitting: the line is queued (no display hook yet).
          assert.equal((await post(h, firstTurn(960_000))).status, 200);
          if (refused) assert.equal((await post(h, toolTurn(990_000))).status, 400);
          const after = await stop(h, "p1");
          const text = after.body?.systemMessage ?? "";
          assert.equal(text.includes(PAYMENT_OVER_BUDGET_LINE), !refused, text);
        } finally { h.close(); }
      });
  }
}
