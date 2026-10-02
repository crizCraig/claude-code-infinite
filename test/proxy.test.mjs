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
  NOT_COMPRESSED_NOTE,
  DEGRADED_NOTICE,
  PAYMENT_REQUIRED_NOTICE,
  wrapNotice,
} from "../dist/notices.js";
import { AWAY_SUMMARY_PROMPT_PREFIX } from "../dist/turns.js";
import { SessionFinder } from "../dist/memtree-mcp.js";

const GREEN = "\x1b[32m";
const DEFAULT_FOREGROUND = "\x1b[39m";

/** The success line, optionally with its "· ~Nk → Mk tokens" sizes, then the answer. */
const SUCCESS_TOTALS_RE = / · ~\d+(?:\.\d+)?[km]? → \d+(?:\.\d+)?[km]? tokens/;

function assertSuccessNotice(text, answer) {
  const colored = text.startsWith(GREEN);
  const plain = text.replace(SUCCESS_TOTALS_RE, "");
  assert.equal(
    plain,
    `${colored ? GREEN : ""}${COMPRESSED_NOTICE}` +
      `${colored ? DEFAULT_FOREGROUND : ""}\n${answer}`,
    "the success line, with no latency"
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
/** `headers` (object, or `(body, call) => object`) adds response headers per call. */
/** Text of a message whose content is a string or text blocks (the compressed message carries a cache marker). */
function flatText(message) {
  const c = message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : c;
}

async function mockMemtree(status, bodyObj, headers = {}) {
  const calls = [];
  const callHeaders = [];
  const srv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      calls.push(parsed);
      callHeaders.push(req.headers);
      const resolved =
        typeof bodyObj === "function" ? bodyObj(parsed, calls.length - 1) : bodyObj;
      const body = JSON.stringify(withServerFlatten(resolved, parsed));
      const extra =
        typeof headers === "function" ? headers(parsed, calls.length - 1) : headers;
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(body);
    });
  });
  return { ...srv, calls, callHeaders };
}

/**
 * Mirror the real server's flatten contract: `flattened_messages` appears in
 * the response only when the request asked `flatten: true`, and holds exactly
 * one string-content user message. Defaults from the mock's single non-system
 * user message so the 60+ existing mocks keep their asserted content. A mock
 * models a pre-flatten server by setting `flattened_messages: null` (the key
 * is then omitted entirely); an explicit array is passed through verbatim so
 * malformed-flatten tests can exercise the client's rejection paths.
 */
function withServerFlatten(response, requestBody) {
  if (
    response == null ||
    typeof response !== "object" ||
    requestBody?.flatten !== true
  ) {
    return response;
  }
  if ("flattened_messages" in response) {
    if (response.flattened_messages === null) {
      const { flattened_messages: _omitted, ...rest } = response;
      return rest;
    }
    return response;
  }
  const nonSystem = Array.isArray(response.messages)
    ? response.messages.filter((m) => m?.role !== "system")
    : [];
  if (
    nonSystem.length !== 1 ||
    nonSystem[0].role !== "user" ||
    typeof nonSystem[0].content !== "string"
  ) {
    return response;
  }
  return {
    ...response,
    flattened_messages: [{ role: "user", content: nonSystem[0].content }],
  };
}

/**
 * listen() for hand-rolled per-test MemTree servers. Applies the same mock
 * flatten contract as mockMemtree to whatever JSON body the handler writes,
 * so the ~30 tests with bespoke server logic (health flips, per-leg routing,
 * deferred responses) don't each re-implement `flattened_messages`. The
 * request body is captured here (our listeners attach before the handler's,
 * so it is parsed before any same-tick response) and every JSON response the
 * handler ends is rewritten through withServerFlatten — a no-op for index_only
 * acks, errors, and non-flatten requests.
 */
function listenMemtree(handler) {
  return listen((req, res) => {
    const chunks = [];
    let requestBody;
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        requestBody = undefined;
      }
    });
    const originalEnd = res.end.bind(res);
    res.end = (body, ...rest) => {
      if (typeof body === "string") {
        try {
          body = JSON.stringify(withServerFlatten(JSON.parse(body), requestBody));
        } catch {
          // Not JSON — pass through untouched.
        }
      }
      return originalEnd(body, ...rest);
    };
    handler(req, res);
  });
}

async function postMessages(port, messages, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages }),
  });
  return res.json();
}

function linkText(text) {
  return stripAnsi(text).replace(SUCCESS_TOTALS_RE, "");
}

function postSessionMessages(port, messages, extraHeaders = {}) {
  return postMessages(port, messages, { "x-claude-code-session-id": "session-1", ...extraHeaders });
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
      flatText(counted.body.messages[0]),
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
      flatText(routed.messages[0]),
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

/** Claude Code 2.1.284's shape for a prompt typed while the turn is running. */
const midTurnReminder = (prompt) =>
  "<system-reminder>\nThe user sent a new message while you were working:\n" +
  `${prompt}\n\nThis is how Claude Code surfaces messages the user sends mid-turn ` +
  "— within the running turn, often alongside the next tool result, rather " +
  "than as a separate conversation turn. Address the message above as you " +
  "continue this turn.\n</system-reminder>";

/** Appends one tool_use/tool_result round; extra parts ride the result wrapper. */
const withToolRound = (messages, id, extraParts = []) => [
  ...messages,
  { role: "assistant", content: [{ type: "tool_use", id, name: "x", input: {} }] },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }, ...extraParts],
  },
];

async function startMidTurnHarness(extraOpts = {}) {
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
    ...extraOpts,
  });
  const compressCalls = () => memtreeSrv.calls.filter((c) => c.index_only !== true).length;
  const lastUpstream = () => JSON.stringify(upstreamBodies.at(-1).messages);
  const close = () => {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  };
  return { proxy, compressCalls, lastUpstream, close };
}

test("a prompt typed mid-turn keeps the tool loop on its memory route (2026-10-02 overflow)", async () => {
  // Incident: the user typed while the main turn was running. UserPromptSubmit
  // fired at once and cleared the route; Claude Code then delivered the text
  // inside a <system-reminder> next to the next tool_result, which the
  // merged-prompt matcher ignores. Recovery stayed transform-only under the
  // armed window, its retry was spent, and every later tool turn forwarded
  // the full history until the conversation hit the 1M window. Compaction
  // off: the session's stable prefix would otherwise carry the tool loop.
  const h = await startMidTurnHarness({ defaultCompactTarget: null });
  const headers = { "x-claude-code-session-id": "session-1" };
  try {
    await armMainTurn(h.proxy, "turn two", "prompt-two");
    const base = followupTurn("turn two");
    await postMessages(h.proxy.port, base, headers);
    assert.equal(h.compressCalls(), 1, "the followup compresses and installs a route");

    const round1 = withToolRound(base, "t1");
    await postMessages(h.proxy.port, round1, headers);
    assert.match(h.lastUpstream(), /compressed context/, "tool turn rides the route");

    await postHook(h.proxy, {
      hook_event_name: "UserPromptSubmit",
      prompt: "do both?",
      prompt_id: "prompt-midturn",
    });
    const round2 = withToolRound(round1, "t2", [
      { type: "text", text: midTurnReminder("do both?") },
    ]);
    await postMessages(h.proxy.port, round2, headers);
    assert.match(h.lastUpstream(), /compressed context/, "mid-turn prompt rides the route");
    assert.doesNotMatch(h.lastUpstream(), /first question/, "no full-history passthrough");
    assert.match(h.lastUpstream(), /do both\?/, "the typed prompt still reaches the model");

    await postMessages(h.proxy.port, withToolRound(round2, "t3"), headers);
    assert.match(h.lastUpstream(), /compressed context/, "later tool turns keep riding");
    assert.doesNotMatch(h.lastUpstream(), /first question/);
    assert.equal(h.compressCalls(), 1, "a mid-turn prompt needs no blocking compress");
  } finally {
    h.close();
  }
});

test("a prompt deferred as mid-turn still owns its own turn when Stop never came", async () => {
  // Claude Code skips Stop on an interrupt, so a real next prompt can look
  // mid-turn to the hook. It is deferred, then armed by the request that
  // carries it as a plain user turn: it compresses and its tool loop rides.
  const h = await startMidTurnHarness({ defaultCompactTarget: null });
  const headers = { "x-claude-code-session-id": "session-1" };
  try {
    await armMainTurn(h.proxy, "turn two", "prompt-two");
    const base = followupTurn("turn two");
    await postMessages(h.proxy.port, base, headers);
    const round1 = withToolRound(base, "t1");
    await postMessages(h.proxy.port, round1, headers);

    await armMainTurn(h.proxy, "turn three", "prompt-three");
    const next = [
      ...round1,
      { role: "assistant", content: [{ type: "text", text: "interrupted" }] },
      { role: "user", content: "turn three" },
    ];
    await postMessages(h.proxy.port, next, headers);
    assert.equal(h.compressCalls(), 2, "the real next prompt compresses");
    assert.match(h.lastUpstream(), /compressed context/);

    await postMessages(h.proxy.port, withToolRound(next, "t4"), headers);
    assert.match(h.lastUpstream(), /compressed context/, "its tool loop rides the new route");
    assert.doesNotMatch(h.lastUpstream(), /first question/);
  } finally {
    h.close();
  }
});

test("queued prompts before Stop keep the compressed route for tool wrappers", async () => {
  const h = await startMidTurnHarness({ defaultCompactTarget: null, toolRouteRecovery: false });
  const headers = { "x-claude-code-session-id": "session-1" };
  try {
    await armMainTurn(h.proxy, "turn two", "prompt-two");
    const base = followupTurn("turn two");
    await postMessages(h.proxy.port, base, headers);
    for (const prompt of ["first queued", "second queued"]) {
      await armMainTurn(h.proxy, prompt, prompt);
    }
    await postHook(h.proxy, { hook_event_name: "Stop", prompt_id: "prompt-two" });
    const next = withToolRound(base, "late-tool", [
      { type: "text", text: "first queued" },
      { type: "text", text: midTurnReminder("second queued") },
    ]);
    await postMessages(h.proxy.port, next, headers);
    assert.match(h.lastUpstream(), /compressed context/);
    assert.doesNotMatch(h.lastUpstream(), /first question/);
    assert.match(h.lastUpstream(), /first queued/);
    assert.match(h.lastUpstream(), /second queued/);
    assert.equal(h.compressCalls(), 1);
  } finally { h.close(); }
});

test("ambiguous route mismatch refuses instead of forwarding the full history", async () => {
  const h = await startMidTurnHarness({ defaultCompactTarget: null, toolRouteRecovery: false });
  const headers = { "x-claude-code-session-id": "session-1" };
  try {
    await armMainTurn(h.proxy, "turn two", "prompt-two");
    const base = followupTurn("turn two");
    await postMessages(h.proxy.port, base, headers);
    const before = h.lastUpstream();
    await armMainTurn(h.proxy, "queued", "queued");
    await postHook(h.proxy, { hook_event_name: "Stop" });
    const mismatch = withToolRound([{ role: "user", content: "different history" }, ...base.slice(1)], "tool");
    await postMessages(h.proxy.port, mismatch, headers);
    assert.equal(h.lastUpstream(), before, "no whole-history request may reach upstream");
    await postMessages(h.proxy.port, withToolRound(base, "valid-tool"), headers);
    assert.match(h.lastUpstream(), /compressed context/, "uncertain mismatch must keep the route");
  } finally { h.close(); }
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

test("server compressed:false is passthrough even when usage looks compressed", async () => {
  // Under budget the server returns the conversation as-is and says so with
  // `compressed: false`. Its cached_tokens is a billing prediction and is > 0
  // on such passthroughs, so the client must gate on the explicit verdict:
  // a flattened rewrite here would defeat Anthropic's prefix cache every
  // human turn for zero size reduction.
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
    compressed: false,
    // Present on purpose: the gate must be the verdict, not the field.
    flattened_messages: [{ role: "user", content: "FLATTENED REWRITE" }],
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 200_000,
      prompt_tokens_details: { cached_tokens: 200_000 },
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
      "compressed:false must forward the original structured request"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("server compressed:true is trusted over a zero cached_tokens", async () => {
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
    messages: [{ role: "user", content: "memory + recent turns" }],
    compressed: true,
    usage: {
      prompt_tokens: 200_000,
      completion_tokens: 1_000,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const json = await postMessages(proxy.port, messages);
    assert.equal(json.content.at(-1).text, "upstream answer");
    // The flattened compressed message carries a cache breakpoint, so Anthropic
    // caches system + tools + compressed history for the tool turns that follow.
    assert.deepEqual(forwarded.messages, [{ role: "user", content: [{ type: "text", text: "memory + recent turns", cache_control: { type: "ephemeral" } }] }]);
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
    // Out of scope: recovery's blocking compress would interleave with the
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
    assert.deepEqual(forwarded.messages, [{ role: "user", content: [{ type: "text", text: "compressed context", cache_control: { type: "ephemeral" } }] }]);
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

test("a replacement prompt's own turn discards the old turn's late notice", async () => {
  const upstream = await mockUpstream();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let compressCalls = 0;
  const memtreeSrv = await listenMemtree((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
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
          // Growing coverage: the repeat-notice dedup must not mask the
          // replacement turn's own notice.
          prompt_tokens_details: { cached_tokens: compressCalls },
        },
      }));
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "old prompt", "prompt-old");
    const oldRequest = postMessages(proxy.port, followupTurn("old prompt"));
    await waitFor(() => compressCalls === 1);

    // No Stop yet, so the hook defers this prompt as possibly mid-turn; its
    // own request below arms it (an interrupt skips Stop). That arm replaces
    // delivery state, so the old turn's late completion cannot surface.
    await armMainTurn(proxy, "new prompt", "prompt-new");
    releaseFirst();
    await oldRequest;

    await postMessages(proxy.port, followupTurn("new prompt"));
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-old" }))).status,
      204
    );
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

const stripAnsi = (text) => text.replace(/\x1B\[[0-9;]*m/g, "");

// The server stamps its short spelling of the page (/m/<leading hex of the
// id>) and the completed index the turn was compressed against.
const PAGE_URL_1 = "https://app.polychat.co/m/ea18af90658b";
const PAGE_URL_2 = "https://app.polychat.co/m/0f1c2d3e4a5b";
const PAGE_URL_3 = "https://app.polychat.co/m/a1b2c3d40000";
const compressedOnce = {
  messages: [{ role: "user", content: "compressed context" }],
  usage: {
    prompt_tokens: 200_000,
    completion_tokens: 100_000,
    prompt_tokens_details: { cached_tokens: 1 },
  },
};
const stopHook = (prompt_id) => ({
  hook_event_name: "Stop",
  stop_hook_active: false,
  ...(prompt_id ? { prompt_id } : {}),
});
const successLine = (link) => `${COMPRESSED_NOTICE}\n  ${link}`;
/** Page + served-index headers for one compress call. */
const pageHeaders = (url, index) => ({
  "x-polychat-memtree-url": url,
  ...(index ? { "x-polychat-memtree-index": index } : {}),
});

// These tests exercise both rendering modes independently of the runner's terminal.
// Top-level tests run sequentially; restore the environment after each case.
function setNoticeColorMode(t, color) {
  const oldNoColor = process.env.NO_COLOR;
  const oldTerm = process.env.TERM;
  const oldHasColors = Object.getOwnPropertyDescriptor(process.stdout, "hasColors");
  t.after(() => {
    if (oldNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = oldNoColor;
    if (oldTerm === undefined) delete process.env.TERM;
    else process.env.TERM = oldTerm;
    if (oldHasColors) Object.defineProperty(process.stdout, "hasColors", oldHasColors);
    else delete process.stdout.hasColors;
  });
  if (color) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = "1";
  process.env.TERM = "xterm-256color";
  // A color-capable terminal must still respect NO_COLOR.
  Object.defineProperty(process.stdout, "hasColors", {
    configurable: true,
    value: () => true,
  });
}

for (const color of [false, true]) {
test(`the first success line links the page; later ones only when a new index was served (${color ? "color" : "NO_COLOR"})`, async (t) => {
  setNoticeColorMode(t, color);
  const upstream = await mockUpstream();
  // Turn two and three compress against the same index; turn four against a
  // newer one (the tool loop's index finished in between).
  const stamps = [
    pageHeaders(PAGE_URL_1, "index-a"),
    pageHeaders(PAGE_URL_2, "index-a"),
    pageHeaders(PAGE_URL_3, "index-b"),
  ];
  const memtreeSrv = await mockMemtree(200, compressedOnce, (_body, call) => stamps[call]);
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkPlacement: "success",
  });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    const first = await postHook(proxy, displayHook({ prompt_id: "prompt-1" }));
    const rendered = first.body.hookSpecificOutput.displayContent;
    assert.equal(linkText(rendered), `${successLine(PAGE_URL_1)}\nupstream answer`);
    if (color) {
      assert.match(rendered, /\x1b\[39m\n  https:\/\/app\.polychat\.co\/m\/ea18af90658b\nupstream/,
        "the link sits bare on its own line after the SGR reset, so a linkifier cannot swallow it");
    } else {
      assert.equal(rendered.replace(SUCCESS_TOTALS_RE, ""), `${successLine(PAGE_URL_1)}\nupstream answer`,
        "NO_COLOR leaves the entire notice and URL plain");
    }
    assert.equal(
      (await postHook(proxy, displayHook({ prompt_id: "prompt-1", final: true }))).status,
      204
    );
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 204);

    // Same index, flat coverage: nothing to announce — no line at all.
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postSessionMessages(proxy.port, followupTurn("turn three"));
    assert.equal((await postHook(proxy, displayHook({ prompt_id: "prompt-2" }))).status, 204);
    assert.equal((await postHook(proxy, stopHook("prompt-2"))).status, 204);

    // New index, flat coverage: the line comes back with the new page.
    await armMainTurn(proxy, "turn four", "prompt-3");
    await postSessionMessages(proxy.port, followupTurn("turn four"));
    const next = await postHook(proxy, displayHook({ prompt_id: "prompt-3" }));
    assert.equal(
      linkText(next.body.hookSpecificOutput.displayContent),
      `${successLine(PAGE_URL_3)}\nupstream answer`
    );
    assert.equal((await postHook(proxy, stopHook("prompt-3"))).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});
}

test("a tool-only turn's Stop fallback carries the success line with its link", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_2, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkPlacement: "success",
  });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    const stop = await postHook(proxy, stopHook("prompt-1"));
    assert.equal(linkText(stop.body.systemMessage), successLine(PAGE_URL_2));
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a page without a served index (older server, index-only ack) is never linked", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(
    200,
    (body) =>
      body.index_only
        ? { messages: [], usage: {}, index_only: true }
        : compressedOnce,
    (body) => pageHeaders(body.index_only ? PAGE_URL_3 : PAGE_URL_1, undefined)
  );
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    toolRouteRecovery: false,
    memtreeLinkPlacement: "success",
  });
  try {
    await postSessionMessages(proxy.port, toolTurn);
    await waitFor(() => memtreeSrv.calls.some((c) => c.index_only));
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    const first = await postHook(proxy, displayHook({ prompt_id: "prompt-1" }));
    assert.equal(
      linkText(first.body.hookSpecificOutput.displayContent),
      `${COMPRESSED_NOTICE}\nupstream answer`,
      "a page that may still be building gets no link"
    );
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

const trailerNew = (link) => `• MemTree\n  ${link}`;
const trailerSame = (link) => `• MemTree\n  ${link}`;

for (const color of [false, true]) {
test(`placement 'message': the link trails every finished message, marked when the index is new (${color ? "color" : "NO_COLOR"})`, async (t) => {
  setNoticeColorMode(t, color);
  const upstream = await mockUpstream();
  const stamps = [
    pageHeaders(PAGE_URL_1, "index-a"),
    pageHeaders(PAGE_URL_2, "index-a"),
    pageHeaders(PAGE_URL_3, "index-b"),
  ];
  const memtreeSrv = await mockMemtree(200, compressedOnce, (_body, call) => stamps[call]);
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin, memtreeLinkPlacement: "message" });
  try {
    // First index in use: the success line stays plain; the trailer under the
    // same message announces the new index — no waiting for a later turn.
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    const first = await postHook(proxy, displayHook({ prompt_id: "prompt-1", final: true }));
    const rendered = first.body.hookSpecificOutput.displayContent;
    assert.equal(
      linkText(rendered),
      `${COMPRESSED_NOTICE}\nupstream answer\n\n${trailerNew(PAGE_URL_1)}`
    );
    assert.ok(rendered.endsWith(`${color ? "\x1b[39m" : "• MemTree"}\n  ${PAGE_URL_1}`),
      "URL is bare on its own line, after the reset when colored");
    if (!color) assert.equal(rendered, stripAnsi(rendered), "NO_COLOR suppresses all ANSI styling");
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 204);

    // Same index next turn: no success line, trailer still there, dim label.
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postSessionMessages(proxy.port, followupTurn("turn three"));
    assert.equal((await postHook(proxy, displayHook({ prompt_id: "prompt-2" }))).status, 204);
    const same = await postHook(
      proxy,
      displayHook({ prompt_id: "prompt-2", index: 1, final: true, delta: "done" })
    );
    const sameRendered = same.body.hookSpecificOutput.displayContent;
    assert.equal(linkText(sameRendered), `done\n\n${trailerSame(PAGE_URL_2)}`);
    if (color) {
      assert.match(sameRendered, /\x1b\[2m• MemTree\x1b\[22m\n  /, "unchanged index is dim");
    } else {
      assert.equal(sameRendered, `done\n\n${trailerSame(PAGE_URL_2)}`,
        "NO_COLOR leaves the unchanged label and URL plain");
    }
    assert.equal((await postHook(proxy, stopHook("prompt-2"))).status, 204);

    // New index: marked again.
    await armMainTurn(proxy, "turn four", "prompt-3");
    await postSessionMessages(proxy.port, followupTurn("turn four"));
    const next = await postHook(proxy, displayHook({ prompt_id: "prompt-3", final: true }));
    assert.equal(
      linkText(next.body.hookSpecificOutput.displayContent),
      `upstream answer\n\n${trailerNew(PAGE_URL_3)}`
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});
}

test("placement 'message': a turn with no rendered message gets the trailer from Stop", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin, memtreeLinkPlacement: "message" });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    const stop = await postHook(proxy, stopHook("prompt-1"));
    assert.equal(
      linkText(stop.body.systemMessage),
      `${COMPRESSED_NOTICE}\n${trailerNew(PAGE_URL_1)}`
    );
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 200, "every Stop without a message repeats it");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a turn MemTree passed through whole names the unused index next to its link", async () => {
  const upstream = await mockUpstream();
  const stamps = [pageHeaders(PAGE_URL_1, "index-a"), pageHeaders(PAGE_URL_2, "index-a")];
  // First turn fits the budget (server passes it through), second compresses.
  const bodies = [{ ...compressedOnce, compressed: false }, compressedOnce];
  const memtreeSrv = await mockMemtree(200, (_b, call) => bodies[call], (_b, call) => stamps[call]);
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin, memtreeLinkPlacement: "message" });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    const first = await postHook(proxy, displayHook({ prompt_id: "prompt-1", final: true }));
    assert.equal(
      linkText(first.body.hookSpecificOutput.displayContent),
      `upstream answer\n\n• MemTree · ${NOT_COMPRESSED_NOTE}\n  ${PAGE_URL_1}`
    );
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 204);

    await armMainTurn(proxy, "turn three", "prompt-2");
    await postSessionMessages(proxy.port, followupTurn("turn three"));
    const second = await postHook(proxy, displayHook({ prompt_id: "prompt-2", final: true }));
    assert.equal(
      linkText(second.body.hookSpecificOutput.displayContent),
      `${COMPRESSED_NOTICE}\nupstream answer\n\n• MemTree\n  ${PAGE_URL_2}`
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a resumed session shows its link at SessionStart, from memory or from disk", async () => {
  const { MemtreeLinkStore } = await import("../dist/memtree-links.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const file = pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), "ccc-resume-")), "links.json");
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const headers = { "x-claude-code-session-id": "session-1" };
  const first = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkStore: new MemtreeLinkStore(file),
  });
  // A later ccc process resuming the same session: nothing in memory.
  const second = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkStore: new MemtreeLinkStore(file),
  });
  const resume = { hook_event_name: "SessionStart", source: "resume" };
  try {
    await armMainTurn(first, "turn two", "prompt-1");
    await postMessages(first.port, followupTurn("turn two"), headers);

    // Same process (in-app /resume): from memory.
    const again = await postHook(first, resume);
    assert.equal(stripAnsi(again.body.systemMessage), `• MemTree\n  ${PAGE_URL_1}`);

    // New process: from disk. Compaction and subagents get nothing.
    assert.equal((await postHook(second, { ...resume, source: "compact" })).status, 204);
    assert.equal((await postHook(second, { ...resume, agent_id: "a1" })).status, 204);
    assert.equal((await postHook(second, { ...resume, session_id: "other" })).status, 204);
    const fromDisk = await postHook(second, resume);
    assert.equal(stripAnsi(fromDisk.body.systemMessage), `• MemTree\n  ${PAGE_URL_1}`);
    // Shown at resume, so the end of the next turn does not repeat it.
    await armMainTurn(second, "turn three", "prompt-2");
    assert.equal((await postHook(second, displayHook({ prompt_id: "prompt-2", final: true }))).status, 204);
    assert.equal((await postHook(second, stopHook("prompt-2"))).status, 204);
  } finally {
    first.close();
    second.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("the resume relay script forwards SessionStart stdin to the proxy and prints its answer", async () => {
  const { MemtreeLinkStore } = await import("../dist/memtree-links.js");
  const { createSessionNoticePlugin } = await import("../dist/hooks.js");
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), "ccc-relay-"));
  const store = new MemtreeLinkStore(pathMod.join(tmp, "links.json"));
  store.put("session-1", { url: PAGE_URL_2, index: "index-b", compressed: false });
  const upstream = await mockUpstream();
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin, memtreeLinkStore: store });
  const plugin = createSessionNoticePlugin(proxy.hookUrl, { tempRoot: tmp, resumeLink: true });
  try {
    const config = JSON.parse(fs.readFileSync(pathMod.join(plugin.dir, "hooks", "hooks.json"), "utf-8"));
    const entry = config.hooks.SessionStart.find((e) => e.matcher.includes("resume") && e.hooks[0].command.includes("resume-link"));
    const command = entry.hooks[0].command;
    // Async on purpose: the proxy lives in this process, so a sync spawn
    // would block the very event loop that has to answer the relay.
    const run = (input) =>
      new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command]);
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, out }));
        child.stdin.end(JSON.stringify(input));
      });
    const hit = await run({ hook_event_name: "SessionStart", session_id: "session-1", source: "resume" });
    assert.equal(hit.code, 0);
    assert.equal(
      stripAnsi(JSON.parse(hit.out).systemMessage),
      `• MemTree · ${NOT_COMPRESSED_NOTE}\n  ${PAGE_URL_2}`
    );
    assert.deepEqual(
      await run({ hook_event_name: "SessionStart", session_id: "nope", source: "resume" }),
      { code: 0, out: "" }
    );
    proxy.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      await run({ hook_event_name: "SessionStart", session_id: "session-1", source: "resume" }),
      { code: 0, out: "" },
      "proxy gone: silent, exit 0"
    );
  } finally {
    plugin.close();
    proxy.close();
    upstream.close();
  }
});

function recapSse(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return (
    ev("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) +
    ev("message_stop", {})
  );
}

async function postRecap(port, headers) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-x",
      max_tokens: 64,
      stream: true,
      messages: [
        ...followupTurn("turn two").slice(0, 2),
        { role: "user", content: "The user stepped away and is coming back. Recap in under 40 words." },
      ],
    }),
  });
  const body = await res.text();
  const text = body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)))
    .filter((d) => d.type === "content_block_delta")
    .map((d) => d.delta.text)
    .join("");
  return { body, text };
}

test("the recap ends with the session's link, when it fits Claude Code's 400-char cap", async () => {
  let recapText = "You asked for a MemTree link after the recap. Next: try it.";
  const seen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      // Only the recap asks for a stream here (its history may be compressed,
      // so the prompt text itself need not reach upstream).
      if (JSON.parse(body).stream === true) {
        seen.push(req.headers["accept-encoding"]);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(recapSse(recapText));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const headers = { "x-claude-code-session-id": "session-1" };
  try {
    // No page yet: recap untouched.
    assert.equal((await postRecap(proxy.port, headers)).text, recapText);

    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), headers);
    const withLink = await postRecap(proxy.port, headers);
    // Ends with a newline so Claude Code's "(disable recaps in /config)" hint
    // starts its own line instead of trailing the URL.
    assert.equal(withLink.text, `${recapText}\n• MemTree\n  ${PAGE_URL_1}\n`);
    assert.ok(!withLink.text.includes("cc-infinite-notice"), "no marker in UI-only text");
    assert.match(withLink.body, /"index":1/, "appended as its own block after the recap");
    assert.ok(withLink.body.trimEnd().endsWith('data: {"type":"message_stop"}'), "stream still ends properly");
    assert.equal(seen.at(-1), "identity", "recap stream fetched uncompressed so it can be edited");

    // Too long to fit: skipped rather than clipped mid-URL.
    recapText = "x".repeat(380);
    assert.equal((await postRecap(proxy.port, headers)).text, recapText);

    // Another session's recap never gets this session's link.
    recapText = "short";
    assert.equal((await postRecap(proxy.port, { "x-claude-code-session-id": "other" })).text, "short");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("/memtree-view is answered by the hook and blocked, without touching turn state", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const view = (prompt = "/memtree-view") =>
    postHook(proxy, { hook_event_name: "UserPromptSubmit", prompt, prompt_id: "p-view" });
  try {
    const none = await view();
    assert.equal(none.body.decision, "block");
    assert.match(none.body.reason, /no page yet/);

    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), { "x-claude-code-session-id": "session-1" });
    const shown = await view("/ccc:memtree-view");
    assert.deepEqual(shown.body, {
      decision: "block",
      reason: `• MemTree\n  ${PAGE_URL_1}`,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
    });

    // The command is not a human turn: the pending notice for prompt-1 survives it.
    const display = await postHook(proxy, displayHook({ prompt_id: "prompt-1", final: true }));
    assert.equal(display.status, 200);
    // Another plugin's command of the same name is left alone.
    assert.equal((await view("/otherplugin:memtree-view")).status, 204);
    // An ordinary prompt still arms normally (204, no body).
    assert.equal((await view("tell me about /memtree-view")).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("/memtree-compact compacts the session's next message to its target (default half the budget)", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const headers = { "x-claude-code-session-id": "session-1" };
  const command = (prompt, session_id = "session-1") =>
    postHook(proxy, { hook_event_name: "UserPromptSubmit", prompt, session_id });
  const lastCall = () => memtreeSrv.calls.filter((c) => !c.index_only).at(-1);
  const lastTarget = () => lastCall().compression_target_tokens;
  // claude-x has a 200k window; this server reports no model budget, so the
  // budget is the window-ratio fallback: 160k, half of it 80k.
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), headers);
    assert.equal(lastTarget(), undefined, "automatic by default");

    const on = await command("/memtree-compact");
    assert.equal(on.body.decision, "block");
    assert.match(on.body.reason, /compacting: your next message .* about half the budget/);
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postMessages(proxy.port, followupTurn("turn three"), headers);
    assert.equal(lastTarget(), 80_000);
    assert.equal(lastCall().compression_threshold_tokens, undefined, "manual: forced, no threshold");

    assert.match((await command("/memtree-compact 120k")).body.reason, /about 120k tokens/);
    await armMainTurn(proxy, "turn four", "prompt-3");
    await postMessages(proxy.port, followupTurn("turn four"), headers);
    assert.equal(lastTarget(), 120_000);
    // Compacted once: the next turn is back to the budget check (under it).
    await armMainTurn(proxy, "turn 4b", "prompt-3b");
    await postMessages(proxy.port, followupTurn("turn 4b"), headers);
    assert.equal(lastTarget(), undefined);

    // Another session is unaffected.
    await armMainTurn(proxy, "turn five", "prompt-4");
    await postMessages(proxy.port, followupTurn("turn five"), { "x-claude-code-session-id": "other" });
    assert.equal(lastTarget(), undefined);

    const help = await command("/memtree");
    assert.equal(help.body.decision, "block");
    assert.match(help.body.reason, /^• \/memtree-view · .*\n• \/memtree-compact \[tokens \| off\] · .*default half the budget, at least 20k/);
    assert.match((await command("/memtree-compact nope")).body.reason, /usage:/);
    assert.match((await command("/memtree-compact 19k")).body.reason, /usage:.*at least 20k/);
    assert.match((await command("/memtree-compact 20k")).body.reason, /about 20k tokens/);
    assert.match((await command("/memtree-compact OFF")).body.reason, /compaction off/);
    await armMainTurn(proxy, "turn six", "prompt-5");
    await postMessages(proxy.port, followupTurn("turn six"), headers);
    assert.equal(lastTarget(), undefined);
    assert.equal(lastCall().compression_threshold_tokens, undefined);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("default placement: the success line carries the link; the end-of-turn line only for one not yet shown", async () => {
  const upstream = await mockUpstream();
  const stamps = [
    pageHeaders(PAGE_URL_1, "index-a"),
    pageHeaders(PAGE_URL_2, "index-a"),
    pageHeaders(PAGE_URL_3, "index-b"),
  ];
  const memtreeSrv = await mockMemtree(200, compressedOnce, (_body, call) => stamps[call]);
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postSessionMessages(proxy.port, followupTurn("turn two"));
    // The success line shows the page below it, so Stop doesn't repeat it.
    const shown = await postHook(proxy, displayHook({ prompt_id: "prompt-1", final: true }));
    assert.equal(linkText(shown.body.hookSpecificOutput.displayContent), `${successLine(PAGE_URL_1)}\nupstream answer`);
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status, 204);

    // Same index, new page URL: nothing at the end of this turn.
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postSessionMessages(proxy.port, followupTurn("turn three"));
    assert.equal((await postHook(proxy, displayHook({ prompt_id: "prompt-2", final: true }))).status, 204);
    assert.equal((await postHook(proxy, stopHook("prompt-2"))).status, 204);

    // New index: the success line returns with the new page; Stop stays quiet.
    await armMainTurn(proxy, "turn four", "prompt-3");
    await postSessionMessages(proxy.port, followupTurn("turn four"));
    const next = await postHook(proxy, displayHook({ prompt_id: "prompt-3", final: true }));
    assert.equal(linkText(next.body.hookSpecificOutput.displayContent), `${successLine(PAGE_URL_3)}\nupstream answer`);
    assert.equal((await postHook(proxy, stopHook("prompt-3"))).status, 204);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("compress calls carry each assistant message's usage from the transcript", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const seen = [];
  const transcriptUsage = {
    usageFor(sessionId, messages) {
      seen.push(sessionId);
      const i = messages.findIndex((m) => m.role === "assistant");
      return i < 0 ? {} : { [i]: { output_tokens: 50, thinking_tokens: 20 } };
    },
    timesFor(_sessionId, messages) {
      return { [messages.length - 1]: "2026-09-23T20:00:00.000Z" };
    },
  };
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin, transcriptUsage });
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), { "x-claude-code-session-id": "session-1" });
    const call = memtreeSrv.calls.filter((c) => !c.index_only).at(-1);
    assert.deepEqual(seen, ["session-1"]);
    assert.deepEqual(call.message_usage, { 1: { output_tokens: 50, thinking_tokens: 20 } });
    assert.equal(call.messages[1].role, "assistant", "keyed by position in the messages sent");
    assert.deepEqual(call.message_times, { [call.messages.length - 1]: "2026-09-23T20:00:00.000Z" });

    // No session id: nothing is looked up or sent.
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postMessages(proxy.port, followupTurn("turn three"));
    assert.equal(memtreeSrv.calls.filter((c) => !c.index_only).at(-1).message_usage, undefined);
    assert.equal(memtreeSrv.calls.filter((c) => !c.index_only).at(-1).message_times, undefined);
    assert.equal(seen.length, 1);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("every messages log line describes the Claude Code billing header; forwarding is unchanged", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-x", max_tokens: 64,
        system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.281.e3c; cc_entrypoint=cli; cch=bb387;" },
                 { type: "text", text: "You are a security monitor for autonomous AI coding agents." }],
        messages: followupTurn("judge this"),
      }),
    });
    assert.equal(res.status, 200);
    await waitFor(() => records.some((r) => r.kind === "messages"));
    const rec = records.find((r) => r.kind === "messages");
    assert.equal(rec.client.suspectedSideRequest, true);
    assert.equal(rec.client.systemHead, "You are a security monitor for autonomous AI coding agents.");
    assert.equal(rec.client.tools, 0);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("the away recap rides the main thread's last compressed prefix after Stop, with no MemTree call", async () => {
  const bodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(UPSTREAM_BODY)) });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const recapQ = { role: "user", content: "The user stepped away and is coming back. Recap in under 40 words." };
  const post = (messages, h = headers) => postMessages(proxy.port, messages, h);
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await post(followupTurn("turn two"));
    await waitFor(() => records.some((r) => r.kind === "messages"));
    const mainSent = bodies.at(-1).messages;
    assert.equal((await postHook(proxy, stopHook("prompt-1"))).status >= 200, true);
    const before = memtreeSrv.calls.length;

    const recap = [...followupTurn("turn two"), { role: "assistant", content: [{ type: "text", text: "done" }] }, recapQ];
    await post(recap);
    await waitFor(() => records.filter((r) => r.kind === "messages").length === 2);
    const rec = records.filter((r) => r.kind === "messages").at(-1);
    assert.equal(rec.turnType, "fork-memory");
    assert.equal(rec.routeLane, "away");
    assert.equal(memtreeSrv.calls.length, before, "no MemTree call for the recap");
    const sent = bodies.at(-1).messages;
    assert.deepEqual(sent.slice(0, mainSent.length), mainSent, "same prefix bytes the main thread sent");
    assert.deepEqual(sent.slice(mainSent.length), recap.slice(3));

    // Another session's recap cannot ride this session's prefix.
    await post(recap, { "x-claude-code-session-id": "other" });
    await waitFor(() => records.filter((r) => r.kind === "messages").length === 3);
    const other = records.filter((r) => r.kind === "messages").at(-1);
    assert.equal(other.forkMiss, "session");
    assert.notEqual(other.turnType, "fork-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a security-monitor side request skips MemTree and leaves the main tool loop's route intact", async () => {
  const bodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(UPSTREAM_BODY)) });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const msgRecs = () => records.filter((r) => r.kind === "messages");
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), headers);
    await waitFor(() => msgRecs().length === 1);
    const callsBefore = memtreeSrv.calls.length;

    const monitor = JSON.stringify({
      model: "claude-x", max_tokens: 64,
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.281.e3c; cc_entrypoint=cli; cch=bb387;" },
               { type: "text", text: "You are a security monitor for autonomous AI coding agents." }],
      messages: [
        { role: "user", content: "CLAUDE.md config" },
        { role: "user", content: '<transcript>\n{"user":"turn two"}\n{"Bash":{"command":"ls"}}\n</transcript>\nRespond.' },
      ],
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: monitor });
    assert.equal(res.status, 200);
    await waitFor(() => msgRecs().length === 2);
    const side = msgRecs()[1];
    assert.equal(side.turnType, "side-request");
    assert.equal(side.transcript.ok, true);
    assert.equal(side.transcript.toolLines, 1);
    assert.equal(bodies.at(-1), monitor, "forwarded byte for byte");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(memtreeSrv.calls.length, callsBefore, "no compress and no background index");

    // Monitor-shaped header but no recognisable transcript (e.g. an older
    // Claude Code main request): ordinary handling, and the reason is logged.
    const odd = JSON.stringify({ ...JSON.parse(monitor), messages: [{ role: "user", content: "first" }, { role: "assistant", content: "a" }, { role: "user", content: "no transcript here" }] });
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: odd });
    await waitFor(() => msgRecs().length === 3);
    assert.notEqual(msgRecs()[2].turnType, "side-request");
    assert.equal(msgRecs()[2].transcript.reason, "no-transcript");
    await armMainTurn(proxy, "turn two", "prompt-2");
    await postMessages(proxy.port, followupTurn("turn two"), headers);
    await waitFor(() => msgRecs().length === 4);

    // The main thread's next tool turn still rides its compressed route.
    const toolLoop = [
      ...followupTurn("turn two"),
      { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "ok" }] },
    ];
    await postMessages(proxy.port, toolLoop, headers);
    await waitFor(() => msgRecs().length === 5);
    assert.equal(msgRecs()[4].turnType, "tool-memory");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("claudeCodeOnly: a request without Claude Code's session header is forwarded untouched, with no MemTree call", async () => {
  const bodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf-8"));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(UPSTREAM_BODY)) });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    claudeCodeOnly: true,
  });
  const msgRecs = () => records.filter((r) => r.kind === "messages");
  try {
    // A script's multi-turn call: would otherwise look like a main followup.
    const foreign = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 64, messages: followupTurn("grade this") });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "litellm/1.80" }, body: foreign,
    });
    assert.equal(res.status, 200);
    await waitFor(() => msgRecs().length === 1);
    assert.equal(msgRecs()[0].turnType, "foreign");
    assert.equal(msgRecs()[0].userAgent, "litellm/1.80");
    assert.equal(bodies.at(-1), foreign, "byte for byte");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(memtreeSrv.calls.length, 0, "no compress, no background index");

    // Claude Code's own request still gets MemTree.
    await postMessages(proxy.port, followupTurn("turn two"), { "x-claude-code-session-id": "session-1" });
    await waitFor(() => msgRecs().length === 2);
    assert.notEqual(msgRecs()[1].turnType, "foreign");
    assert.ok(memtreeSrv.calls.length > 0);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("MemTree calls carry Claude Code's session id header, compress and background index alike", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  const headers = { "x-claude-code-session-id": "session-abc" };
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), headers);
    await waitFor(() => memtreeSrv.calls.some((c) => !c.index_only));
    const compressAt = memtreeSrv.calls.findIndex((c) => !c.index_only);
    assert.equal(memtreeSrv.callHeaders[compressAt]["x-claude-code-session-id"], "session-abc");
    assert.deepEqual(JSON.parse(memtreeSrv.callHeaders[compressAt]["x-client-meta"]),
      { lane: "main", requested_model: "claude-x" });

    await postMessages(proxy.port, [{ role: "user", content: "first message" }], headers);
    await waitFor(() => memtreeSrv.calls.some((c) => c.index_only));
    const indexAt = memtreeSrv.calls.findIndex((c) => c.index_only);
    assert.equal(memtreeSrv.callHeaders[indexAt]["x-claude-code-session-id"], "session-abc");
    assert.equal(JSON.parse(memtreeSrv.callHeaders[indexAt]["x-client-meta"]).lane, "main");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("the compressed message's cache marker copies a 1h TTL, and a reused route stays within 4 markers", async () => {
  const bodies = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(UPSTREAM_BODY)) });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  const headers = { "content-type": "application/json", "x-claude-code-session-id": "session-1" };
  const hour = { type: "ephemeral", ttl: "1h" };
  const marked = (text) => [{ type: "text", text, cache_control: hour }];
  const count = (b) => [...(Array.isArray(b.system) ? b.system : []), ...b.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])]
    .filter((p) => p?.cache_control).length;
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    const history = followupTurn("turn two");
    history[history.length - 1] = { role: "user", content: marked("turn two") };
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST", headers,
      body: JSON.stringify({ model: "claude-x", max_tokens: 64, system: [{ type: "text", text: "sys", cache_control: hour }], messages: history }),
    });
    await waitFor(() => bodies.length === 1);
    assert.deepEqual(bodies[0].messages[0].content[0].cache_control, hour, "same TTL as Claude Code's own markers");

    // Tool turn riding the route, with Claude Code marking three suffix blocks.
    const toolLoop = [
      ...history,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {}, cache_control: hour }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a", cache_control: hour }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "b", cache_control: hour }] },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST", headers,
      body: JSON.stringify({ model: "claude-x", max_tokens: 64, system: [{ type: "text", text: "sys", cache_control: hour }], messages: toolLoop }),
    });
    await waitFor(() => bodies.length === 2);
    const routed = bodies[1];
    assert.ok(count(routed) <= 4, `at most 4 markers, got ${count(routed)}`);
    assert.ok(routed.messages[0].content[0].cache_control, "the compressed prefix keeps its marker");
    assert.ok(routed.messages.at(-1).content.at(-1).cache_control, "the newest block keeps its marker");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

/** Capture the actual outgoing request, including raw bytes for fail-open checks. */
async function cacheTtlHarness() {
  const raws = [];
  let failCompression = false;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      raws.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_BODY);
    });
  });
  const memtreeSrv = await mockMemtree(200, () => failCompression ? { messages: [] } : compressedOnce);
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
  });
  return {
    proxy,
    raws,
    failCompression: () => { failCompression = true; },
    compressCalls: () => memtreeSrv.calls.filter((call) => !call.index_only),
    post: async (body, endpoint = "messages") => {
      const raw = JSON.stringify(body, null, 2);
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": "session-1" },
        body: raw,
      });
      await response.text();
      return { original: raw, forwarded: JSON.parse(raws.at(-1)) };
    },
    close: () => { proxy.close(); upstream.close(); memtreeSrv.close(); },
  };
}

const cacheMarker = (ttl) => ({ type: "ephemeral", ...(ttl === undefined ? {} : { ttl }) });
const cacheText = (text, ttl) => ({ type: "text", text, cache_control: cacheMarker(ttl) });

for (const ttl of [undefined, "5m", "1h"]) {
  test(`cache TTL: a flattened marker matches the last existing marker (${ttl ?? "default 5m"})`, async () => {
    const h = await cacheTtlHarness();
    try {
      await armMainTurn(h.proxy, "turn two", "prompt-1");
      const body = {
        model: "claude-x", max_tokens: 64,
        tools: [{ name: "Bash", input_schema: { type: "object" }, cache_control: cacheMarker("1h") }],
        system: [cacheText("sys", ttl)],
        messages: followupTurn("turn two"),
      };
      const { forwarded } = await h.post(body);
      assert.equal(forwarded.messages.length, 1, "actually compressed");
      assert.deepEqual(forwarded.messages[0].content[0].cache_control, cacheMarker(ttl));
      assert.deepEqual(forwarded.tools, body.tools, "user tool markers remain unchanged");
      assert.deepEqual(forwarded.system, body.system, "user system markers remain unchanged");
    } finally { h.close(); }
  });
}

for (const layout of ["four tools", "mixed tools and system"]) {
  test(`cache prefix slot: reserve a marker with ${layout}, then reuse identical prefix bytes`, async () => {
    const h = await cacheTtlHarness();
    const mixed = layout === "mixed tools and system";
    const ttl = mixed ? "5m" : "1h";
    const markerBlocks = (body) => [
      ...(body.tools ?? []), ...(body.system ?? []),
      ...body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []),
    ].filter((block) => block.cache_control);
    try {
      const body = {
        model: "claude-x", max_tokens: 64,
        tools: Array.from({ length: mixed ? 2 : 4 }, (_, n) => ({
          name: `tool_${n}`, input_schema: { type: "object" }, cache_control: cacheMarker("1h"),
        })),
        ...(mixed ? { system: [cacheText("sys one", ttl), cacheText("sys two", ttl)] } : {}),
        messages: followupTurn("turn two"),
      };
      assert.equal(markerBlocks(body).length, 4, "the incoming request uses exactly four valid markers");
      const snapshot = structuredClone(body);
      const first = await h.post({ ...body, messages: [{ role: "user", content: "first question" }] });
      assert.equal(h.raws.at(-1), first.original, "passthrough keeps all original marker bytes");
      await armMainTurn(h.proxy, "turn two", "prompt-1");
      const { forwarded: compressed } = await h.post(body);
      assert.equal(compressed.messages.length, 1);
      assert.deepEqual(compressed.messages[0].content[0]?.cache_control, cacheMarker(ttl), "the flattened prefix always gets a marker");
      assert.equal(markerBlocks(compressed).length, 4, "prefix plus three retained markers");
      assert.deepEqual(body, snapshot, "input tools and system remain unchanged");

      // Move one incoming marker to the newest result, keeping the original
      // request valid at four markers before the proxy adds its prefix.
      const next = structuredClone(body);
      const field = mixed ? "system" : "tools";
      const { cache_control: _old, ...unmarked } = next[field][0];
      next[field][0] = unmarked;
      next.messages.push(
        { role: "assistant", content: [{ type: "tool_use", id: "slot-tool", name: "tool_0", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "slot-tool", content: "ok", cache_control: cacheMarker(ttl) }] },
      );
      assert.equal(markerBlocks(next).length, 4);
      const nextSnapshot = structuredClone(next);
      const { forwarded: ride } = await h.post(next);
      assert.equal(h.compressCalls().length, 1, "compatible tool turn rides without recompressing");
      assert.equal(JSON.stringify(ride.messages[0]), JSON.stringify(compressed.messages[0]), "prefix bytes remain identical");
      assert.equal(markerBlocks(ride).length, 4);
      assert.deepEqual(ride.messages.at(-1).content[0].cache_control, cacheMarker(ttl), "newest suffix marker is retained");
      assert.deepEqual(next, nextSnapshot, "reusing the prefix leaves input objects unchanged");
      const ttls = markerBlocks(ride).map((block) => block.cache_control.ttl ?? "5m");
      const firstShort = ttls.indexOf("5m");
      assert.ok(firstShort < 0 || ttls.slice(firstShort).every((value) => value === "5m"), "all surviving 1h markers precede 5m markers");
    } finally { h.close(); }
  });
}

for (const lane of ["human", "human-failed-rebuild", "tool", "count_tokens"]) {
  test(`cache TTL: a 5m prefix cannot precede new 1h markers (${lane})`, async () => {
    const h = await cacheTtlHarness();
    try {
      await armMainTurn(h.proxy, "turn two", "prompt-1");
      const history = followupTurn("turn two");
      history[history.length - 1].content = [cacheText("turn two", "5m")];
      const body = { model: "claude-x", max_tokens: 64, system: [cacheText("sys", "5m")], messages: history };
      const { forwarded: first } = await h.post(body);
      assert.equal(first.messages.length, 1);
      const toolTail = [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", cache_control: cacheMarker("5m") }] },
      ];
      const { forwarded: ride } = await h.post({ ...body, messages: [...history, ...toolTail] });
      assert.equal(JSON.stringify(ride.messages[0]), JSON.stringify(first.messages[0]), "compatible rides preserve prefix bytes");
      const callsBefore = h.compressCalls().length;
      // Every marker on the original next request is now 1h, so it is valid.
      const nextHistory = structuredClone(history);
      nextHistory.at(-1).content[0].cache_control = cacheMarker("1h");
      const nextTail = lane.startsWith("human")
        ? [{ role: "assistant", content: "answer" }, { role: "user", content: [cacheText("turn three", "1h")] }]
        : structuredClone(toolTail);
      if (!lane.startsWith("human")) nextTail.at(-1).content[0].cache_control = cacheMarker("1h");
      const next = { ...body, system: [cacheText("sys", "1h")], messages: [...nextHistory, ...nextTail] };
      if (lane.startsWith("human")) await armMainTurn(h.proxy, "turn three", "prompt-2");
      if (lane === "human-failed-rebuild") h.failCompression();
      const { original, forwarded } = await h.post(next, lane === "count_tokens" ? "messages/count_tokens" : "messages");
      if (lane === "human") {
        assert.equal(h.compressCalls().length, callsBefore + 1, "incompatible prefix is rebuilt");
        assert.equal(forwarded.messages.length, 1);
        assert.deepEqual(forwarded.messages[0].content[0].cache_control, cacheMarker("1h"));
        assert.deepEqual(forwarded.system, next.system);
      } else {
        assert.equal(h.raws.at(-1), original, "unusable reuse/rebuild forwards the original request bytes");
      }
    } finally { h.close(); }
  });
}

test("defaultCompactTarget is the target of a compaction, not a trigger: the budget still decides", async () => {
  const upstream = await mockUpstream();
  // A server that reports its model budget understands the threshold.
  const memtreeSrv = await mockMemtree(200, { ...compressedOnce, model_budget_tokens: 100_000 });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    defaultCompactTarget: 20_000,
  });
  const compressCalls = () => memtreeSrv.calls.filter((c) => !c.index_only);
  try {
    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), { "x-claude-code-session-id": "session-1" });
    // First call: the server's abilities are unknown and the conversation is
    // far under the (fallback) budget, so nothing forces a compression.
    assert.equal(compressCalls()[0].compression_target_tokens, undefined);
    await armMainTurn(proxy, "turn three", "prompt-2");
    await postMessages(proxy.port, followupTurn("turn three"), { "x-claude-code-session-id": "session-1" });
    // Now the server decides against the budget it reported; the env target
    // is what it compresses to once over.
    assert.equal(compressCalls()[1].compression_target_tokens, 20_000);
    assert.equal(compressCalls()[1].compression_threshold_tokens, 100_000);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a reused prefix route's tool turn stays within 4 cache markers (2026-09-28 Anthropic 400)", async () => {
  const { __testCapCacheBreakpoints: cap } = await import("../dist/proxy.js");
  const hour = { type: "ephemeral", ttl: "1h" };
  // Layout of the failing request: 2 system markers, the prefix marker, a stale
  // Claude Code marker on an earlier turn's message, and the newest marker.
  const body = {
    system: [{ type: "text", text: "hdr" }, { type: "text", text: "a" }, { type: "text", text: "b", cache_control: hour }, { type: "text", text: "c", cache_control: hour }],
    messages: [
      { role: "user", content: [{ type: "text", text: "memory", cache_control: hour }] },
      { role: "assistant", content: [{ type: "text", text: "x" }] },
      { role: "user", content: [{ type: "text", text: "turn" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r", cache_control: hour }] },
      { role: "assistant", content: [{ type: "tool_use", id: "u", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "u", content: "r", cache_control: hour }] },
    ],
  };
  cap(body, 5);
  const markers = [...body.system, ...body.messages.flatMap((m) => m.content)].filter((p) => p.cache_control);
  assert.equal(markers.length, 4);
  assert.ok(body.messages[0].content[0].cache_control, "the prefix keeps its marker");
  assert.ok(body.messages[6].content[0].cache_control, "the newest block keeps its marker");
  assert.equal(body.messages[4].content[0].cache_control, undefined, "the stale suffix marker goes first");

  // Still too many after the messages: system markers go next.
  const heavy = {
    system: [{ type: "text", text: "a", cache_control: hour }, { type: "text", text: "b", cache_control: hour }, { type: "text", text: "c", cache_control: hour }],
    messages: [
      { role: "user", content: [{ type: "text", text: "memory", cache_control: hour }] },
      { role: "user", content: [{ type: "text", text: "q", cache_control: hour }] },
    ],
  };
  cap(heavy, 1);
  assert.equal([...heavy.system, ...heavy.messages.flatMap((m) => m.content)].filter((p) => p.cache_control).length, 4);
  assert.ok(heavy.messages[0].content[0].cache_control && heavy.messages[1].content[0].cache_control);
});

test("size estimate scales by the sample's bytes per token, including when the body shrank (2026-09-29)", async () => {
  const { __testEstimateRequestTokens: est } = await import("../dist/proxy.js");
  const sample = { tokens: 429_480, forwardedBytes: 1_136_746 };
  const shrank = est(sample, 1_135_494);
  assert.equal(shrank.source, "reported");
  assert.ok(Math.abs(shrank.tokens - 429_016) < 1_000, `got ${shrank.tokens}`);
  const grew = est(sample, 1_143_717);
  assert.ok(grew.tokens >= 431_293 - 100 && grew.tokens <= 431_293 + 1_000, `got ${grew.tokens}`);
  // Growth never counts fewer tokens than bytes/4 would.
  const sparse = { tokens: 100_000, forwardedBytes: 1_000_000 };
  assert.equal(est(sparse, 1_004_000).tokens, 101_000);
  assert.deepEqual(est(undefined, 400_000), { tokens: 100_000, source: "bytes" });
});

test("the success line reports the size before and after compression", async () => {
  const { compressedTotalsText } = await import("../dist/notices.js");
  assert.equal(
    compressedTotalsText(860_941, 425_541),
    `${COMPRESSED_NOTICE} · ~861k → 426k tokens`
  );
  assert.equal(compressedTotalsText(1_250_000, 425_000), `${COMPRESSED_NOTICE} · ~1.3m → 425k tokens`);
  assert.equal(compressedTotalsText(undefined, 425_541), COMPRESSED_NOTICE, "no before size");
  assert.equal(compressedTotalsText(400_000, 425_541), COMPRESSED_NOTICE, "not smaller");
});

test("placements 'stop' and 'off'", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce, pageHeaders(PAGE_URL_1, "index-a"));
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const onStop = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkPlacement: "stop",
  });
  const off = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkPlacement: "off",
  });
  try {
    await armMainTurn(onStop, "turn two", "prompt-1");
    await postSessionMessages(onStop.port, followupTurn("turn two"));
    const shown = await postHook(onStop, displayHook({ prompt_id: "prompt-1", final: true }));
    assert.equal(linkText(shown.body.hookSpecificOutput.displayContent), `${COMPRESSED_NOTICE}\nupstream answer`);
    assert.equal(linkText((await postHook(onStop, stopHook("prompt-1"))).body.systemMessage), trailerNew(PAGE_URL_1));

    await armMainTurn(off, "turn two", "prompt-1");
    await postSessionMessages(off.port, followupTurn("turn two"));
    const plain = await postHook(off, displayHook({ prompt_id: "prompt-1", final: true }));
    assert.equal(linkText(plain.body.hookSpecificOutput.displayContent), `${COMPRESSED_NOTICE}\nupstream answer`);
    assert.equal((await postHook(off, stopHook("prompt-1"))).status, 204);
  } finally {
    onStop.close();
    off.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("GET /memtree/<id>[.json] relays the user's page with the key, either id spelling", async () => {
  const upstream = await mockUpstream();
  const pageGets = [];
  const memtreeSrv = await listen((req, res) => {
    pageGets.push({
      url: req.url,
      accept: req.headers.accept,
      authorization: req.headers.authorization,
    });
    const json = req.url.includes(".json");
    res.writeHead(200, {
      "content-type": json ? "application/json" : "text/html; charset=utf-8",
    });
    res.end(json ? JSON.stringify({ nodes: [] }) : "<html>tree</html>");
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "secret-key" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const get = (path, accept) =>
    fetch(`http://127.0.0.1:${proxy.port}${path}`, { headers: accept ? { accept } : {} });
  try {
    const html = await get("/memtree/ea18af90658b", "text/html");
    assert.equal(html.status, 200);
    assert.equal(await html.text(), "<html>tree</html>");
    assert.deepEqual(pageGets.at(-1), {
      url: "/usage/memtree/ea18af90658b",
      accept: "text/html",
      authorization: "Bearer secret-key",
    });

    const json = await get("/memtree/ea18af90-658b-485f-ad71-063e0ca5e724.json?share=tok");
    assert.equal(json.status, 200);
    assert.equal(
      pageGets.at(-1).url,
      "/usage/memtree/ea18af90-658b-485f-ad71-063e0ca5e724.json?share=tok"
    );

    for (const suffix of ["v1-own", "v3-served"]) {
      const ref = `ea18af90-658b-485f-ad71-063e0ca5e724-${suffix}`;
      assert.equal((await get(`/memtree/${ref}.json`)).status, 200);
      assert.equal(pageGets.at(-1).url, `/usage/memtree/${ref}.json`);
      assert.equal((await get(`/memtree/${ref}/search?q=test`)).status, 200);
      assert.equal(pageGets.at(-1).url, `/usage/memtree/${ref}/search?q=test`);
    }

    // The page's session pane fetches this from wherever the page came from.
    await get("/memtree/ea18af90658b/session.json");
    assert.equal(pageGets.at(-1).url, "/usage/memtree/ea18af90658b/session.json");
    await get("/memtree/sessions/6025e1f7-074b-4abb-a8e7-dbf07ef1e81f.json");
    assert.equal(pageGets.at(-1).url, "/usage/memtree/sessions/6025e1f7-074b-4abb-a8e7-dbf07ef1e81f.json");
    assert.equal((await get("/memtree/sessions/..%2Fx.json")).status, 404);
    assert.equal((await get("/memtree/sessions/a/b.json")).status, 404);

    // Bad shapes never reach the server. (fetch normalizes a literal `..`;
    // the encoded form reaches the handler.)
    const before = pageGets.length;
    assert.equal((await get("/memtree/ea18af90%2F..%2Fx")).status, 404);
    assert.equal((await get("/memtree/ea18af90-v1-own%2F..%2Fsearch")).status, 404);
    assert.equal(pageGets.length, before);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("GET /memtree/sessions and /memtree/search relay to the finder endpoints with the key and project", async () => {
  const upstream = await mockUpstream();
  const seen = [];
  const memtreeSrv = await listen((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      meta: req.headers["x-client-meta"],
      session: req.headers["x-claude-code-session-id"],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [], hits: [], next_cursor: null }));
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "secret-key" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    projectMeta: { project_dir: "polychat", git_repo: "acme/polychat", git_branch: "main", git_commit: "c6fe251" },
  });
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${proxy.port}${path}`, { headers });
  try {
    const list = await get("/memtree/sessions?since=2026-09-01&project=polychat&cursor=abc%3D&limit=5");
    assert.equal(list.status, 200);
    assert.deepEqual(seen.at(-1), {
      url: "/v1/memtree/sessions?since=2026-09-01&project=polychat&cursor=abc%3D&limit=5",
      authorization: "Bearer secret-key",
      meta: JSON.stringify({ project_dir: "polychat", git_repo: "acme/polychat", git_branch: "main", git_commit: "c6fe251" }),
      session: undefined,
    });
    await get("/memtree/search?q=%22cache+invalidation%22&mode=text", { "x-claude-code-session-id": "sess-1" });
    assert.equal(seen.at(-1).url, "/v1/memtree/search?q=%22cache+invalidation%22&mode=text");
    assert.equal(seen.at(-1).session, "sess-1");
    await get("/memtree/search?q=x", { "x-claude-code-session-id": "bad id/../x" });
    assert.equal(seen.at(-1).session, undefined, "a malformed session id is not forwarded");

    // The Step 6 per-tree search goes through the page relay.
    await get("/memtree/ea18af90658b/search?q=deploy&limit=3");
    assert.equal(seen.at(-1).url, "/usage/memtree/ea18af90658b/search?q=deploy&limit=3");

    // Nothing else reaches the server: no subpaths, no encoded walks.
    const before = seen.length;
    for (const path of [
      "/memtree/sessions/x",
      "/memtree/search/..%2F..%2Fadmin",
      "/memtree/sessions%2F..%2Fadmin",
      "/memtree/search%3Fq=x",
      "/memtree/ea18af90658b/search/x",
    ]) {
      assert.equal((await get(path)).status, 404, path);
    }
    assert.equal(seen.length, before);
    // A literal `..` is normalized by the URL parser before routing.
    await get("/memtree/sessions/../search?q=y");
    assert.equal(seen.at(-1).url, "/v1/memtree/search?q=y");
    // Only GET is relayed (anything else is not a MemTree call).
    await fetch(`http://127.0.0.1:${proxy.port}/memtree/sessions`, { method: "POST", body: "{}" });
    assert.equal(seen.length, before + 1, "the POST never reached the MemTree server");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("list and search through the proxy against a mock MemTree server", async () => {
  const upstream = await mockUpstream();
  const requests = [];
  const rid = "3f2a9c1b-7e40-4d2a-9a51-0c8e2b6f4d17";
  const hit = (score, model) => ({
    id: "6025e1f7-074b-4abb-a8e7-dbf07ef1e81f", kind: "claude_code_session",
    session_id: "6025e1f7-074b-4abb-a8e7-dbf07ef1e81f",
    tree: { request_id: rid, created_at: "2026-09-29T01:38:02.211000+00:00",
            links: { url: "https://api.polychat.co/m/3f2a9c1b7e40" } },
    leaf: "leaf_node_1:2:4.txt", range: { block: 1, start: 2, end: 4 },
    snippet: "the <b>Deploy</b> target is cloud-run", score, ...(model ? { embedding_model: model } : {}),
  });
  const memtreeSrv = await listen((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), session: req.headers["x-claude-code-session-id"] });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/memtree/sessions") {
      return send(200, {
        sessions: [{
          id: "6025e1f7-074b-4abb-a8e7-dbf07ef1e81f", kind: "claude_code_session",
          session_id: "6025e1f7-074b-4abb-a8e7-dbf07ef1e81f", title: "Usage dashboard overhaul",
          snippet: "Restyle the usage page", first_at: "2026-09-28T17:02:11+00:00", last_at: "2026-09-29T01:40:57+00:00",
          project: { dir: "polychat", repo: "acme/polychat", branch: "main", commit: "c6fe251" },
          models: ["claude-opus-5-5"], request_count: 212, latest_tree: { request_id: rid, links: { url: "https://api.polychat.co/m/3f2a9c1b7e40" } },
        }],
        next_cursor: url.searchParams.get("cursor") ? null : "CURSOR1",
      });
    }
    if (url.searchParams.get("q") === "partner") return send(403, { detail: "not available to partner keys" });
    if (url.searchParams.get("mode") === "vector") {
      return send(200, { query: url.searchParams.get("q"), mode: "vector", charged: true, next_cursor: "V2",
        groups: [{ embedding_model: "voyage-3.5", has_more: true, hits: [hit(0.88, "voyage-3.5")] },
                 { embedding_model: "gemini-embedding-001", has_more: false, hits: [hit(0.61, "gemini-embedding-001")] }] });
    }
    return send(200, { query: url.searchParams.get("q"), mode: "text", hits: [hit(0.0913)], next_cursor: null, matches_capped: false });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "secret-key" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const finder = new SessionFinder({ proxyUrl: `http://127.0.0.1:${proxy.port}`, sessionId: "sess-9" });
  try {
    const listed = await finder.listSessions({ project: "polychat", since: "2026-09-01" });
    assert.deepEqual(requests.at(-1), { path: "/v1/memtree/sessions", params: { since: "2026-09-01", project: "polychat" }, session: "sess-9" });
    assert.match(listed, /^1 session, most recently active first:/);
    assert.match(listed, /\[1\] Usage dashboard overhaul/);
    assert.match(listed, /session 6025e1f7-074b-4abb-a8e7-dbf07ef1e81f · 2026-09-28 17:02 UTC → 2026-09-29 01:40 UTC · 212 requests/);
    assert.match(listed, /project: acme\/polychat · main @ c6fe251/);
    assert.match(listed, new RegExp(`read_node \\{"tree": "${rid}", "id": 0\\}`));
    assert.match(listed, /"cursor": "CURSOR1"/);
    assert.match(await finder.listSessions({ cursor: "CURSOR1" }), /No more results\./);

    const semantic = await finder.searchSessions({ query: "how did we pick the deploy target", mode: "vector" });
    assert.equal(requests.at(-1).params.mode, "vector");
    assert.match(semantic, /charged: one query embedding per model/);
    assert.match(semantic, /== voyage-3\.5 ==[\s\S]*== gemini-embedding-001 ==/, "one ranking per model");
    assert.match(semantic, /scores are not comparable across groups/);
    assert.match(semantic, new RegExp(`open: read_lines \\{"tree": "${rid}", "block": 1, "start": 2, "end": 4\\}`));
    assert.match(semantic, /"cursor": "V2"/);

    const exact = await finder.searchSessions({ query: "deploy", mode: "text", project: "polychat" });
    assert.deepEqual(requests.at(-1).params, { q: "deploy", mode: "text", project: "polychat" });
    assert.match(exact, /1 text match for "deploy":/);
    assert.match(exact, /the \*\*Deploy\*\* target/);
    assert.match(exact, /page: https:\/\/api\.polychat\.co\/m\/3f2a9c1b7e40/);
    assert.match(exact, /block 1 lines 2-4/);
    assert.match(exact, /No more results\./);

    await assert.rejects(finder.searchSessions({ query: "partner" }), /HTTP 403 not available to partner keys/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("GET /memtree/current[.json]: pages stay scoped to their sessions", async () => {
  const { MemtreeLinkStore } = await import("../dist/memtree-links.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const file = pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), "ccc-current-")), "links.json");
  new MemtreeLinkStore(file).put("resumed-session", { url: PAGE_URL_2, index: "index-old", compressed: true });
  const upstream = await mockUpstream();
  const pageGets = [];
  // Compress POSTs stamp PAGE_URL_1; page GETs answer a tree.
  const memtreeSrv = await listenMemtree((req, res) => {
    if (req.method === "GET") {
      pageGets.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nodes: [{ id: 0, s: "root", k: [] }], blocks: [] }));
      return;
    }
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", ...pageHeaders(PAGE_URL_1, "index-a") });
      res.end(JSON.stringify(compressedOnce));
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({
    memtree,
    upstreamOrigin: upstream.origin,
    memtreeLinkStore: new MemtreeLinkStore(file),
  });
  const get = (path) => fetch(`http://127.0.0.1:${proxy.port}${path}`);
  try {
    assert.equal((await get("/memtree/current")).status, 404, "nothing served, no session");
    assert.equal((await get("/memtree/current?session=unknown")).status, 404);
    assert.equal(pageGets.length, 0);
    // Before this proxy served a page: the session's stored page (resume).
    assert.deepEqual(await (await get("/memtree/current?session=resumed-session")).json(), {
      id: "0f1c2d3e4a5b",
      url: PAGE_URL_2,
      index: "index-old",
      session_id: "resumed-session",
      compressed: true,
    });

    await armMainTurn(proxy, "turn two", "prompt-1");
    await postMessages(proxy.port, followupTurn("turn two"), { "x-claude-code-session-id": "session-1" });
    const pointer = await (await get("/memtree/current?session=session-1")).json();
    assert.deepEqual(pointer, {
      id: "ea18af90658b",
      url: PAGE_URL_1,
      index: "index-a",
      session_id: "session-1",
      compressed: true,
    });
    // Concurrent and cleared sessions cannot inherit the newest page of another.
    assert.equal((await (await get("/memtree/current?session=resumed-session")).json()).id, "0f1c2d3e4a5b");
    assert.equal((await get("/memtree/current")).status, 404);
    await postHook(proxy, { hook_event_name: "SessionStart", source: "clear", session_id: "cleared-session" });
    assert.equal((await get("/memtree/current?session=cleared-session")).status, 404);
    assert.equal((await (await get("/memtree/current?session=session-1")).json()).id, "ea18af90658b");
    assert.equal(pageGets.length, 0, "the pointer never calls upstream");

    const page = await get("/memtree/current.json?session=session-1");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-memtree-page"), PAGE_URL_1);
    assert.deepEqual((await page.json()).nodes, [{ id: 0, s: "root", k: [] }]);
    assert.deepEqual(pageGets, ["/usage/memtree/ea18af90658b.json"]);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("x-memtree-tools rides compress calls only when the memtree MCP tools are configured", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const run = async (memtreeTools) => {
    const proxy = await startProxy({
      memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k", memtreeTools }),
      upstreamOrigin: upstream.origin,
    });
    const from = memtreeSrv.calls.length;
    const headers = { "x-claude-code-session-id": `session-${from}` };
    try {
      await armMainTurn(proxy, "turn two", "prompt-1");
      await postMessages(proxy.port, followupTurn("turn two"), headers);
      await postMessages(proxy.port, [{ role: "user", content: `first message ${from}` }], headers);
      await waitFor(() => {
        const mine = memtreeSrv.calls.slice(from);
        return mine.some((c) => !c.index_only) && mine.some((c) => c.index_only);
      });
      return memtreeSrv.calls.slice(from).map((c, i) => ({
        indexOnly: !!c.index_only,
        tools: memtreeSrv.callHeaders[from + i]["x-memtree-tools"],
      }));
    } finally {
      proxy.close();
    }
  };
  try {
    const on = await run("search,read_node,read_lines");
    assert.ok(on.filter((c) => !c.indexOnly).every((c) => c.tools === "search,read_node,read_lines"));
    assert.ok(on.filter((c) => c.indexOnly).every((c) => c.tools === undefined), "index-only calls return no memory");
    const off = await run(undefined);
    assert.ok(off.length >= 2);
    assert.ok(off.every((c) => c.tools === undefined));
  } finally {
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
      // Styling depends on terminal color capability; assert placement only.
      const text = hook.body.hookSpecificOutput.displayContent;
      assert.ok(text.startsWith("upstream answer\n"));
      assert.ok(text.includes(DEGRADED_NOTICE));
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
    // tokens. By every usage measure this is the best possible compression.
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
  // The server flatten drops signatures (and redacted payloads), so the model
  // would see effectively nothing — this must not count as usable.
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

// ---------------------------------------------------------------------------
// Tool-route miss recovery (plans/2026-08-04_PLAN_tool_turn_route_recovery.md)
// ---------------------------------------------------------------------------

/**
 * Tool turns compress only once their estimated size reaches the budget
 * (planToolCompaction). These tests exercise the compaction machinery with a
 * largeToolTurn (~130k tokens), so they run under a 20k budget: the whole
 * history is over it, a ride on the ~1k-token recovered memory is not.
 */
const RECOVERY_BUDGET = 20_000;
const startRecoveryProxy = (opts) => startProxy({ budgetTokensOverride: RECOVERY_BUDGET, ...opts });

/** Recording upstream that answers both /messages and /count_tokens. */
function recordingUpstream() {
  const seen = [];
  return listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const isCount = req.url.startsWith("/v1/messages/count_tokens");
      const raw = Buffer.concat(chunks);
      seen.push({
        raw: raw.toString("utf-8"),
        isCount,
        body: JSON.parse(raw.toString("utf-8")),
      });
      // Usage sized like Anthropic's (bytes/4): tool turns' budget check is
      // anchored on the reported size of the previous request.
      const body = isCount
        ? JSON.stringify({ input_tokens: 42 })
        : JSON.stringify({
            ...JSON.parse(UPSTREAM_BODY),
            usage: { input_tokens: Math.floor(raw.length / 4), output_tokens: 1 },
          });
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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

test("a tool turn under the budget makes no compress call and spends nothing; the lane compresses when it reaches the budget", async () => {
  // Regression (requests.jsonl: routeRecovery noop 2,290 / spent 2,839): the
  // first tool turn of a long loop was under the budget, so its blocking
  // compress no-oped and "spent" the lane, and every later tool turn went out
  // whole past the budget. Now a tool turn under the budget makes no call at
  // all, and the lane compresses at the budget, however late in the turn.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startRecoveryProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  // ~4k tokens: well under the 20k budget.
  const smallishToolTurn = [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "history ".repeat(2000) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ];
  try {
    await postMessages(proxy.port, smallishToolTurn, SESSION);
    const under = messageRecords(records)[0];
    assert.equal(under.routeLane, "main");
    assert.equal(under.routeMiss, "missing");
    assert.equal(under.turnType, "tool");
    assert.equal(under.routeRecovery, undefined, "no attempt, nothing spent");
    assert.equal(under.compress, undefined);
    assert.equal(under.compaction.budgetTokens, RECOVERY_BUDGET);
    assert.ok(under.compaction.estimatedTokens < RECOVERY_BUDGET);
    assert.equal(under.compaction.reason, undefined);
    assert.equal(blockingCalls(), 0, "under the budget: no compress call");

    // The loop keeps going; a big tool result takes it past the budget.
    const grown = [
      ...smallishToolTurn,
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "r".repeat(200_000) }] },
    ];
    await postMessages(proxy.port, grown, SESSION);
    const crossed = messageRecords(records).at(-1);
    assert.equal(crossed.turnType, "tool-recompressed");
    assert.equal(crossed.compaction.reason, "budget");
    assert.equal(crossed.compaction.sizeSource, "reported");
    assert.ok(crossed.compaction.estimatedTokens >= RECOVERY_BUDGET);
    assert.equal(crossed.routeRecovery.outcome, "compressed");
    assert.equal(crossed.routeRecovery.prefix, "installed");
    assert.equal(blockingCalls(), 1);
    assert.equal(memtreeSrv.calls.find((c) => !c.index_only).compression_target_tokens, RECOVERY_BUDGET / 2);
    assert.match(JSON.stringify(upstream.seen.at(-1).body.messages), /recovered memory/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a no-op that finds no tree stops the tool loop's compress calls until the tree's page is built", async () => {
  // Live Haiku run 2026-09-29: a new conversation's loop crossed the budget
  // before its first tree existed; each tool turn paid a blocking compress
  // call that could only pass everything through (unindexed messages are
  // always kept verbatim). Now the lane waits for the tree instead.
  const upstream = await recordingUpstream();
  let pageReady = false;
  let pageGets = 0;
  const calls = [];
  const memtreeSrv = await listen((req, res) => {
    if (req.method === "GET") {
      pageGets++;
      assert.match(req.url, /^\/usage\/memtree\/ea18af90658b\.json$/);
      res.writeHead(pageReady ? 200 : 202, { "content-type": "application/json" });
      res.end(JSON.stringify(pageReady ? { nodes: [] } : { status: "building" }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      calls.push(parsed);
      const body = parsed.index_only
        ? { messages: [], index_only: true, usage: {} }
        : pageReady
          ? withServerFlatten(recoveredMemory(), parsed)
          : { messages: parsed.messages, compressed: false, usage: { prompt_tokens_details: { cached_tokens: 0 } } };
      res.writeHead(200, { "content-type": "application/json", ...(parsed.index_only ? {} : pageHeaders(PAGE_URL_1)) });
      res.end(JSON.stringify(body));
    });
  });
  const records = [];
  const proxy = await startRecoveryProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const blockingCalls = () => calls.filter((c) => !c.index_only).length;
  try {
    let loop = largeToolTurn();
    await postMessages(proxy.port, loop, SESSION);
    const first = messageRecords(records).at(-1);
    assert.equal(first.routeRecovery.outcome, "noop");
    assert.equal(first.routeRecovery.awaitingIndex, true);
    assert.equal(blockingCalls(), 1);

    for (const id of ["t2", "t3"]) {
      loop = extendToolLoop(loop, id);
      await postMessages(proxy.port, loop, SESSION);
      assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "awaiting-index");
    }
    assert.equal(blockingCalls(), 1, "no compress call while the tree is building");
    await waitFor(() => pageGets >= 1);

    pageReady = true;
    loop = extendToolLoop(loop, "t4");
    await postMessages(proxy.port, loop, SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "awaiting-index");
    await waitFor(() => pageGets >= 2);
    await new Promise((r) => setTimeout(r, 20));

    loop = extendToolLoop(loop, "t5");
    await postMessages(proxy.port, loop, SESSION);
    const ready = messageRecords(records).at(-1);
    assert.equal(ready.routeRecovery.outcome, "compressed", "tree built: compresses without waiting for growth");
    assert.equal(blockingCalls(), 2);
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
  const proxy = await startRecoveryProxy({
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

test("a compaction with no byte gain forwards the original and backs the lane off until it grows", async () => {
  // A tiny conversation's recovered body is BIGGER than the original: the
  // no-gain check forwards the original (never worse than verbatim) and
  // installs nothing. The lane then backs off: a same-size retry makes no
  // second call, and only growth past a twentieth of the budget retries.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    // toolTurn is ~60 tokens: over a 20-token budget (backoff margin: 1).
    budgetTokensOverride: 20,
  });
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
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
    assert.equal(blockingCalls(), 1);

    const sameSize = structuredClone(toolTurn);
    sameSize[2].content[0].content = "no";
    await postMessages(proxy.port, sameSize, SESSION);
    const rec2 = messageRecords(records)[1];
    assert.equal(rec2.routeMiss, "missing");
    assert.equal(rec2.routeRecovery.outcome, "backoff");
    assert.equal(blockingCalls(), 1, "a backoff skip pays nothing");
    assert.match(JSON.stringify(upstream.seen.at(-1).body.messages), /first question/);

    await postMessages(proxy.port, extendToolLoop(toolTurn, "t2"), SESSION);
    assert.equal(messageRecords(records)[2].routeRecovery.outcome, "no-gain", "grown: tried again");
    assert.equal(blockingCalls(), 2);
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
    // Still over the budget with nothing to ride: the lane compresses again
    // (a lane is no longer "spent" after one attempt per human turn).
    assert.equal(rejected.routeRecovery.outcome, "compressed");

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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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

    // agent-2 survived under the cap: its extension rides.
    await postMessages(
      proxy.port,
      extendToolLoop(largeToolTurn("AAA"), "x2"),
      laneHeaders(2)
    );
    assert.equal(messageRecords(records).at(-1).turnType, "tool-memory");

    // agent-1 was the least recently used entry, so the 33rd install
    // evicted it: its extension misses, and being over the budget with
    // nothing to ride, compresses again.
    await postMessages(
      proxy.port,
      extendToolLoop(largeToolTurn("AAA"), "x1"),
      laneHeaders(1)
    );
    const evicted = messageRecords(records).at(-1);
    assert.equal(evicted.routeMiss, "missing");
    assert.equal(evicted.turnType, "tool-recompressed");
    assert.equal(evicted.routeRecovery.outcome, "compressed");
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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

test("an in-flight recovery holds the lane; a concurrent miss forwards verbatim", async () => {
  // Two concurrent compactions in one lane are impossible: the first marks
  // the lane in flight BEFORE its compress settles, so a miss racing it
  // forwards verbatim ("in-flight") instead of stacking a second blocking
  // wait — and the in-flight attempt still installs.
  const upstream = await recordingUpstream();
  const held = deferred();
  let aCompressArrived = false;
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
    assert.equal(recB.routeRecovery.outcome, "in-flight");
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
    // charge the full blocking budget to each of these. Main's own lane is
    // backing off after its failed attempt and "backoff" wins when both gates
    // hold, so the cooldown is observed from a sibling lane with no backoff.
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

    // Main's backoff stays visible even while the cooldown is armed: it has
    // grown by far less than a twentieth of the budget since its attempt.
    await postMessages(proxy.port, extendToolLoop(conversation, "t4"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "backoff");
    assert.equal(blockingCalls(), afterFirst, "a backoff skip pays nothing either");
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  // compactions per lane are impossible: the second miss is "in-flight".)
  const upstream = await recordingUpstream();
  const gates = { AAA: deferred(), BBB: deferred(), CCC: deferred() };
  const arrived = { AAA: false, BBB: false, CCC: false };
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
    // the lane is already compressing, so it never reaches the mock.
    await postMessages(proxy.port, largeToolTurn("CCC"), SESSION);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "in-flight"
    );
    assert.equal(arrived.CCC, false, "the in-flight miss sent no compress");

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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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

    // Main's own lane backs off after its failed attempt above: with the
    // fuse lifted it still forwards verbatim until its history has grown by
    // a twentieth of the budget.
    await postMessages(proxy.port, largeToolTurn("EEE"), SESSION);
    assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "backoff");
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
      stop.body.systemMessage.replace(/\x1B\[[0-9;]*m/g, "").replace(SUCCESS_TOTALS_RE, ""),
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
  const proxy = await startRecoveryProxy({
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

test("a hook-armed prompt's followup bump keeps a lane's backoff", async () => {
  // One turn boundary, one budget wipe: UserPromptSubmit already cleared
  // toolRecoveryAttemptedLanes, so the same prompt's followup bump must not
  // clear it again — a lane that spent its attempt between the two bumps
  // would otherwise get a second blocking compress at the same boundary.
  const upstream = await recordingUpstream();
  // BBB (the agent lane) is an index-warming no-op: its attempt produces no
  // prefix, which starts the lane's backoff until the next budget wipe.
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? { messages: reqBody.messages }
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startRecoveryProxy({
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
      messageRecords(records).at(-1).routeRecovery.outcome,
      "noop"
    );
    // ...and then the armed prompt's own followup arrives and bumps again.
    await postMessages(proxy.port, followupTurn("turn two"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The followup bump cleared the agent's route (new epoch) but kept its
    // backoff: the next agent miss forwards verbatim, no second compress.
    const beforeMiss = blockingCalls();
    await postMessages(proxy.port, extendToolLoop(largeToolTurn("BBB"), "s1"), agent);
    const spent = messageRecords(records).at(-1);
    assert.equal(spent.routeMiss, "missing");
    assert.equal(spent.routeRecovery.outcome, "backoff");
    assert.equal(spent.turnType, "tool");
    assert.equal(blockingCalls(), beforeMiss, "the backed-off lane paid nothing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a hookless followup bump still lifts a lane's backoff", async () => {
  // Hookless embedders never fire UserPromptSubmit, so the followup bump is
  // their only per-human-turn wipe. It must keep clearing, or a lane that
  // spent its attempt would forward full history for the rest of the session.
  const upstream = await recordingUpstream();
  // BBB (the agent lane) is an index-warming no-op: its attempt produces no
  // prefix, which starts the lane's backoff until the next budget wipe.
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? { messages: reqBody.messages }
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startRecoveryProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-hookless" };
  try {
    // The agent lane spends its attempt; no hook ever fires.
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "noop"
    );
    // A hookless main followup: the arm was never set, so this bump clears.
    await postMessages(proxy.port, followupTurn("turn two"), SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");

    // The agent lane's next miss attempts again instead of backing off.
    await postMessages(proxy.port, extendToolLoop(largeToolTurn("BBB"), "s1"), agent);
    const regranted = messageRecords(records).at(-1);
    assert.equal(regranted.routeMiss, "missing");
    assert.equal(regranted.routeRecovery.outcome, "noop", "a fresh attempt");
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const memtreeSrv = await listenMemtree((req, res) => {
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
  const proxy = await startRecoveryProxy({
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
  const proxy = await startRecoveryProxy({
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

test("a route bookkeeping throw labels activation-error and backs the lane off", async () => {
  // The third no-install fate. The upstream serves the recovered forward to
  // protocol-complete and the client receives its complete answer, but route
  // bookkeeping throws at BOTH activation attempts (the protocol-complete
  // callback and the delivered-settle retry) — injected via the test-only
  // routeInstallFault seam, which fires after installMemoryRoute's guards and
  // immediately before the store. The settle must label "activation-error",
  // never "upstream-failed" (the model answered) or "client-aborted" (the
  // client stayed to delivery). Unlike those two fates it must NOT refund the
  // lane budget — a deterministic bookkeeping throw would otherwise fund one
  // blocking recompress per tool turn — while still releasing the lane's
  // reservation so the next miss classifies cleanly instead of erroring.
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const records = [];
  const proxy = await startRecoveryProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    routeInstallFault: () => {
      throw new Error("injected");
    },
  });
  const conversation = largeToolTurn();
  const blockingCalls = () => memtreeSrv.calls.filter((c) => !c.index_only).length;
  try {
    const answer = await postMessages(proxy.port, conversation, SESSION);
    assert.equal(answer.id, "msg_upstream", "the client got its full answer");
    await waitFor(() =>
      messageRecords(records).some((r) => r.routeRecovery?.install !== undefined)
    );
    const first = messageRecords(records)[0];
    assert.equal(first.turnType, "tool-recompressed");
    assert.equal(first.routeMiss, "missing");
    assert.equal(first.routeRecovery.outcome, "compressed");
    assert.equal(
      first.routeRecovery.install,
      "activation-error",
      "a delivered turn whose bookkeeping threw is neither upstream-failed nor client-aborted"
    );
    assert.ok(!first.clientAborted, "the client stayed connected to delivery");
    const liveCompresses = blockingCalls();

    // NO refund: the identical-shape retry on the same lane and epoch finds
    // the lane backing off (nothing was installed). The empty lane (not a
    // "replay") logs a plain missing miss, classifies "backoff" — the
    // released reservation is what lets it reach that label at all — and
    // forwards the original history without paying a second blocking
    // compress.
    await postMessages(proxy.port, conversation, SESSION);
    await waitFor(() => messageRecords(records).length >= 2);
    const retry = messageRecords(records).at(-1);
    assert.equal(retry.routeMiss, "missing", "the throw left no route behind");
    assert.equal(
      retry.routeRecovery.outcome,
      "backoff",
      "activation-error must not refund the lane budget"
    );
    assert.equal(retry.routeRecovery.conversationBytes, undefined);
    assert.equal(retry.turnType, "tool");
    assert.equal(blockingCalls(), liveCompresses, "a backoff skip pays nothing");
    assert.match(
      JSON.stringify(upstream.seen.at(-1).body.messages),
      /first question/,
      "the backed-off miss forwards the original history verbatim"
    );
  } finally {
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
  // BBB (the agent lane) is an index-warming no-op: its attempt produces no
  // prefix, which starts the lane's backoff until the next budget wipe.
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? { messages: reqBody.messages }
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startRecoveryProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-first-user" };
  try {
    // An agent lane spends its budget in the pre-boundary epoch...
    await postMessages(proxy.port, largeToolTurn("BBB"), agent);
    assert.equal(
      messageRecords(records).at(-1).routeRecovery.outcome,
      "noop"
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
      messageRecords(records).at(-1).routeRecovery.outcome,
      "noop"
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
      "noop",
      "a stale boundary flag would have kept this lane backing off"
    );
  } finally {
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
  // BBB (the agent lane) is an index-warming no-op: its attempt produces no
  // prefix, which starts the lane's backoff until the next budget wipe.
  const memtreeSrv = await mockMemtree(200, (reqBody) =>
    JSON.stringify(reqBody.messages).includes("BBB")
      ? { messages: reqBody.messages }
      : {
          messages: [
            { role: "user", content: "compressed context " + "c".repeat(2500) },
          ],
          usage: { prompt_tokens_details: { cached_tokens: 123 } },
        }
  );
  const records = [];
  const proxy = await startRecoveryProxy({
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
      messageRecords(records).at(-1).routeRecovery.outcome,
      "noop"
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
      messageRecords(records).at(-1).routeRecovery.outcome,
      "noop"
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
      "backoff",
      "a consumed flag would have let the followup re-grant this lane"
    );
    assert.equal(spent.turnType, "tool");
    assert.equal(blockingCalls(), beforeMiss, "the backed-off lane paid nothing");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// Stable compressed prefix (edge compaction)
// ---------------------------------------------------------------------------

const EPH = { type: "ephemeral" };
const BIG = (tag, chars = 100_000) => `${tag} ` + "x".repeat(chars);

/**
 * A MemTree server that decides like the real one: a request compresses only
 * with a target, and only when its size (chars/4) exceeds the threshold, or
 * the target itself when no threshold was sent. `reportsBudget: false` models
 * a server from before `model_budget_tokens` / `compression_threshold_tokens`.
 */
async function edgeMemtree({ reportsBudget = true, modelBudget = 800_000, noop = false } = {}) {
  let compressions = 0;
  return mockMemtree(200, (body) => {
    if (body.index_only) {
      return {
        messages: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
        index_only: true,
      };
    }
    const size = Math.round(JSON.stringify(body.messages).length / 4);
    const target = body.compression_target_tokens;
    const threshold = reportsBudget ? body.compression_threshold_tokens ?? target : target;
    const budget = reportsBudget ? { model_budget_tokens: modelBudget } : {};
    if (noop || target === undefined || size <= threshold) {
      return {
        messages: body.messages,
        compressed: false,
        usage: { prompt_tokens: size, completion_tokens: size, prompt_tokens_details: { cached_tokens: 1 } },
        ...budget,
      };
    }
    compressions += 1;
    return {
      messages: [{ role: "user", content: `memory ${compressions} ` + "m".repeat(3_000) }],
      compressed: true,
      usage: { prompt_tokens: size, completion_tokens: 900, prompt_tokens_details: { cached_tokens: size } },
      ...budget,
    };
  });
}

/** Anthropic stand-in that reports a request's size as bytes/4, like its usage. */
async function sizingUpstream({ bytesPerToken = 4, reportUsage = true } = {}) {
  const bodies = [];
  const rawBodies = [];
  const srv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      rawBodies.push(raw.toString("utf-8"));
      bodies.push(JSON.parse(raw.toString("utf-8")));
      const tokens = Math.floor(raw.length / bytesPerToken);
      const body = JSON.stringify({
        type: "message",
        id: "msg_upstream",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "upstream answer" }],
        stop_reason: "end_turn",
        ...(reportUsage ? { usage: { input_tokens: 3, cache_read_input_tokens: tokens - 3, output_tokens: 1 } } : {}),
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
  });
  return { ...srv, bodies, rawBodies };
}

async function edgeHarness({ budget = 20_000, memtree = {}, proxyOpts = {}, upstreamOptions = {} } = {}) {
  const upstream = await sizingUpstream(upstreamOptions);
  const memtreeSrv = await edgeMemtree(memtree);
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    // null: no CCC_BUDGET_TOKENS override.
    ...(budget === null ? {} : { budgetTokensOverride: budget }),
    reqlog: { log: (r) => records.push(structuredClone(r)) },
    ...proxyOpts,
  });
  const session = "s-edge";
  const messageRecs = () => records.filter((r) => r.kind === "messages");
  const post = async (messages, extraHeaders = {}, extraBody = {}) => {
    const before = messageRecs().length;
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": session,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 64,
        system: [{ type: "text", text: "sys", cache_control: EPH }],
        messages,
        ...extraBody,
      }),
    });
    await res.json();
    await waitFor(() => messageRecs().length > before);
    return messageRecs().at(-1);
  };
  const command = (prompt) =>
    postHook(proxy, { hook_event_name: "UserPromptSubmit", prompt, session_id: session });
  return {
    upstream,
    memtreeSrv,
    records,
    proxy,
    post,
    command,
    compressCalls: () => memtreeSrv.calls.filter((c) => !c.index_only),
    indexCalls: () => memtreeSrv.calls.filter((c) => c.index_only),
    close: () => {
      proxy.close();
      upstream.close();
      memtreeSrv.close();
    },
  };
}

const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
const markedUser = (text) => ({ role: "user", content: [{ type: "text", text, cache_control: EPH }] });
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const countMarkers = (b) =>
  [
    ...(Array.isArray(b.system) ? b.system : []),
    ...b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
  ].filter((p) => p?.cache_control).length;

test("edge compaction: passthrough under budget, one compaction to half at the budget, then byte-identical prefix rides until the budget is reached again", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = [userText("q1")];
    assert.equal((await h.post(conv)).turnType, "first-user");

    // Under budget: passes through (the server decides; nothing to compress).
    conv.push(assistantText("a1"), markedUser("q2"));
    const t2 = await h.post(conv);
    assert.equal(t2.turnType, "followup-noop");
    assert.equal(t2.compaction.budgetTokens, 20_000);
    assert.equal(t2.compaction.budgetSource, "override");
    assert.equal(h.compressCalls().length, 1);
    assert.equal(h.compressCalls()[0].compression_target_tokens, undefined, "first call: server abilities unknown");

    // Crossing the budget: compress to half of it, once.
    conv[conv.length - 1] = userText("q2");
    conv.push(assistantText("a2"), markedUser(BIG("q3")));
    const t3 = await h.post(conv);
    assert.equal(t3.turnType, "followup-compressed");
    assert.equal(t3.compaction.reason, "budget");
    assert.equal(h.compressCalls().length, 2);
    assert.equal(h.compressCalls()[1].compression_target_tokens, 10_000);
    assert.equal(h.compressCalls()[1].compression_threshold_tokens, undefined, "calibrated budget crossing forces compression");
    const compacted = h.upstream.bodies.at(-1);
    assert.equal(compacted.messages.length, 1);
    assert.deepEqual(compacted.messages[0].content[0].cache_control, EPH, "the prefix carries the cache marker");
    const prefixLength = conv.length;

    // Next human turn: no compress call, the stored prefix byte for byte, then
    // everything after it verbatim.
    conv[conv.length - 1] = userText(BIG("q3"));
    conv.push(assistantText("a3"), markedUser("q4"));
    const indexBefore = h.indexCalls().length;
    const t4 = await h.post(conv);
    assert.equal(t4.turnType, "followup-prefix");
    assert.equal(t4.compress, undefined);
    assert.equal(h.compressCalls().length, 2, "no compress call while the prefix is reused");
    const ride = h.upstream.bodies.at(-1);
    assert.equal(JSON.stringify(ride.messages[0]), JSON.stringify(compacted.messages[0]));
    assert.deepEqual(ride.messages.slice(1), conv.slice(prefixLength));
    assert.ok(countMarkers(ride) <= 4);
    assert.ok(ride.messages[0].content[0].cache_control, "the prefix keeps its marker");
    await waitFor(() => h.indexCalls().length > indexBefore);

    // The turn's tool loop rides the same prefix bytes.
    conv[conv.length - 1] = userText("q4");
    conv.push(
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", cache_control: EPH }] }
    );
    assert.equal((await h.post(conv)).turnType, "tool-memory");
    assert.equal(JSON.stringify(h.upstream.bodies.at(-1).messages[0]), JSON.stringify(compacted.messages[0]));

    // Another human turn, still under budget: another ride, still no compress.
    conv[conv.length - 1] = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
    conv.push(assistantText("a4"), markedUser("q5"));
    const t5 = await h.post(conv);
    assert.equal(t5.turnType, "followup-prefix");
    assert.equal(t5.compaction.sizeSource, "reported");
    assert.ok(t5.compaction.estimatedTokens < 20_000);
    assert.equal(JSON.stringify(h.upstream.bodies.at(-1).messages[0]), JSON.stringify(compacted.messages[0]));
    assert.equal(h.compressCalls().length, 2);

    // Prefix + new turns reach the budget: recompress, forced to the target.
    conv[conv.length - 1] = userText("q5");
    conv.push(assistantText("a5"), markedUser(BIG("q6")));
    const t6 = await h.post(conv);
    assert.equal(t6.turnType, "followup-compressed");
    assert.equal(t6.compaction.reason, "budget");
    assert.ok(t6.compaction.estimatedTokens >= 20_000);
    assert.equal(h.compressCalls().length, 3);
    assert.equal(h.compressCalls()[2].compression_target_tokens, 10_000);
    assert.equal(h.compressCalls()[2].compression_threshold_tokens, undefined);
    const recompacted = h.upstream.bodies.at(-1);
    assert.notEqual(JSON.stringify(recompacted.messages[0]), JSON.stringify(compacted.messages[0]));

    // And the new prefix is the one reused from then on.
    conv[conv.length - 1] = userText(BIG("q6"));
    conv.push(assistantText("a6"), markedUser("q7"));
    assert.equal((await h.post(conv)).turnType, "followup-prefix");
    assert.equal(JSON.stringify(h.upstream.bodies.at(-1).messages[0]), JSON.stringify(recompacted.messages[0]));
    assert.equal(h.compressCalls().length, 3);
    for (const body of h.upstream.bodies) assert.ok(countMarkers(body) <= 4, `${countMarkers(body)} markers`);
  } finally {
    h.close();
  }
});

/** Drive a harness session to its first compaction; returns the conversation. */
async function compactOnce(h) {
  const conv = [userText("q1"), assistantText("a1"), userText("q2")];
  await h.post(conv);
  conv.push(assistantText("a2"), userText(BIG("q3")));
  const rec = await h.post(conv);
  assert.equal(rec.turnType, "followup-compressed");
  return conv;
}

test("edge compaction: a changed prefix (rewind, edit, /clear) recompresses instead of riding", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = await compactOnce(h);
    const calls = h.compressCalls().length;

    // An edited earlier message: the prefix no longer stands for this history.
    const edited = [userText("q1 (edited)"), ...conv.slice(1), assistantText("a3"), userText("q4")];
    const miss = await h.post(edited);
    assert.equal(miss.compaction.prefixMiss, "prefix");
    assert.equal(miss.compaction.reason, "prefix-mismatch");
    assert.equal(miss.turnType, "followup-compressed", "still over budget: compacted again");
    assert.equal(h.compressCalls().length, calls + 1);

    // /clear: a new, small conversation passes through again.
    const cleared = await h.post([userText("new"), assistantText("hi"), userText("small")]);
    assert.equal(cleared.compaction.prefixMiss, "prefix");
    assert.equal(cleared.turnType, "followup-noop");
    assert.equal(cleared.compaction.reason, undefined);
    assert.equal(h.compressCalls().length, calls + 2);
  } finally {
    h.close();
  }
});

test("edge compaction: /memtree-compact off drops the prefix and passes through", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = await compactOnce(h);
    assert.match((await h.command("/memtree-compact off")).body.reason, /compaction off/);
    conv.push(assistantText("a3"), userText("q4"));
    const off = await h.post(conv);
    assert.equal(off.compaction.mode, "off");
    assert.equal(off.turnType, "followup-noop", "sent whole");
    const last = h.compressCalls().at(-1);
    assert.equal(last.compression_target_tokens, undefined);
    assert.equal(last.compression_threshold_tokens, undefined);
    conv.push(assistantText("a4"), userText("q5"));
    assert.notEqual((await h.post(conv)).turnType, "followup-prefix", "no prefix to ride");
  } finally {
    h.close();
  }
});

test("edge compaction: CCC_COMPACT_TARGET=off (defaultCompactTarget null) starts off; /memtree-compact turns it on", async () => {
  const h = await edgeHarness({ budget: 20_000, proxyOpts: { defaultCompactTarget: null } });
  try {
    // Over the 20k budget from the first turn, yet nothing forces a compaction
    // and no stable prefix is built: the /memtree-compact off state.
    const conv = [userText("q1"), assistantText("a1"), userText(BIG("q2"))];
    const first = await h.post(conv);
    assert.equal(first.compaction.mode, "off");
    assert.equal(first.compaction.reason, undefined);
    assert.equal(first.turnType, "followup-noop", "sent whole");
    assert.equal(h.compressCalls().at(-1).compression_target_tokens, undefined);
    assert.equal(h.compressCalls().at(-1).compression_threshold_tokens, undefined);

    // `/memtree-compact` with no N pins the automatic target (budget/2) for
    // this session, rather than falling back to the off default.
    assert.match((await h.command("/memtree-compact")).body.reason, /about half the budget/);
    conv.push(assistantText("a2"), userText("q3"));
    const manual = await h.post(conv);
    assert.equal(manual.compaction.mode, "auto");
    assert.equal(manual.compaction.reason, "manual");
    assert.equal(manual.turnType, "followup-compressed");
    assert.equal(h.compressCalls().at(-1).compression_target_tokens, 10_000);
  } finally {
    h.close();
  }
});

test("edge compaction: /memtree-compact N compacts now to N, then rides", async () => {
  const h = await edgeHarness({ budget: 100_000 });
  try {
    // ~37k tokens: under the 100k budget, so nothing compacts on its own.
    const conv = [userText("q1"), assistantText("a1"), userText(BIG("q2", 150_000))];
    assert.equal((await h.post(conv)).turnType, "followup-noop");
    conv.push(assistantText("a2"), userText("q3"));
    assert.equal((await h.post(conv)).turnType, "followup-noop");

    assert.match((await h.command("/memtree-compact 30k")).body.reason, /about 30k tokens/);
    conv.push(assistantText("a3"), userText("q4"));
    const manual = await h.post(conv);
    assert.equal(manual.turnType, "followup-compressed");
    assert.equal(manual.compaction.reason, "manual");
    assert.equal(manual.compaction.mode, "explicit");
    assert.equal(h.compressCalls().at(-1).compression_target_tokens, 30_000);
    assert.equal(h.compressCalls().at(-1).compression_threshold_tokens, undefined, "forced");

    const calls = h.compressCalls().length;
    conv.push(assistantText("a4"), userText("q5"));
    const next = await h.post(conv);
    assert.equal(next.turnType, "followup-prefix");
    assert.equal(next.compaction.targetTokens, 30_000);
    assert.equal(h.compressCalls().length, calls);
  } finally {
    h.close();
  }
});

test("edge compaction on a server without model_budget_tokens: the proxy's own estimate triggers the compaction", async () => {
  const h = await edgeHarness({ budget: 20_000, memtree: { reportsBudget: false } });
  try {
    const conv = [userText("q1"), assistantText("a1"), userText("q2")];
    assert.equal((await h.post(conv)).turnType, "followup-noop");
    assert.equal(h.compressCalls()[0].compression_target_tokens, undefined);
    conv.push(assistantText("a2"), userText(BIG("q3")));
    const crossed = await h.post(conv);
    assert.equal(crossed.turnType, "followup-compressed");
    assert.equal(crossed.compaction.reason, "budget");
    assert.ok(crossed.compaction.estimatedTokens >= 20_000);
    assert.equal(h.compressCalls()[1].compression_target_tokens, 10_000);
    assert.equal(h.compressCalls()[1].compression_threshold_tokens, undefined);
    conv.push(assistantText("a3"), userText("q4"));
    assert.equal((await h.post(conv)).turnType, "followup-prefix");
    assert.equal(h.compressCalls().length, 2);
  } finally {
    h.close();
  }
});

test("edge compaction budget: context window x ratio until the server reports its model budget", async () => {
  const h = await edgeHarness({ budget: null, memtree: { modelBudget: 150_000 } });
  try {
    const conv = [userText("q1"), assistantText("a1"), userText("q2")];
    const first = await h.post(conv);
    assert.equal(first.compaction.budgetSource, "window-ratio");
    assert.equal(first.compaction.budgetTokens, 160_000, "claude-x: 200k window x 0.8");
    conv.push(assistantText("a2"), userText("q3"));
    const second = await h.post(conv);
    assert.equal(second.compaction.budgetSource, "server");
    assert.equal(second.compaction.budgetTokens, 150_000);
    assert.equal(second.compaction.targetTokens, 75_000);
    assert.equal(h.compressCalls().at(-1).compression_threshold_tokens, 150_000);
  } finally {
    h.close();
  }
});

test("edge compaction: a failed recompression rides the old prefix instead of sending the whole history", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = await compactOnce(h);
    const compacted = h.upstream.bodies.at(-1);
    // MemTree goes away; the next turn crosses the budget again.
    h.memtreeSrv.server.closeAllConnections();
    h.memtreeSrv.close();
    conv.push(assistantText("a3"), userText(BIG("q4")));
    const failed = await h.post(conv);
    assert.equal(failed.turnType, "followup-prefix");
    assert.equal(failed.compaction.reason, "budget");
    assert.equal(failed.compaction.keptPrefix, true);
    assert.equal(JSON.stringify(h.upstream.bodies.at(-1).messages[0]), JSON.stringify(compacted.messages[0]));
  } finally {
    h.close();
  }
});

test("edge compaction: earlier thinking that Claude Code stops replaying does not break the prefix", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const thinking = { type: "thinking", thinking: "hmm", signature: "sig" };
    const conv = [
      userText("q1"),
      { role: "assistant", content: [thinking, { type: "text", text: "a1" }] },
      userText("q2"),
    ];
    await h.post(conv);
    conv.push(assistantText("a2"), userText(BIG("q3")));
    assert.equal((await h.post(conv)).turnType, "followup-compressed");
    const replayed = [
      conv[0],
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      ...conv.slice(2),
      assistantText("a3"),
      userText("q4"),
    ];
    const next = await h.post(replayed);
    assert.equal(next.turnType, "followup-prefix");
    assert.equal(next.compaction.prefixMiss, undefined);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// Tool-loop compaction: tool turns follow the human-turn budget rule
// ---------------------------------------------------------------------------

/**
 * Append one tool call and its result (~chars/4 tokens) to `conv`, with
 * Claude Code's cache marker moved to the newest result.
 */
function toolStep(conv, id, chars = 20_000) {
  for (const m of conv) {
    if (Array.isArray(m.content)) m.content = m.content.map(({ cache_control: _c, ...p }) => p);
  }
  conv.push(
    { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: `${id} ` + "r".repeat(chars), cache_control: EPH }],
    }
  );
  return conv;
}

/** Run tool turns until one is not `turnType`; returns [that record, turns taken]. */
async function toolTurnsWhile(h, conv, turnType, check = () => {}, headers = {}) {
  for (let n = 1; n < 50; n++) {
    toolStep(conv, `t${conv.length}`);
    const rec = await h.post(conv, headers);
    if (rec.turnType !== turnType) return [rec, n];
    check(rec);
  }
  throw new Error(`tool turns stayed ${turnType}`);
}

test("tool-loop compaction: a single human turn's tool loop passes through under the budget, compresses once at it, rides the prefix byte for byte, and recompresses at the next crossing", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = [userText("q1")];
    assert.equal((await h.post(conv)).turnType, "first-user");

    // Under the budget: every tool turn goes out whole, with no compress call
    // and nothing spent — the old one-shot recovery no-oped here and then
    // forwarded every later tool turn whole past the budget.
    const [crossed, passed] = await toolTurnsWhile(h, conv, "tool", (rec) => {
      assert.ok(rec.compaction.estimatedTokens < 20_000);
      assert.equal(rec.routeRecovery, undefined);
      assert.equal(rec.compress, undefined);
      assert.equal(h.compressCalls().length, 0, "no compress call under the budget");
    });
    assert.ok(passed >= 3, `${passed} turns: several tool turns passed through first`);

    // Crossing: exactly one compress call, forced to half the budget.
    assert.equal(crossed.turnType, "tool-recompressed");
    assert.equal(crossed.compaction.reason, "budget");
    assert.equal(crossed.compaction.sizeSource, "reported");
    assert.equal(crossed.compaction.estimatedBytes, crossed.requestBytes, "first tool compression sizes the whole request");
    assert.ok(crossed.compaction.estimatedTokens >= 20_000);
    assert.equal(crossed.routeRecovery.outcome, "compressed");
    assert.equal(crossed.routeRecovery.install, "installed");
    assert.equal(crossed.routeRecovery.prefix, "installed");
    assert.equal(h.compressCalls().length, 1);
    assert.equal(h.compressCalls()[0].compression_target_tokens, 10_000);
    assert.equal(h.compressCalls()[0].compression_threshold_tokens, undefined);
    const compacted = h.upstream.bodies.at(-1);
    assert.equal(compacted.messages.length, 1);
    assert.deepEqual(compacted.messages[0].content[0].cache_control, EPH, "the prefix carries the cache marker");

    // Later tool turns ride it: the same prefix bytes, no compress call.
    const [recrossed, rides] = await toolTurnsWhile(h, conv, "tool-memory", (rec) => {
      const body = h.upstream.bodies.at(-1);
      assert.equal(JSON.stringify(body.messages[0]), JSON.stringify(compacted.messages[0]));
      assert.ok(countMarkers(body) <= 4, `${countMarkers(body)} markers`);
      assert.equal(rec.compaction.sizeSource, "reported");
      assert.ok(rec.compaction.estimatedTokens < 20_000);
      assert.equal(h.compressCalls().length, 1);
    });
    assert.ok(rides >= 2, `${rides} rides before the next crossing`);

    // Prefix + suffix reach the budget: one more compression.
    assert.equal(recrossed.turnType, "tool-recompressed");
    assert.equal(recrossed.compaction.reason, "budget");
    assert.equal(h.compressCalls().length, 2);
    assert.equal(h.compressCalls()[1].compression_target_tokens, 10_000);
    const recompacted = h.upstream.bodies.at(-1);
    assert.notEqual(JSON.stringify(recompacted.messages[0]), JSON.stringify(compacted.messages[0]));

    toolStep(conv, "after");
    assert.equal((await h.post(conv)).turnType, "tool-memory");
    assert.equal(JSON.stringify(h.upstream.bodies.at(-1).messages[0]), JSON.stringify(recompacted.messages[0]));
    for (const body of h.upstream.bodies) assert.ok(countMarkers(body) <= 4, `${countMarkers(body)} markers`);
  } finally {
    h.close();
  }
});

test("tool-loop compaction: a human turn after a tool-turn compaction rides the same prefix", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = [userText("q1")];
    await h.post(conv);
    const [crossed] = await toolTurnsWhile(h, conv, "tool");
    assert.equal(crossed.turnType, "tool-recompressed");
    const compacted = h.upstream.bodies.at(-1);
    const calls = h.compressCalls().length;

    toolStep(conv, "t-last", 100);
    conv.push(assistantText("done"), markedUser("q2"));
    const human = await h.post(conv);
    assert.equal(human.turnType, "followup-prefix");
    assert.equal(human.compress, undefined);
    assert.equal(h.compressCalls().length, calls, "no compress call");
    const ride = h.upstream.bodies.at(-1);
    assert.equal(JSON.stringify(ride.messages[0]), JSON.stringify(compacted.messages[0]));
    assert.ok(ride.messages[0].content[0].cache_control, "the prefix keeps its marker");
    assert.ok(countMarkers(ride) <= 4);
  } finally {
    h.close();
  }
});

const taskNotification = (text) => ({
  role: "system",
  content: `<task-notification>\n<status>failed</status>\n<summary>${text}</summary>\n</task-notification>`,
});

test("a task notification after a compacted turn rides the stable prefix instead of forwarding the whole history", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = [userText("q1")];
    await h.post(conv);
    const [crossed] = await toolTurnsWhile(h, conv, "tool");
    assert.equal(crossed.turnType, "tool-recompressed");
    const compacted = h.upstream.bodies.at(-1);
    const calls = h.compressCalls().length;

    // The turn ends; later a background agent's notification arrives as a
    // trailing system block after the assistant's final reply.
    toolStep(conv, "t-last", 100);
    conv.push(assistantText("done"), taskNotification("agent stalled"));
    const rec = await h.post(conv);
    assert.equal(rec.continuation, true);
    assert.equal(rec.turnType, "tool-prefix");
    assert.equal(rec.routeMiss, undefined, "a notification never consults or evicts the lane route");
    assert.equal(h.compressCalls().length, calls, "under the budget: no compress call");
    const ride = h.upstream.bodies.at(-1);
    assert.equal(JSON.stringify(ride.messages[0]), JSON.stringify(compacted.messages[0]));
    assert.equal(ride.messages.at(-1).role, "system", "the notification itself goes out verbatim");
  } finally {
    h.close();
  }
});

test("a task notification at the budget with no stable prefix compresses instead of forwarding whole", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const conv = [userText("q1")];
    assert.equal((await h.post(conv)).turnType, "first-user");
    conv.push(assistantText("a".repeat(100_000)), taskNotification("agent finished"));
    const rec = await h.post(conv);
    assert.equal(rec.continuation, true);
    assert.equal(rec.compaction.reason, "budget");
    assert.equal(rec.turnType, "tool-recompressed");
    assert.equal(h.compressCalls().length, 1);
    assert.ok(rec.forwardedBytes < rec.requestBytes / 4, "the compressed history went upstream");
  } finally {
    h.close();
  }
});

test("tool-loop compaction with a typed prompt pending (headless -p): the result becomes the stable prefix and later tool turns ride it directly", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    // The prompt's UserPromptSubmit arms the main thread; a first-user
    // request never consumes the arm, so the whole loop runs with it set.
    await h.command("q1");
    const conv = [userText("q1")];
    assert.equal((await h.post(conv)).turnType, "first-user");
    const [crossed] = await toolTurnsWhile(h, conv, "tool");
    assert.equal(crossed.turnType, "tool-recompressed");
    assert.equal(crossed.routeRecovery.install, "prompt-pending", "no lane route while a prompt is pending");
    assert.equal(crossed.routeRecovery.prefix, "installed");
    const compacted = h.upstream.bodies.at(-1);

    const [recrossed, rides] = await toolTurnsWhile(h, conv, "tool-prefix", () => {
      assert.equal(JSON.stringify(h.upstream.bodies.at(-1).messages[0]), JSON.stringify(compacted.messages[0]));
      assert.ok(countMarkers(h.upstream.bodies.at(-1)) <= 4);
      assert.equal(h.compressCalls().length, 1);
    });
    assert.ok(rides >= 2);
    assert.equal(recrossed.turnType, "tool-recompressed");
    assert.equal(h.compressCalls().length, 2);
  } finally {
    h.close();
  }
});

test("tool-loop compaction: CCC_COMPACT_TARGET=off, /memtree-compact off and the kill switch pass tool turns through with no compress call", async () => {
  for (const setup of ["env-off", "command-off", "kill-switch"]) {
    const h = await edgeHarness({
      budget: 20_000,
      proxyOpts:
        setup === "env-off"
          ? { defaultCompactTarget: null }
          : setup === "kill-switch"
            ? { toolRouteRecovery: false }
            : {},
    });
    try {
      if (setup === "command-off") await h.command("/memtree-compact off");
      const conv = [userText("q1")];
      await h.post(conv);
      for (let n = 0; n < 6; n++) {
        toolStep(conv, `t${n}`);
        const rec = await h.post(conv);
        assert.equal(rec.turnType, "tool", setup);
        assert.equal(rec.compress, undefined, setup);
        if (setup === "kill-switch") assert.equal(rec.compaction, undefined);
        else assert.equal(rec.compaction.mode, "off");
      }
      assert.ok(h.upstream.bodies.at(-1).messages.length > 10, "sent whole, past the budget");
      assert.equal(h.compressCalls().length, 0, `${setup}: no compress call`);
    } finally {
      h.close();
    }
  }
});

test("tool-loop compaction: a subagent's tool loop compresses once at the budget and rides its own route", async () => {
  const h = await edgeHarness({ budget: 20_000 });
  try {
    const agent = { "x-claude-code-agent-id": "agent-long" };
    const conv = [userText("task")];
    assert.equal((await h.post(conv, agent)).turnType, "first-user");
    const [crossed, passed] = await toolTurnsWhile(
      h,
      conv,
      "tool",
      () => assert.equal(h.compressCalls().length, 0),
      agent
    );
    assert.ok(passed >= 3);
    assert.equal(crossed.routeLane, "agent");
    assert.equal(crossed.turnType, "tool-recompressed");
    assert.equal(crossed.routeRecovery.install, "installed");
    assert.equal(crossed.routeRecovery.prefix, undefined, "a subagent builds no session prefix");
    const [, rides] = await toolTurnsWhile(
      h,
      conv,
      "tool-memory",
      () => assert.equal(h.compressCalls().length, 1),
      agent
    );
    assert.ok(rides >= 2);
    assert.equal(h.compressCalls().length, 2, "recompressed at the next crossing");
  } finally {
    h.close();
  }
});

test("tool-loop compaction: an attempt that produces nothing backs the lane off until the history grows", async () => {
  const h = await edgeHarness({ budget: 20_000, memtree: { noop: true } });
  try {
    const conv = [userText("q1")];
    await h.post(conv);
    let rec;
    for (let n = 0; n < 20 && !rec?.routeRecovery; n++) {
      toolStep(conv, `t${n}`);
      rec = await h.post(conv);
    }
    assert.equal(rec.routeRecovery.outcome, "noop");
    assert.equal(rec.turnType, "tool", "sent whole");
    assert.equal(h.compressCalls().length, 1);

    // Small growth (under a twentieth of the budget): no second call.
    toolStep(conv, "small", 200);
    const waiting = await h.post(conv);
    assert.equal(waiting.routeRecovery.outcome, "backoff");
    assert.equal(waiting.compaction.reason, "budget");
    assert.equal(h.compressCalls().length, 1);

    // Grown past it: the lane tries again.
    toolStep(conv, "big");
    assert.equal((await h.post(conv)).routeRecovery.outcome, "noop");
    assert.equal(h.compressCalls().length, 2);
  } finally {
    h.close();
  }
});

test("index-only calls carry message times keyed by the reminder-stripped list sent", async () => {
  const memtreeSrv = await mockMemtree(200, compressedOnce);
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const messages = [
    { role: "user", content: "first" },
    { role: "user", content: "<system-reminder>only a reminder</system-reminder>" },
    { role: "assistant", content: "answer" },
  ];
  let seenByTimes;
  try {
    memtree.indexInBackground("h-times", messages, 200_000, "session-1", undefined, (sent) => {
      seenByTimes = sent;
      return { [sent.findIndex((m) => m.role === "assistant")]: "2026-09-23T20:00:00.000Z" };
    });
    await memtree.drainBackground(5_000);
    const call = memtreeSrv.calls.find((c) => c.index_only);
    assert.equal(seenByTimes.length, 2, "the reminder-only message was dropped before timing");
    assert.deepEqual(call.message_times, { 1: "2026-09-23T20:00:00.000Z" });
    assert.equal(call.messages[1].role, "assistant");
  } finally {
    memtreeSrv.close();
  }
});

test("a subagent's MemTree calls are timed from that subagent's transcript", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context " + "c".repeat(2500) }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const asked = [];
  const transcriptUsage = {
    usageFor(sessionId, _messages, agentId) {
      asked.push(["usage", sessionId, agentId]);
      return {};
    },
    timesFor(sessionId, messages, agentId) {
      asked.push(["times", sessionId, agentId]);
      return { [messages.length - 1]: "2026-09-23T20:00:00.000Z" };
    },
  };
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    transcriptUsage,
  });
  const agent = { ...SESSION, "x-claude-code-agent-id": "agent-9" };
  const base = followupTurn("agent turn two");
  try {
    await postMessages(proxy.port, base, agent);
    await postMessages(proxy.port, extendToolLoop(base, "t1"), agent);
    await waitFor(() => memtreeSrv.calls.some((c) => c.index_only));
    const session = SESSION["x-claude-code-session-id"];
    assert.ok(asked.length >= 2, JSON.stringify(asked));
    for (const call of asked) assert.deepEqual(call.slice(1), [session, "agent-9"]);
    for (const call of memtreeSrv.calls) {
      assert.deepEqual(call.message_times, { [call.messages.length - 1]: "2026-09-23T20:00:00.000Z" });
    }
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});


test("compression exceptions forward human and tool requests byte for byte and back off", async () => {
  for (const lane of ["human", "tool"]) {
    const upstream = await recordingUpstream();
    const memtreeSrv = await mockMemtree(200, recoveredMemory());
    const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
    const records = [];
    const proxy = await startRecoveryProxy({ memtree, upstreamOrigin: upstream.origin, reqlog: { log: r => records.push(structuredClone(r)) } });
    try {
      let conv = lane === "tool" ? largeToolTurn() : followupTurn("second");
      await postMessages(proxy.port, conv, SESSION);
      assert.match(JSON.stringify(upstream.seen.at(-1).body.messages), /recovered memory/);
      let throws = 0;
      memtree.compress = async () => { throws++; throw new Error("injected compress failure"); };
      if (lane === "tool") {
        conv = extendToolLoop(conv);
        conv.at(-1).content[0].content = "r".repeat(1_000_000);
      } else {
        conv = [...conv, { role: "assistant", content: "answer" }, { role: "user", content: "q".repeat(1_000_000) }];
      }
      const raw = JSON.stringify({ model: "claude-x", max_tokens: 64, system: "<cc-infinite-notice>MemTree working - conversation consolidated</cc-infinite-notice>", messages: conv }, null, 2) + "\n";
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...SESSION }, body: raw });
      assert.equal(response.status, 200, `${lane}: exception must not return 502`);
      await response.text();
      assert.equal(upstream.seen.at(-1).raw, raw, `${lane}: original bytes, not the old prefix`);
      assert.equal(throws, 1);
      if (lane === "tool") {
        const next = extendToolLoop(conv, "t3");
        await postMessages(proxy.port, next, SESSION);
        assert.equal(throws, 1, "small tool growth preserves exception backoff");
        assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "backoff");
      }
    } finally { await proxy.close(); upstream.close(); memtreeSrv.close(); }
  }
});

test("first-tree waiting expires hung probes and endless 202s, and aborts probes on shutdown", async () => {
  for (const mode of ["hung", "building", "shutdown"]) {
    const upstream = await recordingUpstream();
    const records = [];
    let gets = 0, closed = 0, calls = 0, ready = false;
    const memtreeSrv = await listen((req, res) => {
      if (req.method === "GET") {
        gets++;
        res.on("close", () => closed++);
        res.writeHead(mode === "building" ? 202 : 200, { "content-type": "application/json" });
        if (mode === "building") res.end(JSON.stringify({ status: "building" }));
        else res.write("{"); // Headers arrive, but reading the body never finishes.
        return;
      }
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks));
        if (!body.index_only) calls++;
        res.writeHead(200, { "content-type": "application/json", ...pageHeaders(PAGE_URL_1) });
        res.end(JSON.stringify(body.index_only ? { messages: [], index_only: true, usage: {} } : ready ? withServerFlatten(recoveredMemory(), body) : { messages: body.messages, compressed: false, usage: { prompt_tokens_details: { cached_tokens: 0 } } }));
      });
    });
    const proxy = await startRecoveryProxy({
      memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
      upstreamOrigin: upstream.origin,
      awaitedIndexProbeTimeoutMs: mode === "shutdown" ? 10_000 : 25,
      awaitedIndexWaitTimeoutMs: 150,
      reqlog: { log: r => records.push(structuredClone(r)) },
    });
    try {
      let loop = largeToolTurn();
      await postMessages(proxy.port, loop, SESSION);
      assert.equal(calls, 1);
      const waitStarted = Date.now();
      loop = extendToolLoop(loop);
      await postMessages(proxy.port, loop, SESSION);
      assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "awaiting-index");
      await waitFor(() => gets === 1);
      if (mode === "shutdown") {
        await proxy.close();
        await waitFor(() => closed === 1, 500);
      } else {
        if (mode === "hung") await waitFor(() => closed === 1, 500);
        else await waitFor(() => Date.now() >= waitStarted + 150, 500);
        ready = true;
        loop = extendToolLoop(loop, "t3");
        loop.at(-1).content[0].content = "growth".repeat(10_000);
        await postMessages(proxy.port, loop, SESSION);
        assert.equal(calls, 2, `${mode}: finite wait allows a fresh compress`);
        assert.equal(messageRecords(records).at(-1).routeRecovery.outcome, "compressed");
        assert.equal(upstream.seen.length, 3, "all tool turns reach upstream in order");
      }
    } finally { await proxy.close(); upstream.close(); memtreeSrv.server.closeAllConnections(); memtreeSrv.close(); }
  }
});

test("an older failed human compression cannot erase a newer stable prefix", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const held = deferred();
  const records = [];
  let calls = 0;
  const good = { ...recoveredMemory(), flattened_messages: recoveredMemory().messages };
  memtree.compress = async () => { calls++; return calls === 1 ? held.promise : good; };
  const proxy = await startRecoveryProxy({ memtree, upstreamOrigin: upstream.origin, reqlog: { log: r => records.push(structuredClone(r)) } });
  let older;
  try {
    const base = followupTurn("second");
    older = postMessages(proxy.port, base, SESSION);
    await waitFor(() => calls === 1);
    const newer = [...base, { role: "assistant", content: "second answer" }, { role: "user", content: "third" }];
    await postMessages(proxy.port, newer, SESSION);
    assert.equal(messageRecords(records).at(-1).turnType, "followup-compressed");
    const prefixBytes = JSON.stringify(upstream.seen.at(-1).body.messages[0]);
    held.resolve(null);
    await older;
    assert.deepEqual(upstream.seen.at(-1).body.messages, base, "failed older request still forwards its own history");
    const latest = [...newer, { role: "assistant", content: "third answer" }, { role: "user", content: "fourth" }];
    await postMessages(proxy.port, latest, SESSION);
    assert.equal(calls, 2, "newest turn must reuse the winning prefix without recompressing");
    assert.equal(messageRecords(records).at(-1).turnType, "followup-prefix");
    assert.equal(JSON.stringify(upstream.seen.at(-1).body.messages[0]), prefixBytes);
  } finally { held.resolve(null); await older; await proxy.close(); upstream.close(); memtreeSrv.close(); }
});

test("capture files and new or reused directories are private and exclude auth headers", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-capture-permissions-"));
  const oldUmask = process.umask(0o022);
  const upstream = await recordingUpstream();
  const memtreeSrv = await mockMemtree(200, recoveredMemory());
  try {
    for (const mode of ["new", "existing"]) {
      const dir = path.join(root, mode);
      if (mode === "existing") fs.mkdirSync(dir, { mode: 0o755 });
      const records = [];
      const proxy = await startProxy({ memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "memtree-secret" }), upstreamOrigin: upstream.origin, captureDir: dir, reqlog: { log: r => records.push(structuredClone(r)) } });
      try {
        await postMessages(proxy.port, [{ role: "user", content: "hello" }], { ...SESSION, authorization: "Bearer anthropic-secret", "x-api-key": "api-secret" });
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${mode} capture directory is private`);
        const files = fs.readdirSync(dir);
        assert.equal(files.length, 1);
        assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
        const contents = fs.readFileSync(path.join(dir, files[0]), "utf8");
        assert.deepEqual(JSON.parse(contents).messages, [{ role: "user", content: "hello" }]);
        assert.doesNotMatch(contents + JSON.stringify(records), /anthropic-secret|api-secret|memtree-secret/);
      } finally { await proxy.close(); }
    }
  } finally { process.umask(oldUmask); upstream.close(); memtreeSrv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("model churn evicts old server budgets and safely falls back to the context ratio", async () => {
  const upstream = await recordingUpstream();
  const memtreeSrv = await edgeMemtree({ modelBudget: 150_000 });
  const records = [];
  const proxy = await startProxy({ memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }), upstreamOrigin: upstream.origin, reqlog: { log: r => records.push(structuredClone(r)) } });
  let seq = 0;
  const postModel = async (model) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...SESSION }, body: JSON.stringify({ model, max_tokens: 64, messages: followupTurn(`question ${seq++}`) }) });
    assert.equal(response.status, 200);
    await response.text();
    return messageRecords(records).at(-1);
  };
  try {
    assert.equal((await postModel("claude-review-0")).compaction.budgetSource, "window-ratio");
    const remembered = await postModel("claude-review-0");
    assert.equal(remembered.compaction.budgetSource, "server");
    assert.equal(remembered.compaction.budgetTokens, 150_000);
    for (let n = 1; n <= 20; n++) await postModel(`claude-review-${n}`);
    const evicted = await postModel("claude-review-0");
    assert.equal(evicted.compaction.budgetSource, "window-ratio", "old model budget is evicted after churn");
    assert.equal(evicted.compaction.budgetTokens, 160_000);
    assert.equal((await postModel("claude-review-0")).compaction.budgetSource, "server", "a fresh report repopulates the evicted entry");
  } finally { await proxy.close(); upstream.close(); memtreeSrv.close(); }
});


test("calibrated dense input forces compaction before the server threshold", async () => {
  const h = await edgeHarness({ upstreamOptions: { bytesPerToken: 2 } });
  try {
    const conv = [userText("q"), assistantText("a"), userText("warm")];
    await h.post(conv);
    conv.push(assistantText("a"), userText("dense ".repeat(8_000)));
    const rec = await h.post(conv);
    assert.equal(rec.compaction.sizeSource, "reported");
    assert.ok(rec.compaction.estimatedTokens >= 20_000);
    const call = h.compressCalls().at(-1);
    assert.ok(JSON.stringify(call.messages).length / 4 < 20_000);
    assert.equal(call.compression_threshold_tokens, undefined);
    assert.equal(call.compression_target_tokens, 10_000);
    assert.equal(rec.turnType, "followup-compressed");
  } finally { h.close(); }
});

for (const reportsBudget of [true, false]) {
  for (const lane of ["human", "tool", "prefix"]) {
    test(`uncalibrated ${lane} budget check lets ${reportsBudget ? "threshold" : "older"} server decide`, async () => {
      const h = await edgeHarness({ memtree: { reportsBudget }, upstreamOptions: { reportUsage: false } });
      try {
        const conv = [userText("q"), assistantText("a"), userText("warm")];
        await h.post(conv);
        if (lane === "prefix") {
          await h.command("/memtree-compact");
          conv.push(assistantText("a"), userText(BIG("manual")));
          assert.equal((await h.post(conv)).turnType, "followup-compressed");
          assert.equal(h.compressCalls().at(-1).compression_threshold_tokens, undefined, "manual remains explicit");
        }
        if (lane === "tool") toolStep(conv, "large", 100_000);
        else conv.push(assistantText("a"), userText(BIG("cross")));
        const rec = await h.post(conv);
        assert.equal(rec.compaction.sizeSource, "bytes");
        assert.ok(rec.compaction.estimatedTokens >= 20_000);
        const call = h.compressCalls().at(-1);
        assert.equal(call.compression_threshold_tokens, reportsBudget ? 20_000 : undefined);
        assert.equal(call.compression_target_tokens, reportsBudget ? 10_000 : undefined);
      } finally { h.close(); }
    });
  }
}

test("a bytes-only window alarm does not force below the calibrated budget and window", async () => {
  const h = await edgeHarness({ budget: 160_000, upstreamOptions: { bytesPerToken: 10 } });
  try {
    const conv = [userText("q"), assistantText("a"), userText("x".repeat(900_000))];
    await h.post(conv);
    toolStep(conv, "small", 10);
    const rec = await h.post(conv);
    assert.equal(rec.compaction.sizeSource, "reported");
    assert.ok(rec.compaction.estimatedTokens < 160_000);
    assert.ok(rec.requestBytes / 4 > 200_000);
    const call = h.compressCalls().at(-1);
    assert.equal(call.compression_target_tokens, 80_000);
    assert.equal(call.compression_threshold_tokens, 160_000);
  } finally { h.close(); }
});

for (const reportUsage of [false, true]) {
  test(`recompaction totals use the old prefix size basis ${reportUsage ? "with" : "without"} Anthropic usage`, async () => {
    const { compressedTotalsText } = await import("../dist/notices.js");
    const h = await edgeHarness({ upstreamOptions: { reportUsage } });
    try {
      const conv = await compactOnce(h);
      const oldBody = structuredClone(h.upstream.bodies.at(-1));
      const suffix = [assistantText(BIG("answer")), userText("recompact")];
      conv.push(...suffix);
      const expectedBytes = Buffer.byteLength(JSON.stringify({ ...oldBody, messages: [...oldBody.messages, ...suffix] }));
      await h.command("recompact");
      const rec = await h.post(conv);
      assert.equal(rec.turnType, "followup-compressed");
      assert.ok(rec.requestBytes > expectedBytes * 1.5, "raw history is much larger than the old prefix ride");
      const expectedAfter = reportUsage
        ? rec.usage.input_tokens + rec.usage.cache_read_input_tokens
        : Math.round(rec.compaction.estimatedTokens * rec.forwardedBytes / expectedBytes);
      const notice = await postHook(h.proxy, displayHook({ session_id: "s-edge" }));
      assert.equal(notice.status, 200);
      const text = stripAnsi(notice.body.hookSpecificOutput.displayContent);
      assert.ok(text.includes(compressedTotalsText(rec.compaction.estimatedTokens, expectedAfter)), text);
      assert.equal(rec.compaction.estimatedBytes, expectedBytes);
    } finally { h.close(); }
  });
}


for (const reportUsage of [true, false]) {
  test(`human output reservation ${reportUsage ? "forces with calibrated usage" : "does not force from bytes alone"}`, async () => {
    const h = await edgeHarness({ budget: 160_000, upstreamOptions: { reportUsage } });
    try {
      const conv = [userText("q"), assistantText("a"), userText("")];
      const shape = { model: "claude-x", max_tokens: 64, system: [{ type: "text", text: "sys", cache_control: EPH }], messages: conv };
      const padding = 600_268 - Buffer.byteLength(JSON.stringify(shape));
      conv.at(-1).content[0].text = "x".repeat(padding);
      const warm = await h.post(conv);
      assert.equal(warm.requestBytes, 600_268);
      assert.equal(warm.turnType, "followup-noop");
      if (reportUsage) assert.equal(warm.usage.input_tokens + warm.usage.cache_read_input_tokens, 150_067);
      // The larger output reservation adds three bytes. Keep total request
      // bytes unchanged so the calibrated next input estimate is exact.
      conv.at(-1).content[0].text = "x".repeat(padding - 3);
      const rec = await h.post(conv, {}, { max_tokens: 64_000 });
      assert.equal(rec.requestBytes, 600_268);
      assert.equal(rec.compaction.estimatedTokens, 150_067);
      assert.equal(rec.compaction.sizeSource, reportUsage ? "reported" : "bytes");
      assert.ok(150_067 < 160_000 && 150_067 + 64_000 > 200_000);
      const call = h.compressCalls().at(-1);
      assert.equal(h.compressCalls().length, 2);
      assert.equal(call.compression_target_tokens, 80_000);
      assert.equal(call.compression_threshold_tokens, reportUsage ? undefined : 160_000);
      assert.equal(rec.turnType, reportUsage ? "followup-compressed" : "followup-noop");
      if (reportUsage) assert.ok(rec.forwardedBytes / 4 + 64_000 < 200_000);
    } finally { h.close(); }
  });
}

for (const mode of ["compress", "failure", "uncalibrated"]) {
  test(`human prefix output reservation: ${mode}`, async () => {
    const h = await edgeHarness({ budget: 160_000, upstreamOptions: { bytesPerToken: 2, reportUsage: mode !== "uncalibrated" } });
    try {
      const conv = [userText("q"), assistantText("a"), userText("x".repeat(350_000))];
      await h.post(conv);
      await h.command("/memtree-compact");
      conv.push(assistantText("a"), userText("compact"));
      assert.equal((await h.post(conv)).turnType, "followup-compressed");
      const calls = h.compressCalls().length;
      if (mode === "failure") {
        h.memtreeSrv.server.closeAllConnections();
        h.memtreeSrv.close();
      }
      conv.push(assistantText("a"), userText("y".repeat(290_000)));
      const rec = await h.post(conv, {}, { max_tokens: 64_000 });
      assert.ok(rec.compaction.estimatedBytes / 4 + 64_000 < 200_000, "transport estimate fits");
      if (mode === "uncalibrated") {
        assert.equal(rec.compaction.sizeSource, "bytes");
        assert.equal(rec.turnType, "followup-prefix");
        assert.equal(h.compressCalls().length, calls, "bytes alone do not force");
      } else {
        assert.equal(rec.compaction.sizeSource, "reported");
        assert.ok(rec.compaction.estimatedTokens < 160_000);
        assert.ok(rec.compaction.estimatedTokens + 64_000 > 200_000);
        if (mode === "failure") {
          assert.equal(rec.compress.ok, false, "attempted compression");
          assert.equal(rec.turnType, "followup-degraded");
          assert.equal(rec.forwardedBytes, rec.requestBytes, "unsafe prefix is not retained as fallback");
          assert.deepEqual(h.upstream.bodies.at(-1).messages, conv);
        } else {
          assert.equal(h.compressCalls().length, calls + 1);
          assert.equal(h.compressCalls().at(-1).compression_threshold_tokens, undefined);
          assert.equal(rec.turnType, "followup-compressed");
          assert.ok(rec.forwardedBytes / 2 + 64_000 < 200_000);
        }
      }
    } finally { h.close(); }
  });
}

for (const mode of ["compress", "failure", "backoff", "uncalibrated"]) {
  test(`tool prefix output reservation: ${mode}`, async () => {
    const h = await edgeHarness({ budget: 160_000, upstreamOptions: { bytesPerToken: 2, reportUsage: mode !== "uncalibrated" } });
    try {
      const conv = [userText("q"), assistantText("a"), userText("x".repeat(350_000))];
      await h.post(conv);
      await h.command("/memtree-compact");
      conv.push(assistantText("a"), userText("compact"));
      assert.equal((await h.post(conv)).turnType, "followup-compressed");
      const calls = h.compressCalls().length;
      if (mode === "failure" || mode === "backoff") {
        h.memtreeSrv.server.closeAllConnections();
        h.memtreeSrv.close();
      }
      toolStep(conv, "dense", 290_000);
      let rec = await h.post(conv, {}, { max_tokens: 64_000 });
      assert.ok(rec.compaction.estimatedBytes / 4 + 64_000 < 200_000, "bytes estimate fits");
      if (mode === "uncalibrated") {
        assert.equal(rec.compaction.sizeSource, "bytes");
        assert.equal(h.compressCalls().length, calls, "uncalibrated estimate never forces");
        assert.match(rec.turnType, /^tool-(memory|prefix)$/);
      } else {
        assert.equal(rec.compaction.sizeSource, "reported");
        assert.ok(rec.compaction.estimatedTokens < 160_000);
        assert.ok(rec.compaction.estimatedTokens + 64_000 > 200_000);
        if (mode === "compress") {
          assert.equal(h.compressCalls().length, calls + 1);
          assert.equal(h.compressCalls().at(-1).compression_threshold_tokens, undefined);
          assert.equal(rec.routeRecovery.outcome, "compressed");
          assert.ok(rec.forwardedBytes / 2 + 64_000 < 200_000);
        } else {
          assert.equal(rec.compress.ok, false);
          assert.deepEqual(h.upstream.bodies.at(-1).messages, conv);
          if (mode === "backoff") {
            toolStep(conv, "next", 10);
            const original = JSON.stringify({ model: "claude-x", max_tokens: 64_000,
              system: [{ type: "text", text: "sys", cache_control: EPH }], messages: conv }, null, 2);
            const count = messageRecords(h.records).length;
            const res = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
              method: "POST", headers: { "content-type": "application/json", "x-claude-code-session-id": "s-edge" }, body: original,
            });
            await res.json();
            await waitFor(() => messageRecords(h.records).length > count);
            rec = messageRecords(h.records).at(-1);
            assert.equal(rec.routeRecovery.outcome, "backoff");
            assert.equal(rec.turnType, "tool");
            assert.equal(h.upstream.rawBodies.at(-1), original, "backoff clears unsafe caller ride and preserves original bytes");
          }
        }
      }
    } finally { h.close(); }
  });
}


test("concurrent session pages and late completions are ordered within each session, even with links off", async () => {
  const upstream = await mockUpstream();
  const pending = new Map();
  const memtreeSrv = await listenMemtree((req, res) => {
    req.on("end", () => {
      const session = req.headers["x-claude-code-session-id"];
      const queue = pending.get(session) ?? [];
      queue.push((id) => {
        res.writeHead(200, { "content-type": "application/json", ...pageHeaders(`https://app.polychat.co/m/${id}`, id) });
        res.end(JSON.stringify(compressedOnce));
      });
      pending.set(session, queue);
    });
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    memtreeLinkPlacement: "off",
  });
  const get = (session) => fetch(`http://127.0.0.1:${proxy.port}/memtree/current?session=${session}`);
  const waitFor = async (session, count) => {
    for (let n = 0; n < 500 && (pending.get(session)?.length ?? 0) < count; n++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(pending.get(session)?.length, count);
  };
  const requests = [];
  try {
    const launch = async (session, prompt, count) => {
      await postHook(proxy, { hook_event_name: "UserPromptSubmit", session_id: session, prompt, prompt_id: prompt });
      const request = postMessages(proxy.port, followupTurn(prompt), { "x-claude-code-session-id": session });
      requests.push(request);
      await waitFor(session, count);
    };
    await launch("a", "a old", 1);
    await launch("b", "b new", 1);
    await launch("a", "a new", 2);
    pending.get("b")[0]("bbbb22");
    await requests[1];
    pending.get("a")[1]("aaaa22");
    await requests[2];
    pending.get("a")[0]("aaaa11");
    await requests[0];
    assert.equal((await (await get("a")).json()).id, "aaaa22", "old A cannot replace newer A");
    assert.equal((await (await get("b")).json()).id, "bbbb22", "A cannot replace concurrent B");
    await postHook(proxy, { hook_event_name: "SessionStart", source: "clear", session_id: "c" });
    assert.equal((await get("c")).status, 404);
    assert.equal((await (await get("a")).json()).id, "aaaa22");
    await postHook(proxy, { hook_event_name: "SessionStart", source: "resume", session_id: "b" });
    assert.equal((await (await get("b")).json()).id, "bbbb22");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});
