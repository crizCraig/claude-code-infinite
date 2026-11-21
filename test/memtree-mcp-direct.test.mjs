import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./fixtures/direct-mcp-cli.mjs", import.meta.url));
const mock = new URL("./fixtures/direct-mcp-https.mjs", import.meta.url).href;
const tree = "abcd-v1-own";
const session = "12345678-1234-1234-1234-123456789abc";

function run(t, args, messages, env = {}, config = {
  polychatApiKey: "fixture-production-key", stagingPolychatApiKey: "fixture-staging-key",
}, nodeArgs = [], setupHome = () => {}) {
  const home = mkdtempSync(path.join(tmpdir(), "ccc-direct-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".claude-code-infinite");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const cwd = setupHome(home) ?? home;
  const result = spawnSync(process.execPath, [...nodeArgs, cli, "memtree-mcp", ...args], {
    cwd, // Keep any Node profile files inside the disposable directory.
    // NODE_DEBUG=* can log several MiB of ESM loader diagnostics before startup.
    encoding: "utf8", timeout: 15000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, HOME: home, USERPROFILE: home,
      CCC_MEMTREE_PROXY: "http://proxy.invalid", ANTHROPIC_BASE_URL: "http://anthropic.invalid",
      CCC_MEMTREE_HOST_TOKEN: "stale", CLAUDE_CODE_SESSION_ID: session,
      CCC_PROXY_VERSION: "", CCC_MEMTREE_MCP_DESKTOP: "", EXPECT_STAGING: "", ...env },
    input: messages.map((msg, id) => JSON.stringify({ jsonrpc: "2.0", id, ...msg }) + "\n").join(""),
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-(production|staging)-key/);
  return { ...result, home };
}

const call = (name, args) => ({ method: "tools/call", params: { name, arguments: args } });
function results(proc) {
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stderr, "");
  return proc.stdout.trim().split("\n").map(line => JSON.parse(line).result);
}

const installedCli = realpathSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url)));
const printEnv = { CHECK_KEY_UNREAD: "1", CHECK_NO_SPAWN: "1", CCC_MEMTREE_MCP_DESKTOP: "1" };

test("--print-config emits Codex TOML by default, without reading the key", t => {
  const result = run(t, ["--print-config"], [], printEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[mcp_servers\.memtree\]$/m);
  const node = /^command = '([^']+)'$/m.exec(result.stdout)?.[1];
  assert.ok(node && path.isAbsolute(node));
  assert.equal(realpathSync(node), realpathSync(process.execPath));
  assert.ok(result.stdout.includes(`args = ['${installedCli}', 'memtree-mcp', '--direct']`));
  assert.match(result.stdout, /^env = \{ NODE_OPTIONS = "" \}$/m);
  const explicit = run(t, ["--print-config", "--format", "codex"], [], printEnv);
  assert.equal(explicit.stdout, result.stdout);
});

test("--print-config accepts claude-hooks at the CLI", t => {
  const result = run(t, ["--print-config", "--format", "claude-hooks", "--env", "staging"], [], printEnv);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.ok(config.hooks.PostToolUse[0].hooks[0].args.includes(installedCli));
});

test("--print-config emits pasteable JSON for staging without reading the key", t => {
  const result = run(t, ["--print-config", "--format", "json", "--env", "staging"], [], printEnv);
  assert.equal(result.status, 0, result.stderr);
  const { mcpServers: { memtree } } = JSON.parse(result.stdout);
  assert.ok(path.isAbsolute(memtree.command));
  assert.equal(realpathSync(memtree.command), realpathSync(process.execPath));
  assert.deepEqual(memtree.args, [installedCli, "memtree-mcp", "--direct", "--env", "staging"]);
  assert.deepEqual(memtree.env, { NODE_OPTIONS: "" });
});

test("--print-config explains the resolved Node fallback and keeps JSON parseable", t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ccc-node-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = path.join(dir, "node");
  writeFileSync(node, "");
  for (const format of ["codex", "json"]) {
    const result = run(t, ["--print-config", "--format", format], [], { ...printEnv, TEST_NODE_BINARY: node });
    assert.equal(result.status, 0, result.stderr);
    assert.match(format === "json" ? result.stderr : result.stdout, /^# .*resolved Node.*--print-config/m);
    if (format === "json") assert.equal(JSON.parse(result.stdout).mcpServers.memtree.command, node);
    else assert.ok(result.stdout.includes(`command = '${node}'`));
  }
});

test("--print-config rejects invalid options without echoing their values", t => {
  for (const args of [["--format", "fixture-production-key"], ["--env", "local"], ["--direct"]]) {
    const result = run(t, ["--print-config", ...args], [], printEnv);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage: ccc memtree-mcp --print-config/);
  }
});

test("--print-config quotes Windows paths and paths containing apostrophes", async () => {
  const { formatDirectMcpConfig } = await import("../dist/memtree-mcp-config.js");
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const cli = String.raw`C:\Users\Alex\MemTree\dist\cli.js`;
  const toml = formatDirectMcpConfig("codex", node, cli, "staging");
  assert.ok(toml.includes(`command = '${node}'`));
  assert.ok(toml.includes(`args = ['${cli}', 'memtree-mcp', '--direct', '--env', 'staging']`));
  const unusual = cli.replace("Alex", "O'Brien");
  assert.ok(formatDirectMcpConfig("codex", node, unusual, "production").includes(JSON.stringify(unusual)));
});

test("--print-config prefers a Homebrew symlink only while it resolves to this Node", {
  skip: process.platform === "win32",
}, async t => {
  const { directMcpNodePath } = await import("../dist/memtree-mcp-config.js");
  const prefix = realpathSync(mkdtempSync(path.join(tmpdir(), "ccc-brew-")));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const node = path.join(prefix, "Cellar", "node", "24.0.0", "bin", "node");
  const stable = path.join(prefix, "bin", "node");
  mkdirSync(path.dirname(node), { recursive: true });
  mkdirSync(path.dirname(stable));
  writeFileSync(node, "");
  symlinkSync(node, stable);
  assert.equal(directMcpNodePath(node), stable);
  rmSync(stable);
  writeFileSync(stable, "");
  assert.equal(directMcpNodePath(node), node);
});

test("direct refusal lists --disable-sigusr1 only when supported", t => {
  for (const unsupported of [false, true]) {
    const result = run(t, ["--direct"], [], {
      TEST_EXEC_ARG: "--title=fixture", TEST_NO_DISABLE_SIGUSR1: unsupported ? "1" : "",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("--disable-sigusr1"),
      !unsupported && process.allowedNodeEnvironmentFlags.has("--disable-sigusr1"));
  }
});

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

function recallHook(home, event, fields = {}) {
  const child = spawnSync(process.execPath, [installedCli, "recall-hook"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CCC_RECALL_WRAPPED: "", CCC_RECALL_NOTICE: "1" },
    input: JSON.stringify({ hook_event_name: event, session_id: session, prompt_id: "p", ...fields }),
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test("each successive prompt gets its notice from one live MCP tree cache", { timeout: 15000 }, async t => {
  const home = mkdtempSync(path.join(tmpdir(), "ccc-live-recall-"));
  const dir = path.join(home, ".claude-code-infinite");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ polychatApiKey: "fixture-production-key" }));
  const server = spawn(process.execPath, [cli, "memtree-mcp", "--direct"], {
    cwd: home, stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CLAUDE_CODE_SESSION_ID: session, CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: "1" },
  });
  const closed = new Promise(resolve => server.once("close", resolve));
  t.after(async () => {
    server.stdin.end();
    await closed;
    rmSync(home, { recursive: true, force: true });
  });
  const replies = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
  for (let i = 0; i < 6; i++) {
    const name = i % 2 ? "read_lines" : "read_node";
    const field = { tool_name: "mcp__memtree__" + name, tool_use_id: "live-" + i, prompt_id: "prompt-" + i };
    recallHook(home, "PreToolUse", field);
    const msg = call(name, { node: tree + "#3" });
    msg.params._meta = { "claudecode/toolUseId": field.tool_use_id };
    server.stdin.write(JSON.stringify({ ...msg, jsonrpc: "2.0", id: i }) + "\n");
    const { result } = JSON.parse((await replies.next()).value);
    assert.ok(!result.isError);
    recallHook(home, "PostToolUse", { ...field, tool_response: result.content });
    assert.match(recallHook(home, "Stop", field), /Bucket renamed/, field.prompt_id);
  }
});

for (const lookup of ["ticket", "pid"]) {
  test("cached reads across six prompts get notices while the tool and queued ping bypass a stalled " + lookup, t => {
    const calls = Array.from({ length: 6 }, (_, i) => call(i % 2 ? "read_lines" : "read_node", { node: tree + "#3" }));
    const fields = calls.map((msg, i) => {
      const id = "toolu_fast_" + i;
      msg.params._meta = { "claudecode/toolUseId": id };
      return { tool_name: "mcp__memtree__" + msg.params.name, tool_use_id: id, prompt_id: "prompt-" + i };
    });
    const expected = results(run(t, ["--direct"], calls));
    const proc = run(t, ["--direct"], [...calls, { method: "ping", id: "ping" }], {
      CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: "1", STALL_RECALL_READ: lookup,
      CLAUDE_CONFIG_DIR: "", CLAUDE_CODE_SESSION_ID: "stale-launch-id",
    }, undefined, [], home => {
      const dir = path.join(home, ".claude", "sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: session }));
      for (const field of fields) recallHook(home, "PreToolUse", field);
    });
    assert.deepEqual(results(proc), [...expected, {}]);
    for (const [i, field] of fields.entries()) {
      assert.ok(!expected[i].isError);
      recallHook(proc.home, "PostToolUse", { ...field, tool_response: expected[i].content });
      assert.match(recallHook(proc.home, "Stop", field), /Bucket renamed/, field.prompt_id);
    }
  });
}

test("a queued MCP ping and EOF complete while receipt publication is stalled", t => {
  const msg = call("read_node", { node: tree + "#3" });
  msg.params._meta = { "claudecode/toolUseId": "toolu_stalled" };
  const proc = run(t, ["--direct"], [msg, { method: "ping" }], {
    CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: "1", STALL_RECEIPT: "1",
  }, undefined, [], home => { recallHook(home, "PreToolUse", {
    tool_name: "mcp__memtree__read_node", tool_use_id: "toolu_stalled",
  }); });
  const [answer, ping] = results(proc);
  assert.ok(!answer.isError);
  assert.deepEqual(ping, {});
});

test("direct PID lookup runs only for an enabled recall tool", t => {
  for (const [name, notice] of [["list", "1"], ["read_node", "0"]]) {
    const msg = call(name, name === "list" ? {} : { node: tree + "#3" });
    msg.params._meta = { "claudecode/toolUseId": "toolu_pid" };
    const [result] = results(run(t, ["--direct"], [msg], {
      CHECK_PID_UNREAD: "1", CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: notice,
    }));
    assert.ok(!result.isError);
  }
});

test("direct MCP recall reaches Claude's Stop hook while its tool result stays identical", t => {
  const msg = call("read_node", { node: tree + "#3" });
  const expected = results(run(t, ["--direct"], [msg]));
  msg.params._meta = { "claudecode/toolUseId": "toolu_recall" };
  const fields = { tool_name: "mcp__memtree__read_node", tool_use_id: "toolu_recall" };
  const proc = run(t, ["--direct"], [msg], { CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: "1" },
    undefined, [], home => { recallHook(home, "PreToolUse", fields); });
  assert.deepEqual(results(proc), expected);
  const hook = (event, fields) => recallHook(proc.home, event, fields);
  assert.equal(hook("PostToolUse", { tool_name: "mcp__memtree__read_node", tool_use_id: "toolu_recall", tool_response: expected[0].content }), "");
  assert.deepEqual(JSON.parse(hook("Stop")), { systemMessage: "🌿 MemTree recalled from a past session: Bucket renamed." });
  assert.equal(hook("Stop"), "");
});

test("explicit direct mode selects the saved staging key and keeps it out of errors", t => {
  const [list, error] = results(run(t, ["--direct", "--env", "staging"], [call("list", {}), call("list", { q: "denied" })],
    { EXPECT_STAGING: "1", CCC_MEMTREE_MCP_DESKTOP: "1" }));
  assert.ok(!list.isError);
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /403/);
});

for (const [label, savedKey] of [
  ["trailing space", "fixture-production-key "],
  ["surrounding whitespace", "  fixture-production-key\r\n"],
]) {
  test(`direct mode authenticates and redacts with a saved key containing ${label}`, t => {
    const [reply] = results(run(t, ["--direct"], [call("list", { q: "denied" })], {}, { polychatApiKey: savedKey }));
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /HTTP 403 \[redacted\]/);
  });
}

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

test("invalid direct tree ids give the same guidance as current", t => {
  const messages = [
    call("handover", { tree: "current" }), call("search", { query: "deploy", tree: "bad/id" }),
    call("read_node", { tree: 123, id: 0 }), call("read_lines", { tree: "bad/id", tail: true }),
    call("user_messages", { tree: "bad/id" }),
  ];
  const [current, ...invalid] = results(run(t, ["--direct"], messages));
  for (const reply of invalid) {
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, current.content[0].text);
  }
});

test("direct CLI prints only usage for an unexpected positional key", t => {
  const result = run(t, ["--direct", "positional-canary-key"], [], { CHECK_KEY_UNREAD: "1" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Usage: ccc memtree-mcp --direct [--env staging|production]");
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
    if (variable === "NODE_DEBUG") assert.match(result.stderr, /Unset NODE_DEBUG/);
    else assert.match(result.stderr, /direct mode accepts only/i);
  });
}

test("direct mode accepts unrelated NODE_OPTIONS", t => {
  const [list] = results(run(t, ["--direct"], [call("list", {})], {
    NODE_OPTIONS: "--max-old-space-size=256 --no-warnings",
  }));
  assert.ok(!list.isError);
});

for (const flag of [
  "--heapsnapshot-near-heap-limit=1", "--heap-prof", "--report-on-fatalerror",
  "--inspect=127.0.0.1:0", "--cpu-prof", "--diagnostic-dir=.",
]) {
  for (const source of ["NODE_OPTIONS", "execArgv"]) {
    // Older Node versions only accept the profiling flags on the command line.
    if (source === "NODE_OPTIONS" && !process.allowedNodeEnvironmentFlags.has(flag)) continue;
    test(`direct mode rejects ${flag} in ${source} before requiring a key`, t => {
      const env = source === "NODE_OPTIONS" ? { NODE_OPTIONS: flag } : {};
      const nodeArgs = source === "execArgv" ? [flag] : [];
      const result = run(t, ["--direct"], [{ method: "initialize" }], env, {}, nodeArgs);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /direct mode accepts only/i);
    });
  }
}

test("direct mode starts with the allowed flags in both sources", t => {
  const flags = ["--max_old_space_size=256", "--no-warnings", "--trace-warnings", "--trace-deprecation"];
  if (process.allowedNodeEnvironmentFlags.has("--disable-sigusr1")) flags.push("--disable-sigusr1");
  const result = run(t, ["--direct"], [call("list", {})], {
    NODE_OPTIONS: flags.map(flag => `"${flag}"`).join(" "),
  }, undefined, flags);
  assert.ok(!results(result)[0].isError);
});

test("direct mode handles SIGUSR1 before reading the key and keeps the inspector closed", {
  skip: process.platform === "win32",
}, t => {
  assert.ok(!results(run(t, ["--direct"], [call("list", {})], { CHECK_SIGUSR1: "1" }))[0].isError);
});

test("direct mode refuses an already listening inspector before reading the key", t => {
  const result = run(t, ["--direct"], [], { CHECK_KEY_UNREAD: "1", TEST_INSPECTOR_LISTENING: "1" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /inspector is already listening/i);
});

const v8Options = spawnSync(process.execPath, ["--v8-options"], { encoding: "utf8" }).stdout;
const nodeHelp = spawnSync(process.execPath, ["--help"], { encoding: "utf8" }).stdout;
for (const flag of ["--prof", "-prof-cpp", "--log-code", "--heap-snapshot-on-gc=20", "-heap_snapshot_on_gc=20",
  "--heap-snapshot-on-oom", "--heap-profiler-show-hidden-objects"]) {
  const name = flag.replace(/^-{1,2}/, "--").replaceAll("_", "-").split("=")[0];
  test(`direct mode refuses V8 ${flag} before loading the canary key`, {
    skip: !v8Options.includes(`  ${name} (`),
  }, t => {
    const result = run(t, ["--direct"], [], { CHECK_KEY_UNREAD: "1" },
      { polychatApiKey: "saved-canary-for-refusal" }, [flag]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /direct mode accepts only/i);
    assert.ok(!readdirSync(result.home).some(file => file.endsWith(".heapsnapshot")));
  });
}

for (const selector of ["--experimental-config-file=node.config.json", "--experimental-default-config-file"]) {
  test(`direct mode refuses ${selector} before loading the canary key`, {
    skip: !nodeHelp.includes("--experimental-config-file"),
  }, t => {
    const result = run(t, ["--direct"], [], { CHECK_KEY_UNREAD: "1" },
      { polychatApiKey: "saved-canary-for-refusal" }, [selector], home => {
        writeFileSync(path.join(home, "node.config.json"), JSON.stringify({ nodeOptions: { "diagnostic-dir": "." } }));
      });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /direct mode accepts only/i);
    assert.ok(!readdirSync(result.home).some(file => file.endsWith(".heapsnapshot")));
  });
}

// Inject options in the fixture so the application guard is exercised even when
// this version of Node would reject the option before running the entry point.
for (const flag of ["--print-maglev-code", "--redirect-code-traces", "--heap-snapshot-on-gc",
  "--prof", "--inspect", "--made-up-flag=flag-value-canary", "--experimental-config-file=flag-value-canary",
  "--import=flag-value-canary", "--max-old-space-size=flag-value-canary", "--trace-warnings=flag-value-canary",
  "--abort-on-uncaught-exception"]) {
  for (const source of ["execArgv", "NODE_OPTIONS"]) {
    test(`direct mode refuses ${flag} from ${source} before reading the key`, t => {
      const result = run(t, ["--direct"], [], { CHECK_KEY_UNREAD: "1",
        [source === "execArgv" ? "TEST_EXEC_ARG" : "TEST_NODE_OPTIONS"]: flag });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(flag.split("=")[0]));
      assert.match(result.stderr, /direct mode accepts only/i);
      assert.match(result.stderr, source === "execArgv" ? /remove.*Node command line/i : /remove the flag from NODE_OPTIONS/i);
      assert.equal(result.stderr.trim().split("\n").length, 1);
      assert.doesNotMatch(result.stderr, /flag-value-canary/);
    });
  }
}

test("direct list and search send only directory attribution and spawn no child process", t => {
  const replies = results(run(t, ["--direct"], [call("list", {}), call("search", { query: "deploy" })],
    { EXPECT_PROJECT_META: "1", CHECK_NO_SPAWN: "1" }));
  for (const reply of replies) assert.ok(!reply.isError, reply.content[0].text);
});

test("direct finder omits attribution when the directory contains the saved key", t => {
  const [reply] = results(run(t, ["--direct"], [call("list", {})], { EXPECT_PROJECT_META: "1" },
    undefined, [], home => {
      const cwd = path.join(home, "project-fixture-production-key");
      mkdirSync(cwd);
      return cwd;
    }));
  assert.ok(!reply.isError, reply.content[0].text);
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

test("direct list and search omit project attribution when the working directory is gone", () => {
  runFinder(`
    process.cwd = () => { throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" }); };
    await finder.listSessions({});
    await finder.searchSessions({ query: "deploy" });
  `, { EXPECT_NO_PROJECT_META: "1" });
});

test("JSON detail is sanitized before SessionFinder throws a tool error", () => {
  runFinder(String.raw`await assert.rejects(finder.listSessions({ q: "denied" }), /HTTP 403 \[redacted\]/);`);
});

test("Node connection diagnostics keep the authorization header private", () => {
  const result = runFinder("await finder.listSessions({});", { NODE_DEBUG: "http,https" });
  assert.ok(!result.stderr.includes("fixture-production-key"));
});

test("invalid bearer header leaves no open direct request", () => {
  runFinder(`
    const https = (await import("node:https")).default;
    const original = https.request;
    let request;
    https.request = (...args) => (request = original(...args));
    const invalid = new SessionFinder({ direct: { baseUrl: "https://api.polychat.co", apiKey: "invalid\\nkey" } });
    await assert.rejects(invalid.listSessions({}), /invalid.*header/i);
    assert.ok(!request || request.destroyed, "invalid header left the request open");
  `);
});
