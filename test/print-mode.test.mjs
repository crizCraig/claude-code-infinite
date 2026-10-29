// Print (-p) / non-TTY runs: stdout carries only Claude's own output (agents
// parse --output-format json|stream-json from it), and ccc gives the session
// its memtree MCP tools by default, exactly as in interactive sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeConsoleToStderr, stripAnsi } from "../dist/cli-output.js";
import { subcommandArgs } from "../dist/cli-args.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function fakeStream(isTTY) {
  const chunks = [];
  return { isTTY, chunks, write: (text) => { chunks.push(text); return true; } };
}

test("ccc's own console output goes to stderr, without colour codes when stderr is not a terminal", () => {
  const target = { log: null, info: null, debug: null };
  const piped = fakeStream(false);
  routeConsoleToStderr(target, piped);
  target.log("\x1b[1;35m🚧 STAGING MODE\x1b[0m\n");
  target.info("count %d", 3);
  target.debug("[DEBUG] x");
  assert.deepEqual(piped.chunks, ["🚧 STAGING MODE\n\n", "count 3\n", "[DEBUG] x\n"]);

  const tty = fakeStream(true);
  routeConsoleToStderr(target, tty);
  target.log("\x1b[2mRequest log: /x\x1b[0m");
  assert.deepEqual(tty.chunks, ["\x1b[2mRequest log: /x\x1b[0m\n"]);
});

test("stripAnsi removes SGR colours and OSC 8 hyperlinks, keeping the text", () => {
  const banner = "\x1b[38;5;209m∞\x1b[0m \x1b[38;5;48mfrom \x1b]8;;https://MemTree.dev\x1b\\MemTree\x1b]8;;\x1b\\\x1b[0m";
  assert.equal(stripAnsi(banner), "∞ from MemTree");
});

test("subcommands are found after an environment word too (ccc staging memtree-mcp)", () => {
  assert.deepEqual(subcommandArgs(["memtree-mcp"]), { name: "memtree-mcp", args: [] });
  assert.deepEqual(subcommandArgs(["staging", "memtree-mcp"]), { name: "memtree-mcp", args: [] });
  assert.deepEqual(subcommandArgs(["local", "fetch", "u"]), { name: "fetch", args: ["u"] });
  assert.deepEqual(subcommandArgs(["fetch", "u"]), { name: "fetch", args: ["u"] });
  assert.equal(subcommandArgs(["-p", "memtree-mcp"]), undefined);
  assert.equal(subcommandArgs(["staging", "-p", "fetch"]), undefined);
  assert.equal(subcommandArgs([]), undefined);
});

/** A fake `claude` on PATH that prints one JSON line naming its argv. */
function fakeClaudeHome({ key = "test-key", claudeJson, seenAuth, authStatus } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-print-"));
  if (claudeJson) fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify(claudeJson));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const script = path.join(bin, "claude.mjs");
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('2.1.302 (Claude Code)'); process.exit(0); }",
    // `claude auth status --json` (claude-auth-status.ts): the given answer, else the argv line.
    ...(authStatus ? [`if (args[0] === 'auth') { console.log(${JSON.stringify(
      JSON.stringify(authStatus))}); process.exit(authStatus.loggedIn ? 0 : 1); }`
      .replace("authStatus.loggedIn", String(authStatus.loggedIn))] : []),
    "const cfg = args.find((a) => a.startsWith('--mcp-config='));",
    "const servers = cfg ? Object.keys(JSON.parse(fs.readFileSync(cfg.slice(13), 'utf8')).mcpServers) : [];",
    "process.stdout.write(JSON.stringify({ type: 'result', args, servers }) + '\\n');",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@"${process.execPath}" "%~dp0claude.mjs" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/claude.mjs" "$@"\n`);
    fs.chmodSync(path.join(bin, "claude"), 0o755);
  }
  const configDir = path.join(home, ".claude-code-infinite");
  fs.mkdirSync(configDir, { mode: 0o700 });
  fs.writeFileSync(path.join(configDir, "config.json"),
    JSON.stringify({ localPolychatApiKey: key, diagnostics: false, updateCheck: false }),
    { mode: 0o600 });
  if (seenAuth) fs.writeFileSync(path.join(configDir, "claude-auth-seen"), `${seenAuth}\n`);
  return { home, bin };
}

function runCcc(args, extraEnv = {}, home_ = {}) {
  const { home, bin } = fakeClaudeHome(home_);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CCC_NO_DIAGNOSTICS: "1",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  delete env.ANTHROPIC_BASE_URL;
  delete env.CCC_MEMTREE_MCP;
  // Claude Code's sign-in comes from this fake home only.
  for (const name of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY"]) delete env[name];
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "local", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("ccc -p: stdout is exactly Claude's output, and the memtree tools are registered", { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCcc(["-p", "--output-format", "json", "--", "hi"]);
  assert.equal(code, 0, stderr);
  const lines = stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be Claude's only: ${JSON.stringify(stdout)}`);
  const result = JSON.parse(lines[0]);
  assert.match(result.args[0], /^--mcp-config=/);
  assert.equal(result.args[1],
    "--allowedTools=mcp__memtree__search,mcp__memtree__read_node,mcp__memtree__read_lines,mcp__memtree__list");
  assert.deepEqual(result.args.slice(2), ["-p", "--output-format", "json", "--", "hi"]);
  assert.deepEqual(result.servers, ["memtree"]);
  // The banner and notices still reach a human, on stderr and uncoloured.
  assert.match(stderr, /Claude Code Infinite/);
  assert.match(stderr, /LOCAL MODE/);
  assert.doesNotMatch(stderr, /\x1b\[/);
});

test("ccc -p with CCC_MEMTREE_MCP=0: Claude's argv is untouched", { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCcc(["-p", "hi"], { CCC_MEMTREE_MCP: "0" });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim()).args, ["-p", "hi"]);
});

test("ccc -p with no saved key and no terminal: fails on stderr, never prompts on stdout", { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCcc(["-p", "hi"], {}, { key: null });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /MemTree API key is required/);
  assert.match(stderr, /run `ccc` in a terminal/);
});

const NO_PLAN = /^Claude Code is signed in for API billing \(an Anthropic Console account\), so Claude bills that account per token, not a Claude plan\. Your MemTree credit covers MemTree, not Claude itself\. To use Claude Pro or Max instead, run \/login in Claude Code and choose "Claude account with subscription"\.$/m;

test("ccc -p not signed in to a plan: the no-plan line on stderr, stdout still Claude's alone", { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCcc(["-p", "hi"], {}, {
    claudeJson: { primaryApiKey: "sk-ant-api03-x" },
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, NO_PLAN);
  assert.equal(stdout.split("\n").filter(Boolean).length, 1);
  assert.doesNotMatch(stdout, /Pro or Max/);
});

test("ccc -p, Claude Code says nobody is signed in: the sign-in message, no wait", { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runCcc(["-p", "hi"], {}, {
    authStatus: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /^Claude Code isn't signed in to a Claude plan yet\. ccc needs Claude Pro or Max\.$/m);
  assert.match(stderr, /^ {2}- Don't have one\? Get Pro at https:\/\/claude\.ai\/upgrade, then run \/login\.$/m);
  assert.match(stderr, /^Your MemTree credit covers MemTree, not Claude itself\.$/m);
  assert.doesNotMatch(stderr, /Press Enter/, "a print run never waits");
  assert.deepEqual(JSON.parse(stdout.trim()).args.slice(-2), ["-p", "hi"]);
});

test("ccc -p, Claude Code says Max even though the config files are silent: nothing said", { timeout: 30_000 }, async () => {
  const { code, stderr } = await runCcc(["-p", "hi"], {}, {
    authStatus: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
      email: "a@b.c", subscriptionType: "max" },
  });
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /Pro or Max|signed in/);
});

test("ccc -p on a Claude subscription: no no-plan line", { timeout: 30_000 }, async () => {
  const { code, stderr } = await runCcc(["-p", "hi"], {}, {
    claudeJson: { oauthAccount: { emailAddress: "a@b.c" }, organizationType: "claude_max" },
  });
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /Pro or Max/);
});

test("ccc -p: the sign-in Claude Code last sent through ccc decides when the config is silent", { timeout: 30_000 }, async () => {
  const quiet = await runCcc(["-p", "hi"], {}, { seenAuth: "subscription" });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /Pro or Max/);
  const max = await runCcc(["-p", "hi"], {}, {
    seenAuth: "api_key", claudeJson: { oauthAccount: { x: 1 }, organizationType: "claude_max" },
  });
  assert.doesNotMatch(max.stderr, /Pro or Max/, "a /login to Max since then wins");
  const key = await runCcc(["-p", "hi"], {}, { seenAuth: "api_key" });
  assert.match(key.stderr, NO_PLAN);
});

/** A fake MemTree server that says the key is unpaid, on a free port. */
function fakeUnpaidServer(requests) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/context_memory/status") {
        res.end(JSON.stringify({ paid: false, payment_message: "Please subscribe." }));
      } else {
        res.statusCode = 402;
        res.end(JSON.stringify({ detail: "Payment required" }));
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const localBase = (server) => ({ CCC_LOCAL_BASE_URL: `http://127.0.0.1:${server.address().port}` });

test("ccc -p with an unpaid key: one stderr line, then plain Claude Code with no MemTree calls", { timeout: 30_000 }, async () => {
  const requests = [];
  const server = await fakeUnpaidServer(requests);
  try {
    const { code, stdout, stderr } = await runCcc(["-p", "hi"], localBase(server));
    assert.equal(code, 0, stderr);
    // No memtree MCP server or plugin: Claude Code's own argv, exactly.
    assert.deepEqual(JSON.parse(stdout.trim()).args, ["-p", "hi"]);
    assert.equal(stderr.split("\n").filter((l) => /MemTree is paused/.test(l)).length, 1, stderr);
    assert.match(stderr, /plain Claude Code/);
    assert.doesNotMatch(stderr, /Request log:/, "no proxy was started");
    assert.deepEqual(requests, ["GET /v1/context_memory/status"]);
  } finally {
    server.close();
  }
});

test("ccc -p --resume with an unpaid key keeps ccc's handling (a resumed session may be past the window)", { timeout: 30_000 }, async () => {
  const requests = [];
  const server = await fakeUnpaidServer(requests);
  try {
    const id = "6472823f-ca4f-4027-9b89-64a81c367dc3";
    const { code, stdout, stderr } = await runCcc(["-p", "--resume", id, "hi"], localBase(server));
    assert.equal(code, 0, stderr);
    const { args } = JSON.parse(stdout.trim());
    assert.match(args[0], /^--mcp-config=/, "still through ccc");
    assert.deepEqual(args.slice(-4), ["-p", "--resume", id, "hi"]);
    assert.match(stderr, /Request log:/);
    assert.match(stderr, /resumed session runs uncompressed/);
  } finally {
    server.close();
  }
});
