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

async function listen(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccc-prefix-store-"));
}

/** One proxy process: Anthropic and MemTree stand-ins, and the given store. */
async function proxyProcess(store) {
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
  });
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: memory.origin, apiKey: "k" }),
    upstreamOrigin: upstream.origin, budgetTokensOverride: 20_000, countTokens: true,
    reqlog: { log: (r) => h.records.push(structuredClone(r)) },
    ...(store ? { stablePrefixStore: store } : {}),
  });
  h.post = async (messages, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION,
        ...headers },
      body: JSON.stringify({ model: "claude-x", max_tokens: 64,
        system: [{ type: "text", text: "sys" }], messages }),
    });
    await response.text();
    return response.status;
  };
  h.port = proxy.port;
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

  const after = await proxyProcess(new StablePrefixStore(dir));
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

async function afterRestart(dir, conv) {
  const after = await proxyProcess(new StablePrefixStore(dir));
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
  assert.deepEqual(await afterRestart(dir, edited), await baseline(edited));
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
  assert.deepEqual(await afterRestart(dir, conv), await baseline(conv));
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

const PREFIX = (fill) => ({
  originalSystemHash: "h", originalPrefixHashes: ["a", "b"],
  compressedMessages: [{ role: "user", content: fill }], compressedSystem: undefined,
  hasCompressedSystem: false, targetTokens: 10_000, explicitTarget: false,
  modelContextLimit: 200_000,
});

test("the store is bounded by total size and evicts the oldest sessions", () => {
  const dir = tempDir();
  const store = new StablePrefixStore(dir, { maxBytes: 25_000, maxEntries: 10 });
  let now = 1_000;
  for (const session of ["s1", "s2", "s3"]) {
    store.save(session, PREFIX("p".repeat(10_000)), undefined, now += 1_000);
  }
  assert.equal(store.load("s1"), undefined, "oldest evicted to fit the size bound");
  assert.equal(store.load("s2")?.prefix.compressedMessages[0].content.length, 10_000);
  assert.ok(store.load("s3"));
  const counted = new StablePrefixStore(tempDir(), { maxBytes: 1e9, maxEntries: 2 });
  for (const session of ["a", "b", "c"]) counted.save(session, PREFIX("p"), undefined, now += 1);
  assert.equal(counted.load("a"), undefined, "entry count bound");
  assert.ok(counted.load("b") && counted.load("c"));
  const big = new StablePrefixStore(tempDir(), { maxBytes: 5_000, maxEntries: 10 });
  big.save("huge", PREFIX("p".repeat(10_000)), undefined, now += 1);
  assert.equal(big.load("huge"), undefined, "an entry over the whole bound is not kept");
});
