// Use a disposable ccc home for both sides of the MCP/hook handoff.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-recall-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: "1" });
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
delete process.env.CCC_RECALL_WRAPPED;
after(() => fs.rmSync(home, { recursive: true, force: true }));

// Each scenario may reuse the same simulated Claude prompt and session IDs.
beforeEach(() => fs.rmSync(path.join(home, ".claude-code-infinite"), { recursive: true, force: true }));

const { beginRecall, recalled: consume, recallLine, pastRecallCount, standaloneRecall: directHook } = await import("../dist/recall.js");
const { handleMcpMessage } = await import("../dist/memtree-mcp.js");
const { MemtreeIndex, formatTail } = await import("../dist/memtree-tools.js");
const { formatSearchResults } = await import("../dist/memtree-finder.js");
const { formatDirectMcpConfig } = await import("../dist/memtree-mcp-config.js");
const { createSessionNoticePlugin } = await import("../dist/hooks.js");
const { startProxy } = await import("../dist/proxy.js");
const { MemtreeClient } = await import("../dist/memtree.js");
const example = JSON.parse(fs.readFileSync(new URL("./fixtures/memtree-page.json", import.meta.url)));
const current = "here";
const account = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "fixture" }).storageIdentity;
const recalled = (input, scope = account) => consume(input, scope);
const standaloneRecall = input => directHook(input, account);
const focus = new MemtreeIndex({ ...example, session_id: current });
const other = new MemtreeIndex({ ...example, session_id: "there" });
const source = { get: async tree => tree === "past" ? other : focus,
  tail: async () => formatTail({ session_id: "there", messages: [] }) };

async function tool(name, args, finder, { id = randomUUID(), session = current, scope = account, tree = source, prompt = "turn", agent } = {}) {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const hook = { session_id: session, prompt_id: prompt, agent_id: agent, tool_use_id: id, tool_name: "mcp__memtree__" + name };
  await beginRecall({ ...hook, hook_event_name: "PreToolUse" }, scope);
  const plain = await handleMcpMessage(call, tree, finder);
  call.params._meta = { "claudecode/toolUseId": id };
  const actual = await handleMcpMessage(call, tree, finder, undefined, undefined, false, false, { account: scope, session });
  assert.deepEqual(actual, plain, "notice tracking preserves the entire MCP reply");
  return { ...hook, hook_event_name: "PostToolUse", tool_response: actual.result.content };
}
const read = (tree, start, end = start, caller) => tool("read_lines", { tree, block: 0, start, end }, undefined, caller);
const stop = { hook_event_name: "Stop", session_id: current, prompt_id: "turn" };

test("search, read_node and read_lines stay silent for the calling session", async () => {
  for (const input of [
    await read("current", 4), await tool("read_node", { node: "current#3" }),
    await tool("search", { query: "7731", tree: "current", mode: "text" }),
  ]) assert.equal(await recalled(input), undefined);
});

test("spilled MCP text must match the saved answer in the calling session", async () => {
  const input = await read("past", 4);
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, "projects");
  const dir = path.join(projects, "fixture", current, "tool-results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mcp-memtree-read_lines-fixture.txt");
  const pointer = [{ type: "text", text: "Error: result (100,021 characters) exceeds maximum allowed tokens. Output has been saved to " + file + ".\nFormat: Plain text" }];
  fs.writeFileSync(file, input.tool_response[0].text);
  assert.equal((await recalled({ ...input, tool_response: pointer })).count, 1);
  fs.writeFileSync(file, "other answer");
  assert.equal(await recalled({ ...await read("past", 4), tool_response: pointer }), undefined);
});

test("a replayed tool ID cannot cross account or calling session", async () => {
  const input = await read("past", 4);
  assert.equal(await recalled(input, "another-account"), undefined);
  assert.equal(await recalled({ ...input, session_id: "another-session" }), undefined);
  assert.equal((await recalled(input)).count, 1);
});

test("a new invocation cannot reuse an interrupted receipt even for byte-identical results", async () => {
  const input = await read("past", 4);
  await standaloneRecall({ ...input, hook_event_name: "PreToolUse" });
  // The replacement MCP registration produced the same answer without writing a matching receipt.
  assert.equal(await recalled(input), undefined);
});

test("a mismatched answer, an empty replay and an expired receipt stay silent", async () => {
  const make = (query, id) => tool("search", { query, tree: "past", mode: "text" }, undefined, { id });
  const first = await make("7731", randomUUID());
  assert.equal(await recalled({ ...first, tool_response: [{ type: "text", text: "different answer" }] }), undefined);
  const old = await make("7731", randomUUID());
  assert.equal(await recalled(await make("no-match", old.tool_use_id)), undefined);
  const expired = await read("past", 4);
  const now = Date.now;
  try {
    Date.now = () => now() + 2 * 86400000;
    assert.equal(await recalled(expired), undefined);
  } finally { Date.now = now; }
});

test("session notices use local calendar days and the available page time on older trees", async () => {
  const now = new Date(2026, 10, 20, 0, 5);
  for (const [at, label] of [
    [new Date(2026, 10, 19, 23, 58).toISOString(), "yesterday’s session"],
    [new Date(2026, 10, 17, 23, 58).toISOString(), "Tuesday’s session"],
    [new Date(2026, 10, 3, 13).toISOString(), "a session on Nov 3"],
    [undefined, "a past session"],
  ]) {
    const index = new MemtreeIndex({ ...other.page, created_at: at });
    const input = await tool("read_node", { node: "past#3" }, undefined, { tree: { get: async () => index } });
    assert.equal(recallLine([await recalled(input)], now), "🌿 MemTree recalled from " + label + ": Bucket renamed.");
  }
});

test("a dated hit supplies the session date for an undated first hit from the same session", async () => {
  const hit = { tree: { request_id: "r" }, session_id: "older", summary: "Original label" };
  const at = new Date(2026, 10, 3, 12).toISOString();
  const finder = { searchSessions: async () => formatSearchResults({ hits: [hit, { ...hit, times: [at, at] }] }, { query: "deploy" }) };
  const batch = await recalled(await tool("search", { query: "deploy" }, finder));
  assert.match(recallLine([batch], new Date(2026, 10, 20)), /from a session on Nov 3: Original label/);
});

test("grouped and mixed search results use only qualifying source summaries", async () => {
  const at = new Date(2026, 10, 17, 23, 58).toISOString();
  const hit = (session_id, summary, snippet) => ({ id: session_id, session_id, tree: { request_id: "ref" },
    summary, snippet, times: [at, at] });
  const finder = { searchSessions: async () => formatSearchResults({ groups: [{ embedding_model: "fixture", hits: [
    hit(current, "Already visible", "The billing service port is 8443"),
    hit("past-a", "Deployment\n\x1b[31mdecision\x1b[0m " + "x".repeat(80), "PRIVATE TRANSCRIPT"),
    hit("past-b", "", "PRIVATE TRANSCRIPT"),
  ] }] }, { query: "q" }) };
  const input = await tool("search", { query: "q" }, finder);
  const batch = await recalled(input);
  assert.equal(batch.count, 2);
  assert.equal(Array.from(batch.label).length, 60);
  const line = recallLine([batch], new Date(2026, 10, 20, 8));
  assert.match(line, /^🌿 MemTree recalled from Tuesday’s session: Deployment decision x+… …and 1 more$/);
  assert.doesNotMatch(line, /PRIVATE|Already visible|[\x00-\x1f]/);
  assert.equal(await recalled(input), undefined, "a retried PostToolUse cannot claim it twice");
});

test("empty searches, unavailable nodes, empty tails, unrelated tools and opt-out stay silent", async () => {
  for (const [name, args] of [
    ["search", { query: "nonexistent", tree: "past", mode: "text" }],
    ["read_node", { tree: "past", id: 99 }], ["read_lines", { tree: "past", tail: true }],
    ["list", {}],
  ]) assert.equal(await recalled(await tool(name, args)), undefined);
  process.env.CCC_RECALL_NOTICE = "0";
  try { assert.equal(await recalled(await read("past", 4)), undefined); }
  finally { process.env.CCC_RECALL_NOTICE = "1"; }
});

test("direct Claude settings preserve paths as separate Windows arguments; separate turns claim once", async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const cli = String.raw`C:\Users\O'Brien\ccc & co\dist\cli.js`;
  const config = JSON.parse(formatDirectMcpConfig("claude-hooks", node, cli, "production"));
  for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
    const hook = config.hooks[event][0].hooks[0];
    assert.equal(hook.command, node);
    assert.deepEqual(hook.args, [cli, "recall-hook"]);
    assert.equal(hook.async, undefined);
  }
  const before = pastRecallCount(current, account);
  for (const input of await Promise.all([read("past", 4), tool("read_node", { node: "past#3" })])) {
    assert.equal(await standaloneRecall(input), undefined);
  }
  assert.equal(pastRecallCount(current, account), before + 2);
  assert.equal(pastRecallCount("other-session", account), 0);
  const line = await standaloneRecall(stop);
  assert.match(line, /^🌿 MemTree recalled from a past session: .* …and 1 more$/);
  assert.doesNotMatch(line, /billing-artifacts/);
});

test("ccc's interactive HTTP hooks merge recalls at Stop and discard interrupted prompts", async () => {
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "fixture" });
  const proxy = await startProxy({ memtree, visibleRecall: true });
  const plugin = createSessionNoticePlugin(proxy.hookUrl, { recall: true, subagentResult: true });
  try {
    const config = JSON.parse(fs.readFileSync(path.join(plugin.dir, "hooks/hooks.json")));
    assert.equal(config.hooks.PostToolUse.length, 2);
    const recallHook = config.hooks.PostToolUse.find(h => new RegExp(h.matcher).test("mcp__memtree__search"));
    const post = async (input, url = proxy.hookUrl) => {
      const res = await fetch(url, { method: "POST", body: JSON.stringify(input) });
      return res.status === 204 ? null : res.json();
    };
    const prompt = id => post({ hook_event_name: "UserPromptSubmit", session_id: current, prompt_id: id, prompt: "hello" });
    await prompt("interrupted");
    await post(await read("past", 5, 5, { prompt: "interrupted" }), recallHook.hooks[0].url);
    await prompt("turn");
    await Promise.all((await Promise.all([read("past", 4), read("past", 5)]))
      .map(i => post(i, recallHook.hooks[0].url)));
    const output = await post(stop);
    assert.deepEqual(Object.keys(output), ["systemMessage"]);
    assert.match(output.systemMessage, / …and 1 more$/);
    await post({ ...stop, agent_id: "continued", hook_event_name: "SubagentStart" });
    await post(await read("past", 4, 4, { agent: "continued" }), recallHook.hooks[0].url);
    assert.equal(await post(stop), null);
    await prompt("turn-2");
    assert.match((await post({ ...stop, prompt_id: "turn-2" })).systemMessage, /MemTree recalled/);
    await prompt("turn-3");
    const input = await read("past", 4, 4, { prompt: "turn-3" });
    await post(input, recallHook.hooks[0].url);
    assert.match((await post({ ...stop, prompt_id: "turn-3" })).systemMessage, /🌿 MemTree recalled/);
  } finally {
    plugin.close();
    await proxy.drain();
  }
});

test("wrapped hooks skip missing receipts even if they arrive later", async () => {
  const proxy = await startProxy({ visibleRecall: true,
    memtree: new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "fixture" }) });
  const hook = { ...stop, tool_use_id: randomUUID(), tool_name: "mcp__memtree__read_node" };
  const post = (url, input) => fetch(url, { method: "POST", body: JSON.stringify(input) });
  try {
    await post(proxy.hookUrl, { ...stop, hook_event_name: "UserPromptSubmit", prompt: "hello" });
    await beginRecall({ ...hook, hook_event_name: "PreToolUse" }, account);
    let publish;
    const reply = await handleMcpMessage({ id: 1, method: "tools/call", params: {
      name: "read_node", arguments: { node: "past#3" }, _meta: { "claudecode/toolUseId": hook.tool_use_id },
    } }, source, undefined, undefined, undefined, false, false, {
      account, session: current, afterReply: write => { publish = write; },
    });
    assert.equal((await post(proxy.hookUrl + "/recall", {
      ...hook, hook_event_name: "PostToolUse", tool_response: reply.result.content,
    })).status, 204);
    const response = await post(proxy.hookUrl, stop);
    assert.equal(response.status, 204);
    await publish();
    assert.equal((await post(proxy.hookUrl, stop)).status, 204);
  } finally { await proxy.drain(); }
});

test("wrapped reads of compressed-away current-session content stay silent", async () => {
  const secret = "I created deploy.yaml with region us-west2 and bucket billing-artifacts-7731";
  const calls = [];
  const kept = "compressed history of the billing project. ".repeat(6);
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/context_memory")) {
      const messages = [{ role: "user", content: kept }];
      return res.end(JSON.stringify({ compressed: true, messages, flattened_messages: messages,
        usage: { prompt_tokens: 300000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 1 } } }));
    }
    calls.push(raw);
    res.end(JSON.stringify({ type: "message", id: "m", role: "assistant", model: "claude-x", stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }], usage: { input_tokens: 200, output_tokens: 2 } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const memtree = new MemtreeClient({ baseUrl: origin, apiKey: "fixture" });
  const proxy = await startProxy({ memtree,
    upstreamOrigin: origin, visibleRecall: true });
  const send = (url, body, headers = {}) => fetch(url, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers } });
  try {
    await send(proxy.hookUrl, { ...stop, hook_event_name: "UserPromptSubmit", prompt: "question" });
    await send(`http://127.0.0.1:${proxy.port}/v1/messages`,
      { model: "claude-x", max_tokens: 64, messages: [
        { role: "user", content: "start" }, { role: "assistant", content: secret }, { role: "user", content: "question" },
      ] }, { "x-claude-code-session-id": current });
    assert.equal(calls.some(c => c.includes(kept) && !c.includes(secret)), true, "fixture compressed the history");
    await send(proxy.hookUrl + "/recall", await tool("read_lines", { tree: "current", block: 0, start: 4, end: 4 }, undefined, { scope: memtree.storageIdentity }));
    const response = await send(proxy.hookUrl, stop);
    const output = response.status === 204 ? {} : await response.json();
    assert.doesNotMatch(output.systemMessage ?? "", /MemTree recalled/);
    assert.ok(calls.every(c => !c.includes("MemTree recalled")));
  } finally {
    await proxy.drain();
    server.close();
  }
});

test("direct background recalls arriving after the parent Stop appear once on its next Stop", async () => {
  const event = { ...stop, prompt_id: "background-parent" };
  await standaloneRecall(await read("past", 4, 4, { prompt: event.prompt_id }));
  assert.match(await standaloneRecall(event), /MemTree recalled/);
  await standaloneRecall(await read("past", 4, 4, { prompt: "agent-prompt", agent: "bg" }));
  assert.equal(await standaloneRecall(event), undefined);
  const next = { ...stop, prompt_id: "next-parent" };
  assert.match(await standaloneRecall(next), /🌿 MemTree recalled/);
  assert.equal(await standaloneRecall(next), undefined);
});

for (const scenario of ["teammate prompt", "late background agent", "late background agent without a new prompt"]) {
  test("wrapped Stop preserves a recall across a " + scenario, async () => {
    const proxy = await startProxy({ visibleRecall: true,
      memtree: new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "fixture" }) });
    const post = async (event, suffix = "") => {
      const response = await fetch(proxy.hookUrl + suffix, { method: "POST", body: JSON.stringify(event) });
      return response.status === 204 ? undefined : (await response.json()).systemMessage;
    };
    const prompt = { ...stop, hook_event_name: "UserPromptSubmit", prompt: "hello" };
    try {
      await post(prompt);
      let next = stop;
      if (scenario === "teammate prompt") {
        await post(await read("past", 4), "/recall");
        await post({ ...prompt, session_id: "teammate", prompt_id: "teammate-turn" });
      } else {
        const agent = { ...stop, prompt_id: "agent-prompt", agent_id: "bg" };
        await post({ ...agent, hook_event_name: "SubagentStart" });
        await post(stop);
        await post(await read("past", 4, 4, { prompt: agent.prompt_id, agent: agent.agent_id }), "/recall");
        await post({ ...agent, hook_event_name: "SubagentStop" });
        next = { ...stop, prompt_id: "next" };
        if (scenario === "late background agent") await post({ ...prompt, prompt_id: next.prompt_id });
      }
      assert.match(await post(next), /🌿 MemTree recalled/);
      assert.equal(await post(next), undefined);
    } finally { await proxy.drain(); }
  });
}

test("direct PostToolUse tries a missing receipt once", async t => {
  const input = await read("past", 4);
  await standaloneRecall({ ...input, hook_event_name: "PreToolUse" });
  const renames = t.mock.method(fs.promises, "rename");
  assert.equal(await standaloneRecall(input), undefined);
  assert.equal(renames.mock.callCount(), 1);
});

test("repeated Stops racing after another recall cannot announce the same prompt again", async () => {
  const prompt = "continued-prompt";
  const event = { ...stop, prompt_id: prompt };
  const recall = () => read("past", 4, 4, { prompt }).then(standaloneRecall);
  assert.equal(await standaloneRecall(event), undefined);
  await recall();
  const first = await Promise.all([standaloneRecall(event), standaloneRecall(event)]);
  assert.equal(first.filter(Boolean).length, 1);
  assert.match(first.find(Boolean), /MemTree recalled/);
  await Promise.all([recall(), recall()]);
  assert.deepEqual(await Promise.all([standaloneRecall(event), standaloneRecall(event)]), [undefined, undefined]);
});

test("exit counts are isolated when accounts resume the same Claude session", async () => {
  const session = "shared-session";
  for (const scope of [account, "another-account", account]) {
    await directHook(await read("past", 4, 4, { session, scope }), scope);
  }
  assert.equal(pastRecallCount(session, account), 2);
  assert.equal(pastRecallCount(session, "another-account"), 1);
});

test("wrapped PreToolUse releases Claude while ticket publication is blocked", async t => {
  const proxy = await startProxy({ visibleRecall: true,
    memtree: new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "fixture" }) });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const hook = await read("past", 4);
  const post = (input, suffix = "", signal) =>
    fetch(proxy.hookUrl + suffix, { method: "POST", body: JSON.stringify(input), signal });
  try {
    await post({ ...stop, hook_event_name: "UserPromptSubmit", prompt: "question" });
    const rename = fs.promises.rename;
    const mock = t.mock.method(fs.promises, "rename", async (...args) => {
      entered();
      await gate;
      return rename(...args);
    });
    const pre = await post({ ...hook, hook_event_name: "PreToolUse" }, "/recall", AbortSignal.timeout(5000));
    assert.equal(pre.status, 204);
    await started;
    mock.mock.restore();
    await post(hook, "/recall"); // Identical answer with the old ticket still on disk.
    assert.equal((await post(stop)).status, 204);
  } finally {
    release();
    await proxy.drain();
  }
});
