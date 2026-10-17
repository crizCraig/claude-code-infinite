// Print (-p) / non-TTY runs: stdout carries only Claude's own output (agents
// parse --output-format json|stream-json from it), and ccc gives the session
// its memtree MCP tools by default, exactly as in interactive sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
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
function fakeClaudeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-print-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const script = path.join(bin, "claude.mjs");
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('2.1.302 (Claude Code)'); process.exit(0); }",
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
    JSON.stringify({ localPolychatApiKey: "test-key", diagnostics: false, updateCheck: false }),
    { mode: 0o600 });
  return { home, bin };
}

function runCcc(args, extraEnv = {}) {
  const { home, bin } = fakeClaudeHome();
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CCC_NO_DIAGNOSTICS: "1",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  delete env.ANTHROPIC_BASE_URL;
  delete env.CCC_MEMTREE_MCP;
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
