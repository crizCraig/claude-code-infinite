// HTTPS-proxy mode's session setup (src/https-proxy-session.ts): Claude Code's env, and the
// Bash env file that gives programs run from the Bash tool what they see in base-URL mode.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeChildEnv } from "../dist/claude-env.js";
import {
  MODEL_CALLS_MISSING, ModelCallWatch, sanitizedNoProxy, startHttpsProxySession,
} from "../dist/https-proxy-session.js";

const POSIX = { skip: process.platform === "win32" };

/** Run `sh` with `env`, source CLAUDE_ENV_FILE as Claude Code does, and return the env. */
function bashSees(env, before = "") {
  const out = spawnSync("/bin/sh", ["-c", `${before}. "$CLAUDE_ENV_FILE"; env -0`],
    { env, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return Object.fromEntries(out.stdout.split("\0").filter(Boolean)
    .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
}

const ROOT = mkdtempSync(path.join(tmpdir(), "ccc-session-test-"));

function session(parentEnv, port = 41234) {
  const s = startHttpsProxySession(parentEnv, undefined, ROOT);
  const child = s.childFor(port);
  return { s, child, env: claudeChildEnv(parentEnv, `http://127.0.0.1:${port}`, child) };
}

test("Claude Code gets the token proxy and the bundle, and no base URL", () => {
  const parent = { PATH: "/bin", ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", https_proxy: "", CCC_AUTO_COMPACT: "0" };
  const { s, child, env } = session(parent);
  try {
    assert.match(env.HTTPS_PROXY, /^http:\/\/ccc:[0-9a-f]{48}@127\.0\.0\.1:41234$/);
    assert.equal(env.NODE_EXTRA_CA_CERTS, child.caBundlePath);
    assert.equal(env.CLAUDE_ENV_FILE, child.bashEnvPath);
    assert.equal(env.CCC_MEMTREE_PROXY, "http://127.0.0.1:41234");
    for (const gone of ["ANTHROPIC_BASE_URL", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "https_proxy", "CCC_AUTO_COMPACT"]) {
      assert.equal(env[gone], undefined, gone);
    }
    assert.equal(env.DISABLE_AUTO_COMPACT, "1");
    assert.equal(env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD, "1000000000");
    assert.equal(parent.ANTHROPIC_BASE_URL, "http://127.0.0.1:1", "the parent env is untouched");
    const bundle = readFileSync(child.caBundlePath, "utf8");
    assert.match(bundle, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(bundle, /PRIVATE KEY/);
  } finally {
    s.cleanup();
  }
});

test("Bash commands get today's base URL back, the user's own values, and never the token",
  POSIX, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ccc it's-"));
    const userCa = path.join(dir, "corp.pem");
    writeFileSync(userCa, "");
    const userEnvFile = path.join(dir, "user's env.sh");
    writeFileSync(userEnvFile, "export FROM_USER_FILE=yes\n");
    const parent = { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: userCa,
      CLAUDE_ENV_FILE: userEnvFile, NO_PROXY: "localhost,.anthropic.com", CCC_HTTPS_PROXY_MODE: "1" };
    const { s, child, env } = session(parent);
    try {
      const seen = bashSees(env);
      assert.equal(seen.HTTPS_PROXY, undefined);
      assert.equal(seen.https_proxy, undefined);
      assert.equal(seen.NODE_EXTRA_CA_CERTS, userCa);
      assert.equal(seen.NO_PROXY, "localhost,.anthropic.com");
      assert.equal(seen.CLAUDE_ENV_FILE, userEnvFile);
      assert.equal(seen.CCC_MEMTREE_PROXY, undefined);
      assert.equal(seen.CCC_HTTPS_PROXY_MODE, "1");
      assert.equal(seen.ANTHROPIC_BASE_URL, "http://127.0.0.1:41234");
      assert.equal(seen._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "1");
      assert.equal(seen.FROM_USER_FILE, "yes", "the user's own env file is sourced last");
      const script = readFileSync(child.bashEnvPath, "utf8");
      assert.ok(!script.includes(env.HTTPS_PROXY.split(":")[2].split("@")[0]), "no token");
      assert.equal(statSync(child.bashEnvPath).mode & 0o077, 0);
    } finally {
      s.cleanup();
    }
  });

test("the sandbox's own proxy and CA survive the Bash env file", POSIX, () => {
  const { s, env } = session({ PATH: process.env.PATH });
  try {
    const seen = bashSees(env, "export HTTPS_PROXY=http://localhost:3128 " +
      "NODE_EXTRA_CA_CERTS=/sandbox/ca.pem NO_PROXY=sandbox; ");
    assert.equal(seen.HTTPS_PROXY, "http://localhost:3128");
    assert.equal(seen.NODE_EXTRA_CA_CERTS, "/sandbox/ca.pem");
    assert.equal(seen.NO_PROXY, "sandbox");
    const other = bashSees(env, "export HTTPS_PROXY=http://ccc:x@127.0.0.1:9; ");
    assert.equal(other.HTTPS_PROXY, "http://ccc:x@127.0.0.1:9", "another port's proxy is kept");
  } finally {
    s.cleanup();
  }
});

test("NO_PROXY entries that would send api.anthropic.com past ccc are dropped", () => {
  assert.deepEqual(sanitizedNoProxy({}), {});
  assert.deepEqual(sanitizedNoProxy({ NO_PROXY: "localhost,127.0.0.1" }), {}, "unchanged: unset");
  assert.deepEqual(sanitizedNoProxy({
    NO_PROXY: "localhost, *, .anthropic.com,api.anthropic.com:443",
    no_proxy: "*.anthropic.com anthropic.com. example.com com API.ANTHROPIC.COM",
  }), { NO_PROXY: "localhost", no_proxy: "example.com" });
  assert.deepEqual(sanitizedNoProxy({ NO_PROXY: "notanthropic.com,claude.ai" }), {});
  const { s, env } = session({ NO_PROXY: "*,internal" });
  try {
    assert.equal(env.NO_PROXY, "internal");
  } finally {
    s.cleanup();
  }
});

test("cleanup removes the session's files", () => {
  const { s, child } = session({});
  assert.ok(existsSync(child.bashEnvPath));
  s.cleanup();
  assert.equal(existsSync(path.dirname(child.caBundlePath)), false);
});

test("two consecutive prompts with no model call through ccc get one warning", () => {
  const watch = new ModelCallWatch();
  assert.equal(watch.promptLine(), undefined);
  watch.modelCall();
  assert.equal(watch.promptLine(), undefined, "a model call since the last prompt");
  assert.equal(watch.promptLine(), undefined, "one prompt without a call (a blocked prompt)");
  assert.equal(watch.promptLine(), MODEL_CALLS_MISSING);
  assert.equal(watch.promptLine(), undefined, "once per session");
  assert.match(MODEL_CALLS_MISSING, /CCC_HTTPS_PROXY_MODE=0/);
});
