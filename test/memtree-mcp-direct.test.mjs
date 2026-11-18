import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const mock = new URL("./fixtures/direct-mcp-fetch.mjs", import.meta.url).href;
const tree = "abcd-v1-own";
const session = "12345678-1234-1234-1234-123456789abc";

function run(t, args, messages, env = {}, config = {
  polychatApiKey: "fixture-production-key", stagingPolychatApiKey: "fixture-staging-key",
}) {
  const home = mkdtempSync(path.join(tmpdir(), "ccc-direct-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".claude-code-infinite");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const result = spawnSync(process.execPath, ["--import", mock, cli, "memtree-mcp", ...args], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, HOME: home, USERPROFILE: home,
      CCC_MEMTREE_PROXY: "http://proxy.invalid", ANTHROPIC_BASE_URL: "http://anthropic.invalid",
      CCC_MEMTREE_DIRECT: "", CCC_MEMTREE_HOST_TOKEN: "stale", CLAUDE_CODE_SESSION_ID: session,
      CCC_PROXY_VERSION: "", CCC_MEMTREE_MCP_DESKTOP: "", EXPECT_STAGING: "", ...env },
    input: messages.map((msg, id) => JSON.stringify({ jsonrpc: "2.0", id, ...msg }) + "\n").join(""),
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-(production|staging)-key/);
  return result;
}

const call = (name, args) => ({ method: "tools/call", params: { name, arguments: args } });
function results(proc) {
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stderr, "");
  return proc.stdout.trim().split("\n").map(line => JSON.parse(line).result);
}

test("direct CLI reads all six tools with the saved production key, including by session id", t => {
  const replies = results(run(t, ["--direct"], [
    { method: "initialize" }, { method: "tools/list" }, call("list", {}),
    call("search", { query: "deploy" }), call("search", { tree, mode: "text", query: "deploy" }),
    call("read_node", { tree: session, id: 0 }), call("read_lines", { node: tree + "#2" }),
    call("read_lines", { tree, tail: true }), call("handover", { tree }), call("user_messages", { tree }),
  ]));
  const [init, catalog, ...tools] = replies;
  assert.match(init.instructions, /direct mode/i);
  assert.deepEqual(catalog.tools.map(t => t.name).sort(),
    ["handover", "list", "read_lines", "read_node", "search", "user_messages"]);
  for (const result of tools) assert.ok(!result.isError, result.content[0].text);
  assert.match(tools[3].content[0].text, /is a session id.*newest tree/);
  assert.match(tools[4].content[0].text, /deploy.yaml/);
  for (const result of tools.slice(-2)) assert.match(result.content[0].text, /fixture message/);
});

test("environment opt-in selects the saved staging key and keeps it out of errors", t => {
  const [list, error] = results(run(t, ["--env", "staging"], [call("list", {}), call("list", { q: "denied" })],
    { CCC_MEMTREE_DIRECT: "1", EXPECT_STAGING: "1", CCC_MEMTREE_MCP_DESKTOP: "1" }));
  assert.ok(!list.isError);
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /403/);
});

test("current and implicit current reads fail locally with guidance in direct mode", t => {
  const messages = [
    call("search", { tree: "current", query: "deploy" }), call("search", { tree: "current", query: "deploy", mode: "text" }),
    call("read_node", { node: "current#0" }), call("read_node", { tree: " current ", id: 0 }), call("read_lines", { block: 0, start: 1, end: 2 }),
    call("read_lines", { tail: true }), call("handover", {}), call("user_messages", { tree: "current" }),
  ];
  for (const result of results(run(t, ["--env", "production", "--direct"], messages))) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /pass a tree or session id/i);
  }
});

test("direct mode reports a missing environment key or invalid --env without making a request", t => {
  for (const [env, message] of [["staging", /no.*key.*staging/i], ["other", /--env.*staging.*production/i]]) {
    const result = run(t, ["--direct", "--env", env], [], {}, { polychatApiKey: "fixture-production-key" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});

test("direct mode is opt-in even when a key is saved", t => {
  const [answer] = results(run(t, [], [call("list", {})], {
    CCC_MEMTREE_DIRECT: "0", CCC_MEMTREE_PROXY: "", ANTHROPIC_BASE_URL: "",
  }));
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /need a running ccc session/);
});
