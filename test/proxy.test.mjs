import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  constants as zlibConstants,
  createGzip,
  createGunzip,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import { startProxy } from "../dist/proxy.js";
import {
  checkCompressedHistory,
  MemtreeClient,
  normalizeMessagesForMemtree,
  rawPromptTokenCount,
} from "../dist/memtree.js";
import {
  NOTICE_OPEN,
  COMPRESSED_NOTICE,
  DEGRADED_NOTICE,
  PAYMENT_REQUIRED_NOTICE,
  wrapNotice,
} from "../dist/notices.js";
import { AWAY_SUMMARY_PROMPT_PREFIX } from "../dist/turns.js";

const GREEN = "\x1b[32m";
const DEFAULT_FOREGROUND = "\x1b[39m";

function assertSuccessNotice(text, answer) {
  const colored = text.startsWith(GREEN);
  assert.equal(
    text,
    `${colored ? GREEN : ""}${COMPRESSED_NOTICE}` +
      `${colored ? DEFAULT_FOREGROUND : ""}\n${answer}`,
    "the notice is the bare copy: no latency, no token totals"
  );
}

const PAYMENT_DETAIL =
  "Payment required for user@example.com on polychat.co for use of MemTree API" +
  "\n\nVisit polychat.co to add payment.\n\nMemTree compresses your context.";
const DETAIL_FIRST_LINE = PAYMENT_DETAIL.split("\n")[0];

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}

const UPSTREAM_BODY = JSON.stringify({
  type: "message",
  id: "msg_upstream",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "upstream answer" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** Mock Anthropic upstream: always a 200 non-streaming message. */
function mockUpstream() {
  return listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
}

/**
 * Mock MemTree server for /v1/context_memory POSTs. `bodyObj` is a plain
 * response object, or a function of (requestBody, callIndex) for tests that
 * need per-call responses — e.g. a memory message that changes between turns,
 * since an unchanged memory message no longer re-queues the success notice.
 */
async function mockMemtree(status, bodyObj) {
  const calls = [];
  const srv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      calls.push(parsed);
      const body = JSON.stringify(
        typeof bodyObj === "function" ? bodyObj(parsed, calls.length - 1) : bodyObj
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  return { ...srv, calls };
}

async function postMessages(port, messages, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }),
  });
  return res.json();
}

async function postCountTokens(port, body, extraHeaders = {}, search = "") {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens${search}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function armMainTurn(proxy, prompt = "typed prompt", promptId = "prompt-main") {
  const res = await fetch(proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt,
      prompt_id: promptId,
    }),
  });
  assert.equal(res.status, 204);
}

async function postHook(proxy, input) {
  const res = await fetch(proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "session-1", ...input }),
  });
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

const displayHook = (overrides = {}) => ({
  hook_event_name: "MessageDisplay",
  turn_id: "turn-1",
  message_id: "message-1",
  index: 0,
  final: false,
  delta: "upstream answer",
  ...overrides,
});

/** Followup user turn: an earlier real user input exists → blocking compress. */
const followupTurn = (question) => [
  { role: "user", content: "first question" },
  { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  { role: "user", content: question },
];

/** Tool turn: last message is a tool_result wrapper → background index only. */
const toolTurn = [
  { role: "user", content: "first question" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
];

async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function within(promise, message, timeoutMs = 1_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("generic passthrough keeps no-body GET responses byte-transparent", async () => {
  const payload = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  const upstream = await listen((req, res) => {
    req.resume();
    req.once("end", () => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(payload.length),
      });
      res.end(payload);
    });
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: upstream.origin, apiKey: "unused" }),
    upstreamOrigin: upstream.origin,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${proxy.port}/healthz?probe=exact`
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    assert.equal(
      await within(proxy.drain(500), "normal GET passthrough did not drain"),
      true
    );
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("forced drain owns passthrough after upstream end but before downstream finish", async () => {
  const path = "/generic-delayed-finish";
  const payload = Buffer.from("byte-transparent passthrough");
  const upstream = await listen((req, res) => {
    req.resume();
    req.once("end", () => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(payload.length),
      });
      res.end(payload);
    });
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: upstream.origin, apiKey: "unused" }),
    upstreamOrigin: upstream.origin,
  });
  const downstreamEndAttempted = deferred();
  const clientClosed = deferred();
  const originalEnd = http.ServerResponse.prototype.end;
  let clientReq;
  let clientRes;
  try {
    // Hold the proxy response at its final end/finish seam. This deterministically
    // models a final flush retained by a backpressured downstream socket while
    // still proving that the proxy has consumed upstream through `end`.
    http.ServerResponse.prototype.end = function (...args) {
      if (
        this.req?.socket?.localPort === proxy.port &&
        this.req?.url === path
      ) {
        downstreamEndAttempted.resolve();
        return this;
      }
      return originalEnd.apply(this, args);
    };

    clientReq = http.get(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path,
      },
      (response) => {
        clientRes = response;
        response.on("error", () => {});
        response.once("close", clientClosed.resolve);
        response.resume();
      }
    );
    clientReq.on("error", () => {});

    await within(
      downstreamEndAttempted.promise,
      "proxy never reached the delayed downstream finish seam"
    );
    http.ServerResponse.prototype.end = originalEnd;

    assert.equal(
      await within(
        proxy.drain(1),
        "forced drain lost ownership of delayed passthrough"
      ),
      false
    );
    await within(clientClosed.promise, "forced drain did not close the client");
    assert.equal(clientRes.destroyed, true);
  } finally {
    http.ServerResponse.prototype.end = originalEnd;
    clientReq?.destroy();
    clientRes?.destroy();
    proxy.close();
    upstream.close();
  }
});

test("forced drain owns an early passthrough response until upload completes", async () => {
  const path = "/generic-early-response";
  const earlyBody = Buffer.from("request rejected early");
  const upstreamRequestStarted = deferred();
  const upstreamSocketClosed = deferred();
  let upstreamReq;
  let upstreamSocket;
  const upstream = await listen((req, res) => {
    upstreamReq = req;
    upstreamSocket = req.socket;
    req.on("error", () => {});
    upstreamSocket.once("close", upstreamSocketClosed.resolve);
    req.resume();
    upstreamRequestStarted.resolve();
    res.writeHead(413, {
      "content-type": "text/plain",
      "content-length": String(earlyBody.length),
      connection: "keep-alive",
    });
    res.end(earlyBody);
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: upstream.origin, apiKey: "unused" }),
    upstreamOrigin: upstream.origin,
  });
  const responseEnded = deferred();
  const clientClosed = deferred();
  let clientReq;
  try {
    clientReq = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(1024 * 1024),
        },
      },
      (response) => {
        response.on("error", () => {});
        response.once("end", responseEnded.resolve);
        response.resume();
      }
    );
    clientReq.on("error", () => {});
    clientReq.once("close", clientClosed.resolve);
    clientReq.write(Buffer.alloc(1024, 7));

    await within(upstreamRequestStarted.promise, "upstream upload never started");
    await within(responseEnded.promise, "early upstream response never completed");
    assert.equal(clientReq.writableEnded, false, "test upload is still incomplete");
    assert.equal(clientReq.destroyed, false, "upload socket remains owned by proxy");

    assert.equal(
      await within(
        proxy.drain(1),
        "forced drain lost ownership of the incomplete upload"
      ),
      false
    );
    await within(clientClosed.promise, "forced drain did not cancel the upload");
    await within(
      upstreamSocketClosed.promise,
      "forced drain did not close the upstream upload socket"
    );
    assert.equal(clientReq.destroyed, true);
    assert.equal(upstreamReq.complete, false, "upstream upload never completed");
    assert.equal(upstreamSocket.destroyed, true);
  } finally {
    clientReq?.destroy();
    upstreamReq?.destroy();
    proxy.close();
    upstream.close();
  }
});

test("rawPromptTokenCount accepts only a positive finite nested usage value", () => {
  const result = (raw_prompt_tokens) => ({
    messages: [{ role: "user", content: "compressed" }],
    usage: { raw_prompt_tokens },
  });
  assert.equal(rawPromptTokenCount(result(393_000)), 393_000);
  for (const invalid of [undefined, null, 0, -1, Number.NaN, Infinity, "393000"]) {
    assert.equal(rawPromptTokenCount(result(invalid)), undefined);
  }
  assert.equal(
    rawPromptTokenCount({ messages: [], usage: "unexpected" }),
    undefined
  );
});

test("successful compression leaves response untouched and prefixes MessageDisplay once", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 123 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        messages: followupTurn("turn two"),
      }),
    });
    assert.equal(await response.text(), UPSTREAM_BODY, "Anthropic body is byte-transparent");

    const first = await postHook(proxy, displayHook());
    assert.equal(first.status, 200);
    assert.equal(
      first.body.hookSpecificOutput.hookEventName,
      "MessageDisplay"
    );
    assertSuccessNotice(
      first.body.hookSpecificOutput.displayContent,
      "upstream answer"
    );
    assert.equal((await postHook(proxy, displayHook())).status, 204, "no duplicate");
    assert.equal(
      (await postHook(proxy, { hook_event_name: "Stop", stop_hook_active: false })).status,
      204,
      "Stop fallback cannot duplicate a claimed MessageDisplay notice"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("compressed SSE queues the success notice before the stream ends", async () => {
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const streamPrefix =
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_stream", usage: { input_tokens: 94_594 } },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "streamed answer" },
    });
  const streamSuffix =
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    }) +
    frame("message_stop", { type: "message_stop" });
  const countBodies = [];
  let releaseStream;
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve;
  });
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (req.url.startsWith("/v1/messages/count_tokens")) {
        countBodies.push(requestBody);
        const compressed = JSON.stringify(requestBody.messages).includes(
          "compressed context"
        );
        const body = JSON.stringify({
          input_tokens: compressed ? 94_594 : 330_272,
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "content-encoding": "gzip",
      });
      const gzip = createGzip();
      gzip.pipe(res);
      gzip.write(streamPrefix);
      gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => {
        void streamGate.then(() => gzip.end(streamSuffix));
      });
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      raw_prompt_tokens: 330_272,
      prompt_tokens_details: { cached_tokens: 123 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const common = {
    model: "claude-x",
    system: "system instructions",
    messages: followupTurn("turn two"),
  };
  let responseDone;
  try {
    await armMainTurn(proxy, "turn two");
    let firstResponseByte;
    const firstByte = new Promise((resolve) => {
      firstResponseByte = resolve;
    });
    responseDone = new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({
        ...common,
        max_tokens: 64,
        stream: true,
      }));
      const request = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          "accept-encoding": "gzip",
        },
      }, (response) => {
        const responseChunks = [];
        response.on("data", (chunk) => {
          responseChunks.push(chunk);
          firstResponseByte();
        });
        response.on("end", () => resolve(Buffer.concat(responseChunks)));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(body);
    });

    await firstByte;
    assert.equal(countBodies.length, 0, "ccc does not issue a Count Tokens request");
    const hook = await postHook(
      proxy,
      displayHook({ delta: "streamed answer" })
    );
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "streamed answer"
    );

    releaseStream();
    const compressedResponse = await responseDone;
    assert.equal(
      gunzipSync(compressedResponse).toString("utf-8"),
      streamPrefix + streamSuffix,
      "the gzip response remains byte-valid and content-exact"
    );
  } finally {
    releaseStream?.();
    await responseDone?.catch(() => {});
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("memory route installs on a followup, so count_tokens sizes the compressed context", async () => {
  const seen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const isCount = req.url.startsWith("/v1/messages/count_tokens");
      seen.push({
        isCount,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
      });
      const body = isCount
        ? JSON.stringify({ input_tokens: 42 })
        : UPSTREAM_BODY;
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const headers = { "x-claude-code-session-id": "session-1" };
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, headers);
    await waitFor(() => seen.some((c) => !c.isCount));

    await postCountTokens(
      proxy.port,
      {
        model: "claude-x",
        messages: [
          ...base,
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        ],
      },
      headers
    );

    const counted = seen.find((c) => c.isCount);
    assert.ok(counted, "count_tokens reached upstream");
    assert.equal(
      counted.body.messages[0].content,
      "compressed context",
      "count_tokens must size the compressed context; counting the full " +
        "history is what makes Claude Code auto-compact"
    );
    assert.ok(
      !JSON.stringify(counted.body.messages).includes("first question"),
      "the uncompressed prefix must not be re-counted"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("memory route survives a mid-loop model switch", async () => {
  const upstreamBodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  const headers = {
    "content-type": "application/json",
    "x-claude-code-session-id": "session-model-switch",
  };
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    const userTurn = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-fable-5",
        max_tokens: 64,
        messages: base,
      }),
    });
    await userTurn.json();
    await waitFor(() => upstreamBodies.length >= 1);

    // Claude Code continues the same turn's tool loop on a different model.
    const toolTurn = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        messages: [
          ...base,
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        ],
      }),
    });
    await toolTurn.json();
    await waitFor(() => upstreamBodies.length >= 2);

    const routed = upstreamBodies[1];
    assert.equal(routed.model, "claude-opus-5", "model passes through untouched");
    assert.equal(
      routed.messages[0].content,
      "compressed context",
      "the tool loop must keep riding the compressed prefix after a model switch"
    );
    assert.ok(
      !JSON.stringify(routed.messages).includes("first question"),
      "the uncompressed prefix must not be re-sent on the fallback model"
    );
    assert.ok(
      JSON.stringify(routed.messages).includes("tool_result"),
      "the current turn's tool suffix rides after the compressed prefix"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("memory route tolerates Claude 2.1.219 system cache-shape churn", async () => {
  const upstreamBodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    // Out of scope here: with recovery on, the changed-system reject would
    // recompress fresh instead of falling to full history, masking the
    // fail-closed no-grafting signal this test asserts on.
    toolRouteRecovery: false,
  });
  const headers = { "x-claude-code-session-id": "session-shape-churn" };
  const billingSystem = (cch, previousRequest) => [
    {
      type: "text",
      text:
        "x-anthropic-billing-header: cc_version=2.1.219; " +
        `cc_entrypoint=cli; cch=${cch};` +
        (previousRequest ? ` cc_prev_req=${previousRequest};` : ""),
    },
    { type: "text", text: "stable system instructions" },
  ];
  const originalMessages = [
    ...followupTurn("turn two"),
    {
      role: "system",
      content: [
        {
          type: "text",
          text: "deferred tool and skill context",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ];
  try {
    await armMainTurn(proxy, "turn two");
    const initialResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: billingSystem("first"),
          messages: originalMessages,
        }),
      }
    );
    await initialResponse.text();

    const toolMessages = structuredClone(originalMessages);
    // Claude 2.1.219 rewrites a one-text-block ambient system message to its
    // string shorthand after the first tool call. It also rotates cch and adds
    // cc_prev_req to the synthetic billing system block.
    toolMessages.at(-1).content = "deferred tool and skill context";
    toolMessages.push(
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      }
    );
    const toolResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: billingSystem("second", "req_second"),
          messages: toolMessages,
        }),
      }
    );
    await toolResponse.text();

    const routed = upstreamBodies.at(-1);
    assert.match(JSON.stringify(routed.messages), /compressed context/);
    assert.doesNotMatch(JSON.stringify(routed.messages), /first question/);
    assert.match(
      JSON.stringify(routed.system),
      /cch=second/,
      "the routed request keeps Claude's current billing metadata"
    );
    assert.match(JSON.stringify(routed.system), /cc_prev_req=req_second/);
    assert.doesNotMatch(
      JSON.stringify(routed.system),
      /cch=first/,
      "the compressed prefix must not retain stale request attribution"
    );

    const changedSystemMessages = [
      ...toolMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "ok" }],
      },
    ];
    const materiallyChangedSystem = billingSystem("third");
    materiallyChangedSystem[1].text = "different system instructions";
    const changedSystemResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: materiallyChangedSystem,
          messages: changedSystemMessages,
        }),
      }
    );
    await changedSystemResponse.text();
    assert.match(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /first question/,
      "real system changes still fail closed to full history"
    );

    const headerLikeMessages = [
      {
        role: "user",
        content:
          "x-anthropic-billing-header: cc_version=fake; cch=conversation-old;",
      },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "turn three" },
    ];
    await armMainTurn(proxy, "turn three");
    const headerLikeInitialResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: billingSystem("fourth", "req_fourth"),
          messages: headerLikeMessages,
        }),
      }
    );
    await headerLikeInitialResponse.text();

    const changedHeaderLikeMessages = structuredClone(headerLikeMessages);
    changedHeaderLikeMessages[0].content =
      "x-anthropic-billing-header: cc_version=fake; cch=conversation-new;";
    changedHeaderLikeMessages.push(
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-3", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-3", content: "ok" }],
      }
    );
    const headerLikeToolResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: billingSystem("fifth", "req_fifth"),
          messages: changedHeaderLikeMessages,
        }),
      }
    );
    await headerLikeToolResponse.text();
    assert.match(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /cch=conversation-new/,
      "header-like conversation text remains part of route identity"
    );
    assert.doesNotMatch(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /compressed context/,
      "conversation drift still fails closed instead of grafting memory"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("memory route drops stale billing headers when the one-header invariant breaks", async () => {
  const upstreamBodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  // The compressed system carries TWO recognizable billing-header blocks, so
  // currentRouteSystem cannot tell which one to rewrite with the current
  // request's metadata. It must not replay the first request's stale
  // cch/cc_prev_req attribution on every tool call in the turn.
  const memtreeSrv = await mockMemtree(200, {
    messages: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text:
              "x-anthropic-billing-header: cc_version=2.1.219; " +
              "cc_entrypoint=cli; cch=first;",
          },
          {
            type: "text",
            text:
              "x-anthropic-billing-header: cc_version=2.1.219; " +
              "cc_entrypoint=cli; cch=first-duplicate;",
          },
          { type: "text", text: "stable system instructions" },
        ],
      },
      { role: "user", content: "compressed context" },
    ],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  const headers = { "x-claude-code-session-id": "session-header-mismatch" };
  const billingSystem = (cch, previousRequest) => [
    {
      type: "text",
      text:
        "x-anthropic-billing-header: cc_version=2.1.219; " +
        `cc_entrypoint=cli; cch=${cch};` +
        (previousRequest ? ` cc_prev_req=${previousRequest};` : ""),
    },
    { type: "text", text: "stable system instructions" },
  ];
  const originalMessages = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    const initialResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: billingSystem("first"),
          messages: originalMessages,
        }),
      }
    );
    await initialResponse.text();

    const toolMessages = [
      ...structuredClone(originalMessages),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      },
    ];
    const toolResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          system: billingSystem("second", "req_second"),
          messages: toolMessages,
        }),
      }
    );
    await toolResponse.text();

    const routed = upstreamBodies.at(-1);
    assert.match(
      JSON.stringify(routed.messages),
      /compressed context/,
      "the tool loop still rides the compressed prefix"
    );
    assert.doesNotMatch(JSON.stringify(routed.messages), /first question/);
    assert.doesNotMatch(
      JSON.stringify(routed.system),
      /cch=first/,
      "the ambiguous compressed headers must not replay stale attribution"
    );
    assert.doesNotMatch(
      JSON.stringify(routed.system),
      /x-anthropic-billing-header/,
      "no attribution beats wrong attribution when grafting is ambiguous"
    );
    assert.match(
      JSON.stringify(routed.system),
      /stable system instructions/,
      "real system instructions survive the header drop"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("typed prompt merged into a tool_result wrapper recompresses instead of sticky passthrough", async () => {
  // The failure this pins down: a prompt typed to recover an interrupted tool
  // loop (or queued mid-turn) is delivered merged into the pending tool_result
  // wrapper. UserPromptSubmit has already cleared the memory route expecting
  // this request to rebuild it, but the merged shape fails isNonToolUserMessage
  // -- so nothing rebuilds, and every later tool turn forwards the full
  // history until the next pure user turn.
  const upstreamBodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    // Out of scope: tool-route recovery would add blocking compresses to the
    // plain tool turns below, polluting the compress-count signal this test
    // uses to detect (non-)promotion of wrappers to user turns.
    toolRouteRecovery: false,
  });
  const headers = { "x-claude-code-session-id": "session-recovery" };
  // Interrupted tool loop: tool_use answered, response lost, user typed
  // "continue". Claude Code merges the typed text into the wrapper.
  const recoveryMessages = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "text", text: "continue" },
      ],
    },
  ];
  try {
    await armMainTurn(proxy, "continue");
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        messages: recoveryMessages,
      }),
    });
    await response.text();

    assert.ok(
      memtreeSrv.calls.some((c) => c.index_only !== true),
      "recovery turn must reach MemTree as a blocking compress, not index-only"
    );
    assert.match(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /compressed context/,
      "recovery turn forwards the compressed context"
    );

    // The rebuilt route must carry the next pure tool turn.
    const toolMessages = [
      ...recoveryMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "x", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
      },
    ];
    const toolResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          messages: toolMessages,
        }),
      }
    );
    await toolResponse.text();
    const lastMessages = JSON.stringify(upstreamBodies.at(-1).messages);
    assert.match(
      lastMessages,
      /compressed context/,
      "tool turn after recovery rides the rebuilt memory route"
    );
    assert.doesNotMatch(
      lastMessages,
      /first question/,
      "tool turn after recovery must not fall back to full history"
    );

    // A plain tool wrapper without an armed typed prompt must stay a tool
    // turn: arm a prompt whose text the wrapper does not contain and verify
    // no new compress fires for it.
    const compressCallsBefore = memtreeSrv.calls.filter(
      (c) => c.index_only !== true
    ).length;
    await armMainTurn(proxy, "unrelated typed prompt");
    const plainToolMessages = [
      ...toolMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t3", name: "x", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }],
      },
    ];
    const plainToolResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          messages: plainToolMessages,
        }),
      }
    );
    await plainToolResponse.text();
    assert.equal(
      memtreeSrv.calls.filter((c) => c.index_only !== true).length,
      compressCallsBefore,
      "a wrapper without the typed text must not be promoted to a user turn"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("prompt substring inside a tool wrapper's system-reminder must not consume the arm", async () => {
  // Misfire this pins down: a short prompt queued mid-turn ("continue") arms
  // the hook and clears the route; an intermediate tool_result wrapper whose
  // appended <system-reminder> (or unrelated mid-sentence text) happens to
  // contain that substring must stay a plain tool turn. If it were promoted,
  // it would consume the arm and pay a blocking compress, and the real merged
  // wrapper arriving next would degrade to sticky full-history passthrough.
  const upstreamBodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    // Out of scope: recovery on the decoy tool turn would blocking-compress
    // (transform-only under the armed window, but a compress all the same),
    // breaking the compress-count signal for arm consumption.
    toolRouteRecovery: false,
  });
  const headers = { "x-claude-code-session-id": "session-reminder-misfire" };
  const baseMessages = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
  ];
  try {
    await armMainTurn(proxy, "continue", "prompt-misfire");

    // Intermediate wrapper: the armed text appears only inside an appended
    // <system-reminder> block and mid-sentence in ordinary trailing text.
    const decoyWrapper = [
      ...baseMessages,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          {
            type: "text",
            text: "<system-reminder>Tests may continue running in the background.</system-reminder>",
          },
          { type: "text", text: "The build will continue after this step." },
        ],
      },
    ];
    await postMessages(proxy.port, decoyWrapper, headers);
    assert.equal(
      memtreeSrv.calls.filter((c) => c.index_only !== true).length,
      0,
      "reminder/mid-sentence substring must not trigger a blocking compress"
    );
    assert.doesNotMatch(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /compressed context/,
      "decoy wrapper forwards as a plain tool turn"
    );

    // The real merged-prompt wrapper arrives next; the preserved arm must
    // still promote it to a compressible recovery turn.
    const recoveryWrapper = [
      ...baseMessages,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "continue" },
        ],
      },
    ];
    await postMessages(proxy.port, recoveryWrapper, headers);
    assert.equal(
      memtreeSrv.calls.filter((c) => c.index_only !== true).length,
      1,
      "real merged-prompt wrapper still owns the arm and compresses"
    );
    assert.match(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /compressed context/,
      "recovery turn forwards the compressed context"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("retried recovery turn after an upstream 529 still compresses instead of sticky passthrough", async () => {
  // The failure this pins down: the recovery wrapper is classified and
  // compressed, but the display arm is consumed before forwarding. When the
  // upstream answers 529/500, Claude Code auto-retries the identical body --
  // with the arm gone and no route installed (delivery failed), the retry
  // used to degrade to a plain tool turn and forward the full history,
  // reintroducing on the retry path exactly the sticky passthrough this
  // feature exists to eliminate.
  const upstreamBodies = [];
  let upstreamCalls = 0;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      upstreamCalls++;
      if (upstreamCalls === 1) {
        // Transient overload on the first attempt only.
        const overloaded = JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        });
        res.writeHead(529, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(overloaded)),
        });
        res.end(overloaded);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  const headers = { "x-claude-code-session-id": "session-recovery-retry" };
  const recoveryMessages = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "text", text: "continue" },
      ],
    },
  ];
  const postRecovery = () =>
    fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        messages: recoveryMessages,
      }),
    });
  try {
    await armMainTurn(proxy, "continue");
    const firstAttempt = await postRecovery();
    await firstAttempt.text();
    assert.equal(firstAttempt.status, 529, "the 529 is relayed to the client");
    assert.match(
      JSON.stringify(upstreamBodies.at(-1).messages),
      /compressed context/,
      "the failed first attempt was classified and compressed"
    );

    // Claude Code's automatic retry of the identical body.
    const retry = await postRecovery();
    await retry.text();
    assert.equal(retry.status, 200);
    const retried = JSON.stringify(upstreamBodies.at(-1).messages);
    assert.match(
      retried,
      /compressed context/,
      "the retry is still the recovery turn and forwards the compressed context"
    );
    assert.doesNotMatch(
      retried,
      /first question/,
      "the retry must not degrade to full-history passthrough"
    );

    // The retry's successful delivery rebuilds the route for the tool loop.
    const toolMessages = [
      ...recoveryMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "x", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
      },
    ];
    await postMessages(proxy.port, toolMessages, headers);
    const lastMessages = JSON.stringify(upstreamBodies.at(-1).messages);
    assert.match(
      lastMessages,
      /compressed context/,
      "tool turn after the retried recovery rides the rebuilt memory route"
    );
    assert.doesNotMatch(
      lastMessages,
      /first question/,
      "tool turn after the retried recovery must not fall back to full history"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

async function assertFastToolRouteActivation(compressed = false) {
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const messageStopFrame = frame("message_stop", { type: "message_stop" });
  const toolResponse =
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_tool", usage: { input_tokens: 42 } },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "x", input: {} },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    }) +
    messageStopFrame;
  const upstreamBodies = [];
  let gzipStream;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      upstreamBodies.push(body);
      if (upstreamBodies.length === 1) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          ...(compressed ? { "content-encoding": "gzip" } : {}),
        });
        // Deliberately leave HTTP open after the logical Anthropic completion.
        // Claude Code may close here as soon as it sees message_stop.
        if (compressed) {
          gzipStream = createGzip();
          gzipStream.pipe(res);
          gzipStream.write(toolResponse);
          gzipStream.flush(zlibConstants.Z_SYNC_FLUSH);
        } else {
          res.write(toolResponse);
        }
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  const headers = { "x-claude-code-session-id": "session-fast-tool" };
  const base = followupTurn("turn two");
  let clientRequest;
  let clientResponse;
  let clientDecoder;
  try {
    await armMainTurn(proxy, "turn two");
    await new Promise((resolve, reject) => {
      const body = Buffer.from(
        JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          stream: true,
          messages: base,
        })
      );
      clientRequest = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            ...headers,
          },
        },
        (response) => {
          clientResponse = response;
          clientDecoder = compressed ? response.pipe(createGunzip()) : response;
          let received = "";
          clientDecoder.setEncoding("utf-8");
          clientDecoder.on("data", (chunk) => {
            received += chunk;
            if (!received.includes(messageStopFrame)) return;
            response.destroy();
            resolve();
          });
          clientDecoder.on("error", () => {});
          response.on("error", () => {});
        }
      );
      clientRequest.once("error", reject);
      clientRequest.end(body);
    });
    await waitFor(() =>
      records.some(
        (record) =>
          record.kind === "messages" &&
          record.turnType === "followup-compressed"
      )
    );

    await postMessages(
      proxy.port,
      [
        ...base,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
      headers
    );

    assert.match(JSON.stringify(upstreamBodies.at(-1).messages), /compressed context/);
    assert.doesNotMatch(JSON.stringify(upstreamBodies.at(-1).messages), /first question/);
    assert.ok(
      records.some(
        (record) =>
          record.kind === "messages" && record.turnType === "tool-memory"
      ),
      "the fast tool follow-up stayed on the compressed prefix"
    );
  } finally {
    clientDecoder?.destroy();
    clientResponse?.destroy();
    clientRequest?.destroy();
    gzipStream?.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
}

test("message_stop activates the memory route before Claude closes the SSE response", async () => {
  await assertFastToolRouteActivation();
});

test("encoded message_stop activates the route before a fast tool request", async () => {
  await assertFastToolRouteActivation(true);
});

async function assertRetryAfterFailedDeliverySurvivesInstalledRoute() {
  // The failure this pins down: a recovery-prompt turn compresses, the
  // upstream protocol completes (message_stop accepted into ServerResponse,
  // which installs the memory route), but the client connection dies before
  // the flush, so forwardRaw resolves delivered=false and mainPromptDelivered
  // stays false. Claude Code then retries the identical body. The surviving
  // route used to veto recovery classification, pushing the retry into the
  // tool path, where the empty suffix made memoryRoutedToolBody reject it
  // into full-history passthrough -- the exact degradation the
  // mainPromptDelivered window exists to prevent. The retry must reclassify
  // as the recovery turn and forward the compressed context.
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const messageStopFrame = frame("message_stop", { type: "message_stop" });
  const sseResponse =
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_rec", usage: { input_tokens: 42 } },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    }) +
    messageStopFrame;
  const upstreamBodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      if (upstreamBodies.length === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Complete the Anthropic protocol but leave HTTP open: the client
        // tears the connection down first, so delivery settles false after
        // the route was already installed at protocol-complete.
        res.write(sseResponse);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  const headers = { "x-claude-code-session-id": "session-dead-flush-retry" };
  // Interrupted tool loop: the typed "continue" is merged into the pending
  // tool_result wrapper (recovery-prompt shape).
  const recoveryMessages = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "text", text: "continue" },
      ],
    },
  ];
  const requestBody = JSON.stringify({
    model: "claude-x",
    max_tokens: 64,
    stream: true,
    messages: recoveryMessages,
  });
  let clientRequest;
  let clientResponse;
  try {
    await armMainTurn(proxy, "continue");
    await new Promise((resolve, reject) => {
      const body = Buffer.from(requestBody);
      clientRequest = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            ...headers,
          },
        },
        (response) => {
          clientResponse = response;
          let received = "";
          response.setEncoding("utf-8");
          response.on("data", (chunk) => {
            received += chunk;
            if (!received.includes(messageStopFrame)) return;
            // The socket dies after the proxy accepted message_stop (route
            // installed) but before the HTTP exchange finishes: delivery
            // settles false.
            response.destroy();
            resolve();
          });
          response.on("error", () => {});
        }
      );
      clientRequest.once("error", reject);
      clientRequest.end(body);
    });
    await waitFor(() =>
      records.some(
        (record) =>
          record.kind === "messages" &&
          record.turnType === "followup-compressed"
      )
    );

    // Claude Code's automatic retry of the identical body.
    const retry = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: requestBody,
    });
    await retry.text();
    assert.equal(retry.status, 200);
    const retried = JSON.stringify(upstreamBodies.at(-1).messages);
    assert.match(
      retried,
      /compressed context/,
      "the retry is still the recovery turn and forwards the compressed context"
    );
    assert.doesNotMatch(
      retried,
      /first question/,
      "the retry must not degrade to full-history tool passthrough"
    );
    assert.equal(
      records.filter(
        (record) =>
          record.kind === "messages" &&
          record.turnType === "followup-compressed"
      ).length,
      2,
      "the retry reclassifies as a compressed followup, not a tool turn"
    );

    // The retry's successful delivery rebuilds the route for the tool loop.
    const toolMessages = [
      ...recoveryMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "x", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
      },
    ];
    await postMessages(proxy.port, toolMessages, headers);
    const lastMessages = JSON.stringify(upstreamBodies.at(-1).messages);
    assert.match(
      lastMessages,
      /compressed context/,
      "tool turn after the retried recovery rides the rebuilt memory route"
    );
    assert.doesNotMatch(
      lastMessages,
      /first question/,
      "tool turn after the retried recovery must not fall back to full history"
    );
  } finally {
    clientResponse?.destroy();
    clientRequest?.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
}

test("identical-body retry after a dead-before-flush delivery still compresses despite the installed route", async () => {
  await assertRetryAfterFailedDeliverySurvivesInstalledRoute();
});

test("successful MemTree no-op does not claim the conversation was compressed", async () => {
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const messages = followupTurn("turn two");
  const memtreeSrv = await mockMemtree(200, {
    messages,
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const json = await postMessages(proxy.port, messages);
    assert.equal(json.content.at(-1).text, "upstream answer");
    assert.deepEqual(
      forwarded,
      { model: "claude-x", max_tokens: 64, messages },
      "cached_tokens=0 is an indexing warm-up no-op, so Anthropic must receive " +
        "the original structured request rather than a flattened rewrite"
    );
    assert.equal((await postHook(proxy, displayHook())).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("MemTree identity is stable when resume omits prior reasoning", () => {
  const beforeSwitch = [
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          signature: "opaque-model-a-signature",
          cache_control: { type: "ephemeral" },
        },
        {
          type: "thinking",
          thinking: "A useful retained thought",
          signature: "another-opaque-signature",
        },
        {
          type: "redacted_thinking",
          data: "opaque-redacted-reasoning",
        },
        {
          type: "tool_use",
          id: "tool-1",
          name: "verify",
          input: { signature: "semantic-tool-input-value" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "   ",
          signature: "thinking-only-message-signature",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: { signature: "semantic-tool-result-value" },
        },
      ],
    },
  ];
  const afterSwitch = structuredClone(beforeSwitch);
  afterSwitch[1].content.splice(0, 3);
  afterSwitch.splice(2, 1);
  const original = structuredClone(beforeSwitch);

  const normalizedBefore = normalizeMessagesForMemtree(beforeSwitch);
  const normalizedAfter = normalizeMessagesForMemtree(afterSwitch);

  assert.deepEqual(normalizedBefore, normalizedAfter);
  assert.equal(
    MemtreeClient.hashMessages(normalizedBefore),
    MemtreeClient.hashMessages(normalizedAfter)
  );
  assert.deepEqual(beforeSwitch, original, "normalization must not mutate Anthropic input");
  assert.doesNotMatch(JSON.stringify(normalizedBefore), /thinking/);
  assert.doesNotMatch(JSON.stringify(normalizedBefore), /opaque-signature/);
  assert.equal(
    normalizedBefore[1].content[0].input.signature,
    "semantic-tool-input-value"
  );
  assert.equal(
    normalizedBefore[2].content[0].content.signature,
    "semantic-tool-result-value"
  );
});

test("primary MemTree requests normalize thinking while Anthropic stays original", async () => {
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "unused" }],
    usage: { prompt_tokens_details: { cached_tokens: 0 } },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    // Out of scope: recovery's blocking compress (and its legacy probe,
    // which deliberately sends RAW messages) would interleave with the
    // index-only requests whose normalization this test asserts on.
    toolRouteRecovery: false,
  });
  const messages = [
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "opaque-signature" },
        { type: "tool_use", id: "tool-1", name: "verify", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "done" },
      ],
    },
  ];
  try {
    await postMessages(proxy.port, messages);
    await waitFor(() => memtreeSrv.calls.length > 0);

    assert.match(JSON.stringify(forwarded), /opaque-signature/);
    assert.doesNotMatch(JSON.stringify(memtreeSrv.calls[0]), /opaque-signature/);
    assert.doesNotMatch(JSON.stringify(memtreeSrv.calls[0]), /"type":"thinking"/);

    const followup = [
      ...messages,
      { role: "assistant", content: [{ type: "text", text: "tool complete" }] },
      { role: "user", content: "next question" },
    ];
    await armMainTurn(proxy, "next question");
    await postMessages(proxy.port, followup);
    await waitFor(() => memtreeSrv.calls.length > 1);

    assert.match(
      JSON.stringify(forwarded),
      /opaque-signature/,
      "the blocking-compress no-op remains exact Anthropic passthrough"
    );
    assert.doesNotMatch(JSON.stringify(memtreeSrv.calls[1]), /opaque-signature/);
    assert.doesNotMatch(JSON.stringify(memtreeSrv.calls[1]), /"type":"thinking"/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a shallow canonical index can reuse a deeper legacy signed-thinking index", async () => {
  const memtreeCalls = [];
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      memtreeCalls.push(payload);
      const isLegacy = JSON.stringify(payload.messages).includes(
        "legacy-thinking-signature"
      );
      const response = {
        messages: isLegacy
          ? [{ role: "user", content: "compressed legacy context" }]
          : [{ role: "user", content: "shallow canonical context" }],
        usage: {
          raw_prompt_tokens: isLegacy ? 177_915 : 150_531,
          prompt_tokens_details: {
            cached_tokens: isLegacy ? 169_543 : 88_211,
          },
        },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  const messages = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          signature: "legacy-thinking-signature",
        },
        { type: "text", text: "first answer" },
      ],
    },
    { role: "user", content: "turn two" },
  ];
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, messages);

    assert.equal(memtreeCalls.length, 2);
    assert.doesNotMatch(JSON.stringify(memtreeCalls[0]), /legacy-thinking-signature/);
    assert.match(JSON.stringify(memtreeCalls[1]), /legacy-thinking-signature/);
    assert.equal(
      forwarded.messages[0].content,
      "compressed legacy context",
      "the normalized lookup starts canonical indexing while the deeper " +
        "legacy hit avoids one oversized turn during migration"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("streaming compression response bytes and content-length remain upstream-exact", async () => {
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const upstreamBody =
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_stream", usage: { input_tokens: 1 } },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "streamed answer" },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    }) +
    frame("message_stop", { type: "message_stop" });
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "content-length": String(Buffer.byteLength(upstreamBody)),
      });
      res.end(upstreamBody);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 123 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        stream: true,
        messages: followupTurn("turn two"),
      }),
    });
    const body = await response.text();
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(upstreamBody)));
    assert.equal(body, upstreamBody);
    const hook = await postHook(proxy, displayHook({ delta: "streamed answer" }));
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "streamed answer"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("captured CC trailing role=system shape is still classified and compressed", async () => {
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 10 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    const messages = [
      ...followupTurn("typed prompt"),
      {
        role: "system",
        content: "The following agent types are no longer available... ambient context",
      },
    ];
    await armMainTurn(proxy, "typed prompt", "prompt-trailing-system");
    await postMessages(proxy.port, messages);
    assert.equal(memtreeSrv.calls.length, 1);
    assert.notEqual(memtreeSrv.calls[0].index_only, true, "blocking compression ran");
    assert.ok(
      memtreeSrv.calls[0].messages.some((m) => m.role === "system" &&
        String(m.content).includes("ambient context")),
      "ambient system block remains in the MemTree payload"
    );
    assert.deepEqual(forwarded.messages, [{ role: "user", content: "compressed context" }]);
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-trailing-system" }))).status,
      200
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("first-user probe does not consume the arm needed by the full followup fallback", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "typed prompt", "prompt-probe");
    await postMessages(proxy.port, [{ role: "user", content: "typed prompt" }]);
    await postMessages(proxy.port, followupTurn("typed prompt"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-probe" }))).status,
      200
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("hidden away-summary queues nothing and cannot disarm an overlapping human prompt", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "visible prompt", "prompt-overlap");
    await postMessages(
      proxy.port,
      followupTurn(`${AWAY_SUMMARY_PROMPT_PREFIX}, 1-2 plain sentences, no markdown.`)
    );
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-overlap" }))).status,
      204,
      "recap itself never arms a notice"
    );

    await postMessages(proxy.port, followupTurn("visible prompt"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-overlap" }))).status,
      200,
      "human arm survived the overlapping recap"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("new UserPromptSubmit during async compression discards the old turn's notice", async () => {
  const upstream = await mockUpstream();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let compressCalls = 0;
  const memtreeSrv = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (body.index_only === true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [], usage: {} }));
      return;
    }
    compressCalls++;
    if (compressCalls === 1) await firstGate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      messages: [{ role: "user", content: "compressed context" }],
      usage: {
        prompt_tokens: 200_000,
        completion_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 1 },
      },
    }));
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "old prompt", "prompt-old");
    const oldRequest = postMessages(proxy.port, followupTurn("old prompt"));
    await waitFor(() => compressCalls === 1);

    // This clears/replaces delivery state while the old MemTree call is still
    // in flight. Its eventual completion must not reinsert a stale notice.
    await armMainTurn(proxy, "new prompt", "prompt-new");
    releaseFirst();
    await oldRequest;
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-old" }))).status,
      204
    );

    await postMessages(proxy.port, followupTurn("new prompt"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-new" }))).status,
      200,
      "replacement prompt still receives its own notice"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("flat index coverage suppresses the repeat compression notice", async () => {
  const upstream = await mockUpstream();
  let indexedTokens = 120_000;
  // Memory text varies every call the way the real server's per-question
  // unfolding does, proving the gate is coverage-driven and not text-driven.
  let call = 0;
  const memtreeSrv = await mockMemtree(200, () => ({
    messages: [{ role: "user", content: `unfolded for question #${++call}` }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: indexedTokens },
    },
  }));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-1" }))).status,
      200,
      "first indexed turn announces the optimization"
    );

    // Same coverage, freshly unfolded text: the index learned nothing new, so
    // this turn was merely appended after it.
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postMessages(proxy.port, followupTurn("turn three"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-2" }))).status,
      204,
      "flat coverage stays quiet even though the memory text changed"
    );

    indexedTokens = 150_000;
    await armMainTurn(proxy, "turn four", "prompt-3");
    await postMessages(proxy.port, followupTurn("turn four"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-3" }))).status,
      200,
      "newly indexed messages announce again"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("Stop-only arm → compress → systemMessage fallback delivers without MessageDisplay", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two", "prompt-stop");
    await postMessages(proxy.port, followupTurn("turn two"));
    const stop = await postHook(proxy, {
      hook_event_name: "Stop",
      stop_hook_active: false,
      prompt_id: "prompt-stop",
    });
    assert.equal(
      // Notice may be ANSI-colored depending on terminal detection; strip codes.
      stop.body.systemMessage.replace(/\x1B\[[0-9;]*m/g, ""),
      COMPRESSED_NOTICE
    );
    assert.equal((await postHook(proxy, displayHook({ prompt_id: "prompt-stop" }))).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("subagent traffic cannot clear, overwrite, or claim a pending main notice", async () => {
  const upstream = await mockUpstream();
  // Index coverage grows per call: this test announces two separate main
  // turns, and flat coverage would suppress the second notice.
  const memtreeSrv = await mockMemtree(200, (_body, call) => ({
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 1_000 * (call + 1) },
    },
  }));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two", "prompt-main");
    await postMessages(proxy.port, followupTurn("turn two"));
    await postHook(proxy, {
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      agent_type: "general-purpose",
      prompt_id: "prompt-main",
    });
    await postMessages(proxy.port, followupTurn("agent work"));
    assert.equal(
      (await postHook(proxy, displayHook({ agent_id: "agent-1", prompt_id: "agent-prompt" }))).status,
      204
    );
    await postHook(proxy, {
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_type: "general-purpose",
      prompt_id: "prompt-main",
    });
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-main" }))).status,
      200
    );

    // Ordering regression: an agent can start before the main API request and
    // repeat the exact human steer in its own prompt. That traffic must not
    // consume the arm intended for the later main request.
    await armMainTurn(proxy, "steered prompt", "prompt-steer");
    await postHook(proxy, {
      hook_event_name: "SubagentStart",
      agent_id: "agent-2",
      agent_type: "general-purpose",
      prompt_id: "prompt-steer",
    });
    await postMessages(proxy.port, followupTurn("agent repeats steered prompt verbatim"));
    await postHook(proxy, {
      hook_event_name: "SubagentStop",
      agent_id: "agent-2",
      agent_type: "general-purpose",
      prompt_id: "prompt-steer",
    });
    await postMessages(proxy.port, followupTurn("steered prompt"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-steer" }))).status,
      200,
      "later main request still owns the arm"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("x-claude-code-agent-id excludes agent requests from main notice ownership", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "shared prompt text", "prompt-header");

    // No lifecycle hook is sent: the explicit CC request header alone must
    // suppress notice ownership, even though the agent repeats the exact main
    // prompt and still follows the normal compression path.
    await postMessages(
      proxy.port,
      followupTurn("agent embeds shared prompt text"),
      { "x-claude-code-agent-id": "agent-from-header" }
    );
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-header" }))).status,
      204,
      "agent request neither queued nor consumed a main notice"
    );

    await postMessages(proxy.port, followupTurn("shared prompt text"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-header" }))).status,
      200,
      "later main request still owns the arm"
    );
    assert.equal(
      memtreeSrv.calls.filter((call) => call.index_only !== true).length,
      2,
      "notice attribution did not change agent compression"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("legacy assistant/system markers are stripped while human marker quotes survive", async () => {
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, { messages: [], usage: {} });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const legacy = wrapNotice(
    "MemTree working - conversation consolidated - <model does not see this message>"
  );
  const humanQuote = `please inspect ${wrapNotice("literal human quote")}`;
  try {
    const messages = [
      { role: "user", content: humanQuote },
      { role: "assistant", content: [{ type: "text", text: `${legacy}real answer` }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        system: `${legacy}real system instructions`,
        messages,
      }),
    });
    await response.text();
    await waitFor(() => memtreeSrv.calls.length > 0);
    for (const payload of [forwarded, memtreeSrv.calls[0]]) {
      const serialized = JSON.stringify(payload);
      assert.ok(serialized.includes("literal human quote"));
      assert.ok(serialized.includes(NOTICE_OPEN), "human quote envelope is preserved");
      assert.ok(!serialized.includes("model does not see this message"));
      assert.ok(serialized.includes("real answer"));
      assert.ok(serialized.includes("real system instructions"));
    }
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("Accept-Encoding and compressed upstream response stay byte-transparent", async () => {
  let acceptedEncoding;
  const compressedBody = gzipSync(Buffer.from(UPSTREAM_BODY));
  const upstream = await listen((req, res) => {
    acceptedEncoding = req.headers["accept-encoding"];
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressedBody.length),
      });
      res.end(compressedBody);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 0 } },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const result = await new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        messages: followupTurn("turn two"),
      }));
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          "accept-encoding": "gzip",
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(acceptedEncoding, "gzip");
    assert.equal(result.headers["content-encoding"], "gzip");
    assert.equal(result.headers["content-length"], String(compressedBody.length));
    assert.deepEqual(result.body, compressedBody);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("Accept-Encoding with only unsupported or q=0 codings falls back to identity", async () => {
  let acceptedEncoding;
  const upstream = await listen((req, res) => {
    acceptedEncoding = req.headers["accept-encoding"];
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 0 } },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    // zstd is unsupported by the observer and identity;q=0 is explicitly
    // refused by the client — neither may survive the intersection, so the
    // forwarded header must fall back to plain identity.
    const result = await postMessages(proxy.port, followupTurn("turn two"), {
      "accept-encoding": "zstd, identity;q=0",
    });
    assert.equal(result.content[0].text, "upstream answer");
    assert.equal(acceptedEncoding, "identity");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("402 payment becomes shown only when hook claims it, then later turns stay quiet", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(402, { detail: PAYMENT_DETAIL });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const first = await postMessages(proxy.port, followupTurn("turn two"));
    assert.equal(first.content[0].text, "upstream answer");
    assert.equal(memtree.paymentRequiredDetail, PAYMENT_DETAIL);

    // A new main prompt replaces the unclaimed first notice. Because it was
    // never delivered, payment is still eligible and is queued again.
    await armMainTurn(proxy, "turn three");
    const second = await postMessages(proxy.port, followupTurn("turn three"));
    assert.equal(second.content[0].text, "upstream answer");
    const delivered = await postHook(proxy, displayHook({ final: true }));
    const text = delivered.body.hookSpecificOutput.displayContent;
    assert.ok(text.includes(PAYMENT_REQUIRED_NOTICE));
    assert.ok(text.includes(DETAIL_FIRST_LINE));
    assert.ok(!text.includes(DEGRADED_NOTICE));
    assert.ok(!text.includes("Visit polychat.co to add payment."), "only detail first line");

    await armMainTurn(proxy, "turn four");
    await postMessages(proxy.port, followupTurn("turn four"));
    assert.equal((await postHook(proxy, displayHook({ final: true }))).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("non-402 compress failure keeps DEGRADED_NOTICE on every degraded turn", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(500, { detail: "boom" });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    for (const q of ["turn two", "turn three"]) {
      await armMainTurn(proxy, q);
      const json = await postMessages(proxy.port, followupTurn(q));
      assert.equal(json.content[0].text, "upstream answer");
      const hook = await postHook(proxy, displayHook({ final: true }));
      assert.equal(
        hook.body.hookSpecificOutput.displayContent,
        `upstream answer\n${DEGRADED_NOTICE}`
      );
    }
    assert.equal(memtree.paymentRequiredDetail, null);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("402 on background index sets unpaid state; next user turn shows payment notice", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(402, { detail: PAYMENT_DETAIL });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    // Out of scope: with recovery on, the tool turn's blocking compress
    // would take the 402 first and suppress the background index whose
    // index_only 402 this test is about.
    toolRouteRecovery: false,
  });
  try {
    // Tool turn: forwarded verbatim (no notice), index_only 402 off the path.
    const toolResp = await postMessages(proxy.port, toolTurn);
    assert.equal(toolResp.content[0].text, "upstream answer");
    await waitFor(() => memtree.paymentRequiredDetail !== null);
    assert.equal(memtree.paymentRequiredDetail, PAYMENT_DETAIL);
    assert.ok(memtreeSrv.calls.some((c) => c.index_only === true));

    await armMainTurn(proxy, "turn two");
    const userResp = await postMessages(proxy.port, followupTurn("turn two"));
    assert.equal(userResp.content[0].text, "upstream answer");
    const hook = await postHook(proxy, displayHook({ final: true }));
    assert.ok(hook.body.hookSpecificOutput.displayContent.includes(PAYMENT_REQUIRED_NOTICE));
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("MemtreeClient records the 402 detail and clears it on a later success", async () => {
  let unpaid = true;
  const srv = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      if (unpaid) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: PAYMENT_DETAIL }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messages: [{ role: "user", content: "compressed" }] }));
      }
    });
  });
  const client = new MemtreeClient({ baseUrl: srv.origin, apiKey: "k" });
  try {
    const msgs = followupTurn("turn two");
    assert.equal(client.paymentRequiredDetail, null);
    const r1 = await client.compress(MemtreeClient.hashMessages(msgs), msgs, 200_000);
    assert.equal(r1, null);
    assert.equal(client.paymentRequiredDetail, PAYMENT_DETAIL);

    unpaid = false; // user paid mid-session
    const msgs2 = followupTurn("turn three");
    const r2 = await client.compress(MemtreeClient.hashMessages(msgs2), msgs2, 200_000);
    assert.ok(r2);
    assert.equal(client.paymentRequiredDetail, null);
  } finally {
    srv.close();
  }
});

test("plain resumed Opus 4.8 gets a native 1M MemTree budget", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    // Out of scope: recovery's blocking compress on the tool turn would
    // displace the index-only call this test inspects at calls[0].
    toolRouteRecovery: false,
  });
  const tools = [
    { name: "Bash", description: "run a command", input_schema: { type: "object" } },
  ];
  const post = async (messages) => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Resume stores the API model id without a [1m] suffix.
        model: "claude-opus-4-8",
        max_tokens: 64,
        tools,
        messages,
      }),
    });
    await res.text();
  };
  try {
    // Tool turn → background index_only call: the server's index_only path
    // returns before budget resolution, so the client saves the upload bytes.
    await post(toolTurn);
    await waitFor(() => memtreeSrv.calls.length >= 1);
    const indexCall = memtreeSrv.calls[0];
    assert.equal(indexCall.index_only, true);
    assert.equal(indexCall.model, undefined, "index-only omits model");
    assert.equal(indexCall.tools, undefined, "index-only omits tools");

    // Followup user turn → blocking compress: model + tools ride along so the
    // server resolves the model-based budget (500k for Fable / Opus 4.8)
    // instead of the static 50k fallback.
    await armMainTurn(proxy, "turn two");
    await post(followupTurn("turn two"));
    const compressCall = memtreeSrv.calls.find((c) => c.index_only !== true);
    assert.ok(compressCall, "blocking compress call reached MemTree");
    assert.equal(compressCall.model, "claude-opus-4-8[1m]");
    assert.equal(compressCall.model_context_limit, 1_000_000);
    assert.deepEqual(compressCall.tools, tools);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("context-1m beta header yields 1M limit and a [1m]-tagged model", async () => {
  // Claude Code signals 1M context via `anthropic-beta: context-1m-*` with a
  // PLAIN model name (it strips the `[1m]` suffix on the wire). The proxy must
  // read the header for extended-context models that are not natively 1M.
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    // Prove the explicit beta remains authoritative even when the client has
    // deliberately disabled native model inference.
    nativeOneMillionContext: false,
  });
  const post = async (messages) => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07,other-flag",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 64,
        messages,
      }),
    });
    await res.text();
  };
  try {
    await post(toolTurn);
    await waitFor(() => memtreeSrv.calls.length >= 1);
    await armMainTurn(proxy, "turn two");
    await post(followupTurn("turn two"));
    const compressCall = memtreeSrv.calls.find((c) => c.index_only !== true);
    assert.ok(compressCall, "blocking compress call reached MemTree");
    assert.equal(compressCall.model_context_limit, 1_000_000);
    assert.equal(compressCall.model, "claude-opus-4-6[1m]");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("MemtreeClient falls back to generic detail on a non-JSON 402 body", async () => {
  const srv = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(402, { "content-type": "text/plain" });
      res.end("payment gateway said no");
    });
  });
  const client = new MemtreeClient({ baseUrl: srv.origin, apiKey: "k" });
  try {
    const msgs = followupTurn("turn two");
    const r = await client.compress(MemtreeClient.hashMessages(msgs), msgs, 200_000);
    assert.equal(r, null);
    assert.equal(client.paymentRequiredDetail, "Payment required");
  } finally {
    srv.close();
  }
});

// --- Regression: fully indexed responses that carry no conversation --------
//
// Reproduces the 2026-07-24 staging incident. MemTree indexed 141/141 messages
// and returned HTTP 200 with cached_tokens covering the whole prompt, but the
// server's whole-request budget (31,864 tokens / 86,032 chars, resolved from a
// fuzzy "opus" family match) was smaller than the request's fixed system+tool
// overhead (123,094 chars). Its allocator clamped remaining to 0, so the body
// came back as system prompt + the current user turn and nothing else. Every
// usage-based signal reported a perfect compression, ccc forwarded 20,305
// tokens, and the model answered as if the session had just started.

/** A prior conversation large enough to be worth protecting. */
function longHistory(question) {
  const para = (n) =>
    `Finding ${n}: ${"the security audit traced this to the request path. ".repeat(12)}`;
  return [
    { role: "user", content: "Audit this codebase for security issues" },
    {
      role: "assistant",
      content: [{ type: "text", text: [1, 2, 3, 4, 5].map(para).join("\n") }],
    },
    { role: "user", content: question },
  ];
}

/** MemTree answer shaped like the incident: full index coverage, no history. */
const emptyMemoryResponse = (currentTurn) => ({
  messages: [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: currentTurn },
  ],
  usage: {
    raw_prompt_tokens: 134_500,
    // Indexed essentially the entire prompt: the unindexed tail is ~100
    // tokens, far under the legacy probe threshold. By every usage measure
    // this is the best possible compression.
    prompt_tokens_details: { cached_tokens: 134_400 },
  },
});

test("checkCompressedHistory rejects a fully indexed response with no conversation", () => {
  const question = "Now output detailed remediation steps";
  const sent = longHistory(question);
  const lost = checkCompressedHistory(emptyMemoryResponse(question), sent);

  assert.equal(lost.usable, false, "an empty answer is not a usable memory");
  assert.equal(lost.currentTurnChars, question.length);
  assert.ok(lost.priorHistoryChars > 2_000, "prior history was substantial");
  assert.equal(
    lost.retainedChars,
    question.length,
    "only the current turn survived"
  );

  // A real compression of the same conversation must still pass.
  const kept = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `${"summarized prior findings. ".repeat(200)}${question}` },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 134_400 } },
    },
    sent
  );
  assert.equal(kept.usable, true);

  // A short conversation legitimately compresses to roughly itself; that must
  // not be mistaken for context loss.
  const short = checkCompressedHistory(
    {
      messages: [{ role: "user", content: "compressed context" }],
      usage: { prompt_tokens_details: { cached_tokens: 5 } },
    },
    followupTurn("turn two")
  );
  assert.equal(short.usable, true, "nothing meaningful was there to lose");
});

test("checkCompressedHistory does not count thinking signatures as retained history", () => {
  const question = "Now output detailed remediation steps";
  const sent = longHistory(question);

  // Legacy-shaped result: the only "prior conversation" is assistant thinking
  // blocks whose opaque signature/data bytes dwarf the retained-history floor.
  // flattenToSingleUserMessage drops signatures (and redacted payloads), so
  // the model would see effectively nothing — this must not count as usable.
  const signatureOnly = {
    messages: [
      { role: "system", content: "SYSTEM PROMPT" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "hm.",
            signature: "QUJD".repeat(600), // ~2.4k chars of opaque base64
          },
          { type: "redacted_thinking", data: "REDACTED".repeat(400) },
        ],
      },
      { role: "user", content: question },
    ],
    usage: { prompt_tokens_details: { cached_tokens: 134_400 } },
  };
  const lost = checkCompressedHistory(signatureOnly, sent);
  assert.equal(
    lost.retainedChars,
    "hm.".length + question.length,
    "only thinking text and the current turn count as retained"
  );
  assert.equal(
    lost.usable,
    false,
    "signature bytes alone must not satisfy the retained-history floor"
  );

  // Real thinking text is genuine conversation and still counts.
  const kept = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "recalling the audit findings in detail. ".repeat(60),
              signature: "QUJD".repeat(600),
            },
          ],
        },
        { role: "user", content: question },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 134_400 } },
    },
    sent
  );
  assert.equal(kept.usable, true, "substantial thinking text is real memory");
});

test("checkCompressedHistory: a server-shrunk current turn cannot sink the score", () => {
  // The user pastes a huge log; the server summarizes the log itself AND
  // returns ample prior-conversation memory. Under the old measurement
  // (retained − sent-current-turn) this scored 35k − 100k, deeply negative,
  // and the best compressions were recorded as followup-empty-memory. Only a
  // VERBATIM echo of the sent turn may be subtracted.
  const pastedLog =
    "2026-07-29T10:00:01Z ERROR request failed with ECONNRESET in worker 7\n".repeat(
      1_450
    ); // ~100k chars
  const sent = [
    { role: "user", content: "Help me debug these crashes" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Sure — paste the logs. ".repeat(200) },
      ],
    },
    { role: "user", content: `Here is the full log:\n${pastedLog}` },
  ];
  const shrunkTurn = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content:
            `${"Prior context: the user is debugging worker crashes. ".repeat(600)}` + // ~30k memory
            "Log summary: repeated ECONNRESET failures in worker 7 around 10:00Z.", // ~5k-style rewrite, not verbatim
        },
      ],
      usage: {
        raw_prompt_tokens: 30_000,
        prompt_tokens_details: { cached_tokens: 29_000 },
      },
    },
    sent
  );
  assert.equal(
    shrunkTurn.usable,
    true,
    "memory plus a rewritten current turn is a usable compression"
  );
  assert.ok(shrunkTurn.retainedChars < shrunkTurn.currentTurnChars,
    "scenario premise: the result is smaller than the sent current turn");

  // Same conversation, but the server echoes only the pasted log back
  // (truncated) with nothing of the prior conversation: still unusable, even
  // though the echo is not the complete sent turn.
  const truncatedEchoOnly = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `Here is the full log:\n${pastedLog}`.slice(0, 40_000) },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 29_000 } },
    },
    sent
  );
  assert.equal(
    truncatedEchoOnly.usable,
    false,
    "a truncated verbatim echo with no prior conversation is still empty memory"
  );

  // Verbatim echo embedded in a larger message with no real memory around it
  // (just sub-floor framing text) is also still empty memory.
  const framedEchoOnly = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content: `The user said:\nHere is the full log:\n${pastedLog}`,
        },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 29_000 } },
    },
    sent
  );
  assert.equal(
    framedEchoOnly.usable,
    false,
    "an embedded verbatim echo must be fully subtracted"
  );
});

test("checkCompressedHistory: a double verbatim echo cannot pass the empty-memory gate", () => {
  // Identical-body retry shape: the first attempt already indexed the current
  // turn, so recency-biased memory returns the just-indexed turn (framed)
  // while the tail replays it verbatim — two copies, zero prior conversation.
  // Under the old Math.min cap the two copies were clamped to one turn's
  // worth of echo and the second copy scored as "retained history".
  const turn = "Retry this exact request body please. ".repeat(139); // ~5.4k chars
  const sent = [
    { role: "user", content: "Investigate the flaky deploy" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking into the deploy pipeline now. ".repeat(250) },
      ],
    },
    { role: "user", content: turn },
  ];
  const doubleEcho = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `Relevant memory:\n${turn}` },
        { role: "user", content: turn },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    doubleEcho.usable,
    false,
    "two verbatim copies of the current turn are still empty memory"
  );

  // Same shape with genuine memory in place of the embedded copy still passes:
  // only verbatim copies are subtracted, once per containing piece.
  const realMemory = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content: `Relevant memory:\n${"the deploy flaked on worker restarts. ".repeat(80)}`,
        },
        { role: "user", content: turn },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    realMemory.usable,
    true,
    "genuine memory plus a single tail echo is a usable compression"
  );
});

test("checkCompressedHistory: two verbatim copies inside ONE text block cannot pass the empty-memory gate", () => {
  // Two overlapping index nodes both return the just-indexed turn and the
  // server concatenates them into a single memory text. Boolean containment
  // subtracts only one copy and lets the second score as retained prior
  // conversation; occurrence counting must subtract both.
  const turn = "Retry this exact request body please. ".repeat(139); // ~5.3k chars
  const sent = [
    { role: "user", content: "Investigate the flaky deploy" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking into the deploy pipeline now. ".repeat(250) },
      ],
    },
    { role: "user", content: turn },
  ];
  const singleBlockDoubleEcho = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `Relevant memory:\n${turn}\n---\n${turn}` },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    singleBlockDoubleEcho.usable,
    false,
    "two verbatim copies concatenated into one text block are still empty memory"
  );
});

test("checkCompressedHistory: an echo fragmented into sub-floor text blocks cannot pass the empty-memory gate", () => {
  // The current turn echoed back as many consecutive 31-char text blocks:
  // each fragment is below the echo length floor, but the blocks are adjacent
  // with nothing between them, so they coalesce back into the verbatim turn
  // and must be subtracted in full.
  const turn = "Retry this exact request body please. ".repeat(139); // ~5.3k chars
  const sent = [
    { role: "user", content: "Investigate the flaky deploy" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking into the deploy pipeline now. ".repeat(250) },
      ],
    },
    { role: "user", content: turn },
  ];
  const fragments = [];
  for (let i = 0; i < turn.length; i += 31) {
    fragments.push({ type: "text", text: turn.slice(i, i + 31) });
  }
  assert.ok(
    fragments.every((f) => f.text.length < 32),
    "scenario premise: every fragment is below the echo floor"
  );
  const fragmentedEcho = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: fragments },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    fragmentedEcho.usable,
    false,
    "a turn echoed as consecutive sub-floor text blocks is still empty memory"
  );
});

test("checkCompressedHistory: small quoted fragments of the current turn are not echo", () => {
  // The current turn quotes a short phrase from earlier in the conversation;
  // genuine memory legitimately contains that same phrase. Fragments below
  // the echo length floor must not be scored as echo, or overlap-heavy turns
  // sink usable results — uncapped, now that every copy above the floor is
  // fully subtracted.
  const fragment = "ECONNRESET in worker 7"; // 22 chars, below the echo floor
  const turn =
    `Why do we keep seeing ${fragment} in the logs? ` +
    "Give a full root-cause analysis with a timeline. ".repeat(20);
  const sent = [
    { role: "user", content: "Help me debug these crashes" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is what the logs show so far. ".repeat(200) },
      ],
    },
    { role: "user", content: turn },
  ];
  // Genuine memory: a summary just under the retained floor on its own, plus
  // small pieces that are substrings of the current turn. Counting those
  // fragments as echo would push the result below the floor.
  const summary =
    "Prior discussion covered the crash timeline and mitigation steps. ".repeat(27); // ~1.8k chars
  const quotedFragments = Array.from({ length: 15 }, () => ({
    type: "text",
    text: fragment,
  }));
  const overlapHeavy = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content: [{ type: "text", text: summary }, ...quotedFragments],
        },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    overlapHeavy.usable,
    true,
    "sub-floor fragments shared with the current turn are retained history, not echo"
  );
});

test("checkCompressedHistory: a framed AND truncated echo cannot pass the empty-memory gate", () => {
  // The shape exact matching missed on both sides at once: a framing prefix
  // means the result text is not a substring of the turn, and truncation
  // means no whole turn piece occurs in the result text — yet ~40k of the
  // text is a verbatim echo and there is zero prior conversation. The
  // probe-and-extend scan must charge the echoed span in full.
  const pastedLog =
    "2026-07-29T10:00:01Z ERROR request failed with ECONNRESET in worker 7\n".repeat(
      1_450
    ); // ~100k chars
  const turn = `Here is the full log:\n${pastedLog}`;
  const sent = [
    { role: "user", content: "Help me debug these crashes" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Sure — paste the logs. ".repeat(200) },
      ],
    },
    { role: "user", content: turn },
  ];
  const framedTruncatedEcho = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `The user said:\n${turn.slice(0, 40_000)}` },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 29_000 } },
    },
    sent
  );
  assert.equal(
    framedTruncatedEcho.usable,
    false,
    "a framed, truncated verbatim echo with no prior conversation is still empty memory"
  );
});

test("checkCompressedHistory: a front-truncated echo is caught by the tail probe", () => {
  // A budget cutoff can also drop the FRONT of the echo: the result carries
  // framing plus the turn's tail. The head of the turn never appears in the
  // text, so only a probe anchored at the turn's tail can find the copy.
  const pastedLog =
    "2026-07-29T10:00:01Z ERROR request failed with ECONNRESET in worker 7\n".repeat(
      1_450
    ); // ~100k chars
  const turn = `Here is the full log:\n${pastedLog}`;
  const sent = [
    { role: "user", content: "Help me debug these crashes" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Sure — paste the logs. ".repeat(200) },
      ],
    },
    { role: "user", content: turn },
  ];
  const frontTruncatedEcho = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `The user said:\n${turn.slice(-40_000)}` },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 29_000 } },
    },
    sent
  );
  assert.equal(
    frontTruncatedEcho.usable,
    false,
    "a framed, front-truncated verbatim echo with no prior conversation is still empty memory"
  );
});

test("checkCompressedHistory: a fragmented echo plus a distinct truncated copy are both charged", () => {
  // One run carries the turn twice: reassembled from sub-floor fragments AND
  // as a separate truncated block. Scoring the run as max(coalesced,
  // per-piece) charged only the larger copy and let the other copy's
  // characters score as retained prior conversation; a single masking scan
  // over the coalesced run must charge each copy once.
  const turn = "Retry this exact request body please. ".repeat(139); // ~5.4k chars
  const sent = [
    { role: "user", content: "Investigate the flaky deploy" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking into the deploy pipeline now. ".repeat(250) },
      ],
    },
    { role: "user", content: turn },
  ];
  const fragments = [];
  for (let i = 0; i < turn.length; i += 31) {
    fragments.push({ type: "text", text: turn.slice(i, i + 31) });
  }
  const bothCopies = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content: [...fragments, { type: "text", text: turn.slice(0, 3_000) }],
        },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    bothCopies.usable,
    false,
    "a fragmented copy plus a truncated copy of the turn are still empty memory"
  );
});

test("checkCompressedHistory: substring turn pieces cannot open an uncharged gap inside a bigger echo", () => {
  // A multi-block turn whose early blocks quote interior spans of a later,
  // larger block. Each early piece is a verbatim substring of the big piece,
  // so scanning pieces in message order let the early pieces' probes pre-mask
  // the INTERIOR of the big piece's single copy in the result: the big
  // piece's head extension capped at the first interior mask and its tail
  // extension stopped at the last one, so the region between the two masks
  // was never charged (~800 of 3,000 chars here). That under-count let an
  // empty memory — a framed copy of the big block plus a sliver of genuine
  // text — clear the retained-history gate.
  const big = Array.from(
    { length: 60 },
    (_, i) =>
      `finding ${String(i).padStart(2, "0")}: unique detail ${i * 7919} traced to module ${i * 31}. `
  )
    .join("")
    .slice(0, 3_000);
  const turn = [
    { type: "text", text: big.slice(500, 700) },
    { type: "text", text: big.slice(1_500, 1_700) },
    { type: "text", text: big },
  ];
  const sent = [
    { role: "user", content: "Summarize what the audit found" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "The audit surfaced these findings in detail. ".repeat(60) },
      ],
    },
    { role: "user", content: turn },
  ];
  const genuine = "Prior sessions established these conclusions about the incident. ".repeat(20); // ~1.3k chars, below the gate
  const maskGap = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `The user said:\n${big}\n\n${genuine}` },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    maskGap.usable,
    false,
    "interior spans quoted by earlier turn blocks must not leave a gap uncharged in the big block's echo"
  );

  // The same result with genuinely enough retained history must still pass:
  // the fix must charge the big block's copy exactly once, not over-charge.
  const enough = "Prior sessions established these conclusions about the incident. ".repeat(35); // ~2.3k chars
  const withRealMemory = checkCompressedHistory(
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: `The user said:\n${big}\n\n${enough}` },
      ],
      usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
    },
    sent
  );
  assert.equal(
    withRealMemory.usable,
    true,
    "genuine memory above the gate beside a single fully-charged echo is usable"
  );
});

test("checkCompressedHistory: probe-dense repeated-pattern echoes are charged exactly once per copy", () => {
  // A 16-char-period blob matches its own 32-char probes at every multiple of
  // the period, so the scan sees a probe hit at thousands of offsets and each
  // one consults the charged-span mask. This shape used to linear-scan the
  // growing span list per hit (quadratic in the run length, synchronous on
  // the response path); the list is now kept sorted and binary-searched. No
  // timing is asserted (timing tests flake) — instead assert the charge
  // accounting stays exact on this shape: two framed copies of the blob are
  // each charged in full (unusable when the leftover genuine text is below
  // the gate) and nothing beyond them is charged (usable when it is above).
  const blob = "0123456789abcdef".repeat(700); // 11,200 chars
  const turn = `Here is the dump:\n${blob}`;
  const sent = [
    { role: "user", content: "Decode this dump for me" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Paste the raw dump and I will decode it. ".repeat(60) },
      ],
    },
    { role: "user", content: turn },
  ];
  const doubleCopy = (genuine) => ({
    messages: [
      { role: "system", content: "SYSTEM PROMPT" },
      {
        role: "user",
        content: `First copy:\n${blob}\nSecond copy:\n${blob}\n${genuine}`,
      },
    ],
    usage: { prompt_tokens_details: { cached_tokens: 10_000 } },
  });
  const belowGate = checkCompressedHistory(
    doubleCopy("Earlier we established the dump format in detail. ".repeat(31)), // ~1.6k chars
    sent
  );
  assert.equal(
    belowGate.usable,
    false,
    "both repeated-pattern copies must be charged in full"
  );
  const aboveGate = checkCompressedHistory(
    doubleCopy("Earlier we established the dump format in detail. ".repeat(48)), // ~2.4k chars
    sent
  );
  assert.equal(
    aboveGate.usable,
    true,
    "repeated-pattern copies must not be charged more than once each"
  );
});

test("a fully indexed empty memory forwards real history instead of amnesia", async () => {
  const question = "Now output detailed remediation steps";
  const records = [];
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, emptyMemoryResponse(question));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, longHistory(question), {
      "x-claude-code-session-id": "session-1",
    });
    await waitFor(() => forwarded !== undefined);

    assert.match(
      JSON.stringify(forwarded.messages),
      /Audit this codebase for security issues/,
      "the model must still see the conversation it is being asked to continue"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /the security audit traced this to the request path/,
      "prior assistant findings must survive"
    );
    assert.ok(
      forwarded.messages.length > 1,
      "an empty memory must not collapse the request to a single turn"
    );

    const turn = records.find((r) => r.kind === "messages");
    assert.equal(
      turn.turnType,
      "followup-empty-memory",
      "the recovery must be visible in the request log, not silent"
    );
    assert.equal(turn.history.usable, false);
    assert.ok(turn.history.priorHistoryChars > 2_000);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("legacy probe prefers the candidate that kept the conversation", async () => {
  const question = "Now output detailed remediation steps";
  // Thinking blocks make the normalized and legacy hashes differ, which is what
  // arms the legacy probe.
  const history = [
    { role: "user", content: "Audit this codebase for security issues" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        {
          type: "text",
          text: `Finding: ${"the audit traced this to the request path. ".repeat(60)}`,
        },
      ],
    },
    { role: "user", content: question },
  ];
  const bodies = [
    // Canonical: perfect index coverage, zero conversation returned.
    emptyMemoryResponse(question),
    // Legacy: a smaller unindexed tail is NOT what should win here — the point
    // is that this one actually carries the conversation.
    {
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content: `${"recovered prior findings. ".repeat(200)}${question}`,
        },
      ],
      usage: {
        raw_prompt_tokens: 134_500,
        prompt_tokens_details: { cached_tokens: 100_000 },
      },
    },
  ];
  let call = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      call += 1;
      // The legs run concurrently, so key the answer off the request shape
      // (only the legacy leg carries thinking blocks), not arrival order.
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      const body = JSON.stringify(bodies[isLegacy ? 1 : 0]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, history, {
      "x-claude-code-session-id": "session-1",
    });
    await waitFor(() => forwarded !== undefined);

    assert.equal(call, 2, "the empty canonical result must trigger the probe");
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered prior findings/,
      "the candidate carrying conversation must win, not the emptier one"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a no-op legacy probe does not end the migration", async () => {
  // Both indexes are cold on a conversation started post-upgrade, so the
  // probe's warm-up no-op answer proves nothing about the canonical index.
  // Even within one conversation, ending the migration on that evidence
  // would permanently disable the probe before the legacy index has ever
  // answered — its deep signature-keyed content would then never be reused.
  const question2 = "second question";
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      if (isLegacy) legacyCalls += 1;
      // Canonical leg always a warm-up no-op; legacy leg a no-op on the first
      // probe (fresh conversation), then a deep usable hit (resumed session).
      const response =
        isLegacy && legacyCalls > 1
          ? {
              messages: [
                {
                  role: "user",
                  content: `${"recovered legacy findings. ".repeat(200)}${question2}`,
                },
              ],
              usage: {
                raw_prompt_tokens: 134_500,
                prompt_tokens_details: { cached_tokens: 100_000 },
              },
            }
          : {
              messages: payload.messages,
              usage: {
                raw_prompt_tokens: 50_000,
                prompt_tokens_details: { cached_tokens: 0 },
              },
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const turnOne = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "legacy-sig" },
        { type: "text", text: "first answer" },
      ],
    },
    { role: "user", content: "turn two" },
  ];
  const turnTwo = [
    ...turnOne,
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    { role: "user", content: question2 },
  ];
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, turnOne);
    assert.equal(legacyCalls, 1, "the first followup probes the legacy shape");

    await armMainTurn(proxy, question2);
    await postMessages(proxy.port, turnTwo);
    assert.equal(
      legacyCalls,
      2,
      "a warm-up no-op on both legs must not mark the migration complete"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered legacy findings/,
      "the later deep legacy hit must still be reachable and win"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an unusable empty canonical answer does not end the migration", async () => {
  // Both legs compressed but neither carries the conversation, and the
  // canonical tail is smaller, so the tie-break favors canonical. Per the
  // shouldProbeLegacyMemtree comment, the emptiest answer must not end the
  // migration: the probe has to stay armed for the turn where the legacy
  // index answers with real content.
  const question = "Now output detailed remediation steps";
  const question2 = "And harden the request path";
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const messagesJson = JSON.stringify(payload.messages);
      const isLegacy = messagesJson.includes('"thinking"');
      const currentTurn = messagesJson.includes(question2) ? question2 : question;
      if (isLegacy) legacyCalls += 1;
      let response;
      if (!isLegacy) {
        // Canonical: perfect coverage (tail ~100), zero conversation returned.
        response = emptyMemoryResponse(currentTurn);
      } else if (legacyCalls === 1) {
        // Legacy: also empty, with a LARGER tail, so canonical "wins" the tie.
        response = {
          ...emptyMemoryResponse(currentTurn),
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 130_000 },
          },
        };
      } else {
        response = {
          messages: [
            {
              role: "user",
              content: `${"recovered prior findings. ".repeat(200)}${currentTurn}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const turnOne = [
    { role: "user", content: "Audit this codebase for security issues" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        {
          type: "text",
          text: `Finding: ${"the audit traced this to the request path. ".repeat(60)}`,
        },
      ],
    },
    { role: "user", content: question },
  ];
  const turnTwo = [
    ...turnOne,
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
    { role: "user", content: question2 },
  ];
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, turnOne);
    assert.equal(legacyCalls, 1, "the unusable canonical answer triggers the probe");

    await armMainTurn(proxy, question2);
    await postMessages(proxy.port, turnTwo);
    assert.equal(
      legacyCalls,
      2,
      "an empty canonical answer winning an empty tie must not end the migration"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered prior findings/,
      "the legacy index that finally carries the conversation must win"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a clean fresh conversation does not disable the probe for a resumed legacy session", async () => {
  // The migration flag is scoped per session. A conversation started
  // post-upgrade can produce the strongest possible migration-ending
  // evidence — a clean canonical win against a REAL compressed legacy answer
  // (the probe leg itself warms a legacy index server-side, so fresh
  // conversations manufacture exactly this) — yet that says nothing about a
  // pre-upgrade session /resume'd later in the same run, whose deep
  // signature-keyed legacy index must stay reachable. A process-global flag
  // would be set by the fresh conversation's contest and permanently disable
  // the resumed session's probe.
  const freshQuestion = "fresh turn two";
  const resumedQuestion = "resumed pre-upgrade turn";
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const messagesJson = JSON.stringify(payload.messages);
      const isLegacy = messagesJson.includes('"thinking"');
      const isResumed = messagesJson.includes(resumedQuestion);
      if (isLegacy) legacyCalls += 1;
      let response;
      if (isLegacy && isResumed) {
        // The resumed pre-upgrade session has a deep legacy index.
        response = {
          messages: [
            {
              role: "user",
              content: `${"recovered legacy findings. ".repeat(200)}${resumedQuestion}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      } else if (isLegacy && !isResumed) {
        // Fresh conversation's legacy leg: a REAL compressed answer (warmed
        // by the probe's own earlier writes) that loses to canonical on tail
        // size — a genuine lost contest, the strongest migration-ending
        // evidence a fresh conversation can produce.
        response = {
          messages: [
            {
              role: "user",
              content: `${"stale probe-warmed legacy memory. ".repeat(200)}${freshQuestion}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      } else if (!isLegacy && !isResumed) {
        // Fresh conversation's canonical answer: compressed, usable, and a
        // tiny unindexed tail — the strongest outcome shouldProbe can see.
        response = {
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            {
              role: "user",
              content: `${"compressed canonical memory. ".repeat(200)}${freshQuestion}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 134_400 },
          },
        };
      } else {
        // The resumed session's cold canonical index: warm-up no-op.
        response = {
          messages: payload.messages,
          usage: {
            raw_prompt_tokens: 50_000,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const freshTurn = [
    { role: "user", content: "fresh first question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "fresh-sig" },
        { type: "text", text: "fresh first answer" },
      ],
    },
    { role: "user", content: freshQuestion },
  ];
  const resumedTurn = [
    { role: "user", content: "Audit this codebase for security issues" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old reasoning", signature: "legacy-sig" },
        {
          type: "text",
          text: `Finding: ${"the audit traced this to the request path. ".repeat(60)}`,
        },
      ],
    },
    { role: "user", content: resumedQuestion },
  ];
  try {
    await armMainTurn(proxy, freshQuestion);
    await postMessages(proxy.port, freshTurn, {
      "x-claude-code-session-id": "session-fresh",
    });
    assert.equal(legacyCalls, 1, "the fresh conversation's followup still probes");
    assert.match(
      JSON.stringify(forwarded.messages),
      /compressed canonical memory/,
      "the fresh conversation's clean canonical answer wins its own turn"
    );

    await armMainTurn(proxy, resumedQuestion, "prompt-resumed");
    await postMessages(proxy.port, resumedTurn, {
      "x-claude-code-session-id": "session-resumed",
    });
    assert.equal(
      legacyCalls,
      2,
      "another session's won contest must not end the migration for this session"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered legacy findings/,
      "the resumed session's deep legacy index must still be probed and win"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("the same conversation stops probing after a real lost contest", async () => {
  // The counterpart to per-session scoping: once THIS conversation's
  // canonical index has caught up against a real compressed legacy answer,
  // its later turns must skip the probe — an ended migration stops paying
  // the double-compress tax within that conversation. Posted without a
  // session header to cover the fallback keying by the conversation's first
  // message.
  const question = "second question";
  const question2 = "third question";
  let legacyCalls = 0;
  let canonicalCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const messagesJson = JSON.stringify(payload.messages);
      const isLegacy = messagesJson.includes('"thinking"');
      const currentTurn = messagesJson.includes(question2) ? question2 : question;
      let response;
      if (isLegacy) {
        legacyCalls += 1;
        // A real compressed legacy answer with a much larger unindexed tail
        // than canonical: a genuine contest that the legacy index loses.
        response = {
          messages: [
            {
              role: "user",
              content: `${"stale legacy memory. ".repeat(200)}${currentTurn}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      } else {
        canonicalCalls += 1;
        // Canonical: compressed, usable, tiny unindexed tail — caught up.
        response = {
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            {
              role: "user",
              content: `${"compressed canonical memory. ".repeat(200)}${currentTurn}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 134_400 },
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const turnOne = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        { type: "text", text: "first answer" },
      ],
    },
    { role: "user", content: question },
  ];
  const turnTwo = [
    ...turnOne,
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    { role: "user", content: question2 },
  ];
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, turnOne);
    assert.equal(legacyCalls, 1, "the first followup probes the legacy shape");
    assert.equal(canonicalCalls, 1);
    assert.match(
      JSON.stringify(forwarded.messages),
      /compressed canonical memory/,
      "the caught-up canonical answer wins the contest"
    );

    await armMainTurn(proxy, question2, "prompt-third");
    await postMessages(proxy.port, turnTwo);
    assert.equal(
      legacyCalls,
      1,
      "a real lost contest ends the migration for this conversation — no more probes"
    );
    assert.equal(canonicalCalls, 2, "the canonical leg alone serves later turns");
    assert.match(
      JSON.stringify(forwarded.messages),
      /compressed canonical memory/,
      "later turns forward the canonical compression"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a subagent's lost contest does not end the main conversation's migration", async () => {
  // Subagent requests carry the SAME x-claude-code-session-id as the main
  // thread and are distinguished only by x-claude-code-agent-id. A
  // session-only migration key would let a multi-turn subagent's shallow
  // legacy index lose a genuine contest within a couple of turns and mark
  // the shared session complete — permanently skipping the probe for the
  // main conversation's much deeper, never-contested legacy index.
  const subQuestion = "subagent turn two";
  const mainQuestion = "resumed pre-upgrade main turn";
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const messagesJson = JSON.stringify(payload.messages);
      const isLegacy = messagesJson.includes('"thinking"');
      const isMain = messagesJson.includes(mainQuestion);
      if (isLegacy) legacyCalls += 1;
      let response;
      if (isLegacy && isMain) {
        // The main conversation's deep pre-upgrade legacy index.
        response = {
          messages: [
            {
              role: "user",
              content: `${"recovered legacy findings. ".repeat(200)}${mainQuestion}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      } else if (isLegacy) {
        // Subagent's legacy leg: a REAL compressed answer that loses to the
        // subagent's canonical answer on tail size — a genuine lost contest.
        response = {
          messages: [
            {
              role: "user",
              content: `${"shallow subagent legacy memory. ".repeat(200)}${subQuestion}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      } else if (!isMain) {
        // Subagent's canonical answer: compressed, usable, tiny measured
        // tail — the strongest migration-ending outcome for ITS conversation.
        response = {
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            {
              role: "user",
              content: `${"compressed canonical memory. ".repeat(200)}${subQuestion}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 134_400 },
          },
        };
      } else {
        // The main conversation's cold canonical index: warm-up no-op.
        response = {
          messages: payload.messages,
          usage: {
            raw_prompt_tokens: 50_000,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const subagentTurn = [
    { role: "user", content: "subagent task prompt" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "sub reasoning", signature: "sub-sig" },
        { type: "text", text: "subagent first answer" },
      ],
    },
    { role: "user", content: subQuestion },
  ];
  const mainTurn = [
    { role: "user", content: "Audit this codebase for security issues" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old reasoning", signature: "legacy-sig" },
        {
          type: "text",
          text: `Finding: ${"the audit traced this to the request path. ".repeat(60)}`,
        },
      ],
    },
    { role: "user", content: mainQuestion },
  ];
  try {
    await postMessages(proxy.port, subagentTurn, {
      "x-claude-code-session-id": "session-shared",
      "x-claude-code-agent-id": "agent-worker-1",
    });
    assert.equal(legacyCalls, 1, "the subagent's followup probes the legacy shape");
    assert.match(
      JSON.stringify(forwarded.messages),
      /compressed canonical memory/,
      "the subagent's clean canonical answer wins its own contest"
    );

    await armMainTurn(proxy, mainQuestion, "prompt-main-resumed");
    await postMessages(proxy.port, mainTurn, {
      "x-claude-code-session-id": "session-shared",
    });
    assert.equal(
      legacyCalls,
      2,
      "the subagent's lost contest must not end the main conversation's probe"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered legacy findings/,
      "the main conversation's deep legacy index must still be probed and win"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("headerless migration keys stay stable per conversation and distinct across identical openers", async () => {
  // Without the session header the key derives from conversation content.
  // messages[0] alone collides across conversations that open with identical
  // user text ("hi"): one conversation's won contest would wrongly end the
  // other's probe. Folding in messages[1] (the first assistant reply) keeps
  // the key stable across turns of one conversation while separating
  // conversations whose openers merely share the first user message.
  const questionA = "conversation A second question";
  const questionA2 = "conversation A third question";
  const questionB = "conversation B second question";
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const messagesJson = JSON.stringify(payload.messages);
      const isLegacy = messagesJson.includes('"thinking"');
      const currentTurn = messagesJson.includes(questionA2)
        ? questionA2
        : messagesJson.includes(questionB)
          ? questionB
          : questionA;
      if (isLegacy) legacyCalls += 1;
      const response = isLegacy
        ? {
            // Real compressed legacy answer that loses on tail size: the
            // strongest migration-ending contest each conversation can have.
            messages: [
              {
                role: "user",
                content: `${"stale legacy memory. ".repeat(200)}${currentTurn}`,
              },
            ],
            usage: {
              raw_prompt_tokens: 134_500,
              prompt_tokens_details: { cached_tokens: 100_000 },
            },
          }
        : {
            // Canonical: compressed, usable, tiny measured tail — caught up.
            messages: [
              { role: "system", content: "SYSTEM PROMPT" },
              {
                role: "user",
                content: `${"compressed canonical memory. ".repeat(200)}${currentTurn}`,
              },
            ],
            usage: {
              raw_prompt_tokens: 134_500,
              prompt_tokens_details: { cached_tokens: 134_400 },
            },
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  const upstream = await mockUpstream();
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const turnA = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning A", signature: "sig-a" },
        { type: "text", text: "hello from conversation A" },
      ],
    },
    { role: "user", content: questionA },
  ];
  const turnA2 = [
    ...turnA,
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
    { role: "user", content: questionA2 },
  ];
  const turnB = [
    { role: "user", content: "hi" }, // identical first user message
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning B", signature: "sig-b" },
        { type: "text", text: "hello from conversation B" },
      ],
    },
    { role: "user", content: questionB },
  ];
  try {
    await armMainTurn(proxy, questionA, "prompt-a1");
    await postMessages(proxy.port, turnA);
    assert.equal(legacyCalls, 1, "conversation A's first followup probes");

    await armMainTurn(proxy, questionA2, "prompt-a2");
    await postMessages(proxy.port, turnA2);
    assert.equal(
      legacyCalls,
      1,
      "the fallback key is stable across turns: A's ended migration skips A's later probe"
    );

    await armMainTurn(proxy, questionB, "prompt-b1");
    await postMessages(proxy.port, turnB);
    assert.equal(
      legacyCalls,
      2,
      "an identical opening user message must not inherit conversation A's ended migration"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an unmeasured contest (no raw_prompt_tokens anywhere) does not end the migration", async () => {
  // Both legs return compressed, usable answers whose usage lacks
  // raw_prompt_tokens, so neither tail is measurable. That makes
  // isBetterLegacyMemtreeResult return false — but a "win" awarded only
  // because no measurement exists is no contest, and must not mark the
  // migration complete: the probe has to stay armed until the tails are
  // actually measured.
  const question = "second question";
  const question2 = "third question";
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const messagesJson = JSON.stringify(payload.messages);
      const isLegacy = messagesJson.includes('"thinking"');
      const currentTurn = messagesJson.includes(question2) ? question2 : question;
      if (isLegacy) legacyCalls += 1;
      let response;
      if (isLegacy && legacyCalls > 1) {
        // The later, measured deep legacy hit that must still be reachable.
        response = {
          messages: [
            {
              role: "user",
              content: `${"recovered legacy findings. ".repeat(200)}${currentTurn}`,
            },
          ],
          usage: {
            raw_prompt_tokens: 134_500,
            prompt_tokens_details: { cached_tokens: 100_000 },
          },
        };
      } else if (isLegacy) {
        // First legacy probe: compressed and usable, but no raw_prompt_tokens.
        response = {
          messages: [
            {
              role: "user",
              content: `${"unmeasured legacy memory. ".repeat(200)}${currentTurn}`,
            },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 90_000 } },
        };
      } else if (currentTurn === question) {
        // First canonical answer: compressed and usable, but no
        // raw_prompt_tokens — no tail evidence on either side.
        response = {
          messages: [
            {
              role: "user",
              content: `${"unmeasured canonical memory. ".repeat(200)}${currentTurn}`,
            },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 100_000 } },
        };
      } else {
        // Second turn's canonical leg: warm-up no-op, so the measured deep
        // legacy hit wins outright if the probe is still armed.
        response = {
          messages: payload.messages,
          usage: {
            raw_prompt_tokens: 50_000,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const turnOne = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "legacy-sig" },
        { type: "text", text: "first answer" },
      ],
    },
    { role: "user", content: question },
  ];
  const turnTwo = [
    ...turnOne,
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    { role: "user", content: question2 },
  ];
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, turnOne);
    assert.equal(legacyCalls, 1, "the first followup probes the legacy shape");

    await armMainTurn(proxy, question2, "prompt-third");
    await postMessages(proxy.port, turnTwo);
    assert.equal(
      legacyCalls,
      2,
      "an unmeasured contest must not mark the migration complete"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered legacy findings/,
      "the later measured deep legacy hit must still be reachable and win"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a failed canonical compress falls back to a usable legacy probe result", async () => {
  // The probe decision used to be gated on a non-null canonical result: when
  // the canonical leg failed (server error/timeout maps to null) the turn
  // degraded to full-history passthrough even though the concurrent probe had
  // already paid for a compressed, usable legacy answer. Forward that answer
  // instead of throwing it away.
  const question = "Now output detailed remediation steps";
  let canonicalCalls = 0;
  let legacyCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      if (isLegacy) {
        legacyCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            messages: [
              {
                role: "user",
                content: `${"recovered prior findings. ".repeat(200)}${question}`,
              },
            ],
            usage: {
              raw_prompt_tokens: 134_500,
              prompt_tokens_details: { cached_tokens: 100_000 },
            },
          })
        );
      } else {
        // Only the canonical leg fails, every time — e.g. the normalized
        // payload shape is rejected by the server.
        canonicalCalls += 1;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "canonical shape rejected" }));
      }
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const history = [
    { role: "user", content: "Audit this codebase for security issues" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        {
          type: "text",
          text: `Finding: ${"the audit traced this to the request path. ".repeat(60)}`,
        },
      ],
    },
    { role: "user", content: question },
  ];
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, history);

    assert.equal(canonicalCalls, 1, "the canonical leg was attempted and failed");
    assert.equal(legacyCalls, 1, "the legacy probe ran concurrently");
    const forwardedJson = JSON.stringify(forwarded.messages);
    assert.match(
      forwardedJson,
      /recovered prior findings/,
      "the paid-for legacy compression must be forwarded"
    );
    assert.doesNotMatch(
      forwardedJson,
      /the audit traced this to the request path/,
      "the turn must not degrade to full-history passthrough"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

/** Legacy-probe MemTree response: compressed and usable (round-4 telemetry tests). */
const legacyRescueResponse = (question) => ({
  messages: [
    {
      role: "user",
      content: `${"recovered prior findings. ".repeat(200)}${question}`,
    },
  ],
  usage: {
    raw_prompt_tokens: 134_500,
    prompt_tokens_details: { cached_tokens: 100_000 },
  },
});

/** History with a signed thinking block so legacyHash !== hash arms the probe. */
const legacyProbeHistory = (question) => [
  { role: "user", content: "Audit this codebase for security issues" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "reasoning", signature: "sig" },
      {
        type: "text",
        text: `Finding: ${"the audit traced this to the request path. ".repeat(60)}`,
      },
    ],
  },
  { role: "user", content: question },
];

test("compress telemetry: a slow legacy rescue is not logged as a timeout", async () => {
  // Round-4 semantics: compress.timedOut is measured on the CANONICAL leg's
  // OWN duration, never the Promise.all wall time. A canonical leg that 500s
  // in milliseconds is a fast server error, not a timeout, no matter how
  // long the winning legacy probe takes afterwards. The probe delay stays
  // well under the shared abort budget (both legs abort at compressBudgetMs)
  // but dwarfs the canonical failure, so the durations are unambiguous.
  const question = "Now output detailed remediation steps";
  const BUDGET_MS = 1_500;
  const LEGACY_DELAY_MS = 300;
  const records = [];
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      if (isLegacy) {
        // Slow but comfortably inside the leg's own abort budget.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(legacyRescueResponse(question)));
        }, LEGACY_DELAY_MS);
      } else {
        // Canonical leg fails immediately — a fast 5xx, not a budget burn.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "canonical shape rejected" }));
      }
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    compressTimeoutMs: BUDGET_MS,
  });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, legacyProbeHistory(question));
    await waitFor(() => records.some((r) => r.kind === "messages"));

    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered prior findings/,
      "the legacy rescue must be the forwarded result"
    );
    const turn = records.find((r) => r.kind === "messages");
    assert.equal(turn.compress.ok, true, "the rescue produced a result");
    assert.equal(turn.compress.legacyFallback, true);
    assert.equal(
      turn.compress.timedOut,
      false,
      "a fast canonical 5xx must not be logged as a timeout just because the rescuing legacy leg was slow"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("compress telemetry: a canonical budget burn rescued by legacy still logs the timeout", async () => {
  // The other half of the per-leg round-4 semantics: timedOut is computed
  // from the CANONICAL outcome, not the post-swap result. A canonical leg
  // that hangs until its abort budget expires (compress maps the abort to
  // null) is a real timeout and must be logged as one even though the fast
  // legacy probe rescued the turn and kept ok true — deriving timedOut from
  // the swapped-in result would silently under-report canonical timeouts.
  const question = "Now output detailed remediation steps";
  const BUDGET_MS = 300;
  const records = [];
  const held = [];
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      if (isLegacy) {
        // Fast usable rescue, far under the budget.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(legacyRescueResponse(question)));
      } else {
        // Canonical leg hangs past the budget; the client's own abort timer
        // fires at BUDGET_MS and maps the leg to null.
        held.push(res);
      }
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    compressTimeoutMs: BUDGET_MS,
  });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, legacyProbeHistory(question));
    await waitFor(() => records.some((r) => r.kind === "messages"));

    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered prior findings/,
      "the legacy rescue must be the forwarded result"
    );
    const turn = records.find((r) => r.kind === "messages");
    assert.equal(turn.compress.ok, true, "the rescue kept the turn compressed");
    assert.equal(turn.compress.legacyFallback, true);
    assert.equal(
      turn.compress.timedOut,
      true,
      "the canonical leg burned its whole budget; the legacy rescue must not hide that"
    );
  } finally {
    for (const res of held) res.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("compress telemetry: a budget-burning legacy probe cannot fake a canonical timeout", async () => {
  // Tripwire for the exact regression round 4 fixed: measuring timedOut from
  // the Promise.all wall time. Here the canonical leg fails in milliseconds
  // while the legacy probe hangs until ITS abort fires at the budget, so the
  // overall wall time is guaranteed to cross compressBudgetMs (asserted
  // below) — wall-time measurement would log timedOut: true, but the
  // canonical leg's own fast 5xx means the correct record is false.
  const question = "Now output detailed remediation steps";
  const BUDGET_MS = 300;
  const records = [];
  const held = [];
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      if (isLegacy) {
        held.push(res); // burns the whole budget, then aborts to null
      } else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "canonical shape rejected" }));
      }
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    compressTimeoutMs: BUDGET_MS,
  });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
  });
  try {
    await armMainTurn(proxy, question);
    await postMessages(proxy.port, legacyProbeHistory(question));
    await waitFor(() => records.some((r) => r.kind === "messages"));

    const turn = records.find((r) => r.kind === "messages");
    assert.equal(turn.turnType, "followup-degraded", "no leg produced a result");
    assert.equal(turn.compress.ok, false);
    assert.equal(turn.compress.legacyFallback, undefined);
    // Self-check that this scenario discriminates: the compress step's wall
    // time really crossed the budget (the legacy abort fires at >= BUDGET_MS
    // after its timer is set, which is at/after the compress start).
    assert.ok(
      turn.compress.ms >= BUDGET_MS,
      `wall time ${turn.compress.ms}ms must cross the ${BUDGET_MS}ms budget for this test to mean anything`
    );
    assert.equal(
      turn.compress.timedOut,
      false,
      "timedOut must track the canonical leg's own fast failure, not the slow legacy probe's wall time"
    );
    assert.match(
      JSON.stringify(forwarded.messages),
      /the audit traced this to the request path/,
      "with no usable result the turn degrades to full-history passthrough"
    );
  } finally {
    for (const res of held) res.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("the legacy probe runs concurrently with the canonical compress", async () => {
  // During active migration a followup turn pays ONE compress budget, not
  // two: the legacy leg must start before the canonical result arrives. The
  // mock holds every answer until both legs are in flight; a serial
  // implementation never sends the second request and times out the first.
  const pending = [];
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const isLegacy = JSON.stringify(payload.messages).includes('"thinking"');
      pending.push({ isLegacy, payload, res });
      if (pending.length < 2) return;
      for (const leg of pending) {
        const response = leg.isLegacy
          ? {
              messages: [
                {
                  role: "user",
                  content: `${"recovered prior findings. ".repeat(200)}turn two`,
                },
              ],
              usage: {
                raw_prompt_tokens: 134_500,
                prompt_tokens_details: { cached_tokens: 100_000 },
              },
            }
          : {
              messages: leg.payload.messages,
              usage: {
                raw_prompt_tokens: 50_000,
                prompt_tokens_details: { cached_tokens: 0 },
              },
            };
        leg.res.writeHead(200, { "content-type": "application/json" });
        leg.res.end(JSON.stringify(response));
      }
    });
  });
  let forwarded;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtree = new MemtreeClient({
    baseUrl: memtreeSrv.origin,
    apiKey: "k",
    // Short circuit-breaker: a serial probe deadlocks against the barrier
    // above and degrades to passthrough instead of hanging the test.
    compressTimeoutMs: 1_000,
  });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const messages = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        { type: "text", text: "first answer" },
      ],
    },
    { role: "user", content: "turn two" },
  ];
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, messages);
    assert.equal(pending.length, 2, "both legs were in flight simultaneously");
    assert.match(
      JSON.stringify(forwarded.messages),
      /recovered prior findings/,
      "the concurrent probe result must still be usable as the winner"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// Tool-route miss recovery (plans/2026-08-04_PLAN_tool_turn_route_recovery.md)
// ---------------------------------------------------------------------------

/** Recording upstream that answers both /messages and /count_tokens. */
function recordingUpstream() {
  const seen = [];
  return listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const isCount = req.url.startsWith("/v1/messages/count_tokens");
      seen.push({
        isCount,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
      });
      const body = isCount ? JSON.stringify({ input_tokens: 42 }) : UPSTREAM_BODY;
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  }).then((srv) => ({ ...srv, seen }));
}

/**
 * Tool-loop conversation whose serialized non-system bytes exceed the 400KiB
 * recovery gate. `marker` differentiates conversations (and MemTree hashes).
 */
function largeToolTurn(marker = "AAA") {
  return [
    { role: "user", content: `${marker} first question` },
    {
      role: "assistant",
      content: [{ type: "text", text: `${marker} ` + "history ".repeat(64 * 1024) }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ];
}

/** Extend a conversation with one more tool call/result pair. */
function extendToolLoop(messages, id = "t2") {
  return [
    ...messages,
    { role: "assistant", content: [{ type: "tool_use", id, name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  ];
}

/** A compressed, usable MemTree answer (≥2k retained non-echo chars). */
const recoveredMemory = (marker = "AAA") => ({
  messages: [{ role: "user", content: `${marker} recovered memory ` + "m".repeat(2500) }],
  usage: { prompt_tokens_details: { cached_tokens: 999 } },
});

const SESSION = { "x-claude-code-session-id": "session-1" };

const messageRecords = (records) => records.filter((r) => r.kind === "messages");

test("incident regression: a first-user side request cannot strand the tool loop", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);
    await waitFor(() => upstream.seen.length >= 1);

    // The CC-internal side call: first-user-shaped, same session id, no
    // UserPromptSubmit hook. Before the fix this cleared the route without
    // rebuilding it (2026-08-04 incident).
    await postMessages(proxy.port, [{ role: "user", content: "side probe" }], SESSION);

    const extended = extendToolLoop(base, "t1");
    await postMessages(proxy.port, extended, SESSION);
    const toolBodies = upstream.seen.filter(
      (c) => !c.isCount && JSON.stringify(c.body.messages).includes("tool_result")
    );
    assert.equal(toolBodies.length, 1, "tool turn reached upstream");
    assert.match(
      JSON.stringify(toolBodies[0].body.messages[0].content),
      /compressed context/,
      "the tool turn must still ride the compressed prefix"
    );
    assert.ok(
      !JSON.stringify(toolBodies[0].body.messages).includes("first question"),
      "the uncompressed prefix must not be re-sent"
    );
    const toolRec = messageRecords(records).find((r) => r.turnType === "tool-memory");
    assert.ok(toolRec, "tool turn logged as tool-memory");
    assert.equal(toolRec.routeMiss, undefined, "a hit emits no routeMiss");

    // The matching count_tokens preflight must also size the compressed
    // context (full-history counting is what drives auto-compaction).
    await postCountTokens(
      proxy.port,
      { model: "claude-x", messages: extendToolLoop(base, "t9") },
      SESSION
    );
    const counted = upstream.seen.find((c) => c.isCount);
    assert.ok(counted, "count_tokens reached upstream");
    assert.match(
      JSON.stringify(counted.body.messages[0].content),
      /compressed context/,
      "count_tokens sizes the compressed context after the side request"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a large route-miss tool turn recovers via blocking compress and self-heals the route", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    assert.equal(upstream.seen.length, 1);
    const first = upstream.seen[0].body;
    assert.match(
      JSON.stringify(first.messages[0].content),
      /recovered memory/,
      "the miss forwarded the compressed body, not 2.9MB of history"
    );
    assert.ok(
      !JSON.stringify(first.messages).includes("history history"),
      "the full history must not reach Anthropic"
    );
    const rec1 = messageRecords(records)[0];
    assert.equal(rec1.turnType, "tool-recompressed");
    assert.equal(rec1.routeMiss, "missing");
    assert.equal(rec1.routeRecovery.outcome, "compressed");
    assert.equal(rec1.routeRecovery.install, "installed");
    assert.ok(rec1.routeRecovery.conversationBytes >= 400 * 1024);
    assert.equal(rec1.compress.ok, true);
    assert.equal(rec1.history.usable, true);
    assert.ok(rec1.forwardedBytes < 100_000, "forwarded bytes shrank");

    // The next tool request extends the recovered prefix locally: no second
    // blocking compress, and upstream sees compressed prefix + suffix only.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(upstream.seen.length, 2);
    const second = upstream.seen[1].body;
    assert.match(JSON.stringify(second.messages[0].content), /recovered memory/);
    assert.ok(JSON.stringify(second.messages).includes('"t2"'), "suffix rode along");
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.turnType, "tool-memory");
    assert.equal(rec2.routeMiss, undefined);
    const blockingCompressCalls = memtreeSrv.calls.filter((c) => !c.index_only);
    assert.equal(blockingCompressCalls.length, 1, "exactly one blocking compress");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("recovery failure degrades to the original body and retains the background index", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(500, { error: "boom" });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    await postMessages(proxy.port, largeToolTurn(), SESSION);
    assert.equal(upstream.seen.length, 1);
    assert.match(
      JSON.stringify(upstream.seen[0].body.messages),
      /first question/,
      "failure forwards the original body"
    );
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool");
    assert.equal(rec.routeMiss, "missing");
    assert.equal(rec.routeRecovery.outcome, "failed");
    assert.equal(rec.routeRecovery.install, undefined);
    // The blocking attempt failed on an ordinary server error, so the
    // longer-budget background submission still runs for a later turn.
    await waitFor(() => memtreeSrv.calls.some((c) => c.index_only === true));
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a MemTree no-op or unusable answer never becomes a recovered route", async () => {
  const upstream = await recordingUpstream();
  // No cached_tokens: an index-warming no-op echo.
  const memtreeSrv = await mockMemtree(200, (reqBody) => ({
    messages: reqBody.messages,
  }));
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    assert.match(
      JSON.stringify(upstream.seen[0].body.messages),
      /first question/,
      "a no-op preserves true passthrough semantics"
    );
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool");
    assert.equal(rec.routeRecovery.outcome, "noop");
    // Nothing was installed: the next extension misses again.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.routeMiss, "missing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a small tool-route miss attempts recovery once; the second miss is spent", async () => {
  // The old 400KiB byte gate is gone: a miss well under it still buys the
  // lane's ONE blocking attempt per epoch, and the attempt is the budget —
  // a later miss in the same lane and epoch forwards verbatim.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  // ~16KB conversation: far below the deleted gate, big enough that the
  // recovered body is a genuine byte win.
  const smallishToolTurn = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [{ type: "text", text: "history ".repeat(2000) }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  ];
  try {
    await postMessages(proxy.port, smallishToolTurn, SESSION);
    const rec = messageRecords(records)[0];
    assert.equal(rec.routeLane, "main");
    assert.equal(rec.routeMiss, "missing");
    assert.equal(rec.turnType, "tool-recompressed");
    assert.equal(rec.routeRecovery.outcome, "compressed");
    assert.equal(rec.routeRecovery.install, "installed");
    assert.match(
      JSON.stringify(upstream.seen[0].body.messages),
      /recovered memory/,
      "the small miss was worth exactly one blocking attempt"
    );

    // A same-length body whose tool_result diverged is a genuine mismatch
    // (an identical repost would be a "replay" now), so it rejects — and the
    // lane's budget is already spent: verbatim forward, no second blocking
    // compress.
    const diverged = structuredClone(smallishToolTurn);
    diverged[3].content[0].content = "divergent result";
    await postMessages(proxy.port, diverged, SESSION);
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.routeMiss, "rejected");
    assert.equal(rec2.turnType, "tool");
    assert.equal(rec2.routeRecovery.outcome, "spent");
    assert.equal(rec2.routeRecovery.conversationBytes, undefined);
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /first question/,
      "the spent miss forwards the original history"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("disabled recovery records the suppressed miss and never compresses", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    toolRouteRecovery: false,
  });
  try {
    await postMessages(proxy.port, largeToolTurn(), SESSION);
    assert.match(JSON.stringify(upstream.seen[0].body.messages), /first question/);
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool");
    assert.equal(rec.routeMiss, "missing");
    // Under the kill switch no lane is ever marked spent, so every
    // shape-eligible miss records "disabled" — the exact set a switched-on
    // proxy would have fed into the one-attempt budget. No byte measurement
    // is taken for a miss that gets no attempt.
    assert.equal(rec.routeRecovery.outcome, "disabled");
    assert.equal(rec.routeRecovery.conversationBytes, undefined);
    assert.equal(rec.compress, undefined, "no blocking compress was attempted");
    assert.ok(
      memtreeSrv.calls.every((c) => c.index_only === true),
      "MemTree saw only background index traffic"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a recovery with no byte gain forwards the original and spends the budget", async () => {
  // A tiny conversation's recovered body is BIGGER than the original: the
  // no-gain check forwards the original (never worse than verbatim), installs
  // nothing — and the lane's one attempt is still spent, so the next miss
  // does not retry.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    await postMessages(proxy.port, toolTurn, SESSION);
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool");
    assert.equal(rec.routeMiss, "missing");
    assert.equal(rec.routeRecovery.outcome, "no-gain");
    assert.equal(rec.routeRecovery.install, undefined);
    assert.match(
      JSON.stringify(upstream.seen[0].body.messages),
      /first question/,
      "the no-gain result never replaces the original body"
    );

    await postMessages(proxy.port, extendToolLoop(toolTurn, "t2"), SESSION);
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.routeMiss, "missing");
    assert.equal(rec2.routeRecovery.outcome, "spent");
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /first question/
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a large subagent tool turn recovers into its own lane and rides it next turn", async () => {
  // Subagents get the exact deal main gets: a lane keyed by their agent id.
  // Their recovery installs there — never into main's lane — so the next
  // subagent tool turn rides locally while main's route stays untouched.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);

    await postMessages(proxy.port, largeToolTurn("BBB"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-7",
    });
    const sub = messageRecords(records).at(-1);
    assert.equal(sub.routeLane, "agent");
    assert.equal(sub.turnType, "tool-recompressed");
    assert.equal(sub.routeMiss, "missing");
    assert.equal(sub.routeRecovery.outcome, "compressed");
    assert.equal(sub.routeRecovery.install, "installed");
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages[0].content),
      /BBB recovered memory/,
      "subagent still gets the smaller server-compressed body"
    );

    // The subagent's next tool turn rides its own installed lane.
    await postMessages(proxy.port, extendToolLoop(largeToolTurn("BBB"), "s1"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-7",
    });
    const subRide = messageRecords(records).at(-1);
    assert.equal(subRide.turnType, "tool-memory", "subagent rides its lane");

    // Main route untouched: the next main tool turn still rides locally.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a compressed subagent followup installs its own lane and its tool loop rides", async () => {
  // The acceptance signal the whole change exists for: a subagent's followup
  // user turn compresses AND installs, so its tool loop rides locally instead
  // of forwarding the full history on every turn.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-9" };
  const base = followupTurn("agent turn two");
  try {
    await postMessages(proxy.port, base, agent);
    const followup = messageRecords(records).at(-1);
    assert.equal(followup.turnType, "followup-compressed");
    assert.equal(followup.routeLane, "agent");

    await postMessages(proxy.port, extendToolLoop(base, "t1"), agent);
    const ride = messageRecords(records).at(-1);
    assert.equal(ride.turnType, "tool-memory", "subagent tool loop rides");
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /compressed context/
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a newer subagent followup owns its lane when completions reverse", async () => {
  // Agent followups can install routes now, so they need the same async
  // decision ordering as main: a slower older compression must not overwrite
  // the route chosen by a newer request on the same lane.
  const upstream = await recordingUpstream();
  const gates = { AAA: deferred(), BBB: deferred() };
  const arrived = { AAA: false, BBB: false };
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      const marker = JSON.stringify(parsed.messages).includes("BBB") ? "BBB" : "AAA";
      arrived[marker] = true;
      await gates[marker].promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory(marker)));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    // A stale-route rejection must stay visible instead of being repaired by
    // recovery, or the race could pass while still installing the wrong route.
    toolRouteRecovery: false,
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-race" };
  const olderMessages = followupTurn("AAA agent followup");
  const newerMessages = followupTurn("BBB agent followup");
  try {
    const older = postMessages(proxy.port, olderMessages, agent);
    await waitFor(() => arrived.AAA);
    const newer = postMessages(proxy.port, newerMessages, agent);
    await waitFor(() => arrived.BBB);

    gates.BBB.resolve();
    await newer;
    gates.AAA.resolve();
    await older;

    await postMessages(
      proxy.port,
      extendToolLoop(newerMessages, "agent-race-tool"),
      agent
    );
    const ride = messageRecords(records).at(-1);
    assert.equal(ride.turnType, "tool-memory", "the newer route survived");
    const forwarded = JSON.stringify(upstream.seen.at(-1).body.messages);
    assert.match(forwarded, /BBB recovered memory/);
    assert.doesNotMatch(forwarded, /AAA recovered memory/);
  } finally {
    gates.AAA.resolve();
    gates.BBB.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a closed newer subagent followup hands its lane decision back", async () => {
  // Unlike main, an agent followup does not bump the epoch or clear its lane
  // before compression. If its client disappears before any mutation, its
  // reservation must be released so an older in-flight followup can still
  // install instead of being suppressed by a decision that did nothing.
  const upstream = await recordingUpstream();
  const gates = { AAA: deferred(), BBB: deferred() };
  const arrived = { AAA: false, BBB: false };
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      const marker = JSON.stringify(parsed.messages).includes("BBB") ? "BBB" : "AAA";
      arrived[marker] = true;
      await gates[marker].promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory(marker)));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    toolRouteRecovery: false,
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-close-race" };
  const olderMessages = followupTurn("AAA older followup");
  const newerMessages = followupTurn("BBB abandoned followup");
  try {
    const older = postMessages(proxy.port, olderMessages, agent);
    await waitFor(() => arrived.AAA);

    const newerClientGone = new Promise((resolve, reject) => {
      const clientReq = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...agent },
      });
      clientReq.on("error", resolve);
      clientReq.on("response", (response) => {
        response.resume();
        response.on("end", () =>
          reject(new Error("the abandoned followup unexpectedly completed"))
        );
      });
      clientReq.end(
        JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          messages: newerMessages,
        })
      );
      waitFor(() => arrived.BBB).then(
        () => clientReq.destroy(),
        reject
      );
    });
    await newerClientGone;
    // clientReq.destroy() resolves the client-LOCAL 'error' immediately; the
    // proxy observes the close only when the socket teardown reaches its res
    // 'close' listener. If the gate resolves before that, compression settles
    // with the client still apparently live and the followup logs a normal
    // record — "followup-client-closed" then never arrives, which was this
    // test's historic ~1-in-5 flake. Let the close propagate first.
    await new Promise((r) => setTimeout(r, 150));
    gates.BBB.resolve();
    await within(
      waitFor(() =>
        messageRecords(records).some(
          (record) => record.turnType === "followup-client-closed"
        )
      ),
      "the abandoned followup never released its decision",
      // waitFor's own 3s budget, not within's 1s default: the record can
      // legitimately trail the gate under full-suite event-loop load.
      3_000
    );

    gates.AAA.resolve();
    await older;
    await postMessages(
      proxy.port,
      extendToolLoop(olderMessages, "after-abandoned-newer"),
      agent
    );
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "tool-memory",
      "the older followup installed after the no-op newer decision released"
    );
  } finally {
    gates.AAA.resolve();
    gates.BBB.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an agent followup keeps its reservation through delayed activation", async () => {
  // Three generations expose the activation seam. BBB finishes compression
  // while newer CCC still owns the lane, then waits on its upstream response.
  // CCC abandons without mutation, handing ownership back before BBB activates.
  // BBB's reservation must survive that wait so still-older AAA cannot later
  // overwrite the route BBB installs.
  const upstreamGate = deferred();
  let candidateReachedUpstream = false;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const forwarded = Buffer.concat(chunks).toString("utf-8");
      if (forwarded.includes("BBB recovered memory")) {
        candidateReachedUpstream = true;
        await upstreamGate.promise;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const gates = { AAA: deferred(), BBB: deferred(), CCC: deferred() };
  const arrived = { AAA: false, BBB: false, CCC: false };
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      const body = JSON.stringify(parsed.messages);
      const marker = ["CCC", "BBB"].find((item) => body.includes(item)) ?? "AAA";
      arrived[marker] = true;
      await gates[marker].promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory(marker)));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    toolRouteRecovery: false,
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-activation-race" };
  const oldestMessages = followupTurn("AAA oldest followup");
  const candidateMessages = followupTurn("BBB candidate followup");
  const abandonedMessages = followupTurn("CCC abandoned followup");
  let abandonedRequest;
  try {
    const oldest = postMessages(proxy.port, oldestMessages, agent);
    await waitFor(() => arrived.AAA);

    const candidate = postMessages(proxy.port, candidateMessages, agent);
    await waitFor(() => arrived.BBB);

    const abandonedClientGone = new Promise((resolve, reject) => {
      abandonedRequest = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...agent },
      });
      abandonedRequest.on("error", resolve);
      abandonedRequest.on("response", (response) => {
        response.resume();
        response.on("end", () =>
          reject(new Error("the abandoned followup unexpectedly completed"))
        );
      });
      abandonedRequest.end(
        JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          messages: abandonedMessages,
        })
      );
    });
    await waitFor(() => arrived.CCC);

    // BBB reaches forwarding while CCC's newer reservation is still live.
    gates.BBB.resolve();
    await waitFor(() => candidateReachedUpstream);

    // CCC then releases without a route mutation. BBB is now allowed to
    // activate, but must keep its own generation committed when it does.
    abandonedRequest.destroy();
    await abandonedClientGone;
    // Same race as the deflaked lane-handback test: destroy() resolves the
    // client-LOCAL error immediately, but the proxy observes the close only
    // at its res 'close' listener. Let the teardown propagate before letting
    // compression settle, or CCC forwards as live and the asserted
    // "followup-client-closed" record never arrives.
    await new Promise((r) => setTimeout(r, 150));
    gates.CCC.resolve();
    await within(
      waitFor(() =>
        messageRecords(records).some(
          (record) => record.turnType === "followup-client-closed"
        )
      ),
      "the abandoned newest followup never released"
    );

    upstreamGate.resolve();
    await candidate;

    // AAA finishes last. Without BBB's retained reservation, this still-older
    // completion can overwrite BBB after the newer CCC request has vanished.
    gates.AAA.resolve();
    await oldest;

    await postMessages(
      proxy.port,
      extendToolLoop(candidateMessages, "after-delayed-activation"),
      agent
    );
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "tool-memory",
      "the route installed by BBB stayed protected from still-older AAA"
    );
  } finally {
    abandonedRequest?.destroy();
    gates.AAA.resolve();
    gates.BBB.resolve();
    gates.CCC.resolve();
    upstreamGate.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a same-session subagent reject evicts only its own lane, never main's", async () => {
  // The regression the old subagent carve-out was written to prevent — a
  // same-session subagent reject clearing the main thread's route — must now
  // hold structurally: the reject deletes the subagent's own key only.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-5" };
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);

    // Subagent recovery installs into its own lane.
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );

    // A divergent same-lane body (an identical repost would be a "replay"
    // now) is a genuine mismatch: rejected, and the eviction lands on the
    // SUBAGENT lane only.
    const diverged = structuredClone(largeToolTurn("BBB"));
    diverged[3].content[0].content = "divergent result";
    await postMessages(proxy.port, diverged, agent);
    const rejected = messageRecords(records).at(-1);
    assert.equal(rejected.routeLane, "agent");
    assert.equal(rejected.routeMiss, "rejected");
    assert.equal(rejected.routeRecovery.outcome, "spent");

    // Main's route was never touched: its extension still rides.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("reserved-looking agent ids cannot alias the main route lane", async () => {
  // The key encoding must distinguish the reserved main lane from an opaque
  // agent id whose literal value happens to be "main".
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  const reservedLookingAgent = {
    ...SESSION,
    "x-claude-code-agent-id": "main",
  };
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);

    await postMessages(proxy.port, largeToolTurn("BBB"), reservedLookingAgent);
    const agentRec = messageRecords(records).at(-1);
    assert.equal(agentRec.routeLane, "agent");
    assert.equal(agentRec.routeRecovery.install, "installed");

    await postMessages(proxy.port, extendToolLoop(base, "main-after-agent"), SESSION);
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "tool-memory",
      "the opaque agent id did not overwrite or evict the reserved main lane"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an away-summary followup compresses, stores no route, and spares main's route", async () => {
  // The surviving twin of the 2026-08-04 incident: a hidden away-summary
  // request shares the session and carries no agent header, so under the old
  // single slot it keyed to main and could evict main's route. It keys to its
  // own away lane now — and that lane stores nothing: no request can ever
  // read an away route (tool turns and count_tokens never classify as away).
  //
  // "Stores nothing" is observed through LRU pressure: main's entry is
  // installed first (oldest), the away request runs second, then 31 agent
  // lanes install. A stored away route would make 33 entries and push main
  // past the 32-lane cap; main still riding afterwards proves the away leg
  // never took a slot.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("AAA")
      ? recoveredMemory("AAA")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);

    const awayMessages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      {
        role: "user",
        content:
          "The user stepped away and is coming back. Recap in under 40 words.",
      },
    ];
    await postMessages(proxy.port, awayMessages, SESSION);
    const away = messageRecords(records).at(-1);
    assert.equal(away.routeLane, "away");
    assert.equal(away.turnType, "followup-compressed", "the away leg still compresses");

    // Fill the map to its cap from distinct agent lanes, newer than main.
    for (let n = 1; n <= 31; n++) {
      await postMessages(proxy.port, largeToolTurn("AAA"), {
        ...SESSION,
        "x-claude-code-agent-id": `agent-${n}`,
      });
      assert.equal(
        messageRecords(records).at(-1).routeRecovery.install,
        "installed",
        `lane agent-${n} installed`
      );
    }

    // Main (the oldest entry) survived under the cap: a stored away route
    // would have evicted it at the 31st agent install.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("the route map is LRU-bounded: a 33rd lane evicts the oldest", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const laneHeaders = (n) => ({
    ...SESSION,
    "x-claude-code-agent-id": `agent-${n}`,
  });
  try {
    // 33 distinct lanes each recover and install, in order.
    for (let n = 1; n <= 33; n++) {
      await postMessages(proxy.port, largeToolTurn("AAA"), laneHeaders(n));
      assert.equal(
        messageRecords(records).at(-1).routeRecovery.install,
        "installed",
        `lane agent-${n} installed`
      );
    }

    // agent-1 was the least recently used entry, so the 33rd install
    // evicted it: its extension misses (and its budget is already spent).
    await postMessages(
      proxy.port,
      extendToolLoop(largeToolTurn("AAA"), "x1"),
      laneHeaders(1)
    );
    const evicted = messageRecords(records).at(-1);
    assert.equal(evicted.routeMiss, "missing");
    assert.equal(evicted.turnType, "tool");
    assert.equal(evicted.routeRecovery.outcome, "spent");

    // agent-2 survived under the cap: its extension rides.
    await postMessages(
      proxy.port,
      extendToolLoop(largeToolTurn("AAA"), "x2"),
      laneHeaders(2)
    );
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a sessionless recovery is one-shot: compressed forward, no route", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation); // no session header
    assert.match(
      JSON.stringify(upstream.seen[0].body.messages[0].content),
      /recovered memory/,
      "the one-shot smaller body is still delivered"
    );
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool-recompressed");
    assert.equal(rec.routeRecovery.install, "no-session");
    // No self-healing without identity: the extension misses again.
    await postMessages(proxy.port, extendToolLoop(conversation));
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.routeMiss, "missing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a pending human prompt window keeps recovery transform-only", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    // Armed prompt = a typed prompt may arrive merged into a tool wrapper.
    // The intermediate wrapper must not install a route that would veto the
    // real merged-prompt request's recovery classification.
    await armMainTurn(proxy, "typed while tools ran");
    await postMessages(proxy.port, conversation, SESSION);
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool-recompressed");
    assert.equal(rec.routeRecovery.outcome, "compressed");
    assert.equal(rec.routeRecovery.install, "prompt-pending");
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.routeMiss, "missing", "no route was installed");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a pending main prompt does not make an agent recovery transform-only", async () => {
  // The merged-prompt hazard belongs to main. An attributed agent installs in
  // a disjoint lane, so the main arm must not consume the agent's one attempt
  // without leaving a route for the rest of its tool loop.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory("AGENT"));
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-during-arm" };
  const conversation = largeToolTurn("BBB");
  try {
    await armMainTurn(proxy, "main prompt still waiting");
    await postMessages(proxy.port, conversation, agent);
    const recovered = messageRecords(records).at(-1);
    assert.equal(recovered.routeRecovery.outcome, "compressed");
    assert.equal(recovered.routeRecovery.install, "installed");

    await postMessages(proxy.port, extendToolLoop(conversation, "agent-next"), agent);
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "tool-memory",
      "the agent rides its route while the unrelated main arm remains pending"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a different-session rejection preserves the owner's route; same-session rebuilds", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);
    await waitFor(() => upstream.seen.length >= 1);

    // A tool turn from a DIFFERENT session looks in its own lane and finds
    // nothing — it can never even see the owner's route, let alone evict it.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), {
      "x-claude-code-session-id": "session-2",
    });
    const foreign = messageRecords(records).at(-1);
    assert.equal(foreign.routeMiss, "missing", "foreign session misses its own empty lane");

    // The owner still rides.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    const ride = messageRecords(records).at(-1);
    assert.equal(ride.turnType, "tool-memory", "owner's route survived");

    // A LARGE same-session mismatch evicts and rebuilds via recovery.
    await postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    const rebuilt = messageRecords(records).at(-1);
    assert.equal(rebuilt.routeMiss, "rejected");
    assert.equal(rebuilt.turnType, "tool-recompressed");
    assert.equal(rebuilt.routeRecovery.install, "installed");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an in-flight recovery holds the lane budget; a concurrent miss forwards verbatim", async () => {
  // Two concurrent recoveries in one lane and epoch are impossible now: the
  // first miss spends the lane's one blocking attempt BEFORE its compress
  // settles, so a miss racing it forwards verbatim instead of stacking a
  // second blocking wait — and the in-flight attempt still installs.
  const upstream = await recordingUpstream();
  const held = deferred();
  let aCompressArrived = false;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const respond = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (parsed.index_only) return respond({ ok: true });
      const isA = JSON.stringify(parsed.messages).includes("AAA");
      if (isA) {
        aCompressArrived = true;
        await held.promise; // hold A's compress while B misses
        return respond(recoveredMemory("AAA"));
      }
      return respond(recoveredMemory("BBB"));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const convA = largeToolTurn("AAA");
  const convB = largeToolTurn("BBB");
  try {
    const aInFlight = postMessages(proxy.port, convA, SESSION);
    // A's attempt must have spent the lane budget (its compress reached the
    // server) before B's miss arrives.
    await waitFor(() => aCompressArrived);
    await postMessages(proxy.port, convB, SESSION);
    const recB = messageRecords(records).at(-1);
    assert.equal(recB.routeRecovery.outcome, "spent");
    assert.equal(recB.turnType, "tool");
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /BBB first question/,
      "the racing miss forwarded its own full history"
    );

    held.resolve();
    await aInFlight;
    const recA = messageRecords(records).find(
      (r) => r.routeRecovery && r.routeRecovery.outcome === "compressed"
    );
    assert.equal(recA.routeRecovery.install, "installed");

    // A's route survived its slow completion: A's extension rides.
    await postMessages(proxy.port, extendToolLoop(convA), SESSION);
    const ride = messageRecords(records).at(-1);
    assert.equal(ride.turnType, "tool-memory");
    const last = upstream.seen.at(-1).body;
    assert.match(JSON.stringify(last.messages[0].content), /AAA recovered memory/);
  } finally {
    held.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a human prompt arming during recovery compression prevents stale installation", async () => {
  const upstream = await recordingUpstream();
  const held = deferred();
  let compressArrived = false;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const respond = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (parsed.index_only) return respond({ ok: true });
      compressArrived = true;
      await held.promise;
      return respond(recoveredMemory());
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    const inFlight = postMessages(proxy.port, largeToolTurn(), SESSION);
    // The recovery must have captured its epoch (compress in flight) before
    // the human prompt bumps it.
    await waitFor(() => compressArrived);
    await armMainTurn(proxy, "new human turn"); // bumps the route epoch
    held.resolve();
    await inFlight;
    const rec = messageRecords(records)[0];
    assert.equal(rec.turnType, "tool-recompressed");
    assert.equal(rec.routeRecovery.install, "stale");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// --- ralph-review cycle 1: branches the original suite never exercised ---

test("an amnesiac compressed answer is never installed as a route", async () => {
  const upstream = await recordingUpstream();
  // Indexed (cached_tokens present, so didMemtreeCompress is true) but the
  // conversation is gone. This is the dangerous case: every usage-based
  // measure calls it a perfect compression, and installing it as a route
  // would silently amnesia the rest of the tool loop.
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "hi" }],
    usage: { prompt_tokens_details: { cached_tokens: 999 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    const rec = messageRecords(records)[0];
    assert.equal(rec.routeRecovery.outcome, "unusable");
    assert.equal(rec.history.usable, false);
    assert.equal(rec.turnType, "tool", "not forwarded as tool-recompressed");
    assert.match(
      JSON.stringify(upstream.seen[0].body.messages),
      /first question/,
      "the real history was forwarded, not the amnesiac answer"
    );
    // No route: the next tool turn misses rather than riding amnesia.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(messageRecords(records)[1].routeMiss, "missing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a compression with no byte gain forwards the original body", async () => {
  const upstream = await recordingUpstream();
  // Usable and genuinely indexed, but bigger than what it replaces.
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "bloated memory " + "m".repeat(900_000) }],
    usage: { prompt_tokens_details: { cached_tokens: 999 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    const rec = messageRecords(records)[0];
    assert.equal(rec.routeRecovery.outcome, "no-gain");
    assert.equal(rec.turnType, "tool");
    assert.match(JSON.stringify(upstream.seen[0].body.messages), /first question/);
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(
      messageRecords(records)[1].routeMiss,
      "missing",
      "a bigger body is not worth a route built on it"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an upstream failure on the recovered leg installs no route", async () => {
  // 500 from Anthropic: protocol-complete never fires, delivered is false.
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error" }));
    });
  });
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    const rec = messageRecords(records)[0];
    assert.equal(rec.routeRecovery.outcome, "compressed");
    assert.equal(rec.routeRecovery.install, "upstream-failed");
    // A route built on a request the model never answered would splice a
    // prefix the conversation never actually contained.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(messageRecords(records)[1].routeMiss, "missing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a failed recovery puts the fuse on cooldown instead of stalling every tool turn", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(500, { error: "down" });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  try {
    await postMessages(proxy.port, conversation, SESSION);
    const first = messageRecords(records)[0];
    assert.equal(first.routeRecovery.outcome, "failed");
    assert.equal(first.turnType, "tool");
    const afterFirst = blockingCalls();
    assert.ok(afterFirst >= 1, "the first miss did attempt a blocking compress");

    // Every tool turn appends a tool_result and rehashes, so compress()'s
    // dedup can never absorb the repeat: without a cooldown an outage would
    // charge the full blocking budget to each of these. Main's own lane spent
    // its one attempt above and "spent" wins when both gates hold, so the
    // cooldown is observed from a sibling lane whose budget is intact.
    const sibling = { ...SESSION, "x-claude-code-agent-id": "agent-fuse-probe" };
    await postMessages(proxy.port, extendToolLoop(conversation, "t2"), sibling);
    await postMessages(proxy.port, extendToolLoop(conversation, "t3"), sibling);
    const later = messageRecords(records).slice(1);
    for (const rec of later) {
      assert.equal(rec.routeRecovery.outcome, "cooldown");
      assert.equal(rec.compress, undefined, "no blocking wait was paid");
      assert.equal(rec.turnType, "tool");
    }
    assert.equal(blockingCalls(), afterFirst, "no further blocking compress");
    assert.match(JSON.stringify(upstream.seen.at(-1).body.messages), /first question/);

    // The spent lane stays visible as budget exhaustion even while the
    // cooldown is armed: the reqlog acceptance metric needs "spent", not
    // "cooldown", masking it during outages.
    await postMessages(proxy.port, extendToolLoop(conversation, "t4"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "spent");
    assert.equal(blockingCalls(), afterFirst, "a spent skip pays nothing either");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a large foreign-session turn recovers into its own lane and spares the owner's route", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : recoveredMemory("AAA")
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);

    // Session 2's LARGE tool turn misses its own empty lane, recovers, and
    // installs into that lane. Under the identity-keyed map this cannot evict
    // session 1's route — the eviction ping-pong the old single slot had to
    // defend against is structurally impossible.
    await postMessages(proxy.port, largeToolTurn("BBB"), {
      "x-claude-code-session-id": "session-2",
    });
    const foreign = messageRecords(records).at(-1);
    assert.equal(foreign.routeMiss, "missing");
    assert.equal(foreign.turnType, "tool-recompressed", "still gets a smaller body");
    assert.equal(foreign.routeRecovery.install, "installed");

    // The owner still rides its untouched route.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a degraded main followup still clears the route it cannot rebuild", async () => {
  // The inverse of the clear-gating fix: gating the clear on followup turns
  // must not stop a genuine followup from clearing. A followup whose compress
  // fails has no compressed prefix, so leaving the previous route installed
  // would splice a prefix that no longer matches what the model was sent.
  const upstream = await recordingUpstream();
  let failCompress = false;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (!parsed.index_only && failCompress) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "down" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(parsed.index_only ? { ok: true } : recoveredMemory()));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");
    // Route is live: a small tool turn rides it.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");

    failCompress = true;
    // Deliberately NO armMainTurn here. The UserPromptSubmit hook clears the
    // route itself, before the request under test is even sent — arming would
    // leave nothing for the clear-on-followup path to clear, and the test
    // would pass with both clears deleted. `followupTurn` classifies as a main
    // followup by shape alone, which is the hookless case that matters.
    await postMessages(proxy.port, followupTurn("turn three"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-degraded");

    // The stale route must be gone: this tool turn was sent full history.
    await postMessages(
      proxy.port,
      extendToolLoop(followupTurn("turn three"), "t9"),
      SESSION
    );
    const after = messageRecords(records).at(-1);
    assert.equal(after.routeMiss, "missing", "the degraded followup cleared it");
    assert.notEqual(after.turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a failed recovery releases the route decision it reserved", async () => {
  // The reservation is taken BEFORE the outcome is known, and while held it
  // marks stale every concurrent install. A recovery that installs nothing
  // must return it, or a concurrent followup's route is silently suppressed
  // and the conversation ends up with no route at all. Reproduced with
  // no-hook embedder traffic, where a followup can overlap a tool turn.
  const upstream = await recordingUpstream();
  const held = deferred();
  let followupCompressArrived = false;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const respond = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (parsed.index_only) return respond(200, { ok: true });
      // The tool recovery (conversation BBB) fails fast.
      if (JSON.stringify(parsed.messages).includes("BBB")) {
        return respond(500, { error: "down" });
      }
      followupCompressArrived = true;
      await held.promise; // hold the followup until the recovery has failed
      return respond(200, recoveredMemory("AAA"));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("AAA turn two");
  try {
    const followup = postMessages(proxy.port, base, SESSION);
    // The followup has reserved its generation by the time its compress
    // reaches the server — the reservation happens before the request is
    // sent, so arrival is a sound barrier.
    await waitFor(() => followupCompressArrived);

    // A large tool miss now reserves a NEWER generation, then fails.
    await postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "failed");

    held.resolve();
    await followup;
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The followup's install must have survived the failed recovery.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    const ride = messageRecords(records).at(-1);
    assert.equal(
      ride.turnType,
      "tool-memory",
      "the failed recovery released its reservation, so the followup installed"
    );
  } finally {
    // An assertion that throws before the resolve below would otherwise leave
    // the mock holding the followup response open; listen() closes the server
    // but never destroys live sockets, and node:test has no default timeout,
    // so a future regression here would hang the suite instead of failing it.
    held.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// --- ralph-review cycle 2: holes found in the cycle-1 fixes themselves ---

test("a failed compress arms the cooldown even when the client gave up waiting", async () => {
  // The client-closed check used to sit BEFORE the arming, so a null result
  // on a request whose client had already disconnected taught the cooldown
  // nothing. That is the worst possible blind spot: the full-budget stall a
  // dead MemTree produces is itself the likeliest reason the user hits ESC,
  // so the outage would go unrecorded exactly when it is most expensive.
  const upstream = await recordingUpstream();
  const held = deferred();
  let compressArrived = false;
  let blockingCompresses = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      blockingCompresses++;
      compressArrived = true;
      await held.promise;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    // Send a large tool turn, then kill the client mid-compress.
    const clientGone = new Promise((resolve) => {
      const clientReq = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...SESSION },
      });
      clientReq.on("error", resolve);
      clientReq.end(
        JSON.stringify({ model: "claude-x", max_tokens: 64, messages: conversation })
      );
      waitFor(() => compressArrived).then(() => clientReq.destroy());
    });
    await clientGone;
    // Let the socket teardown reach the proxy's res 'close' listener before
    // compression settles (same race as the deflaked lane-handback test);
    // otherwise the outcome is "failed" instead of "client-closed".
    await new Promise((r) => setTimeout(r, 150));
    held.resolve();
    await within(
      waitFor(() =>
        messageRecords(records).some(
          (r) => r.routeRecovery?.outcome === "client-closed"
        )
      ),
      "the aborted recovery never settled"
    );
    assert.equal(blockingCompresses, 1);

    // The next large miss must ride the cooldown, not pay the budget again.
    // The aborted attempt already spent MAIN's lane budget (and "spent" wins
    // over "cooldown" when both gates hold), so probe from a sibling lane
    // whose budget is intact — the cooldown is the shared fuse under test.
    await postMessages(proxy.port, extendToolLoop(conversation, "t2"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-fuse-probe",
    });
    const next = messageRecords(records).at(-1);
    assert.equal(
      next.routeRecovery.outcome,
      "cooldown",
      "a null result is knowledge about MemTree, not about the client socket"
    );
    assert.equal(blockingCompresses, 1, "no second blocking compress");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a healthy answer on the followup path lifts the tool-recovery cooldown", async () => {
  // Both blocking paths share one MemTree client and one 15s budget, so they
  // must share the health signal too. Otherwise a recovered MemTree stays
  // locked out of tool recovery for the rest of the cooldown window purely
  // because the proof of recovery arrived on the human-turn path.
  const upstream = await recordingUpstream();
  let healthy = false;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (!healthy) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "down" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory()));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    await postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "failed");

    healthy = true;
    await postMessages(proxy.port, followupTurn("turn two"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // A large miss for a different conversation: recovery must be attempted,
    // not suppressed by a cooldown the followup already disproved.
    await postMessages(proxy.port, largeToolTurn("CCC"), SESSION);
    const recovered = messageRecords(records).at(-1);
    assert.equal(recovered.routeMiss, "rejected");
    assert.equal(
      recovered.routeRecovery.outcome,
      "compressed",
      "the followup's answer proved MemTree was back"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a failed recovery releases its reservation; the in-flight followup still installs", async () => {
  // A recovery reserves a newer decision generation than the in-flight
  // followup in the same lane. If the recovery fails and does NOT hand its
  // reservation back, the followup compresses successfully and still installs
  // nothing — the very bug the release exists to prevent. (Two concurrent
  // recoveries per lane are impossible now: the second miss is "spent".)
  const upstream = await recordingUpstream();
  const gates = { AAA: deferred(), BBB: deferred(), CCC: deferred() };
  const arrived = { AAA: false, BBB: false, CCC: false };
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const respond = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (parsed.index_only) return respond(200, { ok: true });
      const body = JSON.stringify(parsed.messages);
      const marker = ["BBB", "CCC"].find((m) => body.includes(m)) ?? "AAA";
      arrived[marker] = true;
      await gates[marker].promise;
      // Only the followup succeeds; both recoveries fail and must release.
      return marker === "AAA"
        ? respond(200, recoveredMemory("AAA"))
        : respond(500, { error: "down" });
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("AAA turn two");
  try {
    // Reservations are taken before the compress request is sent, so arrival
    // at the mock orders the generations: followup first, recovery newer.
    const followup = postMessages(proxy.port, base, SESSION);
    await waitFor(() => arrived.AAA);
    const recovery = postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    await waitFor(() => arrived.BBB);
    // A third miss while the recovery is in flight gets no attempt at all:
    // the lane's budget is already spent, so it never reaches the mock.
    await postMessages(proxy.port, largeToolTurn("CCC"), SESSION);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "spent"
    );
    assert.equal(arrived.CCC, false, "the spent miss sent no compress");

    gates.BBB.resolve();
    await recovery;
    const failed = messageRecords(records).find(
      (r) => r.routeRecovery && r.routeRecovery.outcome === "failed"
    );
    assert.ok(failed, "the recovery attempt failed and released");

    gates.AAA.resolve();
    await followup;
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "tool-memory",
      "the failed recovery handed the decision back, so the followup installed"
    );
  } finally {
    gates.AAA.resolve();
    gates.BBB.resolve();
    gates.CCC.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// ralph-review cycle 3
// ---------------------------------------------------------------------------

test("every lane shares the MemTree fuse: subagent evidence arms and lifts it", async () => {
  // Deliberate inversion of the old main-only rule. With subagents on the
  // same recovery path, a subagent's compress failure is the same evidence
  // about MemTree's health as main's, and its success clears the cooldown
  // too. What bounds any one lane to a single blocking stall per epoch is
  // the per-lane attempt budget, not the fuse.
  const upstream = await recordingUpstream();
  let healthy = false;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (!healthy) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "down" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory()));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    await postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "failed");

    // While the fuse is armed, ANY lane's miss skips its blocking attempt —
    // and a cooldown skip does not consume that lane's budget.
    await postMessages(proxy.port, largeToolTurn("CCC"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-7",
    });
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "cooldown",
      "the fuse is shared: a subagent lane skips during main's cooldown"
    );

    // MemTree answers again, and a SUBAGENT's live compress is what proves
    // it: its success lifts the fuse for everyone.
    healthy = true;
    await postMessages(proxy.port, followupTurn("agent question"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-7",
    });
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "followup-compressed",
      "the subagent's own turn still compresses normally"
    );

    // A lane with its budget intact gets its attempt now.
    await postMessages(proxy.port, largeToolTurn("DDD"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-8",
    });
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "compressed",
      "a subagent's success lifted the fuse"
    );

    // Main's own lane spent its budget on the failed attempt above: with the
    // fuse lifted it still forwards verbatim for the rest of the epoch.
    await postMessages(proxy.port, largeToolTurn("EEE"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "spent");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a cache-served compress result cannot lift the cooldown", async () => {
  // compress() memoizes successes by hash and returns them without touching
  // the network. Claude Code retrying an identical body (after a 529, or an
  // ESC and re-send) therefore replays an answer recorded BEFORE the outage.
  // Reading that as "MemTree is up" re-opens the fuse on pure history.
  const upstream = await recordingUpstream();
  let healthy = true;
  let liveCompressCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      liveCompressCalls++;
      if (!healthy) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "down" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory()));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const replayed = followupTurn("turn two");
  try {
    // Warm the compress cache for this exact body while MemTree is healthy.
    await postMessages(proxy.port, replayed, SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    healthy = false;
    await postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "failed");

    // The identical retry: answered entirely from cache, zero server contact.
    const before = liveCompressCalls;
    await postMessages(proxy.port, replayed, SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");
    assert.equal(
      liveCompressCalls,
      before,
      "the replay must be served from cache for this test to mean anything"
    );

    await postMessages(proxy.port, largeToolTurn("CCC"), SESSION);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "cooldown",
      "a memoized answer is not evidence that MemTree is answering now"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a cached legacy rescue cannot hide a live canonical failure from the fuse", async () => {
  // Warm ONLY the raw signed-thinking hash. Once MemTree is down, the proxy's
  // normalized canonical leg fails live while the cached legacy result still
  // rescues delivery. That cached winner must not conceal the current failure
  // from other lanes' shared recovery cooldown.
  const upstream = await recordingUpstream();
  let healthy = true;
  let blockingCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      blockingCalls++;
      if (!healthy) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "down" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory("LEGACY")));
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const question = "signed-thinking followup";
  const history = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "legacy-sig" },
        { type: "text", text: "first answer " + "detail ".repeat(500) },
      ],
    },
    { role: "user", content: question },
  ];

  // Directly warm the exact raw hash that runBlockingCompression uses for its
  // legacy leg; the normalized canonical hash remains absent from the cache.
  const rawHash = MemtreeClient.hashMessages(history);
  assert.ok(await memtree.compress(rawHash, history, 200_000));
  assert.equal(blockingCalls, 1);

  healthy = false;
  const records = [];
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    await postMessages(proxy.port, history, SESSION);
    const rescued = messageRecords(records).at(-1);
    assert.equal(rescued.compress.legacyFallback, true);
    assert.equal(rescued.turnType, "followup-compressed");
    assert.equal(blockingCalls, 2, "only the uncached canonical leg failed live");

    await postMessages(proxy.port, largeToolTurn("CCC"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-after-cached-rescue",
    });
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "cooldown",
      "the live canonical failure armed the shared fuse"
    );
    assert.equal(blockingCalls, 2, "the fresh lane made no blocking retry");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a fast-tool abort does not strand recovery in transform-only mode", async () => {
  // Claude consuming message_stop and dropping the SSE is a documented normal
  // success, but it settles delivery false, so mainPromptDelivered stays false
  // until the Stop hook. Keying recovery's prompt window off that flag meant
  // every later large tool turn in the same agent turn recompressed and
  // installed NOTHING -- a full blocking wait per tool turn, unbounded by the
  // cooldown because every attempt succeeded.
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const messageStopFrame = frame("message_stop", { type: "message_stop" });
  const toolResponse =
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_tool", usage: { input_tokens: 42 } },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "x", input: {} },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    }) +
    messageStopFrame;
  let seen = 0;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen++;
      if (seen === 1) {
        // Protocol completes; HTTP deliberately left open so the client can
        // tear it down first and delivery settles false.
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.write(toolResponse);
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  let clientRequest;
  let clientResponse;
  try {
    await armMainTurn(proxy, "turn two");
    await new Promise((resolve, reject) => {
      const body = Buffer.from(
        JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          stream: true,
          messages: followupTurn("turn two"),
        })
      );
      clientRequest = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            ...SESSION,
          },
        },
        (response) => {
          clientResponse = response;
          let received = "";
          response.setEncoding("utf-8");
          response.on("data", (chunk) => {
            received += chunk;
            if (!received.includes(messageStopFrame)) return;
            response.destroy(); // the fast-tool abort
            resolve();
          });
          response.on("error", () => {});
        }
      );
      clientRequest.once("error", reject);
      clientRequest.end(body);
    });
    await waitFor(() =>
      messageRecords(records).some((r) => r.turnType === "followup-compressed")
    );

    // A large tool turn for a different conversation shape: the installed
    // route cannot serve it, so this is a genuine same-session route miss.
    await postMessages(proxy.port, largeToolTurn("CCC"), SESSION);
    const recovered = messageRecords(records).at(-1);
    assert.equal(recovered.routeRecovery.outcome, "compressed");
    assert.equal(
      recovered.routeRecovery.install,
      "installed",
      "recovery must self-heal the route instead of recompressing forever"
    );
  } finally {
    clientResponse?.destroy();
    clientRequest?.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// count_tokens lane parity: the preflight mirrors the messages path's
// identity-keyed route lookup, and only its own lane's route may rewrite it.
// ---------------------------------------------------------------------------

test("an agent-attributed count_tokens rides its own lane during the tool loop", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-count" };
  const base = followupTurn("agent turn two");
  try {
    // The agent followup compresses and installs the agent lane's route.
    await postMessages(proxy.port, base, agent);
    const followup = messageRecords(records).at(-1);
    assert.equal(followup.turnType, "followup-compressed");
    assert.equal(followup.routeLane, "agent");

    // The agent's count_tokens preflight for its next tool turn must size the
    // grafted compressed context, not the full history it never sends.
    const counted = await postCountTokens(
      proxy.port,
      { model: "claude-x", messages: extendToolLoop(base, "c1") },
      agent
    );
    assert.equal(counted.input_tokens, 42, "count response stays transparent");
    const seenCount = upstream.seen.find((c) => c.isCount);
    assert.ok(seenCount, "count_tokens reached upstream");
    assert.match(
      JSON.stringify(seenCount.body.messages[0].content),
      /compressed context/,
      "count_tokens sizes the agent lane's compressed context"
    );
    assert.ok(
      !JSON.stringify(seenCount.body.messages).includes("first question"),
      "the uncompressed prefix must not be re-counted"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("agent count_tokens without its own route forwards verbatim and spares main's lane", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const base = followupTurn("turn two");
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, base, SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // Same session, agent attribution: the agent lane holds no route, so the
    // preflight forwards untouched — main's route is not its to graft.
    await postCountTokens(
      proxy.port,
      { model: "claude-x", messages: extendToolLoop(base, "c1") },
      { ...SESSION, "x-claude-code-agent-id": "agent-observer" }
    );
    const seenCount = upstream.seen.find((c) => c.isCount);
    assert.ok(seenCount, "count_tokens reached upstream");
    const countedMessages = JSON.stringify(seenCount.body.messages);
    assert.match(countedMessages, /first question/, "forwarded verbatim");
    assert.doesNotMatch(
      countedMessages,
      /compressed context/,
      "another lane's route must not rewrite the agent's preflight"
    );

    // The lookup on the agent's key must not have deleted or reordered away
    // main's entry: the next MAIN tool turn still rides.
    await postMessages(proxy.port, extendToolLoop(base, "t1"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /compressed context/,
      "main's route survives the foreign-lane count_tokens"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a sibling's count_tokens on the shared parent lane fails closed to verbatim", async () => {
  // Requests attributed only by x-claude-code-parent-agent-id share one lane.
  // When sibling A's route is installed there, sibling B's count_tokens (a
  // different history) must mismatch the stored prefix hashes and forward
  // verbatim — never crash, never count A's compressed context for B.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const parentLane = { ...SESSION, "x-claude-code-parent-agent-id": "parent-lane" };
  try {
    // Sibling A's followup installs the shared parent lane's route.
    await postMessages(proxy.port, followupTurn("sibling A work"), parentLane);
    const installed = messageRecords(records).at(-1);
    assert.equal(installed.turnType, "followup-compressed");
    assert.equal(installed.routeLane, "agent");

    // Sibling B: same attribution headers, unrelated conversation.
    const siblingB = [
      { role: "user", content: "sibling B question" },
      { role: "assistant", content: [{ type: "text", text: "sibling B answer" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "b1", name: "x", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }],
      },
    ];
    const counted = await postCountTokens(
      proxy.port,
      { model: "claude-x", messages: siblingB },
      parentLane
    );
    assert.equal(counted.input_tokens, 42, "the preflight still completes");
    const seenCount = upstream.seen.find((c) => c.isCount);
    assert.ok(seenCount, "count_tokens reached upstream");
    const countedMessages = JSON.stringify(seenCount.body.messages);
    assert.match(countedMessages, /sibling B question/, "forwarded verbatim");
    assert.doesNotMatch(
      countedMessages,
      /compressed context/,
      "sibling A's prefix cannot graft onto sibling B's history"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an unarmed local bang-command turn owns its compression notice", async () => {
  // Local `!command` turns do not consistently emit UserPromptSubmit, and the
  // API history carries bash wrappers rather than the literal typed command.
  // Their strict main-thread replay shape still owns and queues the notice.
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    // Deliberately NO armMainTurn: the bash replay shape alone must qualify.
    await postMessages(
      proxy.port,
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "<bash-input>pwd</bash-input>" },
        {
          role: "user",
          content:
            "<bash-stdout>/tmp/project</bash-stdout>" +
            "<bash-stderr></bash-stderr>",
        },
      ],
      SESSION
    );
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    const stop = await postHook(proxy, {
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    assert.equal(stop.status, 200, "the unarmed bang turn queued its notice");
    assert.equal(
      stop.body.systemMessage.replace(/\x1B\[[0-9;]*m/g, ""),
      COMPRESSED_NOTICE
    );
    assert.equal(
      (await postHook(proxy, { hook_event_name: "Stop", stop_hook_active: false }))
        .status,
      204,
      "the notice is claimed exactly once"
    );
    assert.deepEqual(
      records.filter((r) => r.kind === "notice"),
      [{ kind: "notice", event: "claimed", via: "Stop" }]
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("route matching ignores block cache metadata but preserves nested tool data", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    // A stale-route rejection must stay visible instead of being repaired by
    // recovery, or the nested-data mismatch below would pass while grafting.
    toolRouteRecovery: false,
  });
  const anchored = [
    { role: "user", content: "first question" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "seed-tool",
          name: "seed",
          input: { cache_control: "domain-value" },
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "seed-tool", content: "seed result" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: "turn two" },
  ];
  try {
    await armMainTurn(proxy, "turn two");
    await postMessages(proxy.port, anchored, SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // Claude churns block-level cache_control mid-loop; that is transport
    // metadata, not conversation identity. The suffix's tool_result carries
    // nested content blocks (with their own cache metadata) that must survive
    // the graft byte-for-byte.
    const churned = structuredClone(anchored);
    churned[1].content[0].cache_control = { type: "ephemeral", ttl: "1h" };
    const nestedResult = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "nested one",
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: "nested two" },
          ],
        },
      ],
    };
    const ride = [
      ...churned,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read",
            input: { deep: ["numbers", 1, 2] },
          },
        ],
      },
      nestedResult,
    ];
    await postMessages(proxy.port, ride, SESSION);
    assert.equal(
      messageRecords(records).at(-1).turnType,
      "tool-memory",
      "cache_control churn alone must not break the match"
    );
    const grafted = upstream.seen.at(-1).body.messages;
    assert.match(JSON.stringify(grafted[0].content), /compressed context/);
    assert.deepEqual(
      grafted.at(-1),
      nestedResult,
      "nested tool_result content survives the graft untouched"
    );
    assert.deepEqual(grafted.at(-2).content[0].input, { deep: ["numbers", 1, 2] });

    // Nested tool DATA is identity: a change inside tool_use.input — even one
    // spelled "cache_control" — must reject the route and forward verbatim.
    const changed = structuredClone(ride);
    changed[1].content[0].input.cache_control = "changed-domain-value";
    await postMessages(proxy.port, extendToolLoop(changed, "tool-2"), SESSION);
    const rejected = messageRecords(records).at(-1);
    assert.equal(rejected.routeMiss, "rejected");
    const forwarded = JSON.stringify(upstream.seen.at(-1).body.messages);
    assert.match(forwarded, /first question/, "full history forwards verbatim");
    assert.doesNotMatch(forwarded, /compressed context/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// ralph-review cycle 1 (2026-08-13): decided fixes
// ---------------------------------------------------------------------------

test("a hook-armed prompt's followup bump keeps spent lanes spent", async () => {
  // One turn boundary, one budget wipe: UserPromptSubmit already cleared
  // toolRecoveryAttemptedLanes, so the same prompt's followup bump must not
  // clear it again — a lane that spent its attempt between the two bumps
  // would otherwise get a second blocking compress at the same boundary.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-boundary" };
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  try {
    // The hook bump is this boundary's single budget wipe...
    await armMainTurn(proxy, "turn two");
    // ...the agent lane spends its one attempt after it...
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );
    // ...and then the armed prompt's own followup arrives and bumps again.
    await postMessages(proxy.port, followupTurn("turn two"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The followup bump cleared the agent's route (new epoch) but kept its
    // spent mark: the next agent miss forwards verbatim, no second compress.
    const beforeMiss = blockingCalls();
    await postMessages(proxy.port, extendToolLoop(largeToolTurn("BBB"), "s1"), agent);
    const spent = messageRecords(records).at(-1);
    assert.equal(spent.routeMiss, "missing");
    assert.equal(spent.routeRecovery.outcome, "spent");
    assert.equal(spent.turnType, "tool");
    assert.equal(blockingCalls(), beforeMiss, "the spent lane paid nothing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a hookless followup bump still re-grants a spent lane's budget", async () => {
  // Hookless embedders never fire UserPromptSubmit, so the followup bump is
  // their only per-human-turn wipe. It must keep clearing, or a lane that
  // spent its attempt would forward full history for the rest of the session.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-hookless" };
  try {
    // The agent lane spends its attempt; no hook ever fires.
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );
    // A hookless main followup: the arm was never set, so this bump clears.
    await postMessages(proxy.port, followupTurn("turn two"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The agent lane's next miss attempts again instead of logging "spent".
    await postMessages(proxy.port, extendToolLoop(largeToolTurn("BBB"), "s1"), agent);
    const regranted = messageRecords(records).at(-1);
    assert.equal(regranted.routeMiss, "missing");
    assert.equal(regranted.routeRecovery.outcome, "compressed");
    assert.equal(regranted.routeRecovery.install, "installed");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an identical tool-body retry is a replay: verbatim forward, route retained", async () => {
  // A recovery-installed route's prefix IS the tool body that installed it.
  // Claude Code retries a request whose socket died before the flush with the
  // identical body; the empty suffix cannot ride, but this is a client retry,
  // not a divergence — the route must survive so the next real tool turn
  // rides instead of paying a rebuild.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );

    await postMessages(proxy.port, conversation, SESSION);
    const replay = messageRecords(records).at(-1);
    assert.equal(replay.routeMiss, "replay");
    assert.equal(replay.turnType, "tool");
    assert.equal(
      replay.routeRecovery,
      undefined,
      "a replay neither attempts recovery nor spends budget"
    );
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /first question/,
      "the retry forwards verbatim"
    );

    // The route survived the replay: the next real tool turn rides it.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("an upstream-failed recovery refunds the lane budget for the retry", async () => {
  // A 529 on the recovered leg means the compress succeeded but no route was
  // installed and the model never answered — the client's identical-body
  // retry is coming. Refunding the lane (epoch-guarded) lets that retry
  // re-attempt, and its recompress is a compress-cache hit. Reject-deletes
  // deliberately do NOT refund: see the sibling-eviction test above.
  let failFirst = true;
  const seen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      if (failFirst) {
        failFirst = false;
        res.writeHead(529, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error" }));
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  try {
    await postMessages(proxy.port, conversation, SESSION);
    const first = messageRecords(records).at(-1);
    assert.equal(first.routeRecovery.outcome, "compressed");
    assert.equal(first.routeRecovery.install, "upstream-failed");
    const liveCompresses = blockingCalls();

    // The identical retry re-attempts (budget refunded), served from the
    // compress cache, and installs against the now-healthy upstream.
    await postMessages(proxy.port, conversation, SESSION);
    const retry = messageRecords(records).at(-1);
    assert.equal(retry.routeMiss, "missing");
    assert.equal(retry.routeRecovery.outcome, "compressed");
    assert.equal(retry.routeRecovery.install, "installed");
    assert.equal(
      blockingCalls(),
      liveCompresses,
      "the retry's recompress was a cache hit"
    );

    // And the rest of the tool loop rides the recovered route.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a live 4xx compress failure does not arm the cooldown; a 5xx still does", async () => {
  // The fuse is knowledge about MemTree's health. A 400 comes from a
  // responsive server rejecting one request, so later misses on other lanes
  // must still get their attempt; a 5xx is the outage signal and keeps
  // arming exactly as before (as do timeouts, network errors, and 402).
  const upstream = await recordingUpstream();
  let failStatus = 400;
  let blockingCompresses = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      blockingCompresses++;
      res.writeHead(failStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no" }));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const lane = (id) => ({ ...SESSION, "x-claude-code-agent-id": id });
  try {
    await postMessages(proxy.port, largeToolTurn("BBB"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "failed");
    assert.equal(blockingCompresses, 1);

    // The 400 armed nothing: a sibling lane's miss still pays its attempt.
    await postMessages(proxy.port, largeToolTurn("CCC"), lane("agent-4xx-a"));
    const probe = messageRecords(records).at(-1);
    assert.equal(
      probe.routeRecovery.outcome,
      "failed",
      "a 4xx must not suppress other lanes' attempts as cooldown"
    );
    assert.equal(blockingCompresses, 2, "the sibling's attempt reached MemTree");

    // A 5xx from the same server is the outage class: it arms.
    failStatus = 500;
    await postMessages(proxy.port, largeToolTurn("DDD"), lane("agent-4xx-b"));
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "failed");
    assert.equal(blockingCompresses, 3);

    await postMessages(proxy.port, largeToolTurn("EEE"), lane("agent-4xx-c"));
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "cooldown",
      "the 500 armed the shared fuse"
    );
    assert.equal(blockingCompresses, 3, "the cooldown skip paid nothing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a compress timeout arms the cooldown", async () => {
  // No response inside the abort budget is the strongest outage evidence
  // there is — a stall is exactly what the fuse exists to bound.
  const upstream = await recordingUpstream();
  const held = deferred();
  let blockingCompresses = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      blockingCompresses++;
      await held.promise;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "late" }));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({
      baseUrl: memtreeSrv.origin,
      apiKey: "k",
      compressTimeoutMs: 100,
    }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    await postMessages(proxy.port, conversation, SESSION);
    const first = messageRecords(records).at(-1);
    assert.equal(first.routeRecovery.outcome, "failed");
    assert.equal(first.compress.timedOut, true, "the abort budget burned");
    assert.equal(blockingCompresses, 1);

    // The timeout armed the shared fuse: a sibling lane skips its attempt.
    await postMessages(proxy.port, extendToolLoop(conversation, "t2"), {
      ...SESSION,
      "x-claude-code-agent-id": "agent-timeout-probe",
    });
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "cooldown",
      "no response at all is outage-class evidence"
    );
    assert.equal(blockingCompresses, 1, "no second blocking compress");
  } finally {
    held.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// ralph-review cycles 2+3 (2026-08-13): regression pins for the shipped fixes
// ---------------------------------------------------------------------------

test("a client closed during the blocking compress refunds the lane budget", async () => {
  // Cycle-3 fix: a downstream that dies DURING the compress is the same
  // hazard class as the refunded post-forward fates — no route installed and
  // the client's identical retry imminent. Before the refund, that retry hit
  // "spent" and every later tool turn in the epoch forwarded full history.
  const upstream = await recordingUpstream();
  const gate = deferred();
  let compressArrived = false;
  let blockingCompresses = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      blockingCompresses++;
      compressArrived = true;
      // Held long enough for the client to give up; then SUCCEEDS, so the
      // result lands in the compress cache and the retry pays nothing.
      await gate.promise;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recoveredMemory()));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  try {
    // Send the large miss, then kill the client while the compress is held.
    const clientGone = new Promise((resolve) => {
      const clientReq = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...SESSION },
      });
      clientReq.on("error", resolve);
      clientReq.end(
        JSON.stringify({ model: "claude-x", max_tokens: 64, messages: conversation })
      );
      waitFor(() => compressArrived).then(() => clientReq.destroy());
    });
    await clientGone;
    // Let the close propagate to the proxy's res 'close' listener before the
    // compress settles (same race as the deflaked lane-handback test);
    // otherwise recovery forwards as live, logs "compressed", and the refund
    // assertions below fail.
    await new Promise((r) => setTimeout(r, 150));
    gate.resolve();
    await within(
      waitFor(() =>
        messageRecords(records).some(
          (r) => r.routeRecovery?.outcome === "client-closed"
        )
      ),
      "the client-closed recovery never settled",
      4_000
    );
    assert.equal(blockingCompresses, 1);

    // The refund lets the identical retry make a REAL attempt — an outcome
    // with an install fate, not "spent" — served from the compress cache
    // (client closes are deliberately never fed into compress()).
    await postMessages(proxy.port, conversation, SESSION);
    const retry = messageRecords(records).at(-1);
    assert.equal(retry.routeMiss, "missing");
    assert.equal(retry.routeRecovery.outcome, "compressed");
    assert.equal(retry.routeRecovery.install, "installed");
    assert.equal(
      blockingCompresses,
      1,
      "the retry's recompress was a cache hit"
    );

    // And the rest of the tool loop rides the recovered route.
    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    gate.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a mid-stream client abort logs client-aborted and refunds the lane", async () => {
  // Cycle-2 split the no-install fate by who owned the close, and cycle-3
  // hardened the stamp against the settle detaching the close listener
  // first. A client dropping the SSE before message_stop says nothing about
  // upstream health, so the attempt-rate tripwire must see "client-aborted",
  // never "upstream-failed" — while the refund treats both alike: no route
  // was installed and the identical retry is imminent either way.
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let heldStream;
  let streamedOnce = false;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const forwarded = Buffer.concat(chunks).toString("utf-8");
      if (!streamedOnce && forwarded.includes("recovered memory")) {
        // The recovered forward: stream a first frame, never send
        // message_stop, and hold the socket until the client tears it down —
        // the abort is deterministic, not a race against the stream's end.
        streamedOnce = true;
        heldStream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          frame("message_start", {
            type: "message_start",
            message: { id: "msg_held", usage: { input_tokens: 42 } },
          })
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(UPSTREAM_BODY)),
      });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const conversation = largeToolTurn();
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  let clientRequest;
  let clientResponse;
  try {
    // The client aborts as soon as the first streamed byte arrives — the
    // compress succeeded and the forward is live, but protocol-complete
    // never fires.
    await new Promise((resolve, reject) => {
      const body = Buffer.from(
        JSON.stringify({
          model: "claude-x",
          max_tokens: 64,
          stream: true,
          messages: conversation,
        })
      );
      clientRequest = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            ...SESSION,
          },
        },
        (response) => {
          clientResponse = response;
          response.once("data", () => {
            response.destroy(); // the mid-stream abort
            resolve();
          });
          response.on("error", () => {});
        }
      );
      clientRequest.once("error", reject);
      clientRequest.end(body);
    });
    await within(
      waitFor(() =>
        messageRecords(records).some((r) => r.routeRecovery?.install !== undefined)
      ),
      "the aborted recovery never settled",
      4_000
    );
    const aborted = messageRecords(records).find(
      (r) => r.routeRecovery?.install !== undefined
    );
    assert.equal(aborted.routeRecovery.outcome, "compressed");
    assert.equal(
      aborted.routeRecovery.install,
      "client-aborted",
      "a client-owned close must not be labeled upstream-failed"
    );
    assert.equal(aborted.clientAborted, true);
    const liveCompresses = blockingCalls();

    // The refund: the identical retry re-attempts from the compress cache
    // and installs against the now-ordinary upstream response.
    await postMessages(proxy.port, conversation, SESSION);
    const retry = messageRecords(records).at(-1);
    assert.equal(retry.routeMiss, "missing");
    assert.equal(retry.routeRecovery.outcome, "compressed");
    assert.equal(retry.routeRecovery.install, "installed");
    assert.equal(
      blockingCalls(),
      liveCompresses,
      "the retry's recompress was a cache hit"
    );

    await postMessages(proxy.port, extendToolLoop(conversation), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");
  } finally {
    clientResponse?.destroy();
    clientRequest?.destroy();
    heldStream?.destroy();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a first-user main consumes the boundary wipe so a later hookless followup re-grants", async () => {
  // Cycle-3 fix: a first-user-shaped main request is its boundary's only
  // main arrival — no followup bump will ever come to consume the
  // UserPromptSubmit flag. Left set, a LATER hookless main followup would
  // read a stale "already wiped", keep its spent lanes spent, and the agent
  // lane would forward full history across a human-turn boundary.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-first-user" };
  try {
    // An agent lane spends its budget in the pre-boundary epoch...
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );
    // ...the hook bump wipes the budget and flags the boundary as wiped...
    await armMainTurn(proxy, "typed prompt");
    // ...and the prompt arrives FIRST-USER-shaped: single non-tool user
    // message, no earlier real user turn, so no followup bump ever comes for
    // this boundary. The flag must be consumed here.
    await postMessages(proxy.port, [{ role: "user", content: "typed prompt" }], SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "first-user");

    // The agent spends its re-granted budget inside the new boundary.
    const spentAgain = extendToolLoop(largeToolTurn("BBB"), "b1");
    await postMessages(proxy.port, spentAgain, agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );

    // A hookless-shaped main followup (no UserPromptSubmit fired): its bump
    // must wipe. The stale flag would have skipped the wipe here.
    await postMessages(proxy.port, followupTurn("hookless turn two"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The agent lane's next miss attempts recovery instead of logging
    // "spent" — the exact regression the consume-once closes.
    await postMessages(proxy.port, extendToolLoop(spentAgain, "b2"), agent);
    const regranted = messageRecords(records).at(-1);
    assert.equal(regranted.routeMiss, "missing");
    assert.equal(
      regranted.routeRecovery.outcome,
      "compressed",
      "a stale boundary flag would have kept this lane spent"
    );
    assert.equal(regranted.routeRecovery.install, "installed");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

/**
 * largeToolTurn plus a signed thinking block, so normalization strips it and
 * legacyHash !== hash arms the legacy probe leg.
 */
function largeThinkingToolTurn(marker = "TTT") {
  return [
    { role: "user", content: `${marker} first question` },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        { type: "text", text: `${marker} ` + "history ".repeat(64 * 1024) },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ];
}

test("each compress leg samples its arming class at its own settle", async () => {
  // Cycle-2 fix: the arming classification is per-hash and a concurrent
  // same-hash failure of another class may overwrite it, so each leg samples
  // in its OWN .then. The held legacy probe keeps lane A's Promise.all open
  // long after its canonical 500 settled; lane B's same-hash 400 then
  // overwrites the entry inside that window. A late (post-Promise.all) read
  // would see the non-arming 400 and never arm the fuse.
  const upstream = await recordingUpstream();
  const legacyGate = deferred();
  let legacyArrived = false;
  let canonicalCalls = 0;
  const memtreeSrv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (parsed.index_only) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      // The legacy leg carries the thinking block the canonical shape strips.
      if (JSON.stringify(parsed.messages).includes('"thinking"')) {
        legacyArrived = true;
        await legacyGate.promise;
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "legacy rejected" }));
      }
      canonicalCalls++;
      // First canonical: an arming-class 500. Second (lane B, same hash —
      // failures are never cached, so it is a live call): a non-arming 400
      // that overwrites the per-hash classification entry.
      res.writeHead(canonicalCalls === 1 ? 500 : 400, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "no" }));
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const laneA = { ...SESSION, "x-claude-code-agent-id": "agent-arm-a" };
  const laneB = { ...SESSION, "x-claude-code-agent-id": "agent-arm-b" };
  const laneC = { ...SESSION, "x-claude-code-agent-id": "agent-arm-c" };
  const turn = largeThinkingToolTurn();
  try {
    const first = postMessages(proxy.port, turn, laneA);
    await waitFor(() => canonicalCalls === 1 && legacyArrived);
    // Lane B's canonical must be a LIVE call, which requires lane A's failed
    // canonical to have settled client-side first (failures are deleted from
    // the dedupe cache at settle; an in-flight promise is joined). That
    // settle is not externally observable and a fixed sleep here was
    // load-sensitive: a post arriving too early joins the dedupe and can
    // never go live, timing the test out. Post and re-post from FRESH lanes
    // instead — each lane brings its own recovery budget, while the compress
    // hash the dedupe and arming entry key on depends only on the shared
    // turn body — until one lands live at the server.
    const seconds = [postMessages(proxy.port, turn, laneB)];
    for (let tries = 0; canonicalCalls < 2 && tries < 20; tries++) {
      await new Promise((r) => setTimeout(r, 150));
      if (canonicalCalls < 2) {
        seconds.push(
          postMessages(proxy.port, turn, {
            ...SESSION,
            "x-claude-code-agent-id": `agent-arm-b${tries}`,
          })
        );
      }
    }
    await waitFor(() => canonicalCalls >= 2);
    // Give the 400's non-arming class time to overwrite the per-hash entry
    // while lane A is still parked on the held legacy leg — the exact window
    // the sample-at-settle contract closes. (Lane B's own legacy leg joins
    // lane A's in-flight promise, so it was cached at sampling time and
    // contributes no fuse evidence of its own.) This window is deliberately
    // a fixed sleep: if it ever proves too short under load, the failure
    // direction is a weaker pin — regressed post-Promise.all sampling would
    // read the not-yet-overwritten 500 and still pass — never a flake of the
    // fixed code.
    await new Promise((r) => setTimeout(r, 150));

    legacyGate.resolve();
    await first;
    await Promise.all(seconds);
    // Lane A and the one lane whose canonical went live both classified
    // before the fuse could arm, so they must have settled "failed". A
    // straggler retry-loop lane, though, may reach classification only
    // AFTER legacyGate.resolve() let lane A's settle arm the fuse — under
    // load its record is legitimately "cooldown", which is consistent with
    // (and caused by) exactly the arming this test pins. Under the
    // regression (post-Promise.all sampling reads the 400) no record can be
    // "cooldown" at all, so admitting it here gives the regression nothing.
    // No positional assumptions: records are ordered by response-settle
    // time, and lane A's record push can race a straggler's verbatim
    // forward at the shared upstream — so count outcomes instead of
    // indexing. Lane A structurally cannot record "cooldown" (it passed
    // the fuse gate before any arming evidence existed) and the live-400
    // lane entered compress before arming was possible, so correct code
    // always yields at least two "failed" records.
    const preProbe = messageRecords(records);
    for (const settled of preProbe) {
      assert.ok(
        ["failed", "cooldown"].includes(settled.routeRecovery.outcome),
        `unexpected outcome ${settled.routeRecovery.outcome}`
      );
    }
    assert.ok(
      preProbe.filter((s) => s.routeRecovery.outcome === "failed").length >= 2,
      "lane A's live 500 and the live-400 lane must both settle failed"
    );

    // Lane A's 500 must have armed the shared fuse: the class was read at
    // the canonical leg's own settle, before lane B's 400 overwrote it.
    const callsBeforeProbe = canonicalCalls;
    await postMessages(proxy.port, largeToolTurn("CCC"), laneC);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "cooldown",
      "a post-Promise.all sample would have read the overwriting 400"
    );
    assert.equal(
      canonicalCalls,
      callsBeforeProbe,
      "the cooldown skip paid nothing"
    );
  } finally {
    legacyGate.resolve();
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// ralph-review cycle 4 (2026-08-13): regression pins for the shipped fixes
//
// completeUpstream's shutdown guard (!shutdownCancelled) is deliberately not
// pinned here: the misclassification window is the sub-tick gap between
// decoder.end() and its deferred finish() inside the proxy's own event-loop
// turn, which an external test cannot enter deterministically.
// ---------------------------------------------------------------------------

test("a first-user-shaped side call does not consume the boundary wipe", async () => {
  // Cycle-4 fix: only the armed prompt itself may consume the
  // UserPromptSubmit flag (the same prompt-text correlation
  // hookOwnedMainFollowup uses). A CC-internal side call can arrive
  // first-user shaped on the main key without being the armed prompt;
  // letting it consume left the real followup bumping with keep=false — a
  // second wipe in the same boundary, re-granting lanes spent moments
  // earlier, the exact double-wipe keepRecoveryBudget closes.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? recoveredMemory("BBB")
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-side-call" };
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  try {
    // An agent lane spends its budget in the pre-boundary epoch...
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );
    // ...the hook bump wipes the budget and flags the boundary as wiped...
    await armMainTurn(proxy, "typed prompt");
    // ...and a CC-internal side call arrives first-user shaped on the main
    // key WITHOUT carrying the armed prompt. It forwards normally, but the
    // armed prompt's own arrival is still due — the flag must survive it.
    await postMessages(proxy.port, [{ role: "user", content: "quota check" }], SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "first-user");

    // The agent spends its re-granted budget inside the new boundary.
    const spentAgain = extendToolLoop(largeToolTurn("BBB"), "b1");
    await postMessages(proxy.port, spentAgain, agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.install,
      "installed"
    );

    // The REAL armed prompt arrives as its hook-owned followup. Its bump must
    // read the still-set flag and keep spent lanes spent — under the old
    // uncorrelated consume, the side call already cleared it and this bump
    // wiped a second time inside the same boundary.
    await postMessages(proxy.port, followupTurn("typed prompt"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The agent lane's next miss forwards verbatim, no second compress — a
    // consumed flag would have re-granted it a fresh attempt here.
    const beforeMiss = blockingCalls();
    await postMessages(proxy.port, extendToolLoop(spentAgain, "b2"), agent);
    const spent = messageRecords(records).at(-1);
    assert.equal(spent.routeMiss, "missing");
    assert.equal(
      spent.routeRecovery.outcome,
      "spent",
      "a consumed flag would have let the followup re-grant this lane"
    );
    assert.equal(spent.turnType, "tool");
    assert.equal(blockingCalls(), beforeMiss, "the spent lane paid nothing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});
