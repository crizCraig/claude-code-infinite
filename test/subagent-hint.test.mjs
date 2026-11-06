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
import {
  createSessionNoticePlugin,
  createSubagentHookPlugin,
  PROJECT_TREES_HOOK_SUFFIX,
  SUBAGENT_RESULT_HOOK_SUFFIX,
} from "../dist/hooks.js";
import { ProjectTreesHint } from "../dist/project-trees.js";
import { MEMTREE_LOADED_NOTE, MEMTREE_TOOLS } from "../dist/memtree-mcp.js";
import { NewestTreeLookup } from "../dist/memtree-newest.js";
import {
  isSubagentCall,
  postToolUseOutput,
  SUBAGENT_RESULT_HINT,
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

test("the print-mode plugin asks the project-trees path on UserPromptSubmit when asked", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-subagent-plugin-"));
  const url = "http://127.0.0.1:12345/_ccc/hooks/token";
  const plugin = createSubagentHookPlugin(url, { tempRoot, projectTrees: true });
  try {
    const { hooks } = JSON.parse(fs.readFileSync(path.join(plugin.dir, "hooks", "hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(hooks).sort(), ["SubagentStart", "SubagentStop", "UserPromptSubmit"]);
    assert.equal(hooks.SessionStart, undefined,
      "never SessionStart: Claude Code prints its hook events on stream-json stdout");
    assert.deepEqual(hooks.UserPromptSubmit,
      [{ hooks: [{ type: "http", url: `${url}${PROJECT_TREES_HOOK_SUFFIX}`, timeout: 5 }] }]);
  } finally {
    plugin.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("proxy: the project-trees path answers a session's first prompt, once, context only", async () => {
  const upstream = await serve((req, res) => res.end("{}"));
  const trees = { trees: [{ session_id: "other", last_at: "2026-11-05T10:00:00Z",
    title: "Invoice rounding: agreed ROUND_HALF_EVEN", tree: { ref: "abc-v1-own" } }] };
  const projectTrees = new ProjectTreesHint(
    async () => ({ status: 200, body: Buffer.from(JSON.stringify(trees)) }), "o/r");
  projectTrees.prefetch();
  const memtree = new MemtreeClient({ baseUrl: upstream.url, apiKey: "offline" });
  const proxy = await startProxy({ memtree, upstreamOrigin: upstream.url, projectTrees });
  const post = async (body) => {
    const res = await fetch(`${proxy.hookUrl}${PROJECT_TREES_HOOK_SUFFIX}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.status === 204 ? null : await res.json();
  };
  const prompt = (extra = {}) => ({ session_id: SESSION, hook_event_name: "UserPromptSubmit",
    prompt: "fix the bug", ...extra });
  try {
    const out = await post(prompt());
    assert.equal(out.systemMessage, undefined, "nothing for stdout or the user");
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /Earlier sessions in this project/);
    assert.match(out.hookSpecificOutput.additionalContext, /abc-v1-own/);
    assert.equal(await post(prompt()), null, "once per session");
    const long = await post(prompt({ session_id: "cccccccc-1f1e-4c1e-9e57-2b1f3f9d2a10",
      prompt: "y".repeat(70 * 1024) }));
    assert.match(long.hookSpecificOutput.additionalContext, /abc-v1-own/, "a long prompt too");
    assert.ok(await post(prompt({ session_id: "fd0b6b1c-1f1e-4c1e-9e57-2b1f3f9d2a10" })),
      "another session gets its own");
    assert.equal(await post(prompt({ session_id: "aaaaaaaa-1f1e-4c1e-9e57-2b1f3f9d2a10",
      agent_id: "a1" })), null, "never a subagent's prompt");
    assert.equal(await post({ session_id: "bbbbbbbb-1f1e-4c1e-9e57-2b1f3f9d2a10",
      hook_event_name: "SessionStart", source: "startup" }), null, "UserPromptSubmit only");
  } finally { proxy.close(); upstream.close(); }
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
async function harness({ hint = new SubagentMemoryHint(), tree = true, lookupGate } = {}) {
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
    if (lookupGate) await lookupGate;
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

test("proxy: MemTree pausing while the tree lookup is on its way means no hint", async () => {
  let release;
  const lookupGate = new Promise((resolve) => { release = resolve; });
  const h = await harness({ lookupGate });
  try {
    await turn(h);
    const pending = subagentStart(h);
    h.status = 402;
    await turn(h, false);
    release();
    assert.equal(await pending, null, "paused by the time the tree was named");
  } finally { h.close(); }
});

test("proxy: a tree lookup that never answers delays a subagent start at most ~2.5 s", async () => {
  const h = await harness({ lookupGate: new Promise(() => {}) });
  try {
    await turn(h);
    const started = Date.now();
    assert.equal(await subagentStart(h), null);
    assert.ok(Date.now() - started < 4_000, "well within Claude Code's 5 s hook timeout");
  } finally { h.close(); }
});

// ------------------------------------------------------------------ the parent, after a subagent

test("the subagent-result line is short and names search without tree and read_lines", () => {
  assert.ok(SUBAGENT_RESULT_HINT.length < 400, SUBAGENT_RESULT_HINT.length);
  assert.match(SUBAGENT_RESULT_HINT, /mcp__memtree__search without tree/);
  assert.match(SUBAGENT_RESULT_HINT, /read_lines/);
  assert.match(SUBAGENT_RESULT_HINT, /^ccc: A subagent's result is only its final message/,
    "true at launch and at completion");
  const call = (extra = {}) => ({ hook_event_name: "PostToolUse", tool_name: "Agent",
    tool_input: { prompt: "x" }, ...extra });
  assert.ok(isSubagentCall(call()));
  assert.ok(isSubagentCall(call({ tool_name: "Task" })));
  assert.ok(isSubagentCall(call({ tool_input: { run_in_background: true } })),
    "a background launch too: -p runs launch most subagents that way");
  assert.ok(isSubagentCall(call({ tool_response: { status: "async_launched" } })));
  assert.ok(!isSubagentCall(call({ tool_name: "Bash" })));
  assert.ok(!isSubagentCall(call({ hook_event_name: "PreToolUse" })));
  assert.ok(!isSubagentCall(null));
});

test("both plugins add PostToolUse on Agent|Task only when asked", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-subagent-plugin-"));
  const url = "http://127.0.0.1:12345/_ccc/hooks/token";
  const expected = [{ matcher: "Agent|Task",
    hooks: [{ type: "http", url: `${url}${SUBAGENT_RESULT_HOOK_SUFFIX}`, timeout: 5 }] }];
  const read = (plugin) =>
    JSON.parse(fs.readFileSync(path.join(plugin.dir, "hooks", "hooks.json"), "utf8")).hooks;
  const plugins = [
    createSubagentHookPlugin(url, { tempRoot, subagentResult: true }),
    createSessionNoticePlugin(url, { tempRoot, subagentResult: true }),
    createSubagentHookPlugin(url, { tempRoot }),
    createSessionNoticePlugin(url, { tempRoot }),
  ];
  try {
    assert.deepEqual(read(plugins[0]).PostToolUse, expected);
    assert.deepEqual(read(plugins[1]).PostToolUse, expected);
    assert.equal(read(plugins[2]).PostToolUse, undefined);
    assert.equal(read(plugins[3]).PostToolUse, undefined);
  } finally {
    for (const plugin of plugins) plugin.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function subagentResult(h, extra = {}) {
  const res = await fetch(`${h.proxy.hookUrl}${SUBAGENT_RESULT_HOOK_SUFFIX}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "Agent",
      tool_input: { prompt: "read the log" }, tool_response: {}, ...extra }),
  });
  return res.status === 204 ? null : await res.json();
}

test("proxy: a subagent call points the parent at its tree unless MemTree is known broken", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await subagentResult(h), postToolUseOutput(SUBAGENT_RESULT_HINT),
      "MemTree has not answered yet (a short print run): said, as it is not known broken");
    await turn(h);
    assert.deepEqual(await subagentResult(h), postToolUseOutput(SUBAGENT_RESULT_HINT));
    assert.deepEqual(await subagentResult(h, { tool_response: { status: "async_launched" } }),
      postToolUseOutput(SUBAGENT_RESULT_HINT), "a background launch too");
    assert.equal(await subagentResult(h, { tool_name: "Bash" }), null);
    const big = "x".repeat(200 * 1024);
    assert.deepEqual(await subagentResult(h, { tool_response: { status: "completed",
      content: [{ type: "text", text: big }] } }), postToolUseOutput(SUBAGENT_RESULT_HINT),
      "a long subagent result still gets the line");
  } finally { h.close(); }
  const paused = await harness();
  try {
    paused.status = 402;
    await turn(paused, false);
    assert.equal(await subagentResult(paused), null, "paused: its tools cannot help");
  } finally { paused.close(); }
  const toolless = await harness({ hint: null });
  try {
    await turn(toolless);
    assert.equal(await subagentResult(toolless), null, "no memtree tools in the session");
  } finally { toolless.close(); }
});

