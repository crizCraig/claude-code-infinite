import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  abGateDecision,
  buildFusionGraderBody,
  effectiveContextForModel,
  parseFusionVerdictResponse,
  resolveAbRoutingOptions,
  startProxy,
  MemtreeClient,
} from "../dist/index.js";

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function mockMemtree() {
  const calls = [];
  const server = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    calls.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        messages: [{ role: "user", content: "compressed context and memory" }],
        unfolded_memory: "the exact unfolded memory",
        usage: { prompt_tokens_details: { cached_tokens: 123 } },
      })
    );
  });
  return { ...server, calls };
}

const followupMessages = [
  { role: "user", content: "first question" },
  { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  { role: "user", content: "current question" },
];

function sse(answer) {
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    frame("message_start", {
      type: "message_start",
      message: { id: `msg_${answer}`, usage: { input_tokens: 10 } },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: answer },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    }) +
    frame("message_stop", { type: "message_stop" })
  );
}

function sseSplit(answer) {
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return {
    head:
      frame("message_start", {
        type: "message_start",
        message: { id: `msg_${answer}`, usage: { input_tokens: 10 } },
      }) +
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: answer },
      }),
    tail:
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      }) +
      frame("message_stop", { type: "message_stop" }),
  };
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

async function waitFor(condition, timeoutMs = 2_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fusionVerdict(verdict) {
  return {
    metrics: {
      consensus_points: [],
      contradictions: [],
      partial_coverage: [],
      unique_insights_a: [],
      unique_insights_b: [],
      blind_spots: [],
    },
    verdict,
    materially_different: verdict !== "tie",
    reasoning: `choose ${verdict}`,
  };
}

async function mockRouterUpstream({
  nativeVerdict,
  failMemory = false,
  failFull = false,
} = {}) {
  const calls = [];
  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    const body = JSON.parse(raw.toString("utf-8"));
    const completionKind = body.output_config
      ? "grader"
      : JSON.stringify(body.messages).includes("compressed context")
        ? "memory"
        : "full";
    const kind = req.url.includes("count_tokens")
      ? `count-${completionKind}`
      : completionKind;
    calls.push({ kind, body, headers: req.headers });

    if (kind.startsWith("count-")) {
      const response = JSON.stringify({
        input_tokens: kind === "count-memory" ? 111 : 999,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(response)),
      });
      res.end(response);
      return;
    }

    if (kind === "grader") {
      const response = JSON.stringify({
        type: "message",
        content: [
          { type: "text", text: JSON.stringify(fusionVerdict(nativeVerdict)) },
        ],
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(response)),
      });
      res.end(response);
      return;
    }
    if (
      (kind === "memory" && failMemory) ||
      (kind === "full" && failFull)
    ) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: `${kind} failed` } }));
      return;
    }
    if (body.stream === true) {
      const response = sse(kind === "memory" ? "MEMORY_ANSWER" : "FULL_ANSWER");
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "content-length": String(Buffer.byteLength(response)),
      });
      res.end(response);
      return;
    }
    const response = JSON.stringify({
      type: "message",
      content: [{ type: "text", text: `${kind.toUpperCase()}_TOOL_ANSWER` }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(response)),
    });
    res.end(response);
  });
  return { ...server, calls };
}

async function postStreamingTurn(proxy, extraHeaders = {}, signal) {
  return fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": "session-ab",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: "claude-test",
      max_tokens: 64,
      stream: true,
      messages: followupMessages,
    }),
    signal,
  });
}

async function armMainTurn(proxy) {
  const response = await fetch(proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-ab",
      prompt_id: "prompt-ab",
      prompt: "current question",
    }),
  });
  assert.equal(response.status, 204);
}

async function claimDisplay(proxy) {
  return fetch(proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "MessageDisplay",
      session_id: "session-ab",
      prompt_id: "prompt-ab",
      turn_id: "turn-ab",
      message_id: "message-ab",
      index: 0,
      final: false,
      delta: "answer",
    }),
  });
}

test("gate compares at the boundary and samples models without a prior", () => {
  const options = resolveAbRoutingOptions({
    effectiveContextTokens: () => 100_000,
  });
  assert.equal(abGateDecision("m", 49_999, options).compare, false);
  assert.equal(abGateDecision("m", 50_000, options).compare, true);
  const unknown = resolveAbRoutingOptions({
    effectiveContextTokens: () => undefined,
  });
  assert.equal(abGateDecision("m", 1, unknown).reason, "sample-no-prior");
  assert.equal(abGateDecision("m", 1, unknown).compare, true);
  assert.equal(effectiveContextForModel("claude-opus-4-8[1m]"), 143_000);
  assert.equal(effectiveContextForModel("claude-fable-5[1m]"), 158_888);
});

test("structured grader body and parser preserve the A/B contract", () => {
  const body = buildFusionGraderBody(
    {
      question: "question",
      unfoldedMemory: "memory",
      memoryResponse: "answer A",
      fullResponse: "answer B",
      model: "claude-test",
    },
    "grader-model",
    4_000
  );
  assert.equal(body.model, "grader-model");
  assert.equal(body.output_config.format.type, "json_schema");
  const metricFields = [
    "blind_spots",
    "consensus_points",
    "contradictions",
    "partial_coverage",
    "unique_insights_a",
    "unique_insights_b",
  ];
  assert.deepEqual(
    [...body.output_config.format.schema.properties.metrics.required].sort(),
    metricFields
  );
  assert.match(body.messages[0].content, /ANSWER A/);
  assert.match(body.messages[0].content, /answer B/);
  const parsed = parseFusionVerdictResponse({
    content: [{ type: "text", text: JSON.stringify(fusionVerdict("B")) }],
  });
  assert.equal(parsed.verdict, "B");
  assert.equal(parsed.materially_different, true);
  assert.equal(
    parseFusionVerdictResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...fusionVerdict("A"),
            metrics: [],
          }),
        },
      ],
    }),
    null
  );
  const missingMetric = fusionVerdict("B");
  delete missingMetric.metrics.blind_spots;
  assert.equal(
    parseFusionVerdictResponse({
      content: [{ type: "text", text: JSON.stringify(missingMetric) }],
    }),
    null
  );
  const nonArrayMetric = fusionVerdict("B");
  nonArrayMetric.metrics.unique_insights_b = "not an array";
  assert.equal(
    parseFusionVerdictResponse({
      content: [{ type: "text", text: JSON.stringify(nonArrayMetric) }],
    }),
    null
  );
});

for (const [verdict, expected] of [
  ["A", "MEMORY_ANSWER"],
  ["tie", "MEMORY_ANSWER"],
  ["B", "FULL_ANSWER"],
]) {
  test(`live A/B verdict ${verdict} commits the existing ${expected} stream`, async () => {
    const upstream = await mockRouterUpstream();
    const memtreeServer = await mockMemtree();
    const grades = [];
    const memtree = new MemtreeClient({
      baseUrl: memtreeServer.origin,
      apiKey: "mem-key",
    });
    const proxy = await startProxy({
      memtree,
      upstreamOrigin: upstream.origin,
      abRouting: {
        forceComparison: true,
        prefixChars: 4,
        grader: async (input) => {
          grades.push(input);
          return fusionVerdict(verdict);
        },
      },
    });
    try {
      const response = await postStreamingTurn(proxy);
      const raw = await response.text();
      assert.match(raw, new RegExp(expected));
      assert.doesNotMatch(
        raw,
        new RegExp(expected === "MEMORY_ANSWER" ? "FULL_ANSWER" : "MEMORY_ANSWER")
      );
      assert.deepEqual(
        upstream.calls.filter((call) => call.kind !== "grader").map((call) => call.kind).sort(),
        ["full", "memory"]
      );
      assert.equal(grades.length, 1);
      assert.match(grades[0].memoryResponse, /^MEMO\n…\[truncated/);
      assert.match(grades[0].fullResponse, /^FULL\n…\[truncated/);
      assert.equal(grades[0].unfoldedMemory, "the exact unfolded memory");
    } finally {
      proxy.close();
      upstream.close();
      memtreeServer.close();
    }
  });
}

for (const scenario of [
  { name: "memory winner", verdict: "A", hookStatus: 200 },
  { name: "full winner", verdict: "B", hookStatus: 204 },
  {
    name: "both completion legs fail",
    verdict: "A",
    failMemory: true,
    failFull: true,
    hookStatus: 204,
  },
]) {
  test(`compression notice reflects the actual A/B outcome: ${scenario.name}`, async () => {
    const upstream = await mockRouterUpstream({
      failMemory: scenario.failMemory,
      failFull: scenario.failFull,
    });
    const memtreeServer = await mockMemtree();
    const proxy = await startProxy({
      memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
      upstreamOrigin: upstream.origin,
      abRouting: {
        forceComparison: true,
        prefixChars: 4,
        grader: async () => fusionVerdict(scenario.verdict),
      },
    });
    try {
      await armMainTurn(proxy);
      await (await postStreamingTurn(proxy)).text();
      const hook = await claimDisplay(proxy);
      assert.equal(hook.status, scenario.hookStatus);
      if (hook.status === 200) {
        assert.match(await hook.text(), /conversation optimized/);
      }
    } finally {
      proxy.close();
      upstream.close();
      memtreeServer.close();
    }
  });
}

test("grader failure defaults to the memory leg", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: () => {
        throw new Error("grader unavailable");
      },
    },
  });
  try {
    assert.match(await (await postStreamingTurn(proxy)).text(), /MEMORY_ANSWER/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("grader timeout cannot hang even when a custom grader ignores abort", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      graderTimeoutMs: 10,
      grader: async () => new Promise(() => {}),
    },
  });
  try {
    let guardTimer;
    const response = await Promise.race([
      postStreamingTurn(proxy),
      new Promise((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error("proxy hung after grader timeout")),
          1_000
        );
      }),
    ]).finally(() => clearTimeout(guardTimer));
    assert.match(await response.text(), /MEMORY_ANSWER/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("a failed memory completion serves the healthy full-context leg without grading", async () => {
  const upstream = await mockRouterUpstream({ failMemory: true });
  const memtreeServer = await mockMemtree();
  let grades = 0;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => {
        grades++;
        return fusionVerdict("A");
      },
    },
  });
  try {
    assert.match(await (await postStreamingTurn(proxy)).text(), /FULL_ANSWER/);
    assert.equal(grades, 0);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("prefix timeout selects the ready full leg instead of a stalled memory leg", async () => {
  let stalledMemory;
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const memory = JSON.stringify(body.messages).includes("compressed context");
    if (!memory) {
      const response = sse("FULL_READY");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response);
      return;
    }
    stalledMemory = res;
    const frame = (type, data) =>
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      frame("message_start", {
        type: "message_start",
        message: { id: "msg_thinking", usage: { input_tokens: 10 } },
      }) +
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }) +
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "still thinking" },
        })
    );
  });
  const memtreeServer = await mockMemtree();
  let grades = 0;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      prefixTimeoutMs: 15,
      grader: async () => {
        grades++;
        return fusionVerdict("A");
      },
    },
  });
  try {
    assert.match(await (await postStreamingTurn(proxy)).text(), /FULL_READY/);
    assert.equal(grades, 0);
  } finally {
    stalledMemory?.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("prefix timeout keeps a pending preferred memory leg instead of failing it", async () => {
  const pending = new Map();
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    pending.set(kind, res);
    if (pending.size === 2) {
      setTimeout(() => {
        const memory = pending.get("memory");
        if (!memory.destroyed) {
          memory.writeHead(200, { "content-type": "text/event-stream" });
          memory.end(sse("MEMORY_AFTER_TIMEOUT"));
        }
      }, 35);
    }
  });
  const memtreeServer = await mockMemtree();
  const records = [];
  let grades = 0;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      prefixTimeoutMs: 10,
      grader: async () => {
        grades++;
        return fusionVerdict("B");
      },
    },
  });
  try {
    await armMainTurn(proxy);
    const response = await postStreamingTurn(proxy);
    assert.match(await response.text(), /MEMORY_AFTER_TIMEOUT/);
    assert.equal(grades, 0);
    const hook = await claimDisplay(proxy);
    assert.equal(hook.status, 200);
    await waitFor(() => records.some((record) => record.kind === "messages"));
    const record = records.find((item) => item.kind === "messages");
    assert.equal(record.comparison.fallbackReason, "prefix-timeout-default-memory");
    assert.equal(record.comparison.deliveryOk, true);
  } finally {
    for (const response of pending.values()) response.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("prefix timeout keeps both header-pending legs until one is healthy", async () => {
  const pending = new Map();
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    pending.set(kind, res);
    if (pending.size !== 2) return;
    setTimeout(() => {
      const full = pending.get("full");
      if (!full.destroyed) {
        full.writeHead(200, { "content-type": "text/event-stream" });
        full.end(sse("FULL_FIRST_HEALTHY_RESPONSE"));
      }
    }, 30);
    setTimeout(() => {
      const memory = pending.get("memory");
      if (!memory.destroyed) {
        memory.writeHead(500, { "content-type": "application/json" });
        memory.end(JSON.stringify({ type: "error" }));
      }
    }, 60);
  });
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      prefixTimeoutMs: 10,
      grader: async () => fusionVerdict("A"),
    },
  });
  try {
    const response = await postStreamingTurn(proxy);
    assert.match(await response.text(), /FULL_FIRST_HEALTHY_RESPONSE/);
  } finally {
    for (const response of pending.values()) response.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

for (const memoryMode of ["hangs after headers", "truncates before a prefix"]) {
  test(`prefix fallback survives when memory ${memoryMode}`, async () => {
    let memoryResponse;
    const upstream = await listen(async (req, res) => {
      const body = JSON.parse((await readBody(req)).toString("utf-8"));
      const memory = JSON.stringify(body.messages).includes("compressed context");
      if (memory) {
        memoryResponse = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        if (memoryMode.startsWith("truncates")) {
          setTimeout(() => {
            if (!res.destroyed) {
              res.end(
                `event: message_start\ndata: ${JSON.stringify({
                  type: "message_start",
                  message: { id: "truncated", usage: { input_tokens: 10 } },
                })}\n\n`
              );
            }
          }, 20);
        }
        return;
      }
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse("FULL_AFTER_UNUSABLE_MEMORY"));
        }
      }, 35);
    });
    const memtreeServer = await mockMemtree();
    const proxy = await startProxy({
      memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
      upstreamOrigin: upstream.origin,
      abRouting: {
        forceComparison: true,
        prefixChars: 4,
        prefixTimeoutMs: 10,
        grader: async () => fusionVerdict("A"),
      },
    });
    try {
      const response = await postStreamingTurn(proxy);
      assert.match(await response.text(), /FULL_AFTER_UNUSABLE_MEMORY/);
    } finally {
      memoryResponse?.destroy();
      proxy.close();
      upstream.close();
      memtreeServer.close();
    }
  });
}

test("prefix timeout commits preferred memory when valid thinking is streaming", async () => {
  const legs = new Map();
  const frame = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    legs.set(kind, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      frame("message_start", {
        type: "message_start",
        message: { id: `thinking-${kind}`, usage: { input_tokens: 10 } },
      }) +
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }) +
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "working" },
        })
    );
  });
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      prefixTimeoutMs: 10,
      grader: async () => fusionVerdict("B"),
    },
  });
  try {
    let guard;
    const response = await Promise.race([
      postStreamingTurn(proxy),
      new Promise((_, reject) => {
        guard = setTimeout(
          () => reject(new Error("thinking stream stayed buffered past timeout")),
          200
        );
      }),
    ]).finally(() => clearTimeout(guard));
    const memory = legs.get("memory");
    memory.end(
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
        frame("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }) +
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "MEMORY_AFTER_THINKING" },
        }) +
        frame("content_block_stop", { type: "content_block_stop", index: 1 }) +
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        }) +
        frame("message_stop", { type: "message_stop" })
    );
    assert.match(await response.text(), /MEMORY_AFTER_THINKING/);
  } finally {
    for (const response of legs.values()) response.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("a selected leg that fails during grading is replaced by its healthy peer", async () => {
  const legs = new Map();
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    const parts = sseSplit(kind === "memory" ? "MEMORY_HEAD" : "FULL_HEAD");
    legs.set(kind, { res, parts });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(parts.head);
  });
  const memtreeServer = await mockMemtree();
  const grade = deferred();
  let gradeStarted = false;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => {
        gradeStarted = true;
        return grade.promise;
      },
    },
  });
  try {
    const responsePromise = postStreamingTurn(proxy);
    await waitFor(() => gradeStarted && legs.size === 2);
    legs.get("memory").res.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    grade.resolve(fusionVerdict("A"));
    const response = await responsePromise;
    legs.get("full").res.end(legs.get("full").parts.tail);
    const raw = await response.text();
    assert.match(raw, /FULL_HEAD/);
    assert.doesNotMatch(raw, /MEMORY_HEAD/);
  } finally {
    for (const leg of legs.values()) leg.res.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("a selected A/B stream must reach message_stop before installing memory", async () => {
  const legs = new Map();
  const calls = [];
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    calls.push(body);
    if (body.stream !== true) {
      const response = JSON.stringify({
        type: "message",
        content: [{ type: "text", text: "tool response" }],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(response);
      return;
    }
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    const parts = sseSplit(`${kind.toUpperCase()}_HEAD`);
    legs.set(kind, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(parts.head);
    if (kind === "memory") {
      setTimeout(() => {
        if (!res.destroyed) {
          res.end(parts.tail.replace(/event: message_stop[\s\S]*$/, ""));
        }
      }, 50);
    }
  });
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => fusionVerdict("A"),
    },
  });
  try {
    await armMainTurn(proxy);
    const response = await postStreamingTurn(proxy);
    assert.match(await response.text(), /MEMORY_HEAD/);
    assert.equal((await claimDisplay(proxy)).status, 204);

    const toolMessages = [
      ...followupMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "after-truncate", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "after-truncate", content: "result" },
        ],
      },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: toolMessages,
      }),
    });
    assert.match(JSON.stringify(calls.at(-1).messages), /first question/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /compressed context/);
  } finally {
    for (const response of legs.values()) response.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("native grader reuses incoming Anthropic auth and selects B", async () => {
  const upstream = await mockRouterUpstream({ nativeVerdict: "B" });
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: { forceComparison: true, prefixChars: 4 },
  });
  try {
    const response = await postStreamingTurn(proxy, {
      authorization: "Bearer oauth-test",
      "anthropic-beta": "oauth-test-beta",
      "anthropic-version": "2023-06-01",
    });
    assert.match(await response.text(), /FULL_ANSWER/);
    const grader = upstream.calls.find((call) => call.kind === "grader");
    assert.ok(grader);
    assert.equal(grader.headers.authorization, "Bearer oauth-test");
    assert.equal(grader.headers["anthropic-beta"], "oauth-test-beta");
    assert.equal(grader.body.stream, false);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("downstream cancellation tears down the native grader request", async () => {
  let graderStarted = false;
  let graderClosed = false;
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    if (body.output_config) {
      graderStarted = true;
      res.on("close", () => {
        graderClosed = true;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      return;
    }
    const answer = JSON.stringify(body.messages).includes("compressed context")
      ? "MEMORY_ANSWER"
      : "FULL_ANSWER";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(answer));
  });
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: { forceComparison: true, prefixChars: 4 },
  });
  const controller = new AbortController();
  try {
    const request = postStreamingTurn(proxy, {}, controller.signal);
    await waitFor(() => graderStarted);
    controller.abort();
    await assert.rejects(request, /abort/i);
    await waitFor(() => graderClosed);
  } finally {
    controller.abort();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("request log records gate, both legs, verdict, and selected winner", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => fusionVerdict("B"),
    },
  });
  try {
    await (await postStreamingTurn(proxy)).text();
    await waitFor(() => records.some((record) => record.kind === "messages"));
    const record = records.find((item) => item.kind === "messages");
    assert.equal(record.turnType, "followup-ab-full");
    assert.equal(record.comparison.attempted, true);
    assert.equal(record.comparison.gateReason, "forced");
    assert.equal(record.comparison.verdict, "B");
    assert.equal(record.comparison.winner, "full");
    assert.equal(record.comparison.memoryLeg.upstreamStatus, 200);
    assert.equal(record.comparison.fullLeg.upstreamStatus, 200);
    assert.equal(record.usage.output_tokens, 2);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("buffer-then-commit holds client bytes, continues winner, and aborts loser", async () => {
  const legs = new Map();
  const closed = new Set();
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    const parts = sseSplit(kind === "memory" ? "MEMORY_HEAD" : "FULL_HEAD");
    legs.set(kind, { res, parts });
    res.on("close", () => closed.add(kind));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(parts.head);
  });
  const memtreeServer = await mockMemtree();
  const grade = deferred();
  let gradeStarted = false;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => {
        gradeStarted = true;
        return grade.promise;
      },
    },
  });
  try {
    let clientCommitted = false;
    const responsePromise = postStreamingTurn(proxy).then((response) => {
      clientCommitted = true;
      return response;
    });
    await waitFor(() => gradeStarted && legs.size === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(clientCommitted, false, "no downstream headers before verdict");

    grade.resolve(fusionVerdict("B"));
    const response = await responsePromise;
    await waitFor(() => closed.has("memory"));
    assert.equal(closed.has("full"), false, "winner remains in flight");
    legs.get("full").res.end(legs.get("full").parts.tail);
    const raw = await response.text();
    assert.match(raw, /FULL_HEAD/);
    assert.doesNotMatch(raw, /MEMORY_HEAD/);
  } finally {
    for (const leg of legs.values()) leg.res.destroy();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("downstream cancellation aborts both legs and the grader", async () => {
  const closed = new Set();
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    const kind = JSON.stringify(body.messages).includes("compressed context")
      ? "memory"
      : "full";
    closed.delete(kind);
    res.on("close", () => closed.add(kind));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseSplit(`${kind.toUpperCase()}_HEAD`).head);
  });
  const memtreeServer = await mockMemtree();
  let gradeStarted = false;
  let graderAborted = false;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async ({ signal }) => {
        gradeStarted = true;
        signal.addEventListener("abort", () => {
          graderAborted = true;
        });
        return new Promise(() => {});
      },
    },
  });
  const controller = new AbortController();
  try {
    const request = postStreamingTurn(proxy, {}, controller.signal);
    await waitFor(() => gradeStarted);
    controller.abort();
    await assert.rejects(request, /abort/i);
    await waitFor(() => closed.has("memory") && closed.has("full"));
    await waitFor(() => graderAborted);
  } finally {
    controller.abort();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("downstream cancellation after commit installs no memory route", async () => {
  const calls = [];
  const records = [];
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    calls.push(body);
    if (body.stream !== true) {
      const response = JSON.stringify({
        type: "message",
        content: [{ type: "text", text: "tool response" }],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(response);
      return;
    }
    const memory = JSON.stringify(body.messages).includes("compressed context");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(memory ? "M".repeat(8 * 1024 * 1024) : "FULL_ANSWER"));
  });
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => fusionVerdict("A"),
    },
  });
  const controller = new AbortController();
  try {
    await armMainTurn(proxy);
    const response = await postStreamingTurn(proxy, {}, controller.signal);
    controller.abort();
    await assert.rejects(response.text(), /abort/i);
    await waitFor(() =>
      records.some(
        (record) =>
          record.kind === "messages" && record.comparison?.deliveryOk === false
      )
    );
    assert.equal((await claimDisplay(proxy)).status, 204);

    const toolMessages = [
      ...followupMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "after-abort", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "after-abort", content: "result" },
        ],
      },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: toolMessages,
      }),
    });
    assert.match(JSON.stringify(calls.at(-1).messages), /first question/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /compressed context/);
  } finally {
    controller.abort();
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("memory winner is carried through the same session's tool loop", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => fusionVerdict("tie"),
    },
  });
  try {
    await (await postStreamingTurn(proxy)).text();
    const toolMessages = [
      ...followupMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "result" },
        ],
      },
    ];
    const subagentResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": "session-ab",
          "x-claude-code-agent-id": "agent-1",
        },
        body: JSON.stringify({
          model: "claude-test",
          max_tokens: 64,
          messages: toolMessages,
        }),
      }
    );
    assert.equal(subagentResponse.status, 200);
    assert.match(
      JSON.stringify(upstream.calls.at(-1).body.messages),
      /first question/,
      "subagent traffic stays full-context"
    );

    const countResponse = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/messages/count_tokens`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": "session-ab",
        },
        body: JSON.stringify({ model: "claude-test", messages: toolMessages }),
      }
    );
    assert.deepEqual(await countResponse.json(), { input_tokens: 111 });
    assert.equal(upstream.calls.at(-1).kind, "count-memory");

    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: toolMessages,
      }),
    });
    assert.equal(response.status, 200);
    const completions = upstream.calls.filter((call) => call.kind !== "grader");
    const routedTool = completions.at(-1).body;
    assert.match(JSON.stringify(routedTool.messages), /compressed context/);
    assert.doesNotMatch(JSON.stringify(routedTool.messages), /first question/);
    assert.match(JSON.stringify(routedTool.messages), /tool_result/);
    await waitFor(() => memtreeServer.calls.some((call) => call.index_only === true));
    const indexed = memtreeServer.calls.find((call) => call.index_only === true);
    assert.match(JSON.stringify(indexed.messages), /first question/);
    assert.doesNotMatch(JSON.stringify(indexed.messages), /compressed context/);

    const secondToolMessages = [
      ...toolMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "write", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-2", content: "done" },
        ],
      },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: secondToolMessages,
      }),
    });
    const secondRouted = upstream.calls.at(-1).body;
    assert.match(JSON.stringify(secondRouted.messages), /compressed context/);
    assert.match(JSON.stringify(secondRouted.messages), /tool-1/);
    assert.match(JSON.stringify(secondRouted.messages), /tool-2/);

    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "different-session",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: secondToolMessages,
      }),
    });
    assert.match(
      JSON.stringify(upstream.calls.at(-1).body.messages),
      /first question/,
      "a different session fails closed to full context"
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("a newer user prompt prevents a stale memory verdict from installing a route", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const grade = deferred();
  let gradeStarted = false;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => {
        gradeStarted = true;
        return grade.promise;
      },
    },
  });
  try {
    await armMainTurn(proxy);
    const oldRequest = postStreamingTurn(proxy);
    await waitFor(() => gradeStarted);
    const newPrompt = await fetch(proxy.hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-ab",
        prompt_id: "prompt-new",
        prompt: "replacement question",
      }),
    });
    assert.equal(newPrompt.status, 204);
    grade.resolve(fusionVerdict("A"));
    await (await oldRequest).text();

    const toolMessages = [
      ...followupMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "stale-tool", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "stale-tool", content: "result" },
        ],
      },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: toolMessages,
      }),
    });
    assert.match(JSON.stringify(upstream.calls.at(-1).body.messages), /first question/);
    assert.doesNotMatch(
      JSON.stringify(upstream.calls.at(-1).body.messages),
      /compressed context/
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("a full-context A/B winner leaves subsequent tool turns full-context", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => fusionVerdict("B"),
    },
  });
  try {
    await (await postStreamingTurn(proxy)).text();
    const messages = [
      ...followupMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "full-tool", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "full-tool", content: "result" },
        ],
      },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({ model: "claude-test", max_tokens: 64, messages }),
    });
    assert.match(JSON.stringify(upstream.calls.at(-1).body.messages), /first question/);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("route matching ignores block cache metadata but preserves nested tool data", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      forceComparison: true,
      prefixChars: 4,
      grader: async () => fusionVerdict("A"),
    },
  });
  const anchoredMessages = [
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
    { role: "user", content: "current question" },
  ];
  try {
    await (
      await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": "session-ab",
        },
        body: JSON.stringify({
          model: "claude-test",
          max_tokens: 64,
          stream: true,
          messages: anchoredMessages,
        }),
      })
    ).text();

    const cacheMetadataChurn = structuredClone(anchoredMessages);
    cacheMetadataChurn[1].content[0].cache_control = {
      type: "ephemeral",
      ttl: "1h",
    };
    cacheMetadataChurn.push(
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "one" }],
      }
    );
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: cacheMetadataChurn,
      }),
    });
    assert.match(
      JSON.stringify(upstream.calls.at(-1).body.messages),
      /compressed context/
    );

    const changedToolData = structuredClone(cacheMetadataChurn);
    changedToolData[1].content[0].input.cache_control = "changed-domain-value";
    changedToolData.push(
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "two" }],
      }
    );
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: changedToolData,
      }),
    });
    assert.match(
      JSON.stringify(upstream.calls.at(-1).body.messages),
      /first question/
    );
    assert.doesNotMatch(
      JSON.stringify(upstream.calls.at(-1).body.messages),
      /compressed context/
    );
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("below-threshold turns skip fan-out and serve memory directly", async () => {
  const upstream = await mockRouterUpstream();
  const memtreeServer = await mockMemtree();
  let grades = 0;
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    abRouting: {
      effectiveContextTokens: () => 1_000_000,
      grader: async () => {
        grades++;
        return fusionVerdict("B");
      },
    },
  });
  try {
    assert.match(await (await postStreamingTurn(proxy)).text(), /MEMORY_ANSWER/);
    assert.equal(grades, 0);
    assert.deepEqual(upstream.calls.map((call) => call.kind), ["memory"]);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});

test("a truncated below-threshold memory stream installs no route or success notice", async () => {
  const calls = [];
  const upstream = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString("utf-8"));
    calls.push(body);
    if (body.stream === true) {
      const truncated = sse("TRUNCATED_MEMORY").replace(
        /event: message_stop[\s\S]*$/,
        ""
      );
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(truncated);
      return;
    }
    const response = JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "tool response" }],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(response);
  });
  const memtreeServer = await mockMemtree();
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memtreeServer.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (record) => records.push(structuredClone(record)) },
    abRouting: { effectiveContextTokens: () => 1_000_000 },
  });
  try {
    await armMainTurn(proxy);
    const response = await postStreamingTurn(proxy);
    assert.match(await response.text(), /TRUNCATED_MEMORY/);
    assert.equal((await claimDisplay(proxy)).status, 204);

    const toolMessages = [
      ...followupMessages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "truncated-tool", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "truncated-tool", content: "result" },
        ],
      },
    ];
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "session-ab",
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        messages: toolMessages,
      }),
    });
    assert.match(JSON.stringify(calls.at(-1).messages), /first question/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /compressed context/);
    await waitFor(() => records.some((record) => record.kind === "messages"));
    const record = records.find((item) => item.kind === "messages");
    assert.equal(record.comparison.deliveryOk, false);
  } finally {
    proxy.close();
    upstream.close();
    memtreeServer.close();
  }
});
