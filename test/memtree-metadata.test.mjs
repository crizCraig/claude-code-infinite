import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MemtreeClient } from "../dist/memtree.js";
import { startProxy } from "../dist/proxy.js";

const MEMTREE_RESPONSE = {
  messages: [{ role: "user", content: "compressed context" }],
  usage: { prompt_tokens_details: { cached_tokens: 0 } },
};

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

async function mockJsonServer(responseBody) {
  const calls = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  return { ...server, calls };
}

async function waitFor(condition, timeoutMs = 3_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const followupMessages = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "followup question" },
];

const tools = [
  {
    name: "lookup",
    description: "Look up a value",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Exact query" } },
      required: ["query"],
    },
  },
];

test("proxy sends exact model, tools, system, and context limit for blocking compression", async () => {
  const memtree = await mockJsonServer(MEMTREE_RESPONSE);
  const upstream = await mockJsonServer({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
  });
  const client = new MemtreeClient({ baseUrl: memtree.origin, apiKey: "key" });
  const proxy = await startProxy({
    memtree: client,
    upstreamOrigin: upstream.origin,
  });
  const system = [
    { type: "text", text: "system instructions", cache_control: { type: "ephemeral" } },
  ];
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-fable-5[1m]",
        max_tokens: 64,
        system,
        tools,
        messages: followupMessages,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(memtree.calls.length, 1);
    assert.equal(memtree.calls[0].model, "anthropic/claude-fable-5[1m]");
    assert.deepEqual(memtree.calls[0].tools, tools);
    assert.deepEqual(memtree.calls[0].messages[0], {
      role: "system",
      content: system,
    });
    assert.equal(memtree.calls[0].model_context_limit, 1_000_000);
    assert.ok(!("index_only" in memtree.calls[0]));
  } finally {
    proxy.close();
    upstream.close();
    memtree.close();
  }
});

test("proxy index-only calls send model but deliberately omit tools", async () => {
  const memtree = await mockJsonServer(MEMTREE_RESPONSE);
  const upstream = await mockJsonServer({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
  });
  const client = new MemtreeClient({ baseUrl: memtree.origin, apiKey: "key" });
  const proxy = await startProxy({
    memtree: client,
    upstreamOrigin: upstream.origin,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 64,
        tools,
        messages: [{ role: "user", content: "first question" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    await waitFor(() => memtree.calls.length === 1);
    assert.equal(memtree.calls[0].model, "claude-opus-4-8");
    assert.equal(memtree.calls[0].index_only, true);
    assert.ok(!("tools" in memtree.calls[0]));
  } finally {
    await client.drainBackground();
    proxy.close();
    upstream.close();
    memtree.close();
  }
});

test("three-argument compression stays compatible and omits absent metadata", async () => {
  const server = await mockJsonServer(MEMTREE_RESPONSE);
  const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "key" });
  try {
    const hash = MemtreeClient.hashMessages(followupMessages);
    const result = await client.compress(hash, followupMessages, 200_000);
    assert.ok(result);
    assert.equal(server.calls.length, 1);
    assert.ok(!("model" in server.calls[0]));
    assert.ok(!("tools" in server.calls[0]));
  } finally {
    server.close();
  }
});

test("compression cache identity includes model, context limit, and canonical tools", async () => {
  const server = await mockJsonServer(MEMTREE_RESPONSE);
  const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "key" });
  const hash = MemtreeClient.hashMessages(followupMessages);
  const reorderedTools = [
    {
      input_schema: {
        required: ["query"],
        properties: { query: { description: "Exact query", type: "string" } },
        type: "object",
      },
      description: "Look up a value",
      name: "lookup",
    },
  ];
  try {
    const first = await client.compress(hash, followupMessages, 200_000, undefined, {
      model: "claude-fable-5",
      tools,
    });
    const identical = await client.compress(
      hash,
      followupMessages,
      200_000,
      undefined,
      { model: "claude-fable-5", tools: reorderedTools }
    );
    assert.strictEqual(identical, first);
    assert.equal(server.calls.length, 1, "canonical-equivalent tools deduplicate");

    await client.compress(hash, followupMessages, 200_000, undefined, {
      model: "claude-opus-4-8",
      tools,
    });
    await client.compress(hash, followupMessages, 1_000_000, undefined, {
      model: "claude-opus-4-8",
      tools,
    });
    await client.compress(hash, followupMessages, 1_000_000, undefined, {
      model: "claude-opus-4-8",
      tools: [{ ...tools[0], description: "Changed schema metadata" }],
    });
    assert.equal(server.calls.length, 4);
  } finally {
    server.close();
  }
});

test("canonical tool fingerprints preserve own __proto__ schema fields", async () => {
  const server = await mockJsonServer(MEMTREE_RESPONSE);
  const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "key" });
  const hash = MemtreeClient.hashMessages(followupMessages);
  const computedSchema = {
    type: "object",
    properties: { ["__proto__"]: { type: "string" } },
  };
  const parsedSchema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"number"}}}'
  );
  try {
    for (const input_schema of [computedSchema, parsedSchema]) {
      await client.compress(hash, followupMessages, 200_000, undefined, {
        model: "claude-fable-5",
        tools: [{ name: "prototype-field", input_schema }],
      });
    }

    assert.equal(server.calls.length, 2);
    const sentProperties = server.calls.map(
      (call) => call.tools[0].input_schema.properties
    );
    assert.ok(
      sentProperties.every((properties) => Object.hasOwn(properties, "__proto__"))
    );
    assert.deepEqual(
      sentProperties.map((properties) => properties["__proto__"].type),
      ["string", "number"]
    );
  } finally {
    server.close();
  }
});

test("cache-key serialization failures resolve to null without throwing", async () => {
  const server = await mockJsonServer(MEMTREE_RESPONSE);
  const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "key" });
  const hash = MemtreeClient.hashMessages(followupMessages);
  const cyclicTool = { name: "cyclic" };
  cyclicTool.self = cyclicTool;
  const deepTool = { name: "deep" };
  let nested = deepTool;
  for (let depth = 0; depth < 300; depth += 1) {
    nested.child = {};
    nested = nested.child;
  }
  const invalidTools = [
    [{ name: "bigint", value: 1n }],
    [cyclicTool],
    [deepTool],
  ];

  try {
    for (const invalid of invalidTools) {
      let resultPromise;
      assert.doesNotThrow(() => {
        resultPromise = client.compress(hash, followupMessages, 200_000, undefined, {
          model: "claude-fable-5",
          tools: invalid,
        });
      });
      assert.equal(await resultPromise, null);
    }
    assert.equal(server.calls.length, 0);
  } finally {
    server.close();
  }
});

test("explicit undefined metadata fields are omitted", async () => {
  const server = await mockJsonServer(MEMTREE_RESPONSE);
  const client = new MemtreeClient({ baseUrl: server.origin, apiKey: "key" });
  try {
    const hash = MemtreeClient.hashMessages(followupMessages);
    await client.compress(hash, followupMessages, 200_000, undefined, {
      model: undefined,
      tools: undefined,
    });
    assert.ok(!("model" in server.calls[0]));
    assert.ok(!("tools" in server.calls[0]));
  } finally {
    server.close();
  }
});
