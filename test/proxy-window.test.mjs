import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

const LARGE_MODEL = "claude-opus-5";
const SMALL_MODEL = "claude-haiku-4-5";
const WIDE_MEMORY = "retained wide-window memory ".repeat(40_000);
const SMALL_MEMORY = "retained smaller-window memory ".repeat(1_000);
const FOLLOWUP = [
  { role: "user", content: "Inspect the repository." },
  { role: "assistant", content: "original history details ".repeat(90_000) },
  { role: "user", content: "Continue the investigation." },
];

for (const installThroughRecovery of [false, true]) {
  test(`a smaller window rebuilds a wide route with ${installThroughRecovery ? "spent" : "fresh"} recovery allowance`, async () => {
    const fixture = await windowFixture();
    try {
      const original = installThroughRecovery ? extend(FOLLOWUP, "t0") : FOLLOWUP;
      await fixture.post(original);
      const continued = extend(original, "t1");
      await fixture.post(continued, { model: SMALL_MODEL });
      assert.equal(fixture.calls.length, 2, "the new window needs a fresh compression");
      assert.equal(fixture.calls[1].model_context_limit, 200_000);
      assert.equal(fixture.lastRecord().routeRecovery.install, "installed");
      assert.equal(fixture.forwarded.at(-1).messages[0].content, SMALL_MEMORY);

      await fixture.post(extend(continued, "t2"), { model: SMALL_MODEL });
      assert.equal(fixture.calls.length, 2, "the smaller replacement route is reusable");
      assert.equal(fixture.lastRecord().turnType, "tool-memory");
      assert.equal(fixture.forwarded.at(-1).messages[0].content, SMALL_MEMORY);
      assert.equal(fixture.forwarded.at(-1).messages.at(-1).content[0].tool_use_id, "t2");
    } finally {
      await fixture.close();
    }
  });
}

test("an unsuccessful smaller-window recovery is not regranted on unchanged retries", async () => {
  const fixture = await windowFixture({
    compress: (request, index) => index === 0
      ? compressed(WIDE_MEMORY)
      : { compressed: false, messages: request.messages, usage: {} },
  });
  try {
    const original = extend(FOLLOWUP, "t0");
    await fixture.post(original);
    const continued = extend(original, "t1");
    await fixture.post(continued, { model: SMALL_MODEL });
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.lastRecord().routeRecovery.outcome, "noop");
    for (const messages of [continued, extend(continued, "t2")]) {
      await fixture.post(messages, { model: SMALL_MODEL });
      assert.equal(fixture.lastRecord().routeRecovery.outcome, "spent");
      assert.equal(fixture.calls.length, 2, "one extra allowance per reduced capacity");
    }
  } finally {
    await fixture.close();
  }
});

test("a smaller-window recovery in flight holds the lane's allowance", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let arrived;
  const started = new Promise((resolve) => { arrived = resolve; });
  const fixture = await windowFixture({
    compress: async (_request, index) => {
      if (index === 0) return compressed(WIDE_MEMORY);
      arrived();
      await pending;
      return compressed(SMALL_MEMORY);
    },
  });
  let rebuilding;
  try {
    const original = extend(FOLLOWUP, "t0");
    await fixture.post(original);
    const continued = extend(original, "t1");
    rebuilding = fixture.post(continued, { model: SMALL_MODEL });
    await Promise.race([
      started,
      rebuilding.then(() => {
        assert.fail("the smaller-window turn must enter blocking compression");
      }),
    ]);
    await fixture.post(extend(continued, "t2"), { model: SMALL_MODEL });
    assert.equal(fixture.lastRecord().routeRecovery.outcome, "spent");
    assert.equal(fixture.calls.length, 2, "a concurrent miss cannot buy another attempt");
    release();
    await rebuilding;
    assert.equal(fixture.lastRecord().routeRecovery.install, "installed");
  } finally {
    release();
    await rebuilding;
    await fixture.close();
  }
});

test("an oversized replacement route cannot repeatedly regrant the smaller window", async () => {
  const fixture = await windowFixture({ compress: () => compressed(WIDE_MEMORY) });
  try {
    const original = extend(FOLLOWUP, "t0");
    await fixture.post(original);
    const continued = extend(original, "t1");
    await fixture.post(continued, { model: SMALL_MODEL });
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.lastRecord().routeRecovery.install, "installed");
    await fixture.post(extend(continued, "t2"), { model: SMALL_MODEL });
    assert.equal(fixture.lastRecord().routeMiss, "rejected");
    assert.equal(fixture.lastRecord().routeRecovery.outcome, "spent");
    assert.equal(fixture.calls.length, 2, "the attempt already targeted this capacity");
  } finally {
    await fixture.close();
  }
});

test("a completed recovered response can switch windows before its SSE transport closes", async () => {
  const fixture = await windowFixture({ holdFirstStream: true });
  let reader;
  try {
    const original = extend(FOLLOWUP, "t0");
    const response = await fixture.request(original, { stream: true });
    reader = response.body.getReader();
    let received = "";
    while (!received.includes("event: message_stop")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "the first response deliberately remains open");
      received += Buffer.from(chunk.value).toString("utf-8");
    }
    const continued = extend(original, "t1");
    await fixture.post(continued, { model: SMALL_MODEL });
    assert.equal(fixture.calls.length, 2, "a completed wide route can fund smaller recovery");
    assert.equal(fixture.lastRecord().routeRecovery.install, "installed");
    assert.equal(fixture.forwarded.at(-1).messages[0].content, SMALL_MEMORY);
  } finally {
    await reader?.cancel();
    await fixture.close();
  }
});

test("a smaller-window regrant waits for the outage cooldown", async (t) => {
  const fixture = await windowFixture({ status: (_request, index) => index === 1 ? 503 : 200 });
  try {
    const original = extend(FOLLOWUP, "t0");
    await fixture.post(original);
    await fixture.post(extend(original, "other"), {}, {
      "x-claude-code-agent-id": "failing-agent",
    });
    assert.equal(fixture.lastRecord().routeRecovery.outcome, "failed");
    const continued = extend(original, "t1");
    await fixture.post(continued, { model: SMALL_MODEL });
    assert.equal(fixture.lastRecord().routeMiss, "rejected");
    assert.equal(fixture.lastRecord().routeRecovery.outcome, "cooldown");
    assert.equal(fixture.calls.length, 2, "the extra allowance cannot bypass cooldown");
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 61_000);
    await fixture.post(continued, { model: SMALL_MODEL });
    assert.equal(fixture.calls.length, 3, "the deferred allowance survives the cooldown");
    assert.equal(fixture.lastRecord().routeRecovery.install, "installed");
    assert.equal(fixture.forwarded.at(-1).messages[0].content, SMALL_MEMORY);
  } finally {
    await fixture.close();
  }
});

test("a fitting route remains reusable across models with smaller windows", async () => {
  const fixture = await windowFixture({ compress: () => compressed(SMALL_MEMORY) });
  try {
    await fixture.post(FOLLOWUP);
    await fixture.post(extend(FOLLOWUP, "t1"), { model: SMALL_MODEL });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.lastRecord().turnType, "tool-memory");
    assert.equal(fixture.forwarded.at(-1).model, SMALL_MODEL);
  } finally {
    await fixture.close();
  }
});

test("the beta header preserves 1M capacity for a cross-model route", async () => {
  const fixture = await windowFixture();
  try {
    await fixture.post(FOLLOWUP);
    await fixture.post(extend(FOLLOWUP, "t1"), { model: "claude-sonnet-4-5" }, {
      "anthropic-beta": "context-1m-2025-08-07",
    });
    assert.equal(fixture.calls.length, 1, "the resolved header capacity must be honored");
    assert.equal(fixture.lastRecord().turnType, "tool-memory");
    assert.equal(fixture.forwarded.at(-1).messages[0].content, WIDE_MEMORY);
  } finally {
    await fixture.close();
  }
});

test("removing the explicit 1M capacity rebuilds a route without changing model", async () => {
  const fixture = await windowFixture({ nativeOneMillionContext: false });
  try {
    const original = extend(FOLLOWUP, "t0");
    await fixture.post(original, {}, { "anthropic-beta": "context-1m-2025-08-07" });
    await fixture.post(extend(original, "t1"));
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[1].model_context_limit, 200_000);
    assert.equal(fixture.forwarded.at(-1).messages[0].content, SMALL_MEMORY);
  } finally {
    await fixture.close();
  }
});

for (const overhead of ["system", "tools", "max_tokens"]) {
  test(`route window sizing includes ${overhead}`, async () => {
    const nearLimit = "retained memory ".repeat(43_000);
    const extra = overhead === "system"
      ? { system: "Persistent instructions. ".repeat(8_000) }
      : overhead === "tools"
        ? { tools: [{ name: "inspect", description: "Tool documentation. ".repeat(10_000), input_schema: { type: "object" } }] }
        : { max_tokens: 64_000 };
    const fixture = await windowFixture({
      compress: (_request, index) => compressed(index === 0 ? nearLimit : SMALL_MEMORY),
    });
    try {
      await fixture.post(FOLLOWUP, extra);
      await fixture.post(extend(FOLLOWUP, "t1"), { ...extra, model: SMALL_MODEL });
      assert.equal(fixture.calls.length, 2, "message bytes alone understate request capacity");
      assert.equal(fixture.forwarded.at(-1).messages[0].content, SMALL_MEMORY);
    } finally {
      await fixture.close();
    }
  });
}

async function windowFixture({ compress, status, nativeOneMillionContext, holdFirstStream } = {}) {
  const calls = [];
  const forwarded = [];
  const records = [];
  let heldResponse;
  const backend = await listen(async (req, res) => {
    const request = await readBody(req);
    if (request.index_only) return json(res, { index_only: true, messages: [] });
    calls.push(request);
    const response = compress
      ? await compress(request, calls.length - 1)
      : compressed(request.model_context_limit === 1_000_000 ? WIDE_MEMORY : SMALL_MEMORY);
    json(res, response, status?.(request, calls.length - 1) ?? 200);
  });
  const upstream = await listen(async (req, res) => {
    forwarded.push(await readBody(req));
    if (holdFirstStream && forwarded.length === 1) {
      heldResponse = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"held"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      );
      return;
    }
    json(res, {
      type: "message", id: "offline", role: "assistant", model: "offline",
      content: [{ type: "text", text: "answer" }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  const memtree = new MemtreeClient({ baseUrl: backend.origin, apiKey: "offline-test" });
  const proxy = await startProxy({
    memtree, upstreamOrigin: upstream.origin, nativeOneMillionContext,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  async function request(messages, extra = {}, headers = {}) {
    const result = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-claude-code-session-id": "window-session",
        ...headers,
      },
      body: JSON.stringify({ model: LARGE_MODEL, max_tokens: 64, messages, ...extra }),
    });
    assert.equal(result.status, 200);
    return result;
  }
  return {
    calls, forwarded, request,
    lastRecord: () => records.filter((record) => record.kind === "messages").at(-1),
    async post(messages, extra = {}, headers = {}) {
      const result = await request(messages, extra, headers);
      await result.json();
    },
    async close() {
      heldResponse?.end();
      proxy.close();
      await memtree.drainBackground(100);
      backend.close();
      upstream.close();
    },
  };
}

function extend(messages, id) {
  return [...messages,
    { role: "assistant", content: [{ type: "tool_use", id, name: "inspect", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  ];
}

function compressed(content) {
  const messages = [{ role: "user", content }];
  return {
    compressed: true, messages, flattened_messages: messages,
    usage: { prompt_tokens_details: { cached_tokens: 900_000 } },
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
