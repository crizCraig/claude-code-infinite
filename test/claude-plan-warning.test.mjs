// The "no Claude plan" line (claude-plan-warning.ts): shown before the first
// prompt when Claude Code is on an API key or not signed in, never for a
// subscription; the same advice when Anthropic answers credit_balance_too_low.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  NO_PLAN_TEXT,
  needsPlanWarning,
  noPlanWarningText,
  readSeenClaudeAuth,
  writeSeenClaudeAuth,
} from "../dist/claude-plan-warning.js";
import { claudeAuthFromConfig, creditNoticeText } from "../dist/claude-auth.js";
import { Diagnostics, DiagnosticsRequestSink } from "../dist/diagnostics.js";
import { sanitizeEvent } from "../dist/diagnostics-schema.js";

const EXPECTED =
  "ccc needs Claude Code signed in with a Claude Pro or Max plan (run `claude`, then `/login`). " +
  "With an API key you pay Anthropic per token, and a key with no credit won't work.";

test("the line is the agreed text, one line", () => {
  assert.equal(NO_PLAN_TEXT, EXPECTED);
  assert.equal(noPlanWarningText(false), EXPECTED);
  assert.match(noPlanWarningText(true), /^\x1b\[33m.*\x1b\[39m$/);
  assert.doesNotMatch(NO_PLAN_TEXT, /\n/);
});

test("credit_balance_too_low gets the same advice", () => {
  assert.equal(creditNoticeText(false), EXPECTED);
  assert.equal(creditNoticeText(true), noPlanWarningText(true));
});

test("warns on an API key or no sign-in, unless a paid plan is recorded", () => {
  for (const auth of ["api_key", "unknown"]) {
    for (const plan of ["unknown", "free"]) {
      assert.equal(needsPlanWarning({ auth, plan }), true, `${auth}/${plan}`);
    }
  }
  // A free plan on record with a login on file may be stale (upgraded since): not warned.
  assert.equal(needsPlanWarning({ auth: "subscription", plan: "free" }), false);
  assert.equal(needsPlanWarning({ auth: "unknown", plan: "free", subscriptionLogin: true }), false);
});

test("never fires for a subscription", () => {
  for (const plan of ["pro", "max", "max_5x", "max_20x", "team", "enterprise", "unknown"]) {
    assert.equal(needsPlanWarning({ auth: "subscription", plan }), false, plan);
    // A paid plan on record wins over a stray key in the environment or no sign-in seen yet.
    if (plan !== "unknown") {
      assert.equal(needsPlanWarning({ auth: "api_key", plan }), false, `api_key/${plan}`);
      assert.equal(needsPlanWarning({ auth: "unknown", plan }), false, `unknown/${plan}`);
    }
  }
  // What Claude Code last sent through ccc beats the config files' silence.
  assert.equal(needsPlanWarning({ auth: "api_key", plan: "unknown", seen: "subscription" }), false);
  assert.equal(needsPlanWarning({ auth: "unknown", plan: "free", seen: "subscription" }), false);
  // A claude.ai login on file (oauthAccount, no Console key) with ANTHROPIC_API_KEY exported:
  // Claude Code asks whether to use the key, so the login may well be what it uses.
  assert.equal(needsPlanWarning({ auth: "api_key", plan: "unknown", subscriptionLogin: true }),
    false);
});

test("a stale API-key sighting never outweighs a subscription on file", () => {
  // Refused for credit, then `claude` → `/login` to Max outside ccc: the next ccc launch.
  assert.equal(needsPlanWarning({ auth: "subscription", plan: "max", seen: "api_key" }), false);
  assert.equal(needsPlanWarning({ auth: "api_key", plan: "pro", seen: "api_key" }), false);
  assert.equal(needsPlanWarning({ auth: "subscription", plan: "unknown", seen: "api_key" }), false);
  // Nothing on file but the key: still warned.
  assert.equal(needsPlanWarning({ auth: "unknown", plan: "unknown", seen: "api_key" }), true);
  assert.equal(needsPlanWarning({ auth: "api_key", plan: "free", seen: "api_key" }), true);
});

test("cloud providers are not Claude plans and are not warned", () => {
  for (const auth of ["bedrock", "vertex", "foundry"]) {
    assert.equal(needsPlanWarning({ auth, plan: "unknown" }), false, auth);
    assert.equal(needsPlanWarning({ auth, plan: "unknown", seen: "api_key" }), false, auth);
  }
});

test("a long-lived subscription token (claude setup-token) counts as a subscription", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" };
  const auth = claudeAuthFromConfig({ env, homedir: "/home/ada", cwd: "/w", readFile: () => null });
  assert.equal(auth, "subscription");
  // Claude Code prefers an API key in the environment over that token.
  const both = { ...env, ANTHROPIC_API_KEY: "sk-ant-api03-x" };
  assert.equal(claudeAuthFromConfig({ env: both, homedir: "/home/ada", readFile: () => null }),
    "api_key");
});

test("a claude.ai login on file, by key names only", async () => {
  const { claudeSubscriptionLogin } = await import("../dist/claude-auth.js");
  const at = (files) => claudeSubscriptionLogin({
    env: {}, homedir: "/home/ada", readFile: (f) => files[f.replace(/\\/g, "/")] ?? null,
  });
  assert.equal(at({ "/home/ada/.claude.json": '{"oauthAccount": {"emailAddress": "a@b.c"}}' }), true);
  assert.equal(at({ "/home/ada/.claude.json":
    '{"oauthAccount": {"x": 1}, "primaryApiKey": "sk-ant-api03-x"}' }), false, "a Console login");
  assert.equal(at({ "/home/ada/.claude/.credentials.json": '{"claudeAiOauth": {"accessToken": "t"}}' }),
    true);
  assert.equal(at({}), false);
  // `claude setup-token`, even beside an exported API key.
  assert.equal(claudeSubscriptionLogin({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" },
    homedir: "/home/ada", readFile: () => null }), true);
});

test("info-only runs (--version, --help) get no line", async () => {
  const { isInfoOnlyRun } = await import("../dist/claude-plan-warning.js");
  for (const args of [["--version"], ["-v"], ["--help"], ["-h"], ["mcp", "--help"]]) {
    assert.equal(isInfoOnlyRun(args), true, args.join(" "));
  }
  for (const args of [[], ["-p", "hi"], ["--resume"], ["-p", "--", "--help"]]) {
    assert.equal(isInfoOnlyRun(args), false, args.join(" "));
  }
});

test("the sign-in type Claude Code last used is kept as a type only", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-seen-"));
  assert.equal(readSeenClaudeAuth(dir), undefined);
  writeSeenClaudeAuth(dir, "subscription");
  assert.equal(readSeenClaudeAuth(dir), "subscription");
  writeSeenClaudeAuth(dir, "api_key");
  assert.equal(readSeenClaudeAuth(dir), "api_key");
  writeFileSync(join(dir, "claude-auth-seen"), "sk-ant-oat01-secret\n");
  assert.equal(readSeenClaudeAuth(dir), undefined, "anything else is ignored");
  assert.equal(readSeenClaudeAuth(join(dir, "missing")), undefined);
  writeSeenClaudeAuth(join(dir, "no", "such", "dir"), "api_key"); // never throws
});

test("the tee reports each request's sign-in type, and a credit refusal as an API key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-tee-"));
  const diagnostics = new Diagnostics({
    baseUrl: "http://127.0.0.1:9", configDir: dir, clientName: "t", clientVersion: "1.0.0",
    config: {}, env: { CCC_DIAGNOSTICS: "0" },
  });
  const seen = [];
  const credit = [];
  const sink = new DiagnosticsRequestSink(undefined, diagnostics, (a) => credit.push(a ?? "none"),
    (a) => seen.push(a));
  const rec = (extra) => ({ kind: "messages", turnType: "first-user", ...extra });
  sink.log(rec({ claudeAuth: "subscription", upstreamStatus: 200 }));
  sink.log(rec({ claudeAuth: "unknown", upstreamStatus: 200 }));
  sink.log(rec({ claudeAuth: "api_key", upstreamStatus: 400, upstreamError: "credit_balance_too_low" }));
  sink.log(rec({ upstreamStatus: 400, upstreamError: "credit_balance_too_low" }));
  // A credit refusal on a subscription token stays a subscription (extra usage ran out).
  sink.log(rec({ claudeAuth: "subscription", upstreamStatus: 400,
                 upstreamError: "credit_balance_too_low" }));
  assert.deepEqual(seen, ["subscription", "api_key", "api_key", "subscription"]);
  // ccc's exit line is for API keys: the subscription's refusal is passed on as one.
  assert.deepEqual(credit, ["api_key", "none", "subscription"]);
});

test("diagnostics: the warning is recorded by sign-in type only", () => {
  assert.deepEqual(sanitizeEvent("no_plan_warning", { auth: "api_key" }, 5),
    { name: "no_plan_warning", t: 5, auth: "api_key" });
  assert.deepEqual(sanitizeEvent("no_plan_warning", { auth: "sk-ant-api03-x" }, 5),
    { name: "no_plan_warning", t: 5 });
});

test("print mode: the warning goes to stderr, stdout stays Claude's", () => {
  const script = [
    "import { printNoPlanWarning } from './dist/claude-plan-warning.js';",
    "printNoPlanWarning({ auth: 'api_key', plan: 'unknown' }, false);",
    "printNoPlanWarning({ auth: 'subscription', plan: 'max' }, false);",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", cwd: new URL("..", import.meta.url),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `${EXPECTED}\n`);
});
