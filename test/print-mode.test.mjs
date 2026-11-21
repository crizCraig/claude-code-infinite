// Print (-p) / non-TTY runs: stdout carries only Claude's own output (agents
// parse --output-format json|stream-json from it), and ccc gives the session
// its memtree MCP tools by default, exactly as in interactive sessions.
import test from "node:test";
import { installNpmClaude } from "./fixtures/npm-claude.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
function fakeClaudeHome({
  key = "sk-00000000000000000000000000000000", claudeJson, seenAuth, authStatus, sessionScript = "",
} = {}) {
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
    sessionScript,
    "const cfg = args.find((a) => a.startsWith('--mcp-config='));",
    "const servers = cfg ? Object.keys(JSON.parse(fs.readFileSync(cfg.slice(13), 'utf8')).mcpServers) : [];",
    "const pd = args.indexOf('--plugin-dir');",
    "const hooks = pd < 0 ? null : Object.keys(JSON.parse(fs.readFileSync(",
    "  args[pd + 1] + '/hooks/hooks.json', 'utf8')).hooks);",
    "const bannerFile = pd < 0 ? null : args[pd + 1] + '/hooks/startup-notice.json';",
    "const banner = bannerFile && fs.existsSync(bannerFile) ? JSON.parse(fs.readFileSync(bannerFile)).systemMessage : undefined;",
    "process.stdout.write(JSON.stringify({ type: 'result', args, servers, hooks, banner }) + '\\n');",
  ].join("\n"));
  if (process.platform === "win32") {
    installNpmClaude(bin, fs.readFileSync(script));
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

function runCcc(args, extraEnv = {}, home_ = {}, nodeArgs = []) {
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
    const child = spawn(process.execPath, [...nodeArgs, CLI, "local", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
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
    "--allowedTools=mcp__memtree__search,mcp__memtree__read_node,mcp__memtree__read_lines,mcp__memtree__list," +
    "mcp__memtree__user_messages,mcp__memtree__handover");
  assert.equal(result.args[2], "--plugin-dir");
  assert.deepEqual(result.args.slice(4), ["-p", "--output-format", "json", "--", "hi"]);
  assert.deepEqual(result.servers, ["memtree"]);
  // The subagent hooks (a subagent is told whose memory to search), the parent's pointer
  // to a finished subagent's tree, and, in a repo with an origin remote (as this
  // checkout), the earlier-sessions block with the first prompt: none prints to stdout.
  assert.deepEqual(result.hooks.filter((name) => name !== "UserPromptSubmit"),
    ["SubagentStart", "SubagentStop", "PostToolUse"]);
  assert.ok(!result.hooks.includes("SessionStart"),
    "Claude Code prints SessionStart hook events on stream-json stdout");
  // The banner and notices still reach a human, on stderr and uncoloured.
  assert.match(stderr, /Claude Code Infinite/);
  assert.match(stderr, /LOCAL MODE/);
  assert.doesNotMatch(stderr, /\x1b\[/);
});

test("print and non-TTY model calls do no status-link filesystem work", async t => {
  let modelCalls = 0;
  let treeLookups = 0;
  const session = { session_id: "session-1", links: { url: "https://example.org/m/sessions/session-1" } };
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/messages") {
      modelCalls++;
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] }));
    } else if (req.url.startsWith("/v1/memtree/sessions?")) {
      treeLookups++;
      res.end(JSON.stringify({ sessions: [session] }));
    } else {
      res.end(JSON.stringify({ paid: true }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { CCC_LOCAL_BASE_URL: origin, CCC_ANTHROPIC_UPSTREAM: origin, CCC_HTTPS_PROXY_MODE: "0",
    CCC_MEMTREE_MCP: "0", CCC_MEMTREE_LINK: "off" };
  const sessionScript = `
    for (let i = 0; i < 3; i++) {
      const reply = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": "session-1" },
        body: JSON.stringify({ model: "claude-x", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
      });
      if ((await reply.json()).content[0].text !== "ok") throw Error("unexpected model reply");
    }
  `;
  const trace = `
    import fs from "node:fs";
    for (const op of ["readFileSync", "writeFileSync", "renameSync", "unlinkSync", "statSync"]) {
      const original = fs[op];
      fs[op] = function(file, ...args) {
        if (/session-1[.](url|heartbeat)/.test(String(file))) console.error("status-link I/O", op, file);
        return original.call(this, file, ...args);
      };
    }
  `;
  const home = { sessionScript, authStatus: { loggedIn: false } };
  for (const [args, tty] of [[[], false], [["-p", "hi"], true], [["-pc", "hi"], true]]) {
    const preload = trace + (tty ? "process.stdin.isTTY = process.stdout.isTTY = true;" : "");
    const before = modelCalls;
    const lookupsBefore = treeLookups;
    const { code, stderr } = await runCcc(args, env, home,
      ["--import", "data:text/javascript," + encodeURIComponent(preload)]);
    assert.equal(code, 0, stderr);
    assert.equal(modelCalls - before, 3);
    assert.equal(treeLookups - lookupsBefore, 1, "the background lookup still runs");
    assert.doesNotMatch(stderr, /status-link I\/O/);
  }
});

test("Windows reports a skipped wrapper once on interactive stderr and stays quiet about it in print mode", {
  skip: process.platform !== "win32",
}, async t => {
  const { home, bin } = fakeClaudeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const wrappers = path.join(home, "wrappers");
  fs.mkdirSync(wrappers);
  const wrapper = path.join(wrappers, "claude.bat");
  fs.writeFileSync(wrapper, "@exit /b 42");
  const env = {
    USERPROFILE: home, Path: [wrappers, bin].join(";"), PATHEXT: ".EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home, CCC_NO_DIAGNOSTICS: "1",
  };
  const tty = "data:text/javascript,process.stdin.isTTY = process.stdout.isTTY = true";
  for (const [nodeArgs, args, expectedNotes] of [
    [["--import", tty], ["--help"], 1],
    [["--import", tty], ["-p", "hi"], 0],
    [["--import", tty], ["--print", "hi"], 0],
    [[], ["--help"], 0],
  ]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [...nodeArgs, CLI, "local", ...args], { cwd: home, env, timeout: 15000 });
    assert.ok(!stdout.includes(wrapper), stdout);
    const notes = stderr.split(/\r?\n/).filter(line => line.includes(wrapper));
    assert.equal(notes.length, expectedNotes, stderr);
    if (expectedNotes) assert.match(notes[0], /skipped.*wrapper/i);
  }
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
  assert.doesNotMatch(stderr, /Press Enter|paste it here/);
});

test("ccc -p checks a legacy saved key and warns once without printing the key", async () => {
  const key = "old-saved-value";
  const mock = `globalThis.fetch = async (url, init) => {
    if (url.endsWith("/status") && new Headers(init.headers).get("authorization") === "Bearer ${key}") {
      console.error("checked legacy credential");
    }
    return Response.json({ paid: false });
  };`;
  const { code, stdout, stderr } = await runCcc(["-p", "hi"], {}, { key },
    ["--import", "data:text/javascript," + encodeURIComponent(mock)]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).args, ["-p", "hi"]);
  assert.match(stderr, /checked legacy credential/);
  assert.equal(stderr.match(/legacy format/gi)?.length, 1);
  assert.doesNotMatch(stderr, /old-saved-value|paste it here/);
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
function fakeUnpaidServer(requests, message = "Please subscribe.") {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/context_memory/status") {
        res.end(JSON.stringify({ paid: false, payment_message: message }));
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

test("highest-tier Enter continues with support instructions in the gate and session banner", async t => {
  const message = "Your usage has exceeded our highest tier limits. " +
    "Please contact support@memtree.dev to discuss custom pricing options.";
  const requests = [];
  const server = await fakeUnpaidServer(requests, message);
  t.after(() => server.close());
  const terminal = `
    import readline from "node:readline";
    process.stdin.isTTY = process.stdout.isTTY = true;
    readline.Interface.prototype.question = function (prompt, answer) {
      console.log(prompt);
      answer(prompt.includes("subscribe") ? "q" : "");
    };
  `;
  const { code, stdout, stderr } = await runCcc([], localBase(server), {},
    ["--import", "data:text/javascript," + encodeURIComponent(terminal)]);
  assert.equal(code, 0, stderr);
  assert.ok(stderr.includes(message), stderr);
  assert.doesNotMatch(stdout, /subscribe|waiting for payment/i);
  const result = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith("{")));
  assert.ok(result.banner.includes(message), result.banner);
  assert.deepEqual(requests, ["GET /v1/context_memory/status"]);
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

test("ccc --resume <id> forwards the existing session and uses absolute Windows executables", async t => {
  const { home, bin } = fakeClaudeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projects = path.join(home, ".claude", "projects", "test-project");
  fs.mkdirSync(projects, { recursive: true });
  const id = "e32c1f3e-f811-468a-8d31-e4967cbf1219";
  const transcript = path.join(projects, id + ".jsonl");
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  fs.writeFileSync(path.join(home, ".claude-code-infinite", "config.json"),
    JSON.stringify({ polychatApiKey: "sk-" + "1".repeat(32), diagnostics: false, updateCheck: false }));

  const preload = path.join(home, "capture.mjs");
  fs.writeFileSync(preload, `
    import cp from "node:child_process";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { Server } from "node:net";
    Server.prototype.listen = function(port, host, ready) { queueMicrotask(ready); return this; };
    Server.prototype.address = () => ({ port: 12345 });
    globalThis.fetch = async () => Response.json({ paid: true });
    for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
      const original = cp[method];
      cp[method] = function(file, ...args) {
        fs.appendFileSync(process.env.CCC_TEST_SPAWNS, JSON.stringify(file) + "\\n");
        return original.call(this, file, ...args);
      };
    }
    syncBuiltinESMExports();
  `);
  const log = path.join(home, "spawns");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PATH: bin + path.delimiter + process.env.PATH, CCC_TEST_SPAWNS: log };
  // Child env keys are case-insensitive on Windows. Keep one spelling of PATH.
  for (const key of Object.keys(env)) if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--import", pathToFileURL(preload).href, CLI, "--resume", id], { env, cwd: home, timeout: 10000 });
  const args = JSON.parse(stdout).args;
  assert.deepEqual(args.slice(args.indexOf("--resume")), ["--resume", id]);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(calls.length > 0);
  if (process.platform === "win32") {
    for (const file of calls) {
      assert.ok(path.isAbsolute(file) && path.parse(file).root.length > 1, file);
      assert.doesNotMatch(path.basename(file), /^(ps|lsof)(\.exe)?$/i);
    }
  }
  assert.equal(fs.readFileSync(transcript, "utf8"), '{"type":"user"}\n');
});
