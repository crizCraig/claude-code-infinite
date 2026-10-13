// /memtree/current (the MCP tools' "current" tree) must name the tree whose
// memory is in the prompt: a compress answer that is not adopted (unusable,
// no flatten, old prefix reused, passthrough) must not move it, even when it
// carries a valid page and index. Bare read_node {"id":N} resolves against it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

const SESSION = "source-session";

async function harness() {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "offline" });
  memtree.compress = async () => null;
  memtree.indexInBackground = () => {};
  const proxy = await startProxy({ memtree,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    budgetTokensOverride: 20_000, defaultCompactTarget: undefined });
  return { proxy, memtree, seen, close() { proxy.close(); upstream.close(); } };
}

function send(h, messages) {
  const raw = JSON.stringify({ model: "claude-x", max_tokens: 100, messages });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: h.proxy.port, path: "/v1/messages",
      method: "POST", headers: { "content-type": "application/json",
        "content-length": Buffer.byteLength(raw), "x-claude-code-session-id": SESSION } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

const page = (id) => ({ memtreeUrl: `https://app/m/${id}-s`, memtreeIndex: id });
const adopted = (text, id) => ({ messages: [{ role: "user", content: text }],
  flattened_messages: [{ role: "user", content: text }], compressed: true,
  usage: { prompt_tokens_details: { cached_tokens: 1 } }, ...page(id) });
/** Compressed with a valid page/index, but no flatten: never forwarded. */
const noFlatten = (id) => ({ ...adopted("unused", id), flattened_messages: undefined });
/** Compressed, but the answer dropped the conversation: never forwarded. */
const unusable = (id) => adopted("", id);

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const memoryA = `MEMORY A [node 0] `.repeat(250);
const memoryB = `MEMORY B [node 0] `.repeat(250);

async function pointer(h) {
  const res = await fetch(`http://127.0.0.1:${h.proxy.port}/memtree/current?session=${SESSION}`);
  return (await res.json()).id;
}
function firstText(h, i) {
  const msg = JSON.parse(h.seen[i]).messages[0];
  return typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.text ?? "").join("");
}
function compactNow(h) {
  return fetch(h.proxy.hookUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION,
      prompt: "/memtree-compact" }) });
}

/** Human turn adopting A, then a `/memtree-compact` turn whose answer is `second`. */
async function compactTwice(second) {
  const h = await harness();
  let calls = 0;
  h.memtree.compress = async () => (++calls === 1 ? adopted(memoryA, A) : second);
  const msgs = [{ role: "user", content: "q" }, { role: "assistant", content: "a" },
    { role: "user", content: "x".repeat(160_000) }];
  assert.equal(await send(h, msgs), 200);
  assert.equal(await pointer(h), `${A}-s`);
  await compactNow(h);
  msgs.push({ role: "assistant", content: "a" }, { role: "user", content: "next" });
  assert.equal(await send(h, msgs), 200);
  assert.equal(calls, 2);
  return h;
}

for (const [name, result] of [["unusable", unusable(B)], ["no-flatten", noFlatten(B)]]) {
  test(`human turn: a rejected (${name}) answer keeps current at the prefix's tree`, async () => {
    const h = await compactTwice(result);
    try {
      assert.equal(firstText(h, 1), memoryA, "the old prefix rides");
      assert.equal(await pointer(h), `${A}-s`);
    } finally { h.close(); }
  });
}

test("human turn: an adopted answer moves current to its tree", async () => {
  const h = await compactTwice(adopted(memoryB, B));
  try {
    assert.equal(firstText(h, 1), memoryB);
    assert.equal(await pointer(h), `${B}-s`);
  } finally { h.close(); }
});

/** Human turn adopting A, then a tool turn that outgrows the route: recovery gets `second`. */
async function toolRecovery(second) {
  const h = await harness();
  let calls = 0;
  h.memtree.compress = async () => (++calls === 1 ? adopted(memoryA, A) : second);
  const msgs = [{ role: "user", content: "q" }, { role: "assistant", content: "a" },
    { role: "user", content: "x".repeat(160_000) }];
  assert.equal(await send(h, msgs), 200);
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "z".repeat(160_000) }] });
  assert.equal(await send(h, msgs), 200);
  assert.equal(calls, 2, "the tool turn recompressed");
  return h;
}

for (const [name, result] of [["unusable", unusable(B)], ["no-flatten", noFlatten(B)]]) {
  test(`tool turn: a rejected (${name}) recovery answer keeps current at A`, async () => {
    const h = await toolRecovery(result);
    try {
      assert.ok(!firstText(h, 1).includes("MEMORY B"));
      assert.equal(await pointer(h), `${A}-s`);
    } finally { h.close(); }
  });
}

test("tool turn: an adopted recovery answer moves current to its tree", async () => {
  const h = await toolRecovery(adopted(memoryB, B));
  try {
    assert.equal(firstText(h, 1), memoryB);
    assert.equal(await pointer(h), `${B}-s`);
  } finally { h.close(); }
});
