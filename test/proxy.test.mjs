import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  constants as zlibConstants,
  createGzip,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import { startProxy } from "../dist/proxy.js";
import {
  MemtreeClient,
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
  const upstream = await mockUpstream();
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
    assert.equal((await postHook(proxy, displayHook())).status, 204);
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
      stop.body.systemMessage,
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

test("compress forwards model+tools for server budget resolution; index-only omits them", async () => {
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
        model: "claude-fable-5",
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
    assert.equal(compressCall.model, "claude-fable-5");
    assert.equal(compressCall.model_context_limit, 200_000);
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
  // read the header — model-name sniffing alone under-reports 1M as 200k, and
  // the server then clamps a 500k budget down to 200k.
  const upstream = await mockUpstream();
  const memtreeSrv = await mockMemtree(200, {
    messages: [{ role: "user", content: "compressed context" }],
  });
  const memtree = new MemtreeClient({ baseUrl: memtreeSrv.origin, apiKey: "k" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin });
  const post = async (messages) => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07,other-flag",
      },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 64, messages }),
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
    assert.equal(compressCall.model, "claude-fable-5[1m]");
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
