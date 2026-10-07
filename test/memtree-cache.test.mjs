import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MemtreeClient, withFinalReply } from "../dist/memtree.js";

const MESSAGES = [{ role: "user", content: "same conversation" }];
const HASH = MemtreeClient.hashMessages(MESSAGES);
const RESULT = {
  messages: [{ role: "user", content: "compressed conversation" }],
  compressed: true,
};

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

async function memtreeFixture({ hold = false, status = 200 } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (hold) await gate;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify(RESULT) : "bad request");
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
