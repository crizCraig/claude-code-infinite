import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MemtreeClient } from "../dist/memtree.js";

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

test("client token threshold crossings replace passthroughs while same-side retries deduplicate", async () => {
  const fixture = await memtreeFixture({ hold: true, result: body => ({
    ...RESULT, compressed: body.client_input_tokens > 800_000,
  }) });
  try {
    const client = new MemtreeClient({ baseUrl: fixture.origin, apiKey: "k" });
    const meta = { compressionTargetTokens: 400_000, compressionThresholdTokens: 800_000 };
    const compress = tokens => client.compress(HASH, MESSAGES, 1_000_000, undefined, {
      ...meta, ...(tokens === undefined ? {} : { clientInputTokens: tokens }),
    });
    const below = compress(undefined);
    assert.strictEqual(compress(799_999), below);
    assert.strictEqual(compress(800_000), below, "equality is still under threshold");
    const above = compress(800_001);
    assert.notStrictEqual(above, below, "cannot reuse an under-budget passthrough");
    assert.strictEqual(compress(904_036), above, "changing only the over-budget count dedups");
    fixture.release();
    assert.equal((await below).compressed, false);
    assert.equal((await above).compressed, true);
    assert.strictEqual(compress(950_000), above, "settled over-budget retry dedups too");
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls.find(call => call.client_input_tokens !== undefined)
      .client_input_tokens, 800_001);
  } finally {
    fixture.release();
    await fixture.close();
  }
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
