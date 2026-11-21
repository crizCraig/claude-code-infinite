// Use a disposable ccc home for both sides of the MCP/hook handoff.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-recall-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: "1" });
delete process.env.CCC_RECALL_WRAPPED;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { recalled, recallLine, pastRecallCount, standaloneRecall } = await import("../dist/recall.js");
const { handleMcpMessage } = await import("../dist/memtree-mcp.js");
const { MemtreeIndex, formatTail } = await import("../dist/memtree-tools.js");
const { formatSearchResults } = await import("../dist/memtree-finder.js");
const { formatDirectMcpConfig } = await import("../dist/memtree-mcp-config.js");
const { createSessionNoticePlugin } = await import("../dist/hooks.js");
const { startProxy } = await import("../dist/proxy.js");
const { MemtreeClient } = await import("../dist/memtree.js");
const example = JSON.parse(fs.readFileSync(new URL("./fixtures/memtree-page.json", import.meta.url)));
const current = "here";
const focus = new MemtreeIndex({ ...example, session_id: current });
const other = new MemtreeIndex({ ...example, session_id: "there" });
const source = { get: async tree => tree === "past" ? other : focus,
  tail: async () => formatTail({ session_id: "there", messages: [] }) };
const original = Buffer.from(JSON.stringify(focus.page.blocks));
const sent = Buffer.from("Only the recent turn remains. The billing service port is 8443");
const context = { original, sent };

async function tool(name, args, finder) {
  const id = randomUUID();
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const plain = await handleMcpMessage(call, source, finder);
  call.params._meta = { "claudecode/toolUseId": id };
  const actual = await handleMcpMessage(call, source, finder);
  assert.deepEqual(actual, plain, "notice tracking preserves the entire MCP reply");
  return { hook_event_name: "PostToolUse", session_id: current, prompt_id: "turn",
    tool_use_id: id, tool_name: "mcp__memtree__" + name, tool_response: actual.result.content };
}
const read = (tree, start, end = start) => tool("read_lines", { tree, block: 0, start, end });
const stop = { hook_event_name: "Stop", session_id: current, prompt_id: "turn" };

test("reads compare the actual returned range with the compressed context", async () => {
  assert.equal(recalled(await read("current", 5), context), undefined, "this line is still visible");
  assert.equal(recalled(await read("current", 4)), undefined, "an index alone is insufficient");
  assert.equal(recalled(await read("current", 4), { original, sent: original }), undefined);
  const batch = recalled(await read("current", 4), context);
  assert.equal(batch.past, 0);
  assert.match(recallLine([batch]), /^🌿 MemTree recalled from earlier in this session: User asks/);
  assert.doesNotMatch(recallLine([batch]), /billing-artifacts|deploy.yaml with region/);
  const leaf = recalled(await tool("read_node", { node: "current#3" }), context);
  assert.equal(leaf.label, "Bucket renamed.");
  assert.equal(recalled(await tool("search", { query: "7731", tree: "current", mode: "text" }), context).count, 1);
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
  const batch = recalled(input, context);
  assert.equal(batch.count, 2);
  assert.equal(batch.past, 2);
  assert.equal(Array.from(batch.label).length, 60);
  const line = recallLine([batch], new Date(2026, 10, 20, 8));
  assert.match(line, /^🌿 MemTree recalled from Tuesday’s session: Deployment decision x+… …and 1 more$/);
  assert.doesNotMatch(line, /PRIVATE|Already visible|[\x00-\x1f]/);
  assert.equal(recalled(input, context), undefined, "a retried PostToolUse cannot claim it twice");
});

test("a summary-only hit can identify omitted source by its recorded message time", async () => {
  const at = "2026-01-01T12:30:00Z";
  const finder = { searchSessions: async () => formatSearchResults({ hits: [{
    tree: { request_id: "r" }, session_id: current, summary: "A deployment decision", times: [at, at],
  }] }, { query: "deploy" }) };
  const input = await tool("search", { query: "deploy" }, finder);
  const batch = recalled(input, { ...context, sourceAt: time => {
    assert.equal(time, at);
    return ["bucket billing-artifacts-7731"];
  } });
  assert.equal(batch.label, "A deployment decision");
  assert.equal(batch.past, 0);
});

test("empty searches, unavailable nodes, empty tails, unrelated tools and opt-out stay silent", async () => {
  for (const [name, args] of [
    ["search", { query: "nonexistent", tree: "past", mode: "text" }],
    ["read_node", { tree: "past", id: 99 }], ["read_lines", { tree: "past", tail: true }],
    ["list", {}],
  ]) assert.equal(recalled(await tool(name, args)), undefined);
  process.env.CCC_RECALL_NOTICE = "0";
  try { assert.equal(recalled(await read("past", 4)), undefined); }
  finally { process.env.CCC_RECALL_NOTICE = "1"; }
});

test("direct Claude settings preserve paths as separate Windows arguments; separate turns claim once", async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const cli = String.raw`C:\Users\O'Brien\ccc & co\dist\cli.js`;
  const config = JSON.parse(formatDirectMcpConfig("claude-hooks", node, cli, "production"));
  for (const event of ["PostToolUse", "Stop"]) {
    const hook = config.hooks[event][0].hooks[0];
    assert.equal(hook.command, node);
    assert.deepEqual(hook.args, [cli, "recall-hook"]);
    assert.equal(hook.async, undefined);
  }
  const before = pastRecallCount(current);
  for (const input of await Promise.all([read("past", 4), tool("read_node", { node: "past#3" })])) {
    assert.equal(standaloneRecall(input), undefined);
  }
  assert.equal(pastRecallCount(current), before + 2);
  assert.equal(pastRecallCount("other-session"), 0);
  const line = standaloneRecall(stop);
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
    await post({ ...await read("past", 5), prompt_id: "interrupted" }, recallHook.hooks[0].url);
    await prompt("turn");
    await Promise.all((await Promise.all([read("past", 4), read("past", 5)]))
      .map(i => post(i, recallHook.hooks[0].url)));
    const output = await post(stop);
    assert.deepEqual(Object.keys(output), ["systemMessage"]);
    assert.match(output.systemMessage, / …and 1 more$/);
    assert.equal(await post(stop), null);
    await prompt("turn-2");
    const input = { ...await read("past", 4), prompt_id: "turn-2" };
    await post(input, recallHook.hooks[0].url);
    assert.match((await post({ ...stop, prompt_id: "turn-2" })).systemMessage, /🌿 MemTree recalled/);
  } finally {
    plugin.close();
    await proxy.drain();
  }
});

test("current-session attribution follows the selected proxy request", async () => {
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
  const proxy = await startProxy({ memtree: new MemtreeClient({ baseUrl: origin, apiKey: "fixture" }),
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
    await send(proxy.hookUrl + "/recall", await read("current", 4));
    const response = await send(proxy.hookUrl, stop);
    assert.match((await response.json()).systemMessage, /🌿 MemTree recalled from earlier in this session/);
    assert.ok(calls.every(c => !c.includes("MemTree recalled")));
  } finally {
    await proxy.drain();
    server.close();
  }
});
