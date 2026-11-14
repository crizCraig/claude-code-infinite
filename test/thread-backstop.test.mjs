import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { sessionTag } from "../dist/cc-request.js";

// Claude Code 2.1.325 (probed against a mock): a 400 whose error.details.error_code is
// `thread_unsupported_request` makes it resend that turn without `thread` and keep that
// agent and model stateless for the session. ccc answers so whenever `thread` reaches it.

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function harness(proxyOptions = {}) {
  const forwards = [], records = [], memtreeCalls = [];
  const upstream = await listen((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      forwards.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  const memory = await listen((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      memtreeCalls.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: body.messages, compressed: false,
        index_only: body.index_only, usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  const memtree = new MemtreeClient({ baseUrl: memory.origin, apiKey: "mock-secret" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) }, ...proxyOptions });
  async function post(body, { session = "s1", agent } = {}) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": session,
        ...(agent ? { "x-claude-code-agent-id": agent } : {}) },
      body: JSON.stringify({ model: "claude-x", max_tokens: 64, ...body }),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  }
  return { post, forwards, records, memtreeCalls, close() {
    proxy.close();
    for (const { server } of [upstream, memory]) { server.closeAllConnections(); server.close(); }
  } };
}

const CREATE = { thread: { type: "create" },
  messages: [{ role: "user", content: "hello" }], tools: [{ name: "Bash" }] };
const CONTINUE = { thread: { type: "continue", previous_message_id: "msg_1" },
  messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] };

test("a request carrying thread gets ccc's own 400 thread_unsupported_request, not forwarded", async () => {
  const h = await harness();
  try {
    for (const body of [CREATE, CONTINUE]) {
      const res = await h.post(body);
      assert.equal(res.status, 400);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(res.headers.get("x-should-retry"), null, "the probed shape: no retry header");
      const error = JSON.parse(res.body).error;
      // What Claude Code reads (izn): error.details.error_code on a 400.
      assert.equal(error.details.error_code, "thread_unsupported_request");
      // ccc's own error, labelled as such: not one of Anthropic's error types.
      assert.equal(error.type, "thread_unsupported_request");
      assert.equal(error.details.source, "ccc");
      assert.match(error.message, /^ccc /);
      assert.match(error.message, /full requests/);
    }
    assert.equal(h.forwards.length, 0, "nothing reaches Anthropic");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.memtreeCalls.length, 0, "nothing reaches MemTree");
    const messages = h.records.filter((r) => r.kind === "messages");
    assert.deepEqual(messages.map((r) => r.turnType), ["thread-refused", "thread-refused"]);
  } finally { h.close(); }
});

test("the refusal is logged once per session; the stateless resend goes through", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post(CREATE)).status, 400);
    assert.equal((await h.post(CREATE, { agent: "sub" })).status, 400);
    assert.equal((await h.post(CONTINUE)).status, 400);
    assert.equal((await h.post(CREATE, { session: "s2" })).status, 400);
    const { thread: _dropped, ...stateless } = CREATE;
    assert.equal((await h.post(stateless)).status, 200);
    assert.equal(h.forwards.length, 1);
    assert.equal(h.forwards[0].thread, undefined);
    const events = h.records.filter((r) => r.kind === "thread-refused");
    assert.deepEqual(events.map((e) => e.sessionTag), [sessionTag("s1"), sessionTag("s2")]);
    assert.equal(events[0].thread, "create");
    assert.equal(events[0].model, "claude-x");
  } finally { h.close(); }
});

test("messageThreads passthrough forwards a thread request as sent", async () => {
  const h = await harness({ messageThreads: "passthrough" });
  try {
    assert.equal((await h.post(CONTINUE)).status, 200);
    assert.deepEqual(h.forwards[0].thread, CONTINUE.thread);
    assert.equal(h.records.filter((r) => r.kind === "thread-refused").length, 0);
  } finally { h.close(); }
});
