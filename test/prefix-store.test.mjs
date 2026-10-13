// A session's adopted compressed prefix survives a ccc restart (2026-10-13):
// a resumed session's first turn rides the persisted prefix, byte for byte,
// with no blocking compress. Anything that would not validate in memory (a
// changed history, a corrupt file) is discarded and the turn behaves as if
// nothing had been stored. Only the main lane is ever persisted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { StablePrefixStore } from "../dist/prefix-store.js";

const SESSION = "s-persist";
const PAGE = "https://memtree.example/usage/memtree/page-1";
const BIG = (tag, chars = 100_000) => `${tag} ` + "x".repeat(chars);
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

async function listen(handler, port = 0) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port: server.address().port, origin: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccc-prefix-store-"));
}

/**
 * One proxy process: Anthropic and MemTree stand-ins, and the given store.
 * `memoryPort` reuses an earlier process's MemTree origin (a restart against
 * the same backend); `apiKey` is the MemTree key.
 */
async function proxyProcess(store, { memoryPort = 0, apiKey = "k" } = {}) {
  const h = { raw: [], records: [], compressCalls: 0 };
  const upstream = await listen((req, res, raw) => {
    const tokens = Math.floor(raw.length / 4);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/count_tokens")) return res.end(JSON.stringify({ input_tokens: tokens }));
    h.raw.push(raw.toString("utf-8"));
    res.end(JSON.stringify({ type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 3, cache_read_input_tokens: tokens - 3, output_tokens: 1 } }));
  });
  const memory = await listen((req, res, raw) => {
    const body = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" || body.index_only) {
      return res.end(JSON.stringify({ messages: [], index_only: true }));
    }
    h.compressCalls++;
    const size = Math.round(JSON.stringify(body.messages).length / 4);
    const threshold = body.compression_threshold_tokens ?? body.compression_target_tokens;
    if (threshold === undefined || (size <= threshold && !(body.client_input_tokens > threshold))) {
      return res.end(JSON.stringify({ messages: body.messages, compressed: false,
        usage: { prompt_tokens: size, prompt_tokens_details: { cached_tokens: 1 } } }));
    }
    res.setHeader("x-polychat-memtree-url", PAGE);
    res.setHeader("x-polychat-memtree-index", "idx-1");
    const memory = [{ role: "user", content: `memory ${h.compressCalls} ` + "m".repeat(3_000) }];
    res.end(JSON.stringify({ messages: memory, flattened_messages: memory, compressed: true,
      usage: { prompt_tokens: size, completion_tokens: 900,
        prompt_tokens_details: { cached_tokens: size } } }));
  }, memoryPort);
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memory.origin, apiKey }),
    upstreamOrigin: upstream.origin, budgetTokensOverride: 20_000, countTokens: true,
    reqlog: { log: (r) => h.records.push(structuredClone(r)) },
    ...(store ? { stablePrefixStore: store } : {}),
  });
  h.post = async (messages, headers = {}, extraBody = {}) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION,
        ...headers },
      body: JSON.stringify({ model: "claude-x", max_tokens: 64,
        system: [{ type: "text", text: "sys" }], messages, ...extraBody }),
    });
    await response.text();
    return response.status;
  };
  h.port = proxy.port;
  h.memoryPort = memory.port;
  h.lastRecord = () => h.records.filter((r) => r.kind === "messages").at(-1);
  h.close = () => { proxy.close(); upstream.close(); memory.close(); };
  return h;
}

/** Compact once on a first process; returns the conversation that compacted. */
async function compactOnce(h, headers = {}) {
  const conv = [user("q1"), assistant("a1"), user("q2")];
  assert.equal(await h.post(conv, headers), 200);
  conv.push(assistant("a2"), user(BIG("q3")));
  assert.equal(await h.post(conv, headers), 200);
  assert.equal(h.lastRecord().turnType, "followup-compressed");
  return conv;
}

async function waitForFile(dir) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length) return files.map((f) => path.join(dir, f));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

test("a restarted proxy rides the persisted prefix on its first turn, byte for byte", async () => {
  const dir = tempDir();
  const before = await proxyProcess(new StablePrefixStore(dir));
  let conv;
  let ridden;
  try {
    conv = await compactOnce(before);
    conv.push(assistant("a3"), user("q4"));
    assert.equal(await before.post(conv), 200);
    assert.equal(before.lastRecord().turnType, "followup-prefix");
    ridden = before.raw.at(-1);
    const files = await waitForFile(dir);
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
  } finally { before.close(); }

  const after = await proxyProcess(new StablePrefixStore(dir), { memoryPort: before.memoryPort });
  try {
    assert.equal(await after.post(conv), 200);
    assert.equal(after.compressCalls, 0, "no blocking compress");
    assert.equal(after.lastRecord().turnType, "followup-prefix");
    assert.equal(after.raw.at(-1), ridden, "the same bytes as before the restart");
    const current = await fetch(
      `http://127.0.0.1:${after.port}/memtree/current?session=${SESSION}`);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).url, PAGE, "the memory-source page came back too");
  } finally { after.close(); }
});

/** Today's behaviour for `conv` on a fresh proxy with no store. */
async function baseline(conv) {
  const fresh = await proxyProcess(undefined);
  try {
    assert.equal(await fresh.post(conv), 200);
    return { turnType: fresh.lastRecord().turnType, compressCalls: fresh.compressCalls,
      prefixMiss: fresh.lastRecord().compaction?.prefixMiss };
  } finally { fresh.close(); }
}

async function afterRestart(dir, conv, memoryPort) {
  const after = await proxyProcess(new StablePrefixStore(dir), { memoryPort });
  try {
    assert.equal(await after.post(conv), 200);
    return { turnType: after.lastRecord().turnType, compressCalls: after.compressCalls,
      prefixMiss: after.lastRecord().compaction?.prefixMiss };
  } finally { after.close(); }
}

test("a changed history discards the persisted prefix and behaves as today", async () => {
  const dir = tempDir();
  const before = await proxyProcess(new StablePrefixStore(dir));
  let conv;
  try { conv = await compactOnce(before); } finally { before.close(); }
  assert.equal((await waitForFile(dir)).length, 1);
  const edited = [user("q1 (edited)"), ...conv.slice(1), assistant("a3"), user("q4")];
  assert.deepEqual(await afterRestart(dir, edited, before.memoryPort), await baseline(edited));
  assert.equal((await waitForFile(dir)).length, 1, "the new compaction replaced it");
});

test("a corrupt persisted prefix is discarded and the turn behaves as today", async () => {
  const dir = tempDir();
  const before = await proxyProcess(new StablePrefixStore(dir));
  let conv;
  try { conv = await compactOnce(before); } finally { before.close(); }
  const [file] = await waitForFile(dir);
  fs.writeFileSync(file, "{ not json");
  conv.push(assistant("a3"), user("q4"));
  assert.deepEqual(await afterRestart(dir, conv, before.memoryPort), await baseline(conv));
});

test("a subagent lane's compaction is never persisted", async () => {
  const dir = tempDir();
  const h = await proxyProcess(new StablePrefixStore(dir));
  try {
    const conv = [user("task"),
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: BIG("r") }] }];
    assert.equal(await h.post(conv, { "x-claude-code-agent-id": "agent-1" }), 200);
    assert.ok(h.compressCalls >= 1);
    assert.match(h.raw.at(-1), /memory \d m/, "the subagent did compress");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { h.close(); }
});

const OWNER = "owner-1";
const PREFIX = (fill) => ({
  originalSystemHash: "h".repeat(64), originalPrefixHashes: ["a".repeat(64), "b".repeat(64)],
  compressedMessages: [{ role: "user", content: fill }], compressedSystem: undefined,
  hasCompressedSystem: false, targetTokens: 10_000, explicitTarget: false,
  modelContextLimit: 200_000,
});

test("the store is bounded by total size and evicts the oldest sessions", () => {
  const dir = tempDir();
  const store = new StablePrefixStore(dir, { maxBytes: 25_000, maxEntries: 10 });
  let now = 1_000;
  for (const session of ["s1", "s2", "s3"]) {
    store.save(session, OWNER, PREFIX("p".repeat(10_000)), undefined, now += 1_000);
  }
  assert.equal(store.load("s1", OWNER), undefined, "oldest evicted to fit the size bound");
  assert.equal(store.load("s2", OWNER)?.prefix.compressedMessages[0].content.length, 10_000);
  assert.ok(store.load("s3", OWNER));
  const counted = new StablePrefixStore(tempDir(), { maxBytes: 1e9, maxEntries: 2 });
  for (const session of ["a", "b", "c"]) {
    counted.save(session, OWNER, PREFIX("p"), undefined, now += 1);
  }
  assert.equal(counted.load("a", OWNER), undefined, "entry count bound");
  assert.ok(counted.load("b", OWNER) && counted.load("c", OWNER));
  const big = new StablePrefixStore(tempDir(), { maxBytes: 5_000, maxEntries: 10 });
  big.save("huge", OWNER, PREFIX("p".repeat(10_000)), undefined, now += 1);
  assert.equal(big.load("huge", OWNER), undefined, "an entry over the whole bound is not kept");
});

/** One malformed block per supported type, plus an unknown type (Codex cycle 2). */
const MALFORMED_BLOCKS = [
  ["a text block without text", { type: "text" }],
  ["an image without a valid source", { type: "image", source: { type: "base64" } }],
  ["a document with an unknown source type", { type: "document",
    source: { type: "ftp", url: "ftp://x" } }],
  ["a tool_use without input", { type: "tool_use", id: "t", name: "Read" }],
  ["a tool_result without tool_use_id", { type: "tool_result", content: "done" }],
  ["a tool_result with malformed content", { type: "tool_result", tool_use_id: "t",
    content: [{ type: "text" }] }],
  ["a thinking block without a signature", { type: "thinking", thinking: "hm" }],
  ["a redacted_thinking block without data", { type: "redacted_thinking" }],
  ["an unknown block type", { type: "mystery", text: "m" }],
  // Inherited object keys are not block or source types (Codex cycle 3).
  ...["toString", "constructor", "__proto__", "hasOwnProperty"].flatMap((key) => [
    [`a block typed ${key}`, { type: key, text: "m" }],
    [`an image source typed ${key}`, { type: "image",
      source: { type: key, media_type: "image/png", data: "AA==", url: "https://x" } }],
  ]),
];

/** One well-formed block per supported type. */
const VALID_BLOCKS = [
  { type: "text", text: "m", cache_control: { type: "ephemeral" } },
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
  { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
  { type: "document", source: { type: "text", media_type: "text/plain", data: "doc" } },
  { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA==" } },
  { type: "tool_use", id: "t", name: "Read", input: {} },
  { type: "tool_result", tool_use_id: "t", content: "done" },
  { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "done" }],
    is_error: false },
  { type: "thinking", thinking: "hm", signature: "sig" },
  { type: "redacted_thinking", data: "opaque" },
];

for (const block of VALID_BLOCKS) {
  test(`a well-formed ${block.type} block (${block.source?.type ?? "plain"}) is stored and loaded`,
    () => {
      const store = new StablePrefixStore(tempDir());
      store.save("s", OWNER, { ...PREFIX("p"),
        compressedMessages: [{ role: "assistant", content: [block] }] }, undefined);
      assert.deepEqual(store.load("s", OWNER)?.prefix.compressedMessages[0].content, [block]);
    });
}

for (const [label, block] of MALFORMED_BLOCKS) {
  test(`the store rejects ${label}`, () => {
    const store = new StablePrefixStore(tempDir());
    store.save("s", OWNER, { ...PREFIX("p"),
      compressedMessages: [{ role: "assistant", content: [block] }] }, undefined);
    assert.equal(store.load("s", OWNER), undefined);
  });
}

/** Compact and ride once, then let the entry reach the disk. */
async function persistOnce(dir) {
  const before = await proxyProcess(new StablePrefixStore(dir));
  let conv;
  try {
    conv = await compactOnce(before);
    conv.push(assistant("a3"), user("q4"));
    assert.equal(await before.post(conv), 200);
  } finally { before.close(); }
  const files = await waitForFile(dir);
  assert.equal(files.length, 1);
  return { conv, memoryPort: before.memoryPort, file: files[0] };
}

for (const [label, change] of [
  ["a different MemTree key", (port) => ({ memoryPort: port, apiKey: "other-key" })],
  ["a different MemTree backend", () => ({ apiKey: "k" })],
]) {
  test(`${label} never adopts the persisted prefix`, async () => {
    const dir = tempDir();
    const { conv, memoryPort } = await persistOnce(dir);
    const after = await proxyProcess(new StablePrefixStore(dir), change(memoryPort));
    try {
      assert.equal(await after.post(conv), 200);
      assert.notEqual(after.lastRecord().storedPrefix, "adopted");
      assert.ok(after.compressCalls >= 1, "compressed afresh");
    } finally { after.close(); }
  });
}

test("a persisted entry never stores the MemTree key", async () => {
  const dir = tempDir();
  const { file } = await persistOnce(dir);
  assert.doesNotMatch(fs.readFileSync(file, "utf-8"), /"k"|Bearer/);
});

test("a side request on the session leaves the persisted prefix for the main history",
  async () => {
    const dir = tempDir();
    const { conv, memoryPort } = await persistOnce(dir);
    const after = await proxyProcess(new StablePrefixStore(dir), { memoryPort });
    try {
      // Claude Code's WebSearch helper: Haiku, server tools, one message, main lane.
      assert.equal(await after.post([user("search the web")], {}, { model: "claude-haiku-x",
        tools: [{ type: "web_search_20250305", name: "web_search" }] }), 200);
      assert.equal(await after.post(conv), 200);
      assert.equal(after.compressCalls, 0, "no blocking compress");
      assert.equal(after.lastRecord().turnType, "followup-prefix");
    } finally { after.close(); }
  });

for (const [label, corrupt] of [
  ["a null message", (entry) => { entry.prefix.compressedMessages = [null]; }],
  ["a message without a role", (entry) => {
    entry.prefix.compressedMessages = [{ content: "memory" }]; }],
  ["content blocks without a type", (entry) => {
    entry.prefix.compressedMessages = [{ role: "user", content: [{ text: "m" }] }]; }],
  ["a malformed system", (entry) => {
    entry.prefix.hasCompressedSystem = true; entry.prefix.compressedSystem = [null]; }],
  ["no covered messages", (entry) => { entry.prefix.originalPrefixHashes = []; }],
  ...MALFORMED_BLOCKS.map(([label, block]) => [label, (entry) => {
    entry.prefix.compressedMessages = [{ role: "user", content: [block] }]; }]),
  ["a system text block without text", (entry) => {
    entry.prefix.hasCompressedSystem = true;
    entry.prefix.compressedSystem = [{ type: "text" }]; }],
]) {
  test(`a persisted prefix with ${label} is discarded and the turn behaves as today`,
    async () => {
      const dir = tempDir();
      const { conv, memoryPort, file } = await persistOnce(dir);
      const entry = JSON.parse(fs.readFileSync(file, "utf-8"));
      corrupt(entry);
      fs.writeFileSync(file, JSON.stringify(entry));
      const next = [...conv, assistant("a4"), user("q5")];
      assert.deepEqual(await afterRestart(dir, next, memoryPort), await baseline(next));
    });
}

test("the store repairs its directory mode and cleans stale temporary files", () => {
  const dir = path.join(tempDir(), "store");
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const stale = path.join(dir, "leftover.tmp");
  fs.writeFileSync(stale, "x".repeat(10_000));
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(stale, old, old);
  const store = new StablePrefixStore(dir);
  store.save("s", OWNER, PREFIX("p"), undefined);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(stale), false, "stale temporary file removed");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.endsWith(".json")), []);
});

test("the store follows no symlinks: entry files or its directory", () => {
  const root = tempDir();
  const dir = path.join(root, "store");
  const store = new StablePrefixStore(dir);
  store.save("s", OWNER, PREFIX("p"), undefined);
  const entry = store.entryPath("s", OWNER);
  const outside = path.join(root, "outside.json");
  fs.renameSync(entry, outside);
  fs.symlinkSync(outside, entry);
  assert.equal(store.load("s", OWNER), undefined, "a symlinked entry is not read");

  const real = path.join(root, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  const linked = path.join(root, "linked");
  fs.symlinkSync(real, linked);
  new StablePrefixStore(linked).save("s", OWNER, PREFIX("p"), undefined);
  assert.deepEqual(fs.readdirSync(real), [], "nothing written through a symlinked directory");
});
