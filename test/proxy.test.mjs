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

function assertSuccessNotice(text, answer, tokenSummary) {
  const colored = text.startsWith(GREEN);
  assert.ok(
    text.startsWith(
      `${colored ? GREEN : ""}${COMPRESSED_NOTICE} in `
    )
  );
  assert.ok(
    text.endsWith(`${colored ? DEFAULT_FOREGROUND : ""}\n${answer}`)
  );
  if (tokenSummary === undefined) {
    assert.ok(!text.includes(" tokens "), "unknown totals are omitted");
  } else {
    assert.ok(text.includes(tokenSummary));
  }
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

/** Mock MemTree server answering every /v1/context_memory POST the same way. */
async function mockMemtree(status, bodyObj) {
  const calls = [];
  const srv = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      const body = JSON.stringify(bodyObj);
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

test("success notice prefers MemTree raw count over Claude's count", async () => {
  const countBodies = [];
  const compressedUsage = {
    input_tokens: 2,
    cache_read_input_tokens: 64_063,
    cache_creation_input_tokens: 30_529,
    output_tokens: 1,
  };
  const upstreamBody = JSON.stringify({
    ...JSON.parse(UPSTREAM_BODY),
    usage: compressedUsage,
  });
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = upstreamBody;
      if (req.url.startsWith("/v1/messages/count_tokens")) {
        const countBody = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        countBodies.push(countBody);
        const compressed = JSON.stringify(countBody.messages).includes(
          "compressed context"
        );
        body = JSON.stringify({
          input_tokens: compressed ? 94_594 : 330_272,
        });
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      raw_prompt_tokens: 400_000,
      prompt_tokens_details: { cached_tokens: 123 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const common = {
    model: "claude-x",
    system: "system instructions",
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    thinking: { type: "enabled", budget_tokens: 1_024 },
    messages: followupTurn("turn two"),
  };
  try {
    assert.deepEqual(await postCountTokens(proxy.port, common), {
      input_tokens: 330_272,
    });
    await armMainTurn(proxy, "turn two");
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...common, max_tokens: 64 }),
    });
    assert.equal(await response.text(), upstreamBody);
    assert.equal(countBodies.length, 1, "ccc reuses Claude's own count request");

    const hook = await postHook(proxy, displayHook());
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "upstream answer",
      "~400k → 94.6k tokens"
    );
    assert.ok(
      !hook.body.hookSpecificOutput.displayContent.includes("330.3k"),
      "the server-reported original count is primary"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("a count finishing after compression is still available at display time", async () => {
  let markCountStarted;
  let releaseCount;
  const countStarted = new Promise((resolve) => {
    markCountStarted = resolve;
  });
  const countGate = new Promise((resolve) => {
    releaseCount = resolve;
  });
  const upstreamBody = JSON.stringify({
    ...JSON.parse(UPSTREAM_BODY),
    usage: { input_tokens: 94_594, output_tokens: 1 },
  });
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url.startsWith("/v1/messages/count_tokens")) {
        markCountStarted();
        void countGate.then(() => {
          const body = JSON.stringify({ input_tokens: 330_272 });
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          });
          res.end(body);
        });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(upstreamBody)),
      });
      res.end(upstreamBody);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const messages = followupTurn("turn two");
  let countRequest;
  try {
    countRequest = postCountTokens(proxy.port, { model: "claude-x", messages });
    await countStarted;
    await armMainTurn(proxy, "turn two");
    const response = await postMessages(proxy.port, messages);
    assert.equal(response.content[0].text, "upstream answer");

    releaseCount();
    assert.deepEqual(await countRequest, { input_tokens: 330_272 });
    const hook = await postHook(proxy, displayHook());
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "upstream answer",
      "~330.3k → 94.6k tokens"
    );
  } finally {
    releaseCount?.();
    await countRequest?.catch(() => {});
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("compressed SSE uses MemTree raw totals before the stream ends", async () => {
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
      "streamed answer",
      "~330.3k → 94.6k tokens"
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

test("token counts never cross beta-header or query variants", async () => {
  let countCalls = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      const isCount = req.url.startsWith("/v1/messages/count_tokens");
      if (isCount) countCalls++;
      const body = isCount
        ? JSON.stringify({ input_tokens: 330_272 })
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
  const common = {
    model: "claude-x",
    messages: followupTurn("turn two"),
  };
  try {
    await postCountTokens(proxy.port, common, {
      "anthropic-beta": "tokenizer-variant-a",
      "anthropic-version": "2023-06-01",
    });
    await armMainTurn(proxy, "turn two");
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "tokenizer-variant-b",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ ...common, max_tokens: 64 }),
    });
    await response.text();
    const hook = await postHook(proxy, displayHook());
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "upstream answer"
    );
    assert.equal(countCalls, 1, "mismatched count was neither reused nor extended");

    const queryCommon = {
      model: "claude-x",
      messages: followupTurn("turn three"),
    };
    await postCountTokens(
      proxy.port,
      queryCommon,
      {
        "anthropic-beta": "same-variant",
        "anthropic-version": "2023-06-01",
      },
      "?tokenizer=variant-a"
    );
    await armMainTurn(proxy, "turn three");
    const queryResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages?tokenizer=variant-b`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "same-variant",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...queryCommon, max_tokens: 64 }),
      }
    );
    await queryResponse.text();
    const queryHook = await postHook(proxy, displayHook());
    assertSuccessNotice(
      queryHook.body.hookSpecificOutput.displayContent,
      "upstream answer"
    );
    assert.equal(countCalls, 2, "query-mismatched count was not reused");
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("memory route survives A/B being disabled, so count_tokens sizes the compressed context", async () => {
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
  // No abRouting: the route that keeps a human turn's tool loop on the
  // compressed prefix must not be a side effect of the A/B experiment.
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

async function assertFastToolRouteActivation(abRouting, compressed = false) {
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
    abRouting,
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
  await assertFastToolRouteActivation(undefined);
});

test("A/B below-threshold delivery activates the route before a fast tool request", async () => {
  await assertFastToolRouteActivation({
    effectiveContextTokens: () => 1_000_000,
  });
});

test("encoded message_stop activates the route before a fast tool request", async () => {
  await assertFastToolRouteActivation(undefined, true);
});

async function assertRetryAfterFailedDeliverySurvivesInstalledRoute(abRouting) {
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
    abRouting,
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
  await assertRetryAfterFailedDeliverySurvivesInstalledRoute(undefined);
});

test("A/B below-threshold dead-before-flush retry still compresses despite the installed route", async () => {
  await assertRetryAfterFailedDeliverySurvivesInstalledRoute({
    effectiveContextTokens: () => 1_000_000,
  });
});

test("older MemTree response omits totals when Claude count is unavailable", async () => {
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: { prompt_tokens_details: { cached_tokens: 123 } },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const json = await postMessages(proxy.port, followupTurn("turn two"));
    assert.equal(json.content[0].text, "upstream answer");
    const hook = await postHook(proxy, displayHook());
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "upstream answer"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
});

test("MemTree raw prompt count supplies totals without Claude count_tokens", async () => {
  const upstreamBody = JSON.stringify({
    ...JSON.parse(UPSTREAM_BODY),
    usage: { input_tokens: 94_849, output_tokens: 1 },
  });
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(upstreamBody)),
      });
      res.end(upstreamBody);
    });
  });
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
    usage: {
      raw_prompt_tokens: 393_000,
      prompt_tokens_details: { cached_tokens: 123 },
    },
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  try {
    await armMainTurn(proxy, "turn two");
    const json = await postMessages(proxy.port, followupTurn("turn two"));
    assert.equal(json.content[0].text, "upstream answer");

    const hook = await postHook(proxy, displayHook());
    assertSuccessNotice(
      hook.body.hookSpecificOutput.displayContent,
      "upstream answer",
      "~393k → 94.8k tokens"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeSrv.close();
  }
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
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
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
    assert.match(
      // Notice may be ANSI-colored depending on terminal detection; strip codes.
      stop.body.systemMessage.replace(/\x1B\[[0-9;]*m/g, ""),
      /^✓ MemTree · conversation optimized in (?:\d+ms|\d+(?:\.\d+)?s)$/
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
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
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
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
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
