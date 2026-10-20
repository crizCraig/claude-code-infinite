// MemTree paused and the user chose to continue (or a print run): plain Claude Code,
// no proxy, no MemTree calls, Claude Code's own compaction and limits.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { plainClaudeEnv } from "../dist/paused-session.js";
import { createStartupBannerPlugin } from "../dist/hooks.js";
import { memtreeOffNoticeText } from "../dist/notices.js";

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  "..", "dist");
const SHORT = "https://app.polychat.co/p/Ab3xY9qwertyuiop";

test("plain env: only ccc's own control is dropped; the user's settings stay", () => {
  const env = plainClaudeEnv({ CCC_AUTO_COMPACT: "1", DISABLE_AUTO_COMPACT: "1", HOME: "/h" });
  assert.deepEqual(env, { DISABLE_AUTO_COMPACT: "1", HOME: "/h" });
});

test("the MemTree-off banner says why and how to turn it back on, in both colour modes", () => {
  const plain = memtreeOffNoticeText(false, SHORT);
  assert.equal(plain,
    `\n\n·─╼ MemTree is off for this session ╾─·\nSubscribe, then restart ccc to turn it back on: ${SHORT}`);
  const color = memtreeOffNoticeText(true, `${SHORT}\u001b[31m`);
  assert.match(color, /\x1b\[33mMemTree is off for this session\x1b\[39m/);
  assert.ok(!color.split("back on: ")[1].includes("\u001b"), "no control characters from the url");
});

test("the banner-only plugin has just a SessionStart hook, removed on close", () => {
  const plugin = createStartupBannerPlugin("hello");
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin.dir, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
  const [entry] = hooks.hooks.SessionStart;
  assert.equal(entry.matcher, "startup|resume|clear");
  assert.match(entry.hooks[0].command, /^cat '/);
  assert.ok(!JSON.stringify(hooks).includes("http"), "no hook needs ccc's local server");
  const banner = fs.readFileSync(path.join(plugin.dir, "hooks", "startup-notice.json"), "utf8");
  assert.deepEqual(JSON.parse(banner), { systemMessage: "hello" });
  assert.ok(fs.existsSync(path.join(plugin.dir, ".claude-plugin", "plugin.json")));
  plugin.close();
  assert.ok(!fs.existsSync(plugin.dir));
});

/** Run runWithoutMemtree in a child process against a fake `claude` that records its run. */
function runPaused({ interactive, exitCode = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-paused-"));
  const record = path.join(dir, "claude-run.json");
  const fakeClaude = path.join(dir, "claude.mjs");
  fs.writeFileSync(fakeClaude, [
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const i = args.indexOf('--plugin-dir');",
    "const banner = i < 0 ? null : JSON.parse(fs.readFileSync(",
    "  args[i + 1] + '/hooks/startup-notice.json', 'utf8')).systemMessage;",
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, banner, env: {`,
    "  base: process.env.ANTHROPIC_BASE_URL ?? null,",
    "  disable: process.env.DISABLE_AUTO_COMPACT ?? null,",
    "  blocking: process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE ?? null,",
    "  resume: process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD ?? null,",
    "  firstParty: process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL ?? null,",
    "  ccc: process.env.CCC_AUTO_COMPACT ?? null } }));",
    `process.exit(${exitCode});`,
  ].join("\n"));
  // A `claude` command (not `node script`), so `--plugin-dir` reaches the script.
  const command = process.platform === "win32" ? path.join(dir, "claude.cmd") : path.join(dir, "claude");
  if (process.platform === "win32") {
    fs.writeFileSync(command, `@"${process.execPath}" "%~dp0claude.mjs" %*\r\n`);
  } else {
    fs.writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/claude.mjs" "$@"\n`);
    fs.chmodSync(command, 0o755);
  }
  const runner = path.join(dir, "run.mjs");
  fs.writeFileSync(runner, [
    `import { runWithoutMemtree } from ${JSON.stringify(pathToFileURL(path.join(DIST, "paused-session.js")).href)};`,
    "const events = [];",
    "const diagnostics = { record: (e) => events.push(e), flush: async () => {",
    "  process.stderr.write('events=' + JSON.stringify(events)); }, flushNow() {} };",
    "await runWithoutMemtree({",
    `  claude: { command: ${JSON.stringify(command)}, source: 'path' },`,
    "  claudeArgs: ['-p', 'hi'],",
    `  interactive: ${interactive}, diagnostics, autoUpdate: null, banner: 'MemTree off',`,
    "});",
  ].join("\n"));
  const env = { ...process.env, CCC_AUTO_COMPACT: "0" };
  for (const name of ["ANTHROPIC_BASE_URL", "DISABLE_AUTO_COMPACT",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE", "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD"]) delete env[name];
  const result = spawnSync(process.execPath, [runner], { env, encoding: "utf8", timeout: 20_000 });
  const run = JSON.parse(fs.readFileSync(record, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, run };
}

test("continue without MemTree: Claude Code runs with none of ccc's settings, status passed on", () => {
  const { status, stderr, run } = runPaused({ interactive: false, exitCode: 3 });
  assert.equal(status, 3, stderr);
  assert.deepEqual(run.env, {
    base: null, disable: null, blocking: null, resume: null, firstParty: null, ccc: null,
  });
  assert.deepEqual(run.args, ["-p", "hi"], "print runs get no plugin");
  assert.equal(run.banner, null);
  assert.match(stderr, /claude_exit/);
});

test("an interactive paused session gets only the banner plugin", () => {
  const { status, run } = runPaused({ interactive: true });
  assert.equal(status, 0);
  assert.equal(run.args[0], "--plugin-dir");
  assert.equal(run.banner, "MemTree off");
});
