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

test("credit_balance_too_low gets the plan advice, with the Console sign-in named", () => {
  assert.match(creditNoticeText(false), /Pro or Max plan.*\/logout.*\/login/);
  assert.match(creditNoticeText(false), /Anthropic Console account/);
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
  for (const sub of ["setup-token", "doctor", "update", "upgrade", "mcp", "install", "plugins"]) {
    assert.equal(isInfoOnlyRun([sub, "x"]), true, sub);
  }
  for (const args of [[], ["-p", "hi"], ["--resume"], ["-p", "--", "--help"], ["fix", "mcp"], ["config", "the", "linter"]]) {
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
  // Every refusal is passed on with its sign-in type.
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

test("the exit credit advice is for every sign-in type without a paid tier", async () => {
  const { creditAdviceApplies } = await import("../dist/claude-plan-warning.js");
  // An OAuth token is also how Claude Code signs in to an Anthropic Console
  // account (API usage billing), whose refusal is the commonest first-run failure.
  for (const auth of ["api_key", undefined, "subscription", "unknown"]) {
    assert.equal(creditAdviceApplies(auth, "unknown"), true, String(auth));
  }
});

// A credit refusal is remembered (as a bare marker) so the next launch says why
// before the first prompt, instead of after every prompt has failed again: on
// 2026-10-21, 3 of 4 new users retried several sessions on a sign-in Anthropic
// refused for no credit (an OAuth token with no paid tier on record).
test("a credit refusal is remembered for the next launch, and forgotten on success", async () => {
  const { markCreditRefused, clearCreditRefused, creditRefusedOnFile, CREDIT_REFUSED_FILE } =
    await import("../dist/claude-plan-warning.js");
  const dir = mkdtempSync(join(tmpdir(), "ccc-credit-"));
  assert.equal(creditRefusedOnFile(dir), false);
  markCreditRefused(dir);
  assert.equal(creditRefusedOnFile(dir), true);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(dir, CREDIT_REFUSED_FILE), "utf8"), "credit_balance_too_low\n");
  clearCreditRefused(dir);
  assert.equal(creditRefusedOnFile(dir), false);
  clearCreditRefused(dir); // already gone: never throws
  markCreditRefused(join(dir, "no", "such", "dir")); // never throws
  assert.equal(creditRefusedOnFile(join(dir, "no", "such", "dir")), false);
});

test("the next launch repeats the credit advice unless a paid tier is now on record", async () => {
  const { needsCreditReminder } = await import("../dist/claude-plan-warning.js");
  for (const plan of ["unknown", "free"]) {
    assert.equal(needsCreditReminder({ refused: true, plan }), true, plan);
    assert.equal(needsCreditReminder({ refused: false, plan }), false, plan);
  }
  for (const plan of ["pro", "max", "max_5x", "max_20x", "team", "enterprise"]) {
    assert.equal(needsCreditReminder({ refused: true, plan }), false, plan);
  }
});

test("the tee reports a request Anthropic answered, so a stale refusal can be forgotten", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-tee-ok-"));
  const diagnostics = new Diagnostics({
    baseUrl: "http://127.0.0.1:9", configDir: dir, clientName: "t", clientVersion: "1.0.0",
    config: {}, env: { CCC_DIAGNOSTICS: "0" },
  });
  const ok = [];
  const sink = new DiagnosticsRequestSink(undefined, diagnostics, undefined, undefined,
    () => ok.push(true));
  const rec = (extra) => ({ kind: "messages", turnType: "first-user", ...extra });
  sink.log(rec({ claudeAuth: "subscription", upstreamStatus: 400,
                 upstreamError: "credit_balance_too_low" }));
  sink.log(rec({ claudeAuth: "subscription", upstreamStatus: 429 }));
  sink.log(rec({ claudeAuth: "subscription" })); // no answer (aborted, network)
  assert.equal(ok.length, 0);
  sink.log(rec({ claudeAuth: "subscription", upstreamStatus: 200 }));
  assert.equal(ok.length, 1);
});

test("print mode: the credit reminder goes to stderr with the plan advice", () => {
  const script = [
    "import { printStartupSignInLines } from './dist/claude-plan-warning.js';",
    "const signIn = { auth: 'subscription', plan: 'unknown' };",
    "printStartupSignInLines({ refused: true, plan: 'unknown', signIn, color: false });",
    "printStartupSignInLines({ refused: true, plan: 'pro', signIn, color: false });",
    "printStartupSignInLines({ refused: false, plan: 'unknown', signIn, color: false });",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", cwd: new URL("..", import.meta.url),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^Last time, Anthropic refused/);
  assert.match(lines[0], /Pro or Max plan.*\/logout.*\/login/);
});

test("a side request's 2xx does not count as the sign-in working again", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-tee-side-"));
  const diagnostics = new Diagnostics({
    baseUrl: "http://127.0.0.1:9", configDir: dir, clientName: "t", clientVersion: "1.0.0",
    config: {}, env: { CCC_DIAGNOSTICS: "0" },
  });
  const ok = [];
  const sink = new DiagnosticsRequestSink(undefined, diagnostics, undefined, undefined,
    () => ok.push(true));
  sink.log({ kind: "messages", turnType: "side-request", upstreamStatus: 200 });
  assert.equal(ok.length, 0);
  sink.log({ kind: "messages", turnType: "tool", upstreamStatus: 200 });
  assert.equal(ok.length, 1);
});

test("two sessions sharing the marker: each refusal writes it, each success removes it", async () => {
  const { CreditRefusalMemory, creditRefusedOnFile } =
    await import("../dist/claude-plan-warning.js");
  const dir = mkdtempSync(join(tmpdir(), "ccc-credit-two-"));
  const a = new CreditRefusalMemory(dir);
  const b = new CreditRefusalMemory(dir);
  assert.equal(a.refusedAtStart, false);
  a.refused();
  assert.equal(creditRefusedOnFile(dir), true);
  b.answered(); // B started before A's refusal, and its request went through
  assert.equal(creditRefusedOnFile(dir), false);
  a.refused(); // A is refused again after B removed the marker
  assert.equal(creditRefusedOnFile(dir), true);
  assert.equal(new CreditRefusalMemory(dir).refusedAtStart, true);
});

test("the credit reminder replaces the API-key override line, which says the same", async () => {
  const { startupSignInLines } = await import("../dist/claude-plan-warning.js");
  const override = { source: "ANTHROPIC_AUTH_TOKEN", asks: false };
  const reminded = startupSignInLines({
    refused: true, plan: "unknown", signIn: { auth: "subscription", plan: "unknown",
      subscriptionLogin: true }, override, color: false,
  });
  assert.equal(reminded.lines.length, 1);
  assert.match(reminded.lines[0], /^Last time, Anthropic refused.*ANTHROPIC_AUTH_TOKEN is set/);
  assert.equal(reminded.warned, true);
  const plain = startupSignInLines({
    refused: false, plan: "unknown", signIn: { auth: "subscription", plan: "unknown",
      subscriptionLogin: true }, override, color: false,
  });
  assert.equal(plain.lines.length, 1);
  assert.match(plain.lines[0], /^ANTHROPIC_AUTH_TOKEN is set/);
  assert.equal(plain.warned, false, "the override line is not a no-plan warning");
  const noPlan = startupSignInLines({
    refused: false, plan: "unknown", signIn: { auth: "api_key", plan: "unknown" },
    override: undefined, color: false,
  });
  assert.deepEqual(noPlan, { lines: [NO_PLAN_TEXT], warned: true });
});

test("a remembered refusal is not repeated once Claude Code runs on a cloud provider", async () => {
  const { startupSignInLines } = await import("../dist/claude-plan-warning.js");
  for (const auth of ["bedrock", "vertex", "foundry"]) {
    assert.deepEqual(startupSignInLines({
      refused: true, plan: "unknown", signIn: { auth, plan: "unknown" },
      override: undefined, color: false,
    }), { lines: [], warned: false }, auth);
  }
});
