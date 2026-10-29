// Claude Code's own sign-in answer (claude-auth-status.ts): `claude auth status --json`,
// parsed for the sign-in type and plan only. On 2026-10-28 every Windows signup that
// ccc warned as "unknown" never sent a message: they were not signed in to Claude Code
// at all, which the config files cannot tell apart from "can't tell".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_PROBE_RESULTS,
  parseAuthStatus,
  probeAnswersForSession,
  probeClaudeAuthStatus,
  skippedProbe,
} from "../dist/claude-auth-status.js";
import { AUTH_PROBE_RESULTS as SCHEMA_RESULTS } from "../dist/diagnostics-schema.js";

// Claude Code 2.1's output, account fields included: none of them may come out.
const SIGNED_OUT = {
  loggedIn: false, authMethod: "none", apiProvider: "firstParty", analyticsDisabled: false,
  projectsDirectory: "C:\\Users\\ada\\.claude\\projects", configDirectory: "C:\\Users\\ada\\.claude",
};
const CLAUDE_AI = {
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
  email: "ada@example.com", orgId: "0b5e...", orgName: "Ada's org", subscriptionType: "max",
};

test("not signed in is 'none', not 'unknown'", () => {
  assert.deepEqual(parseAuthStatus(JSON.stringify(SIGNED_OUT), {}),
    { auth: "none", plan: "unknown", console: false });
});

test("a Claude login keeps its plan and nothing about the account", () => {
  const status = parseAuthStatus(JSON.stringify(CLAUDE_AI), {});
  assert.deepEqual(status, { auth: "subscription", plan: "max", console: false });
  assert.doesNotMatch(JSON.stringify(status), /ada|example|org/i);
  for (const [type, plan] of [["pro", "pro"], ["team", "team"], ["enterprise", "enterprise"],
    [null, "unknown"], ["free", "free"]]) {
    assert.equal(parseAuthStatus(JSON.stringify({ ...CLAUDE_AI, subscriptionType: type }), {}).plan,
      plan, String(type));
  }
});

test("API keys: env, apiKeyHelper and the Console sign-in", () => {
  const key = (extra) => parseAuthStatus(JSON.stringify(
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", ...extra }), {});
  assert.deepEqual(key({ apiKeySource: "ANTHROPIC_API_KEY" }),
    { auth: "api_key", plan: "unknown", console: false, keySource: "ANTHROPIC_API_KEY" });
  assert.deepEqual(key({ apiKeySource: "/login managed key", email: "ada@example.com" }),
    { auth: "api_key", plan: "unknown", console: true });
  assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key_helper",
    apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }), {}),
  { auth: "api_key", plan: "unknown", console: false, keySource: "apiKeyHelper" });
});

test("an OAuth token from the environment: setup-token is a plan, ANTHROPIC_AUTH_TOKEN a key", () => {
  const out = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" });
  assert.equal(parseAuthStatus(out, { CLAUDE_CODE_OAUTH_TOKEN: "t" }).auth, "subscription");
  // A host-provided token, a token file or a profile login: no env variable, still a login.
  assert.equal(parseAuthStatus(out, {}).auth, "subscription");
  // ANTHROPIC_AUTH_TOKEN wins in Claude Code even beside a setup-token.
  assert.equal(parseAuthStatus(out, { ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "u" })
    .auth, "api_key");
  assert.deepEqual(parseAuthStatus(out, { ANTHROPIC_AUTH_TOKEN: "t" }),
    { auth: "api_key", plan: "unknown", console: false, keySource: "ANTHROPIC_AUTH_TOKEN" });
});

test("non-ASCII paths, a notice line before the JSON, and replacement characters", () => {
  const out = "Claude Code has switched from npm to the native installer.\n" + JSON.stringify({
    ...SIGNED_OUT, configDirectory: "C:\\Users\\Максим João\\.claude",
    projectsDirectory: "C:\\Users\\M\uFFFD\uFFFDsim\\.claude\\projects" });
  assert.equal(parseAuthStatus(out, {}).auth, "none");
});

test("cloud providers, unknown methods and non-JSON", () => {
  for (const p of ["bedrock", "vertex", "foundry"]) {
    assert.equal(parseAuthStatus(JSON.stringify(
      { loggedIn: true, authMethod: "third_party", apiProvider: p }), {}).auth, p);
  }
  assert.equal(parseAuthStatus(JSON.stringify(
    { loggedIn: true, authMethod: "something_new", apiProvider: "firstParty" }), {}).auth,
  "unknown");
  // A signed-out cloud gateway is not "no Claude plan".
  assert.equal(parseAuthStatus(JSON.stringify(
    { loggedIn: false, authMethod: "none", apiProvider: "gateway" }), {}).auth, "unknown");
  assert.equal(parseAuthStatus("error: unknown command 'auth'", {}), undefined);
  assert.equal(parseAuthStatus("{ not json", {}), undefined);
  assert.equal(parseAuthStatus(JSON.stringify({ loggedIn: "yes" }), {}), undefined);
});

/** A stand-in `claude` (a node script) that prints `stdout` and exits with `code`. */
function fakeClaude(stdout, code = 0, delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ccc-fake-claude-"));
  const script = join(dir, "claude.mjs");
  writeFileSync(script, [
    `const args = process.argv.slice(2).join(" ");`,
    `if (args !== "auth status --json") { process.stdout.write("bad args " + args); process.exit(2); }`,
    `setTimeout(() => { process.stdout.write(${JSON.stringify(stdout)}); process.exit(${code}); },` +
      ` ${delayMs});`,
  ].join("\n"));
  return { command: process.execPath, leadingArgs: [script] };
}

test("the probe: signed out exits 1 and still answers", async () => {
  const fake = fakeClaude(JSON.stringify(SIGNED_OUT), 1);
  const probe = await probeClaudeAuthStatus(fake.command, { leadingArgs: fake.leadingArgs, env: {} });
  assert.equal(probe.result, "ok");
  assert.equal(probe.status.auth, "none");
  assert.ok(probe.ms >= 0);
});

test("the probe: an old Claude Code without `auth`, a hang, a missing command", async () => {
  const old = fakeClaude("Usage: claude [options] [command] [prompt]\n", 1);
  assert.equal((await probeClaudeAuthStatus(old.command, { leadingArgs: old.leadingArgs }))
    .result, "unsupported");
  const garbled = fakeClaude("{ half", 0);
  assert.equal((await probeClaudeAuthStatus(garbled.command, { leadingArgs: garbled.leadingArgs }))
    .result, "failed");
  const slow = fakeClaude(JSON.stringify(CLAUDE_AI), 0, 5000);
  const timedOut = await probeClaudeAuthStatus(slow.command,
    { leadingArgs: slow.leadingArgs, timeoutMs: 200 });
  assert.equal(timedOut.result, "timeout");
  assert.equal(timedOut.status, undefined);
  const missing = await probeClaudeAuthStatus(join(tmpdir(), "no-such-claude-xyz"));
  assert.ok(["failed", "unsupported"].includes(missing.result), missing.result);
});

// Codex r1 P2: a timed-out probe must not outlive ccc's wait, nor leave a child behind
// (on Windows a .cmd shim runs cmd.exe, whose node child a plain kill would miss).
test("the probe: a timeout kills the whole process tree, SIGTERM ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-stubborn-claude-"));
  const pids = join(dir, "pids.txt");
  const child = join(dir, "child.mjs");
  writeFileSync(child, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const script = join(dir, "claude.mjs");
  writeFileSync(script, [
    `import { spawn } from "node:child_process";`,
    `import { writeFileSync } from "node:fs";`,
    `process.on("SIGTERM", () => {});`,
    `const c = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(pids)}, process.pid + " " + c.pid);`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"));
  const probe = await probeClaudeAuthStatus(process.execPath,
    { leadingArgs: [script], timeoutMs: 1500 });
  assert.equal(probe.result, "timeout");
  const [parent, grandchild] = readFileSync(pids, "utf8").split(" ").map(Number);
  const deadline = Date.now() + 5000;
  while ((alive(parent) || alive(grandchild)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(alive(parent), false, "probe process still running");
  assert.equal(alive(grandchild), false, "probe's child still running");
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Codex r1 P2: `claude auth status` takes no --settings, so a session given its own
// settings (an apiKeyHelper, say) or --bare may be signed in differently than it says.
test("the probe is not asked when the session's options change how it signs in", () => {
  assert.equal(probeAnswersForSession([]), true);
  assert.equal(probeAnswersForSession(["--resume", "abc", "-p", "hi"]), true);
  for (const args of [["--settings", "s.json"], ["--settings={\"apiKeyHelper\":\"x\"}"],
    ["--setting-sources", "user"], ["--bare", "-p", "hi"]]) {
    assert.equal(probeAnswersForSession(args), false, args.join(" "));
  }
  assert.deepEqual(skippedProbe(), { result: "skipped", ms: 0 });
});

test("the schema's probe results match the module's", () => {
  assert.deepEqual([...SCHEMA_RESULTS], [...AUTH_PROBE_RESULTS]);
});
