// 2026-10-28 incident (pid 45207, staging): a main-lane human turn whose ride
// on the stable prefix lost its planning count to a timeout was over the
// window only by its uncounted bound, so it was not kept as the fallback. The
// compress call then failed, the whole 30 MB history could not fit, ccc
// refused it (503, nothing forwarded), and still showed "MemTree degraded —
// this turn ran uncompressed". Claude Code's retry rode the prefix and worked.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { DEGRADED_NOTICE, SLOW_RETRY_NOTICE } from "../dist/notices.js";
import { RefusalStreaks, SLOW_RETRY_WINDOW_MS } from "../dist/route-fallback.js";
import { ToolOutputStore } from "../dist/tool-output-store.js";

const HANG = Symbol("hang");
/** A count answered 500: failed, not timed out, so delivery does not retry it. */
const COUNT_ERROR = Symbol("count error");
const SESSION = "session-1";

test("a refused degraded turn shows no degraded notice and is followup-refused", async () => {
  const h = await harness({ compress: () => ({ status: 500, body: { detail: "boom" } }) });
  try {
    await h.armMainTurn("next question");
    // ~1 MB of history: over claude-x's 200k window by any estimate, uncountable.
    const messages = followup("h".repeat(1_000_000), "next question");
    assert.equal(await h.post(messages), 503);
    const rec = h.lastRecord();
    assert.equal(rec.turnType, "followup-refused");
    assert.equal(rec.forwardedBytes, 0);
    assert.equal(rec.refusal.attempt, 1);
    assert.equal(rec.degradedNotice, undefined);
    assert.equal(rec.slowRetryNotice, undefined);
    assert.equal(h.forwards.length, 0);
    assert.equal((await h.display()).status, 204, "a single refusal shows nothing");

    // Claude Code's automatic retry is refused again: the calm notice, once.
    assert.equal(await h.post(messages), 503);
    assert.equal(h.lastRecord().refusal.attempt, 2);
    assert.equal(h.lastRecord().slowRetryNotice, true);
    const shown = await h.display();
    assert.equal(shown.status, 200);
    const text = shown.body.hookSpecificOutput.displayContent;
    assert.ok(text.includes(SLOW_RETRY_NOTICE), text);
    assert.ok(!text.includes(DEGRADED_NOTICE), text);
  } finally {
    h.close();
  }
});

test("a degraded turn whose whole history goes out still shows the degraded notice", async () => {
  const h = await harness({ budget: 20, compress: () => ({ status: 500, body: { detail: "boom" } }) });
  try {
    await h.armMainTurn("next question");
    assert.equal(await h.post(followup("short history", "next question")), 200);
    const rec = h.lastRecord();
    assert.equal(rec.turnType, "followup-degraded");
    assert.equal(rec.degradedNotice, "shown");
    const shown = await h.display();
    assert.ok(shown.body.hookSpecificOutput.displayContent.includes(DEGRADED_NOTICE));
  } finally {
    h.close();
  }
});

test("a prefix over the window only by its uncounted bound stays the failed compress's fallback", async () => {
  let hangNext = 0;
  let compressions = 0;
  const hasMemory = (body) => JSON.stringify(body.messages).includes("memory m");
  const h = await harness({
    // The prefix (~450 KB: ~237k by the 1.9 bytes/token bound, over the 200k
    // window) counts at 60k; the whole history at 300k.
    count: (body) => hangNext-- > 0 ? HANG : { input_tokens: hasMemory(body) ? 60_000 : 300_000 },
    usage: (body) => hasMemory(body) ? 60_000 : 300_000,
    compress: () => ++compressions === 1
      ? compressedReply(450_000)
      : { status: 500, body: { detail: "boom" } },
  });
  try {
    const original = followup("x".repeat(600_000), "first task");
    assert.equal(await h.post(original), 200);
    assert.equal(compressions, 1);
    assert.equal(h.lastRecord().turnType, "followup-compressed");

    // The ride's planning count times out; delivery's retry of it answers.
    hangNext = 1;
    await h.armMainTurn("next question");
    const next = [...original, { role: "assistant", content: "next answer" },
      { role: "user", content: "next question" }];
    assert.equal(await h.post(next), 200);
    const rec = h.lastRecord();
    assert.equal(rec.compaction.uncountedOverWindow, true, JSON.stringify(rec.compaction));
    assert.ok(rec.compaction.estimatedTokens < rec.compaction.budgetTokens);
    assert.equal(compressions, 2, "still asks MemTree to compress");
    assert.equal(rec.compress.ok, false);
    assert.equal(rec.turnType, "followup-prefix");
    assert.equal(rec.compaction.keptPrefix, true);
    assert.equal(rec.refusal, undefined);
    assert.equal(rec.degradedNotice, undefined);
    const sent = JSON.stringify(h.forwards.at(-1).messages);
    assert.match(sent, /memory m/);
    assert.match(sent, /next question/);
    const shown = await h.display();
    assert.ok(!JSON.stringify(shown.body ?? {}).includes("MemTree degraded"));
  } finally {
    h.close();
  }
});

/**
 * The incident's shape: a compressed prefix (~450 KB: ~237k by the 1.9
 * bytes/token bound, over claude-x's 200k window) that counts at 60k, then a
 * human turn on it whose first count (the ride's) hangs. `originalTokens`
 * is what the whole history counts at; `compress2` answers the turn's compress.
 */
async function prefixTurn({ originalTokens = 300_000, originalChars = 600_000, compress2,
  memtreeOptions, rideCount = HANG } = {}) {
  let hangNext = 0;
  let compressions = 0;
  const hasMemory = (body) => JSON.stringify(body.messages).includes("memory m");
  const h = await harness({
    memtreeOptions,
    count: (body) => hangNext-- > 0 ? rideCount
      : { input_tokens: hasMemory(body) ? 60_000 : originalTokens },
    usage: (body) => hasMemory(body) ? 60_000 : originalTokens,
    compress: (body) => ++compressions === 1 ? compressedReply(450_000) : compress2(body),
  });
  const original = followup("x".repeat(originalChars), "first task");
  assert.equal(await h.post(original), 200);
  assert.equal(h.lastRecord().turnType, "followup-compressed");
  hangNext = 1;
  await h.armMainTurn("next question");
  const next = [...original, { role: "assistant", content: "next answer" },
    { role: "user", content: "next question" }];
  return { h, status: await h.post(next), rec: h.lastRecord(), compressions: () => compressions };
}

const FAIL = () => ({ status: 500, body: { detail: "boom" } });

test("an uncounted prefix whose count failed (not timed out) is not kept as the fallback", async () => {
  // Delivery does not retry a failed count: its bound alone could never admit it.
  const { h, status, rec } = await prefixTurn({ rideCount: COUNT_ERROR, compress2: FAIL });
  try {
    assert.equal(rec.compaction.uncountedOverWindow, true, JSON.stringify(rec.compaction));
    assert.equal(rec.compaction.keptPrefix, undefined);
    assert.equal(status, 503);
    assert.equal(rec.turnType, "followup-refused");
  } finally {
    h.close();
  }
});

test("an uncounted fallback keeps the long compress budget when the whole history cannot fit", async () => {
  // Short budget: 50 ms + 1 ms/KiB (~1.1 s here); long: 8 s. The answer takes 2.5 s.
  const { h, status, rec } = await prefixTurn({
    memtreeOptions: { compressTimeoutMs: 50, longCompressTimeoutMs: 8_000 },
    compress2: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      return compressedReply(5_000);
    },
  });
  try {
    assert.equal(status, 200);
    assert.equal(rec.compress.ok, true, JSON.stringify(rec.compress));
    assert.equal(rec.turnType, "followup-compressed");
  } finally {
    h.close();
  }
});

test("a failed compress's ride that delivery cannot send, sent whole instead, warns", async () => {
  // The whole history counts at 150k: over the 100k budget, inside the window.
  const { h, status, rec } = await prefixTurn({ originalTokens: 150_000,
    originalChars: 1_400_000, compress2: FAIL });
  try {
    assert.equal(status, 200);
    assert.equal(rec.turnType, "followup-degraded");
    assert.equal(rec.compaction.keptPrefix, undefined);
    assert.equal(rec.degradedNotice, "shown");
    assert.doesNotMatch(JSON.stringify(h.forwards.at(-1).messages), /memory m/);
    const shown = await h.display();
    assert.ok(shown.body.hookSpecificOutput.displayContent.includes(DEGRADED_NOTICE));
  } finally {
    h.close();
  }
});

test("the whole history sent with its tool result truncated still warns (MemTree 413)", async () => {
  const outputs = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-refused-notice-"));
  const quarter = (body) => Math.floor(JSON.stringify(body).length / 4);
  const h = await harness({ count: (body) => ({ input_tokens: quarter(body) }), usage: quarter,
    toolOutputs: new ToolOutputStore(outputs),
    compress: () => ({ status: 413,
      body: { detail: "Request exceeds the context window after compression" } }) });
  try {
    await h.armMainTurn("next question");
    assert.equal(await h.post([
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
        content: "line\n".repeat(200_000) }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "next question" },
    ]), 200);
    const rec = h.lastRecord();
    assert.ok(rec.truncatedToolResult, JSON.stringify(rec));
    assert.equal(rec.degradedNotice, "shown");
    const shown = await h.display();
    assert.ok(shown.body.hookSpecificOutput.displayContent.includes(DEGRADED_NOTICE));
  } finally {
    h.close();
    fs.rmSync(outputs, { recursive: true, force: true });
  }
});

test("refusal streaks: notice on the second within the window, once, reset by delivery", () => {
  const streaks = new RefusalStreaks();
  assert.equal(streaks.refused("a", 0), false);
  assert.equal(streaks.refused("b", 1), false, "lanes are separate");
  assert.equal(streaks.refused("a", 1_000), true);
  assert.equal(streaks.refused("a", 2_000), false, "once per streak");
  streaks.delivered("a");
  assert.equal(streaks.refused("a", 3_000), false);
  assert.equal(streaks.refused("a", 3_000 + SLOW_RETRY_WINDOW_MS + 1), false, "too far apart");
  assert.equal(streaks.refused("a", 4_000 + SLOW_RETRY_WINDOW_MS), true);
  const held = new RefusalStreaks();
  held.refused("c", 0);
  assert.equal(held.refused("c", 1, false), false, "another notice is pending");
  assert.equal(held.refused("c", 2), true, "left for a later refusal of the streak");
  const none = new RefusalStreaks(0);
  assert.equal(none.refused("a", 0), false);
  assert.equal(none.refused("a", 1), false, "no capacity keeps no streak");
});

function followup(history, question) {
  return [
    { role: "user", content: "first question" },
    { role: "assistant", content: history },
    { role: "user", content: question },
  ];
}

function compressedReply(chars, budget = 100_000) {
  const memory = [{ role: "user", content: "memory " + "m".repeat(chars) }];
  return { body: { messages: memory, flattened_messages: memory, compressed: true,
    model_budget_tokens: budget, usage: { prompt_tokens: 300_000, completion_tokens: 50_000,
      prompt_tokens_details: { cached_tokens: 250_000 } } } };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => resolve(JSON.parse(raw)));
  });
}

/** Anthropic (messages + count_tokens), MemTree and a proxy; counting on when `count` is given. */
async function harness({ count, usage = () => 1_000, compress, budget = 100_000,
  memtreeOptions = {}, countTokens = count !== undefined, toolOutputs } = {}) {
  const forwards = [], records = [];
  const upstream = await listen(async (req, res) => {
    const body = await readJson(req);
    if (req.url.includes("/count_tokens")) {
      const result = await count(body);
      if (result === HANG) return;
      if (result === COUNT_ERROR) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "api_error" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(result));
    }
    forwards.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "upstream answer" }], stop_reason: "end_turn",
      usage: { input_tokens: usage(body), output_tokens: 1 } }));
  });
  const memory = await listen(async (req, res) => {
    const body = await readJson(req);
    const custom = body.index_only ? undefined : await compress(body);
    res.writeHead(custom?.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(custom?.body ?? { messages: body.messages, index_only: true }));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: "k", ...memtreeOptions });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin,
    budgetTokensOverride: budget, countTokens, toolOutputs,
    reqlog: { log: (record) => records.push(structuredClone(record)) } });
  const hook = async (input) => {
    const res = await fetch(proxy.hookUrl, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: SESSION, ...input }) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return {
    forwards,
    lastRecord: () => records.filter((r) => r.kind === "messages").at(-1),
    async post(messages) {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
        body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }) });
      await res.text();
      return res.status;
    },
    armMainTurn: (prompt) => hook({ hook_event_name: "UserPromptSubmit", prompt,
      prompt_id: "prompt-main" }),
    display: () => hook({ hook_event_name: "MessageDisplay", turn_id: "turn-1",
      message_id: "message-1", index: 0, final: true, delta: "upstream answer" }),
    close() {
      proxy.close();
      for (const { server } of [upstream, memory]) { server.closeAllConnections(); server.close(); }
    },
  };
}
