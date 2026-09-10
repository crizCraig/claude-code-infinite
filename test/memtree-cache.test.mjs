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
