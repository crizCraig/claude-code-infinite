// The sign-in probe against a REAL Claude Code (CI: .github/workflows/sign-in-check-e2e.yml
// installs it fresh with Anthropic's installer on Linux, macOS and Windows). Opt-in:
// CCC_E2E_CLAUDE=1. Each state gets its own empty CLAUDE_CONFIG_DIR, so no real sign-in
// is touched: (a) never signed in, (b) an API key in the environment, (c) a fake Claude
// subscription in .credentials.json (Linux and Windows keep it there; macOS uses the
// keychain, so (c) is only asserted off macOS).
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateClaude } from "../dist/claude-locate.js";
import { probeClaudeAuthStatus } from "../dist/claude-auth-status.js";
import { claudeAuthFromConfig, claudeSubscriptionLogin } from "../dist/claude-auth.js";
import { signInNotice } from "../dist/sign-in-notice.js";

const enabled = process.env.CCC_E2E_CLAUDE === "1";
const SIGN_IN_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];

/** The runner's env without any sign-in, pointed at a fresh config dir. */
function freshEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of SIGN_IN_ENV) delete env[name];
  const dir = mkdtempSync(join(tmpdir(), "ccc-e2e-claude-"));
  return { dir, env: { ...env, CLAUDE_CONFIG_DIR: dir, ...extra } };
}

async function probe(env, command) {
  const claude = locateClaude({ env: process.env });
  assert.ok(claude, "Claude Code is installed");
  // A cold first start on a Windows runner can be slow.
  const result = await probeClaudeAuthStatus(command ?? claude.command,
    { env, timeoutMs: 60_000 });
  console.log(`probe (${claude.source}): ${JSON.stringify(result)}`);
  return result;
}

const fallbackFor = (env) => ({
  auth: claudeAuthFromConfig({ env }), plan: "unknown",
  subscriptionLogin: claudeSubscriptionLogin({ env }),
});

test("(a) never signed in: Claude Code says none, and ccc holds the sign-in message",
  { skip: !enabled }, async () => {
    const { env } = freshEnv();
    const result = await probe(env);
    assert.equal(result.result, "ok");
    assert.equal(result.status.auth, "none");
    // The config files alone can't tell this from "can't tell": that was the old "unknown".
    assert.equal(claudeAuthFromConfig({ env }), "unknown");
    const notice = signInNotice({ probe: result, fallback: fallbackFor(env), creditRefused: false,
      override: undefined, color: false });
    assert.equal(notice.kind, "not_signed_in");
    assert.equal(notice.pause, true);
  });

test("(b) an API key in the environment: API billing, not blocking",
  { skip: !enabled }, async () => {
    const { env } = freshEnv({ ANTHROPIC_API_KEY: "sk-ant-api03-e2e-fake-key-not-real" });
    const result = await probe(env);
    assert.equal(result.result, "ok");
    assert.equal(result.status.auth, "api_key");
    assert.equal(result.status.keySource, "ANTHROPIC_API_KEY");
    const notice = signInNotice({ probe: result, fallback: fallbackFor(env), creditRefused: false,
      override: { source: "ANTHROPIC_API_KEY", asks: false }, color: false });
    assert.equal(notice.kind, "api_billing");
    assert.equal(notice.pause, false);
  });

test("(c) a Claude subscription in .credentials.json (Linux and Windows)",
  { skip: !enabled }, async () => {
    const { dir, env } = freshEnv();
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "sk-ant-oat01-e2e-fake", refreshToken: "sk-ant-ort01-e2e-fake",
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
    } }));
    const result = await probe(env);
    assert.equal(result.result, "ok");
    // The config files agree there is a Claude login.
    assert.equal(claudeSubscriptionLogin({ env }), true);
    if (process.platform === "darwin") return; // the keychain, not this file, on macOS
    assert.equal(result.status.auth, "subscription");
    assert.equal(result.status.plan, "max");
    const notice = signInNotice({ probe: result, fallback: fallbackFor(env), creditRefused: false,
      override: undefined, color: false });
    assert.equal(notice, undefined);
  });

const FAKE_PLAN = () => JSON.stringify({ claudeAiOauth: {
  accessToken: "sk-ant-oat01-e2e-fake", refreshToken: "sk-ant-ort01-e2e-fake",
  expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
  scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
  subscriptionType: "pro",
} });

// Several Windows users who never got past the warning had Cyrillic or Portuguese names
// (C:\Users\Максим...). Both checks must read a home folder named like that.
test("(d) a non-ASCII home folder (HOME and USERPROFILE), no CLAUDE_CONFIG_DIR",
  { skip: !enabled }, async () => {
    const home = join(mkdtempSync(join(tmpdir(), "ccc-e2e-home-")), "Максим João");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { env } = freshEnv({ HOME: home, USERPROFILE: home });
    delete env.CLAUDE_CONFIG_DIR;
    const signedOut = await probe(env);
    assert.equal(signedOut.result, "ok");
    assert.equal(signedOut.status.auth, "none");
    writeFileSync(join(home, ".claude", ".credentials.json"), FAKE_PLAN());
    assert.equal(claudeSubscriptionLogin({ env, homedir: home }), true);
    const signedIn = await probe(env);
    assert.equal(signedIn.result, "ok");
    if (process.platform === "darwin") return; // the keychain on macOS
    assert.equal(signedIn.status.auth, "subscription");
    assert.equal(signedIn.status.plan, "pro");
  });

test("(e) Claude Code itself under a non-ASCII folder, run by full path",
  { skip: !enabled }, async () => {
    const claude = locateClaude({ env: process.env });
    assert.ok(claude);
    const found = claude.dir ? join(claude.dir, claude.command.split(/[\\/]/).pop())
      : claude.command;
    const real = realpathSync(claude.command === "claude" ? whichClaude() : found);
    const dir = join(mkdtempSync(join(tmpdir(), "ccc-e2e-bin-")), "Программы Ação");
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, real.split(/[\\/]/).pop());
    copyFileSync(real, copy);
    if (process.platform !== "win32") (await import("node:fs")).chmodSync(copy, 0o755);
    const { env } = freshEnv();
    const result = await probe(env, copy);
    assert.equal(result.result, "ok");
    assert.equal(result.status.auth, "none");
  });

function whichClaude() {
  const exts = process.platform === "win32" ? [".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const ext of exts) {
      const file = join(dir, `claude${ext}`);
      try {
        if (realpathSync(file)) return file;
      } catch {
        // not here
      }
    }
  }
  throw new Error("no native claude binary on PATH");
}

// npm's claude.cmd shim (cmd.exe) in a non-ASCII prefix: how cross-spawn runs a .cmd.
const shim = process.env.CCC_E2E_CLAUDE_SHIM;
test("(f) Windows: npm's claude.cmd shim in a non-ASCII folder", { skip: !enabled || !shim },
  async () => {
    const { env } = freshEnv();
    const result = await probe(env, shim);
    assert.equal(result.result, "ok");
    assert.equal(result.status.auth, "none");
  });
