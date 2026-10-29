// Subagents and resumed sessions reach the MemTree tools without a ToolSearch step.
// 2026-10-29, Craig's 4-week coordinator session (resumed on ccc 1.0.30, Claude Code 2.1.310):
// 36 memtree calls in total, none in its last 5 days. Its tools were on the wire with full
// schemas (alwaysLoad), but a resumed session keeps the MCP instructions and deferred-tools
// list it was first given (here 2026-09-29, before alwaysLoad): that list still named them,
// and its instructions were the first one-line version. Only the tools' own descriptions
// are sent fresh. A subagent it spawned had the tools, but nothing said whose memory to search.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { createSubagentHookPlugin } from "../dist/hooks.js";
import { MEMTREE_LOADED_NOTE, MEMTREE_TOOLS } from "../dist/memtree-mcp.js";
import { NewestTreeLookup } from "../dist/memtree-newest.js";
import {
  SubagentMemoryHint,
  subagentMemoryHintText,
  subagentStartOutput,
} from "../dist/subagent-hint.js";

const SESSION = "6472823f-ca4f-4027-9b89-64a81c367dc3";
const REQUEST_ID = "ab7dc50a-5e7d-4a9e-933f-ff7a3735f809";
const REF = `${REQUEST_ID}-v1-own`;
const HINT =
  `ccc: You are a subagent of session ${SESSION}, whose memory is MemTree tree ${REF}; ` +
  "your own work is indexed too. Before re-deriving earlier decisions, findings or commands " +
  "from the parent's work, search its memory: mcp__memtree__search with tree " +
  `${REF} (or without tree to search all sessions).`;

// ------------------------------------------------------------------ texts

test("the subagent hint names the parent session and its tree, in one short paragraph", () => {
  assert.equal(subagentMemoryHintText(SESSION, REF), HINT);
  assert.ok(HINT.length < 450, `short: it is in every subagent turn (${HINT.length})`);
  assert.equal(subagentMemoryHintText("bad id\n", REF), undefined);
  assert.equal(subagentMemoryHintText(SESSION, "ref with spaces"), undefined);
  assert.equal(subagentMemoryHintText(SESSION, ""), undefined);
  assert.deepEqual(subagentStartOutput("x"), {
    hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "x" },
  });
});

test("search's description (live on every request) says the tools are loaded: no ToolSearch", () => {
  const search = MEMTREE_TOOLS.find((tool) => tool.name === "search");
  assert.ok(search.description.endsWith(MEMTREE_LOADED_NOTE));
  assert.match(MEMTREE_LOADED_NOTE, /loaded up front: call them directly, with no ToolSearch step/);
  assert.match(MEMTREE_LOADED_NOTE, /older deferred-tools list/);
  for (const tool of MEMTREE_TOOLS) assert.deepEqual(tool._meta, { "anthropic/alwaysLoad": true });
});

test("a hint gate is on until disabled", () => {
  const gate = new SubagentMemoryHint();
  assert.equal(gate.enabled, true);
  gate.disable();
  assert.equal(gate.enabled, false);
});

// ------------------------------------------------------------------ -p plugin

test("the print-mode plugin has only the subagent hooks, pointed at the proxy", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-subagent-plugin-"));
  const url = "http://127.0.0.1:12345/_ccc/hooks/token";
  const plugin = createSubagentHookPlugin(url, { tempRoot });
  try {
    const { hooks } = JSON.parse(fs.readFileSync(path.join(plugin.dir, "hooks", "hooks.json"), "utf8"));
    const hook = [{ hooks: [{ type: "http", url, timeout: 5 }] }];
    assert.deepEqual(hooks, { SubagentStart: hook, SubagentStop: hook });
    assert.ok(!fs.existsSync(path.join(plugin.dir, "commands")), "no slash commands");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(plugin.dir, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "ccc");
  } finally {
    plugin.close();
    assert.ok(!fs.existsSync(plugin.dir));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  assert.throws(() => createSubagentHookPlugin("http://example.com/x", { tempRoot }), /localhost/);
});

// ------------------------------------------------------------------ through the proxy

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => handler(req, res, raw));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

/** MemTree answers `h.status` (402: paused) or passes the conversation through. */
async function harness({ hint = new SubagentMemoryHint(), tree = true } = {}) {
  const h = { status: undefined, asked: 0 };
  const upstream = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const memory = await serve((req, res, raw) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 202; return res.end("{}"); }
    if (h.status) {
      res.statusCode = h.status;
      return res.end(JSON.stringify({ detail: "Payment required for MemTree API" }));
    }
    const body = JSON.parse(raw);
    if (body.index_only) return res.end(JSON.stringify({ messages: [] }));
    res.end(JSON.stringify({ messages: body.messages }));
  });
  const memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  const newestTrees = new NewestTreeLookup(async () => {
    h.asked++;
    const latest = tree ? { request_id: REQUEST_ID, ref: REF,
      links: { url: `https://app.polychat.co/m/${REF}` } } : null;
    return { status: 200, body: Buffer.from(JSON.stringify({
      sessions: [{ session_id: SESSION, latest_tree: latest }] })) };
  });
  h.memtree = memtree;
  h.turns = 0;
  h.proxy = await startProxy({
    memtree, upstreamOrigin: upstream.url, newestTrees, ...(hint ? { subagentHint: hint } : {}),
  });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); };
  return h;
}

/** A main turn, then MemTree's answer (`ok`: working) settles. */
async function turn(h, ok = true) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
    body: JSON.stringify({ model: "claude-opus-4-7", max_tokens: 1000,
      messages: [{ role: "user", content: `hello ${h.turns++}` }] }),
  });
  await response.text();
  const settled = () => ok ? h.memtree.answering === true
    : h.memtree.paymentRequiredDetail !== null;
  for (let i = 0; i < 100 && !settled(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(settled(), "MemTree's answer arrived");
}

async function subagentStart(h, extra = {}) {
  const res = await fetch(h.proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, hook_event_name: "SubagentStart",
      agent_id: "agent-1", agent_type: "general-purpose", ...extra }),
  });
  return res.status === 204 ? null : await res.json();
}

test("proxy: SubagentStart while MemTree works gives the subagent the hint", async () => {
  const h = await harness();
  try {
    assert.equal(await subagentStart(h), null, "MemTree has not answered yet: nothing said");
    await turn(h);
    assert.deepEqual(await subagentStart(h), subagentStartOutput(HINT));
    assert.deepEqual(await subagentStart(h, { agent_id: "agent-2", agent_type: "Explore" }),
      subagentStartOutput(HINT), "every subagent, background and nested ones too");
  } finally { h.close(); }
});

test("proxy: no hint while MemTree is paused, without a parent tree, or without the tools", async () => {
  const paused = await harness();
  try {
    paused.status = 402;
    await turn(paused, false);
    assert.equal(await subagentStart(paused), null, "paused: its tools cannot help");
  } finally { paused.close(); }
  const treeless = await harness({ tree: false });
  try {
    await turn(treeless);
    assert.equal(await subagentStart(treeless), null, "no tree yet");
  } finally { treeless.close(); }
  const toolless = await harness({ hint: null });
  try {
    await turn(toolless);
    assert.equal(await subagentStart(toolless), null, "no memtree tools in the session");
  } finally { toolless.close(); }
  const gate = new SubagentMemoryHint();
  const withdrawn = await harness({ hint: gate });
  try {
    await turn(withdrawn);
    gate.disable();
    assert.equal(await subagentStart(withdrawn), null, "the MCP server failed to register");
  } finally { withdrawn.close(); }
});
