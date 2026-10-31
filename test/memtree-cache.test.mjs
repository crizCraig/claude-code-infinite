import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { INDEX_MIN_NEW_CHARS, MemtreeClient, isDroppedConnection, messagesTextChars, withFinalReply }
  from "../dist/memtree.js";
import { startProxy } from "../dist/proxy.js";

const MESSAGES = [{ role: "user", content: "same conversation" }];
const HASH = MemtreeClient.hashMessages(MESSAGES);
const RESULT = {
  messages: [{ role: "user", content: "compressed conversation" }],
  compressed: true,
};

test("unknown server budget keeps absent and differing client hints separate", async () => {
  const fixture = await memtreeFixture({ hold: true });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const compress = (tokens) => client.compress(HASH, MESSAGES, 200_000, undefined,
      tokens === undefined ? {} : { clientInputTokens: tokens });
    const absent = compress(undefined);
    const low = compress(90_000);
    const high = compress(210_000);
    fixture.release();
    await Promise.all([absent, low, high]);
    assert.notStrictEqual(absent, low);
    assert.notStrictEqual(low, high);
    assert.strictEqual(compress(210_000), high);
    assert.equal(fixture.calls.length, 3);
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("concurrent fresh-proxy followup sends a newly counted hint before budget discovery", async () => {
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const counts = [];
  const forwards = [];
  const compressions = [];
  const serve = async (handler) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => handler(req, res, JSON.parse(raw)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
  };
  const upstream = await serve((req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.url.includes("count_tokens")) {
      counts.push(body);
      const original = JSON.stringify(body).includes("x".repeat(1000));
      res.end(counts.length === 1 ? "{broken" : JSON.stringify({
        input_tokens: original ? 210_000 : 2_000,
      }));
    } else {
      forwards.push(body);
      res.end(JSON.stringify({ type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 2_000, output_tokens: 1 } }));
    }
  });
  const memory = await serve(async (_req, res, body) => {
    if (!body.index_only) {
      compressions.push(body);
      entered();
      await held;
    }
    const compressed = body.client_input_tokens > 100_000;
    const messages = compressed ? [{ role: "user", content: "memory ".repeat(1000) }]
      : body.messages;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ messages, compressed, model_budget_tokens: 100_000,
      ...(compressed ? { flattened_messages: messages } : {}),
      usage: { prompt_tokens: 210_000, completion_tokens: 2_000 } }));
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memory.origin, apiKey: "mock-key" }),
    upstreamOrigin: upstream.origin, budgetTokensOverride: 100_000, countTokens: true,
  });
  const post = async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json",
        "x-claude-code-session-id": "s", "x-claude-code-agent-id": "a" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages: [
        { role: "user", content: "first" }, { role: "assistant", content: "answer" },
        { role: "user", content: "x".repeat(240_000) },
      ] }),
    });
    await response.text();
    return response.status;
  };
  try {
    const first = post();
    await ready;
    const second = post();
    const deadline = Date.now() + 2_000;
    while (compressions.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    release();
    assert.deepEqual(await Promise.all([first, second]), [200, 200]);
    assert.deepEqual(compressions.map(body => body.client_input_tokens), [undefined, 210_000]);
    assert.equal(forwards.length, 2);
  } finally {
    release();
    proxy.close();
    for (const { server } of [upstream, memory]) {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("compression cache varies by model, tools, and context limit", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const base = { model: "model-a", tools: [{ name: "tool-a" }] };

    await client.compress(HASH, MESSAGES, 100, undefined, base);
    await client.compress(HASH, MESSAGES, 100, undefined, {
      ...base,
      model: "model-b",
    });
    await client.compress(HASH, MESSAGES, 100, undefined, {
      ...base,
      tools: [{ name: "tool-b" }],
    });
    await client.compress(HASH, MESSAGES, 101, undefined, base);

    assert.equal(fixture.calls.length, 4);
    assert.deepEqual(
      fixture.calls.map(({ model, tools, model_context_limit: limit }) => ({
        model,
        tools,
        limit,
      })),
      [
        { model: "model-a", tools: [{ name: "tool-a" }], limit: 100 },
        { model: "model-b", tools: [{ name: "tool-a" }], limit: 100 },
        { model: "model-a", tools: [{ name: "tool-b" }], limit: 100 },
        { model: "model-a", tools: [{ name: "tool-a" }], limit: 101 },
      ]
    );
  } finally {
    await fixture.close();
  }
});

test("exact complete compression requests share in-flight and settled results", async () => {
  const fixture = await memtreeFixture({ hold: true });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const meta = { model: "model-a", tools: [{ name: "tool-a" }] };
    const first = client.compress(HASH, MESSAGES, 100, undefined, meta);
    const second = client.compress(HASH, MESSAGES, 100, undefined, {
      model: "model-a",
      tools: [{ name: "tool-a" }],
    });

    assert.strictEqual(first, second);
    fixture.release();
    const result = await first;
    assert.deepEqual(result?.messages, RESULT.messages);
    assert.equal(fixture.calls.length, 1);
    const settled = client.compress(HASH, MESSAGES, 100, undefined, meta);
    assert.strictEqual(settled, first);
    assert.strictEqual(await settled, result);
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("cache and failure health lookups use the complete request key", async () => {
  const fixture = await memtreeFixture({ status: 400 });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const base = { model: "model-a", tools: [{ name: "tool-a" }] };
    const changed = { model: "model-b", tools: [{ name: "tool-a" }] };

    const pending = client.compress(HASH, MESSAGES, 100, undefined, base);
    assert.equal(client.hasCachedCompress(HASH, 100, base), true);
    assert.equal(client.hasCachedCompress(HASH, 100, changed), false);
    assert.equal(client.hasCachedCompress(HASH, 101, base), false);
    assert.equal(await pending, null);

    assert.equal(client.lastCompressFailureArming(HASH, 100, base), false);
    assert.equal(client.lastCompressFailureArming(HASH, 100, changed), true);
    assert.equal(client.lastCompressFailureArming(HASH, 101, base), true);
    assert.equal(fixture.calls.length, 1);
  } finally {
    await fixture.close();
  }
});

async function memtreeFixture({ hold = false, status = 200, result = () => RESULT } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(body);
      if (hold) await gate;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify(result(body)) : "bad request");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    origin: `http://127.0.0.1:${server.address().port}`,
    release,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("each distinct size hint is its own compress answer; identical retries deduplicate", async () => {
  // The server calibrates its chars-per-token from the numeric hint (Codex
  // round 3), so even two hints on the same side of the threshold can change
  // its verdict; only a retry with the same hint may reuse an answer.
  const fixture = await memtreeFixture({ hold: true, result: body => ({
    ...RESULT, compressed: body.client_input_tokens > 800_000,
  }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const meta = { compressionTargetTokens: 400_000, compressionThresholdTokens: 800_000 };
    const compress = tokens => client.compress(HASH, MESSAGES, 1_000_000, undefined, {
      ...meta, ...(tokens === undefined ? {} : { clientInputTokens: tokens }),
    });
    const unhinted = compress(undefined);
    assert.strictEqual(compress(undefined), unhinted);
    const below = compress(799_999);
    assert.notStrictEqual(below, unhinted, "a hint is not interchangeable with none");
    assert.strictEqual(compress(799_999), below, "the same hint dedups");
    const above = compress(800_001);
    assert.notStrictEqual(above, below, "cannot reuse an under-budget passthrough");
    const otherAbove = compress(904_036);
    assert.notStrictEqual(otherAbove, above, "a different over-budget hint asks again");
    fixture.release();
    await Promise.all([unhinted, otherAbove]);
    assert.equal((await below).compressed, false);
    assert.equal((await above).compressed, true);
    assert.strictEqual(compress(800_001), above, "settled same-hint retry dedups too");
    assert.equal(fixture.calls.length, 4);
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("projected hints of 500k and 850k for the same messages are two compress calls", async () => {
  const fixture = await memtreeFixture({ result: () => ({ messages: MESSAGES, compressed: false }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const meta = (tokens) => ({ sessionId: "s", model: "claude-opus-5-5",
      compressionTargetTokens: 400_000, compressionThresholdTokens: 900_000,
      clientInputTokens: tokens });
    await client.compress(HASH, MESSAGES, 1_000_000, undefined, meta(500_000));
    await client.compress(HASH, MESSAGES, 1_000_000, undefined, meta(850_000));
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(fixture.calls.map(c => c.client_input_tokens), [500_000, 850_000]);
  } finally { await fixture.close(); }
});


test("identical conversations in different sessions do not share compression responses", async () => {
  const fixture = await memtreeFixture({ hold: true });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const a = client.compress(HASH, MESSAGES, 100, undefined, { sessionId: "a" });
    const b = client.compress(HASH, MESSAGES, 100, undefined, { sessionId: "b" });
    assert.notStrictEqual(a, b);
    fixture.release();
    await Promise.all([a, b]);
    assert.equal(fixture.calls.length, 2);
    assert.strictEqual(client.compress(HASH, MESSAGES, 100, undefined, { sessionId: "a" }), a);
    assert.strictEqual(client.compress(HASH, MESSAGES, 100, undefined, { sessionId: "b" }), b);
  } finally {
    fixture.release();
    await fixture.close();
  }
});


test("the final index sends the session's conversation plus its last reply, once, when idle or at exit", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const reply = { role: "assistant", content: [{ type: "text", text: "PR #42 opened" }] };
    let reads = 0;
    const readReply = () => (reads++, reply);
    const turn = [{ role: "user", content: "open the PR" }];

    client.scheduleFinalIndex("s1", readReply, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fixture.calls.length, 0, "no main conversation recorded: nothing to finalize");

    client.noteMainConversation("s1", { messages: turn, modelContextLimit: 100 });
    client.scheduleFinalIndex("s1", readReply, 5);
    client.noteMainConversation("s1", { messages: turn, modelContextLimit: 100 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fixture.calls.length, 0, "a new request cancels the pending final index");
    assert.equal(reads, 0, "the transcript is read only when the call goes out");

    client.scheduleFinalIndex("s1", readReply, 1);
    await new Promise((r) => setTimeout(r, 20));
    await client.drainBackground(1_000);
    assert.equal(fixture.calls.length, 1, "idle: the final index went out");
    const [call] = fixture.calls;
    assert.equal(call.index_only, true);
    assert.equal(call.final_index, true);
    assert.deepEqual(call.messages.at(-1), reply, "the reply no per-request call carries");
    assert.equal(call.messages.length, 2);
  } finally {
    await fixture.close();
  }
});

test("the final index goes out at exit and is not repeated for the same conversation", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const reply = { role: "assistant", content: [{ type: "text", text: "done" }] };
    client.noteMainConversation("s2", { messages: [{ role: "user", content: "go" }], modelContextLimit: 100 });
    client.scheduleFinalIndex("s2", () => reply, 60_000);
    client.flushFinalIndexes();
    client.scheduleFinalIndex("s2", () => reply, 60_000);
    client.flushFinalIndexes();
    assert.equal(await client.drainBackground(1_000), true);
    assert.equal(fixture.calls.length, 1, "same conversation and reply: sent once");
    client.scheduleFinalIndex("s2", () => reply, 1);
    assert.equal(fixture.calls.length, 1, "draining: no new final index");
  } finally {
    await fixture.close();
  }
});

test("exit sends the final index for a session that never had a Stop (-p, no hooks)", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const reply = { role: "assistant", content: [{ type: "text", text: "print-mode answer" }] };
    client.noteMainConversation("p1", {
      messages: [{ role: "user", content: "one-shot prompt" }], modelContextLimit: 100,
      readReply: () => reply,
    });
    client.flushFinalIndexes();
    assert.equal(await client.drainBackground(1_000), true);
    assert.equal(fixture.calls.length, 1, "exit finalizes the session without a Stop hook");
    assert.equal(fixture.calls[0].final_index, true);
    assert.deepEqual(fixture.calls[0].messages.at(-1), reply);
  } finally {
    await fixture.close();
  }
});

test("final indexes at exit stay inside the 2 s drain and never throw (memtree-bench runs -p)", async () => {
  const hung = await memtreeFixture({ hold: true });
  try {
    const client = new MemtreeClient({ baseUrl: hung.origin, apiKey: "k" });
    client.noteMainConversation("p2", {
      messages: [{ role: "user", content: "bench arm" }], modelContextLimit: 100,
      readReply: () => { throw new Error("transcript unreadable"); },
    });
    assert.doesNotThrow(() => client.flushFinalIndexes(), "a bad transcript never breaks exit");
    const started = Date.now();
    assert.equal(await client.drainBackground(2_000), false, "a hung server is aborted");
    assert.ok(Date.now() - started < 2_500, `drain took ${Date.now() - started} ms`);
    assert.equal(hung.calls.length, 1, "sent without a reply when the transcript fails");
  } finally {
    hung.release();
    await hung.close();
  }
  const failing = await memtreeFixture({ status: 500 });
  try {
    const client = new MemtreeClient({ baseUrl: failing.origin, apiKey: "k" });
    for (const id of ["s1", "s2", "s3", "s4"]) {
      client.noteMainConversation(id, { messages: [{ role: "user", content: id }], modelContextLimit: 100 });
    }
    client.flushFinalIndexes();
    assert.equal(await client.drainBackground(2_000), true, "a 500 is logged and ignored");
    assert.deepEqual(failing.calls.map((c) => c.messages[0].content).sort(), ["s2", "s3", "s4"],
      "only the most recent sessions are finalized at exit");
  } finally {
    await failing.close();
  }
});

test("withFinalReply appends only a reply the conversation does not end with", () => {
  const user = [{ role: "user", content: "q" }];
  const reply = { role: "assistant", content: [{ type: "text", text: "a" }] };
  assert.deepEqual(withFinalReply(user, reply), [...user, reply]);
  assert.equal(withFinalReply(user, undefined), user);
  const answered = [...user, reply];
  assert.equal(withFinalReply(answered, reply), answered);
});

test("background indexing deduplicates within each session only", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    client.indexInBackground(HASH, MESSAGES, 100, "a");
    client.indexInBackground(HASH, MESSAGES, 100, "b");
    client.indexInBackground(HASH, MESSAGES, 100, "a");
    assert.equal(await client.drainBackground(), true);
    assert.equal(fixture.calls.length, 2);
    assert.ok(fixture.calls.every((call) => call.index_only));
  } finally {
    await fixture.close();
  }
});

test("exit caps pending Stop sessions too and chooses the newest three", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      client.noteMainConversation(id, { messages: [{ role: "user", content: id }], modelContextLimit: 100 });
      client.scheduleFinalIndex(id, () => undefined);
    }
    client.flushFinalIndexes();
    await client.drainBackground(1_000);
    assert.deepEqual(fixture.calls.map(c => c.messages[0].content).sort(), ["s3", "s4", "s5"]);
  } finally { await fixture.close(); }
});

test("final preparation yields and shares the exit upload deadline", async () => {
  const fixture = await memtreeFixture();
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    let read = false;
    client.noteMainConversation("s", {
      messages: MESSAGES, modelContextLimit: 100,
      readReply: () => { read = true; return new Promise(() => {}); },
    });
    const started = Date.now();
    client.flushFinalIndexes(50);
    assert.equal(read, false, "preparation must yield before reading the transcript");
    assert.equal(await client.drainBackground(1_000), false);
    assert.ok(Date.now() - started < 300, "one deadline includes preparation");
    assert.equal(fixture.calls.length, 0, "no upload after the deadline");
  } finally { await fixture.close(); }
});

test("count provenance is part of compress identity: exact and projected hints never share an answer", async () => {
  // Codex round 2: the server loosens its ratio only for an exact count, so an
  // exact hint's passthrough is not a valid answer for the same projected hint.
  const passthrough = { messages: MESSAGES, compressed: false };
  const meta = (exact) => ({ sessionId: "s", model: "claude-opus-5-5",
    compressionTargetTokens: 400_000, compressionThresholdTokens: 900_000,
    clientInputTokens: 550_000, ...(exact ? { clientInputTokensExact: true } : {}) });
  const cached = await memtreeFixture({ result: () => passthrough });
  try {
    const client = new MemtreeClient({ baseUrl: cached.origin, apiKey: "k" });
    await client.compress(HASH, MESSAGES, 1_000_000, undefined, meta(true));
    await client.compress(HASH, MESSAGES, 1_000_000, undefined, meta(false));
    assert.equal(cached.calls.length, 2, "the completed exact answer is not reused");
    assert.equal(cached.calls[0].client_input_tokens_exact, true);
    assert.equal(cached.calls[1].client_input_tokens_exact, undefined);
  } finally { await cached.close(); }

  const held = await memtreeFixture({ hold: true, result: () => passthrough });
  try {
    const client = new MemtreeClient({ baseUrl: held.origin, apiKey: "k" });
    const exact = client.compress(HASH, MESSAGES, 1_000_000, undefined, meta(true));
    const projected = client.compress(HASH, MESSAGES, 1_000_000, undefined, meta(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    held.release();
    await Promise.all([exact, projected]);
    assert.equal(held.calls.length, 2, "a projected hint does not join an exact one in flight");
  } finally {
    held.release();
    await held.close();
  }
});

test("background indexing keeps one call in flight per conversation; the newest waits", async () => {
  // Long-session test, staging: every tool round sent the whole 25 MB history as its own
  // index call, up to 16 at once (424 MB) while a compress of the same history timed out.
  const fixture = await memtreeFixture({ hold: true, result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k", indexMinNewChars: 0 });
    // As the proxy sends them: the system prompt first (its billing line changes per call).
    const history = (n, first = "task", system = "sys 1") => [{ role: "system", content: system },
      ...Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i ? `turn ${i}` : first }))];
    const send = (session, messages) => client.indexInBackground(
      MemtreeClient.hashMessages(messages), messages, 100, session);
    send("a", history(3));
    send("a", history(5, "task", "sys 2"));
    send("a", history(7));
    send("a", history(9, "task", "sys 3"));
    send("b", history(3));
    send("a", history(2, "a subagent's task"));
    await waitFor(() => fixture.calls.length === 3);
    const lengths = () => fixture.calls.map((c) => c.messages.length);
    assert.deepEqual(lengths().slice().sort(), [3, 4, 4],
      "one per conversation, whatever the system prompt: the first of each, the rest wait");
    fixture.release();
    await waitFor(() => fixture.calls.length === 4);
    assert.equal(lengths()[3], 10, "only the newest of the waiting ones (9 turns and the system prompt)");
    assert.equal(await client.drainBackground(5_000), true);
    assert.equal(fixture.calls.length, 4);
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("a waiting index call another branch does not extend is sent, not dropped", async () => {
  const fixture = await memtreeFixture({ hold: true, result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k", indexMinNewChars: 0 });
    const branch = (n, tag) => Array.from({ length: n }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", content: i < 3 ? `turn ${i}` : `${tag} ${i}` }));
    for (const messages of [branch(3, "x"), branch(6, "x"), branch(8, "y")]) {
      client.indexInBackground(MemtreeClient.hashMessages(messages), messages, 100, "a");
    }
    await waitFor(() => fixture.calls.length === 2);
    assert.deepEqual(fixture.calls.map((c) => c.messages.at(-1).content).sort(), ["turn 2", "x 5"],
      "the rewound branch y does not contain x's newest turn, so x's waiting call goes now");
    fixture.release();
    await waitFor(() => fixture.calls.length === 3);
    assert.equal(fixture.calls[2].messages.at(-1).content, "y 7");
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("branches that end alike are not one history: the waiting one is still sent", async () => {
  const fixture = await memtreeFixture({ hold: true, result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const branch = (n, tag) => Array.from({ length: n }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", content: i === 0 ? "task" : i === 5 ? "Continue" : `${tag} ${i}` }));
    for (const messages of [branch(3, "a"), branch(6, "b"), branch(8, "c")]) {
      client.indexInBackground(MemtreeClient.hashMessages(messages), messages, 100, "s");
    }
    await waitFor(() => fixture.calls.length === 2);
    fixture.release();
    await waitFor(() => fixture.calls.length === 3);
    assert.deepEqual(fixture.calls.map((c) => c.messages[1].content).sort(), ["a 1", "b 1", "c 1"]);
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("at shutdown a waiting call the final index does not contain (a rewind) is still sent", async () => {
  const fixture = await memtreeFixture({ hold: true, result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const branch = (n, tag) => Array.from({ length: n }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", content: i < 2 ? `turn ${i}` : `${tag} ${i}` }));
    for (const messages of [branch(3, "a"), branch(6, "b")]) {
      client.indexInBackground(MemtreeClient.hashMessages(messages), messages, 100, "s");
    }
    await waitFor(() => fixture.calls.length === 1);
    client.noteMainConversation("s", { messages: branch(5, "c"), modelContextLimit: 100 });
    client.flushFinalIndexes(5_000);
    const drained = client.drainBackground(5_000);
    await waitFor(() => fixture.calls.length === 3);
    fixture.release();
    assert.equal(await drained, true);
    assert.deepEqual(fixture.calls.map((c) => `${c.messages.at(-1).content}${c.final_index ? ":final" : ""}`).sort(),
      ["a 2", "b 5", "c 4:final"]);
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("at shutdown a waiting index call is sent inside the drain unless the final index carries it", async () => {
  const fixture = await memtreeFixture({ hold: true, result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k", indexMinNewChars: 0 });
    const history = (n, first) => Array.from({ length: n }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", content: i ? `turn ${i}` : first }));
    const send = (messages) => client.indexInBackground(
      MemtreeClient.hashMessages(messages), messages, 100, "s");
    send(history(3, "main"));
    send(history(5, "main"));
    send(history(3, "subagent"));
    send(history(5, "subagent"));
    await waitFor(() => fixture.calls.length === 2);
    client.noteMainConversation("s", { messages: history(6, "main"), modelContextLimit: 100 });
    client.flushFinalIndexes(5_000);
    const drained = client.drainBackground(5_000);
    await waitFor(() => fixture.calls.length === 4);
    fixture.release();
    assert.equal(await drained, true);
    const sent = fixture.calls.map((c) => `${c.messages[0].content}:${c.messages.length}${c.final_index ? ":final" : ""}`);
    assert.deepEqual(sent.slice().sort(), ["main:3", "main:6:final", "subagent:3", "subagent:5"],
      "the subagent's newest history goes; the main one's is the final index");
  } finally {
    fixture.release();
    await fixture.close();
  }
});

test("an index upload waits until its history has gained the server's index minimum of new text", async () => {
  // 2026-10-30, a 23 MB session: every main-lane tool turn uploaded the whole history to
  // index; 3 in 4 only got an ack (under the server's 10k-token minimum), ~1 GB per 40 min.
  const fixture = await memtreeFixture({ result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const conv = [{ role: "user", content: "task" }];
    const turn = (chars) => {
      conv.push({ role: "assistant", content: "next" }, { role: "user", content: "y".repeat(chars) });
      const messages = conv.slice();
      client.indexInBackground(MemtreeClient.hashMessages(messages), messages, 100, "s");
    };
    turn(50_000);
    await waitFor(() => fixture.calls.length === 1);
    const step = Math.floor(INDEX_MIN_NEW_CHARS / 4);
    for (let i = 0; i < 3; i++) turn(step); // 3/4 of the minimum: none sent
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.calls.length, 1, "under the minimum of new text: not uploaded");
    turn(step + 10); // past it: the whole history goes
    await waitFor(() => fixture.calls.length === 2);
    assert.equal(fixture.calls[1].messages.length, conv.length);
    // A history that does not extend the last one (a rewind) is sent at once.
    const rewound = [{ role: "user", content: "task" }, { role: "assistant", content: "other" },
      { role: "user", content: "z" }];
    client.indexInBackground(MemtreeClient.hashMessages(rewound), rewound, 100, "s");
    await waitFor(() => fixture.calls.length === 3);
    // A forced call (a subagent's one index at its end) goes whatever its size.
    const tail = [...rewound, { role: "assistant", content: "a" }, { role: "user", content: "b" }];
    client.indexInBackground(MemtreeClient.hashMessages(tail), tail, 100, "s", undefined,
      undefined, { force: true });
    await waitFor(() => fixture.calls.length === 4);
    assert.equal(await client.drainBackground(2_000), true);
  } finally {
    await fixture.close();
  }
});

test("an image is never held back by the text minimum (Claude Code may evict it later)", async () => {
  const fixture = await memtreeFixture({ result: () => ({ messages: [], index_only: true }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const conv = [{ role: "user", content: "x".repeat(50_000) }];
    const send = () => {
      const messages = conv.slice();
      client.indexInBackground(MemtreeClient.hashMessages(messages), messages, 100, "s");
    };
    send();
    await waitFor(() => fixture.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    conv.push({ role: "assistant", content: "shot" }, { role: "user", content: [
      { type: "tool_result", tool_use_id: "t", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }] }] });
    send();
    await waitFor(() => fixture.calls.length === 2);
    assert.equal(await client.drainBackground(2_000), true);
  } finally {
    await fixture.close();
  }
});

test("a failed upload is never the baseline, even with branches failing in flight together", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).messages.length);
      const ok = calls.length > 3;
      setTimeout(() => {
        if (!ok) { res.writeHead(500); return res.end("boom"); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messages: [], index_only: true }));
      }, ok ? 0 : 80);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "k" });
    const root = { role: "user", content: "x".repeat(40_000) };
    const send = (messages) => client.indexInBackground(MemtreeClient.hashMessages(messages),
      messages, 100, "s");
    const a = [root, { role: "assistant", content: "a".repeat(40_000) }];
    send(a); // in flight, fails
    send([root, { role: "assistant", content: "b".repeat(40_000) }]); // waits
    send([root, { role: "assistant", content: "c".repeat(40_000) }]); // b goes beside a; both fail
    await waitFor(() => calls.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    send([...a, { role: "user", content: "small" }]); // a never arrived: sent
    await waitFor(() => calls.length === 4);
    assert.equal(await client.drainBackground(2_000), true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a 401 answered before a streamed upload ended still reads as an invalid key", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Invalid API key" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "revoked" });
    const big = [{ role: "user", content: "x".repeat(25_000_000) }];
    assert.equal(await client.compress(MemtreeClient.hashMessages(big), big, 1_000_000,
      undefined, {}), null);
    assert.equal(client.keyInvalid, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("text size counts text, tool inputs and results, not images", () => {
  assert.equal(messagesTextChars([
    { role: "user", content: "abc" },
    { role: "assistant", content: [{ type: "text", text: "de" }, { type: "thinking", thinking: "f" },
      { type: "tool_use", id: "t", name: "Read", input: { p: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [
      { type: "text", text: "gh" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(999) } }] }] },
  ]), 3 + 2 + 1 + JSON.stringify({ p: 1 }).length + 2);
});

test("a compress whose upload dropped is sent once more; never once its body was sent", async () => {
  // 2026-10-28: a Wi-Fi switch cut a 24 MB compress upload (EHOSTUNREACH after 89 s, ~1 MB
  // sent). A drop after the whole body went may be MemTree already compressing (and billing)
  // it: no second call then.
  let mode = "mid-upload", compressCalls = 0, indexCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    if (mode === "mid-upload" && compressCalls === 0) {
      // Read nothing: the socket buffers fill and the client still holds most of the body
      // (it is larger than any kernel's buffers), then the connection drops.
      compressCalls++;
      req.pause();
      setTimeout(() => req.socket.destroy(), 200);
      return;
    }
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.index_only) {
        indexCalls++;
        return req.socket.destroy();
      }
      compressCalls++;
      if (mode === "after-body") return req.socket.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(RESULT));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "k" });
    // Over 1 MB, so it is streamed, and far over socket buffers: the drop lands before its end.
    const big = [{ role: "user", content: "x".repeat(25_000_000) }];
    const result = await client.compress(MemtreeClient.hashMessages(big), big, 1_000_000,
      undefined, {});
    assert.ok(result, "answered on the second attempt");
    assert.equal(compressCalls, 2);

    mode = "after-body";
    compressCalls = 0;
    const other = [{ role: "user", content: "y".repeat(3_000_000) }];
    assert.equal(await client.compress(MemtreeClient.hashMessages(other), other, 1_000_000,
      undefined, {}), null);
    assert.equal(compressCalls, 1, "the whole body was sent: not sent again");

    client.indexInBackground(HASH, MESSAGES, 1_000_000, "s");
    assert.equal(await client.drainBackground(2_000), true);
    assert.equal(indexCalls, 1);
    assert.equal(isDroppedConnection(Object.assign(new TypeError("fetch failed"),
      { cause: { code: "EHOSTUNREACH" } })), true);
    assert.equal(isDroppedConnection(new Error("context_memory 500: boom")), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a failed index upload is no baseline; a held-back history can still be forced", async () => {
  let fail = true;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(body.messages.length);
      if (fail) { res.writeHead(500); return res.end("boom"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [], index_only: true }));
    });
  });
  const calls = [];
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new MemtreeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "k" });
    const conv = [{ role: "user", content: "x".repeat(40_000) }];
    const send = (options) => {
      const messages = conv.slice();
      client.indexInBackground(MemtreeClient.hashMessages(messages), messages, 100, "s",
        undefined, undefined, options);
    };
    send();
    await waitFor(() => calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fail = false;
    conv.push({ role: "assistant", content: "a" }, { role: "user", content: "b" });
    send(); // ~2 characters more than the failed upload: sent, since that one never arrived
    await waitFor(() => calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    conv.push({ role: "assistant", content: "c" }, { role: "user", content: "d" });
    send(); // held back: under the minimum over the one that arrived
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls.length, 2);
    send({ force: true }); // the same history, forced (a subagent's end): it goes
    await waitFor(() => calls.length === 3);
    assert.equal(calls[2], conv.length);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function waitFor(check, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
