// One-line notices for image-heavy sessions (2026-11-12, ai-safety-sim cf649598): the
// session's one warning when a request body passes ~20 MB, and a main-lane refusal
// saying a background agent's result may be waiting (lane-activity.ts).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { AGENT_RESULT_WAITING_LINE, HEAVY_REQUEST_BYTES, LaneActivity, RECENT_AGENT_MS,
  heavyRequestNoticeText } from "../dist/lane-activity.js";

const HANG = Symbol("hang");
const COUNT_ERROR = Symbol("count error");
const COUNT_DROP = Symbol("count drop");
const SESSION = "session-1";
const AGENT = { "x-claude-code-agent-id": "agent-1" };

test("heavy-request text names images when they are most of the body", () => {
  assert.equal(heavyRequestNoticeText({ bytes: 22_400_000, imageBytes: 21_000_000 }),
    "⚠ Images are making each turn ~22 MB to upload: slow on weak connections. Fewer or " +
    "smaller images (lower-resolution screenshots or contact sheets) keep turns fast.");
  assert.equal(heavyRequestNoticeText({ bytes: 30_000_000, imageBytes: 1_000_000 }),
    "⚠ Each turn of this session uploads ~30 MB: slow on weak connections.");
});

test("lane activity: heavy once per session, agents recent for a while", () => {
  let now = 0;
  const lanes = new LaneActivity(() => now);
  lanes.seen("s", "main");
  lanes.sent("s", { bytes: HEAVY_REQUEST_BYTES - 1, imageBytes: 0 });
  assert.equal(lanes.heavyDue("s"), undefined);
  assert.equal(lanes.agentRecent("s"), false, "a main-lane request is no agent activity");
  lanes.seen("s", "agent");
  lanes.sent("s", { bytes: 22_000_000, imageBytes: 21_000_000 });
  lanes.sent("s", { bytes: 21_000_000, imageBytes: 20_000_000 });
  assert.deepEqual(lanes.heavyDue("s"), { bytes: 22_000_000, imageBytes: 21_000_000 });
  lanes.markWarned("s");
  lanes.sent("s", { bytes: 27_000_000, imageBytes: 26_000_000 });
  assert.equal(lanes.heavyDue("s"), undefined, "never twice");
  assert.equal(lanes.agentRecent("s"), true);
  assert.equal(lanes.agentRecent("other"), false);
  now += RECENT_AGENT_MS + 1;
  assert.equal(lanes.agentRecent("s"), false);
  assert.equal(lanes.heavyDue(undefined), undefined);
});

test("a heavy agent request warns once, on the session's next main turn", async () => {
  const h = await harness({ compress: () => ({ status: 500, body: { detail: "boom" } }) });
  try {
    const big = heavyImages();
    assert.equal(await h.post(big, AGENT), 200);
    await h.armMainTurn("next question");
    assert.equal(await h.post([{ role: "user", content: "next question" }]), 200);
    const shown = await h.display();
    assert.equal(shown.status, 200);
    const text = shown.body.hookSpecificOutput.displayContent;
    assert.ok(text.includes("Images are making each turn ~21 MB to upload"), text);
    await h.armMainTurn("another question");
    assert.equal(await h.post(big, AGENT), 200);
    assert.equal(await h.post([{ role: "user", content: "another question" }]), 200);
    assert.equal((await h.display()).status, 204, "once per session");
  } finally {
    h.close();
  }
});

test("the heavy notice is the lowest priority: the slow-retry notice replaces it", async () => {
  const h = await harness({ compress: () => ({ status: 500, body: { detail: "boom" } }) });
  try {
    assert.equal(await h.post(heavyImages(), AGENT), 200);
    await h.armMainTurn("next question");
    const messages = followup("h".repeat(1_000_000), "next question");
    assert.equal(await h.post(messages), 503);
    assert.equal(await h.post(messages), 503);
    const text = (await h.display()).body.hookSpecificOutput.displayContent;
    assert.ok(text.includes("MemTree is slow to answer"), text);
    assert.ok(!text.includes("Images are making"), text);
    // Still due: the next turn that has nothing else to say shows it.
    await h.armMainTurn("third question");
    assert.equal(await h.post([{ role: "user", content: "third question" }]), 200);
    const later = (await h.display()).body.hookSpecificOutput.displayContent;
    assert.ok(later.includes("Images are making each turn"), later);
  } finally {
    h.close();
  }
});

test("a refused main turn says an agent's result may be waiting, only after agent traffic",
  async () => {
    for (const agentFirst of [false, true]) {
      const h = await harness({ compress: () => ({ status: 500, body: { detail: "boom" } }) });
      try {
        if (agentFirst) assert.equal(await h.post([{ role: "user", content: "hi" }], AGENT), 200);
        await h.armMainTurn("next question");
        const messages = followup("h".repeat(1_000_000), "next question");
        // 503, 503, then the final 400 that carries the refusal line.
        for (const status of [503, 503, 400]) assert.equal(await h.post(messages), status);
        assert.equal(h.lastText.includes(AGENT_RESULT_WAITING_LINE), agentFirst, h.lastText);
      } finally {
        h.close();
      }
    }
  });

/** 21 small-dimension JPEGs of 1 MB each: ~21 MB, a few hundred visual tokens. */
function heavyImages() {
  const image = { type: "image", source: { type: "base64", media_type: "image/jpeg",
    data: jpeg(100, 100, 1_000_000) } };
  return [{ role: "user", content: [{ type: "text", text: "look" },
    ...Array.from({ length: 21 }, () => image)] }];
}

function jpeg(width, height, chars) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  head.writeUInt16BE(height, 7);
  head.writeUInt16BE(width, 9);
  const filler = Buffer.alloc(Math.ceil(chars * 3 / 4) - head.length, 0x41);
  return Buffer.concat([head, filler]).toString("base64").slice(0, chars);
}

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
  memtreeOptions = {}, countTokens = count !== undefined, toolOutputs, proxyOptions = {} } = {}) {
  const forwards = [], records = [];
  const upstream = await listen(async (req, res) => {
    const body = await readJson(req);
    if (req.url.includes("/count_tokens")) {
      const result = await count(body);
      if (result === HANG) return;
      if (result === COUNT_DROP) return req.socket.destroy();
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
    budgetTokensOverride: budget, countTokens, toolOutputs, ...proxyOptions,
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
    async post(messages, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION,
          ...headers },
        body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }) });
      const text = await res.text();
      this.lastText = text;
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
