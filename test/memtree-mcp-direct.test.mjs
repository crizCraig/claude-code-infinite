import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const mock = new URL("./fixtures/direct-mcp-https.mjs", import.meta.url).href;
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
      CCC_MEMTREE_HOST_TOKEN: "stale", CLAUDE_CODE_SESSION_ID: session,
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

test("explicit direct mode selects the saved staging key and keeps it out of errors", t => {
  const [list, error] = results(run(t, ["--direct", "--env", "staging"], [call("list", {}), call("list", { q: "denied" })],
    { EXPECT_STAGING: "1", CCC_MEMTREE_MCP_DESKTOP: "1" }));
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
    CCC_MEMTREE_DIRECT: "1", CCC_MEMTREE_PROXY: "", ANTHROPIC_BASE_URL: "",
  }));
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /need a running ccc session/);
});

test("the legacy environment flag leaves an unrouted desktop server inert", t => {
  const [catalog] = results(run(t, [], [{ method: "tools/list" }], {
    CCC_MEMTREE_DIRECT: "1", CCC_MEMTREE_MCP_DESKTOP: "1",
    CCC_MEMTREE_PROXY: "", ANTHROPIC_BASE_URL: "", HTTPS_PROXY: "",
  }));
  assert.deepEqual(catalog.tools, []);
});

test("proxy mode ignores extra flags and positionals", t => {
  const [reply] = results(run(t, ["extra", "--unknown", "--env", "other"], [{ method: "initialize" }]));
  assert.doesNotMatch(reply.instructions, /direct mode/i);
});

test("direct mode refuses disabled TLS verification at startup", t => {
  const result = run(t, ["--direct"], [], { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

for (const [variable, value] of [
  ...["stream", "http", "net", "tls", "*", "other"].map(value => ["NODE_DEBUG", value]),
  ["NODE_OPTIONS", "--inspect=127.0.0.1:0"],
  ["NODE_OPTIONS", '--no-warnings "--trace_tls"'],
]) {
  test(`direct mode refuses ${variable}=${value} at startup`, t => {
    const result = run(t, ["--direct"], [call("list", {})], { [variable]: value });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(`Unset ${variable}`));
  });
}

test("direct mode accepts unrelated NODE_OPTIONS", t => {
  const [list] = results(run(t, ["--direct"], [call("list", {})], {
    NODE_OPTIONS: "--max-old-space-size=256 --no-warnings",
  }));
  assert.ok(!list.isError);
});

test("direct requests bypass the global transport and environment proxy", t => {
  const [list] = results(run(t, ["--direct"], [call("list", {})], {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "",
  }));
  assert.ok(!list.isError, list.content[0].text);
});

test("JSON errors without a detail field redact escaped keys before displaying the body", t => {
  const [reply] = results(run(t, ["--direct"], [call("list", { q: "nested" })]));
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /"message":"\[redacted\]"/);
});

for (const q of ["plain", "title"]) {
  test(`direct mode redacts the key before truncating a ${q} response`, t => {
    const [reply] = results(run(t, ["--direct"], [call("list", { q })]));
    assert.equal(Boolean(reply.isError), q === "plain");
    assert.doesNotMatch(reply.content[0].text, /fixture-pro/);
    assert.match(reply.content[0].text, /x\[redacted\]/);
  });
}

function runFinder(code, env = {}) {
  const module = new URL("../dist/memtree-mcp.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { SessionFinder } from ${JSON.stringify(module)};
    const finder = new SessionFinder({ direct: { baseUrl: "https://api.polychat.co", apiKey: "fixture-production-key" } });
    ${code}
  `;
  const result = spawnSync(process.execPath, ["--import", mock, "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("JSON detail is sanitized before SessionFinder throws a tool error", () => {
  runFinder(String.raw`await assert.rejects(finder.listSessions({ q: "denied" }), /HTTP 403 \[redacted\]/);`);
});

test("Node connection diagnostics keep the authorization header private", () => {
  const result = runFinder("await finder.listSessions({});", { NODE_DEBUG: "http,https" });
  assert.ok(!result.stderr.includes("fixture-production-key"));
});
