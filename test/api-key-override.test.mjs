// An API key that Claude Code uses ahead of a Claude.ai login (claude-auth.ts
// apiKeyOverride): ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY or an apiKeyHelper
// beat `/login` in Claude Code's auth precedence, so a Pro/Max subscriber with
// one of them set is billed per token. One line says so before Claude Code
// starts; Anthropic's "credit balance too low" always gets the plan advice.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { apiKeyOverride, creditNoticeText, envApiKeySet } from "../dist/claude-auth.js";
import {
  apiKeyOverrideText,
  creditAdviceApplies,
} from "../dist/claude-plan-warning.js";
import { sanitizeContext } from "../dist/diagnostics-schema.js";

const HOME = "/home/ada";
const KEY = "sk-ant-api03-ZyXw9876543210abcdefghijklmnop";

function files(map) {
  return (file) => (file in map ? map[file] : null);
}

function override(env, map = {}, interactive = false) {
  return apiKeyOverride({ env, homedir: HOME, cwd: "/work", readFile: files(map), interactive });
}

function globalConfig(responses) {
  return { [join(HOME, ".claude.json")]: JSON.stringify({
    oauthAccount: {}, customApiKeyResponses: responses }) };
}

test("the API key line, word for word", () => {
  assert.equal(apiKeyOverrideText({ source: "ANTHROPIC_API_KEY", asks: false }, false),
    "ANTHROPIC_API_KEY is set, so Claude Code bills that API key instead of your Pro/Max " +
    "plan. Unset it (or run `ccc` without it) to use your plan.");
  assert.equal(apiKeyOverrideText({ source: "ANTHROPIC_AUTH_TOKEN", asks: false }, false),
    "ANTHROPIC_AUTH_TOKEN is set, so Claude Code bills that API key instead of your Pro/Max " +
    "plan. Unset it (or run `ccc` without it) to use your plan.");
  assert.equal(apiKeyOverrideText({ source: "ANTHROPIC_API_KEY", asks: true }, false),
    "ANTHROPIC_API_KEY is set: if Claude Code asks whether to use it, answer No, or it bills " +
    "that API key instead of your Pro/Max plan. Unset it to stop the question.");
  assert.equal(apiKeyOverrideText({ source: "apiKeyHelper", asks: false }, false),
    "Claude Code's settings set an apiKeyHelper, so Claude Code bills that API key instead of " +
    "your Pro/Max plan. Remove apiKeyHelper from settings.json to use your plan.");
  assert.match(apiKeyOverrideText({ source: "apiKeyHelper", asks: false }, true),
    /^\x1b\[33m.*\x1b\[39m$/);
  for (const source of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "apiKeyHelper"]) {
    assert.doesNotMatch(apiKeyOverrideText({ source, asks: false }, false), /\n/);
  }
});

test("Claude Code's precedence: auth token, then API key, then apiKeyHelper", () => {
  const helper = { [join(HOME, ".claude", "settings.json")]: '{"apiKeyHelper":"vault get"}' };
  assert.deepEqual(override({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: KEY }, helper),
    { source: "ANTHROPIC_AUTH_TOKEN", asks: false });
  assert.deepEqual(override({ ANTHROPIC_API_KEY: KEY }, helper),
    { source: "ANTHROPIC_API_KEY", asks: false });
  assert.deepEqual(override({}, helper), { source: "apiKeyHelper", asks: false });
  assert.deepEqual(override({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, helper),
    { source: "apiKeyHelper", asks: false }, "a setup-token ranks below the keys");
  assert.equal(override({}), undefined);
  assert.equal(override({ ANTHROPIC_API_KEY: "  " }), undefined, "blank is unset");
});

test("cloud providers take no API key: no override", () => {
  for (const flag of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                      "CLAUDE_CODE_USE_FOUNDRY"]) {
    assert.equal(override({ [flag]: "1", ANTHROPIC_API_KEY: KEY }), undefined, flag);
  }
});

test("interactive: ANTHROPIC_API_KEY is used once approved, asked when new, not if rejected", () => {
  const tail = KEY.slice(-20);
  assert.deepEqual(override({ ANTHROPIC_API_KEY: KEY },
    globalConfig({ approved: [tail], rejected: [] }), true),
  { source: "ANTHROPIC_API_KEY", asks: false });
  assert.equal(override({ ANTHROPIC_API_KEY: KEY },
    globalConfig({ approved: [], rejected: [tail] }), true), undefined);
  assert.deepEqual(override({ ANTHROPIC_API_KEY: ` ${KEY}\n` },
    globalConfig({ approved: [], rejected: ["somethingelse"] }), true),
  { source: "ANTHROPIC_API_KEY", asks: true });
  assert.deepEqual(override({ ANTHROPIC_API_KEY: KEY }, {}, true),
    { source: "ANTHROPIC_API_KEY", asks: true }, "no config: Claude Code asks");
  // Print mode never asks: the key is used even if an interactive session rejected it.
  assert.deepEqual(override({ ANTHROPIC_API_KEY: KEY },
    globalConfig({ approved: [], rejected: [tail] }), false),
  { source: "ANTHROPIC_API_KEY", asks: false });
  // The auth token is never asked about.
  assert.deepEqual(override({ ANTHROPIC_AUTH_TOKEN: "t" }, {}, true),
    { source: "ANTHROPIC_AUTH_TOKEN", asks: false });
});

test("the line is printed only when a Claude.ai login is on file too", () => {
  const script = [
    "import { printApiKeyOverrideWarning } from './dist/claude-plan-warning.js';",
    "const o = { source: 'ANTHROPIC_API_KEY', asks: false };",
    "const out = (v) => process.stdout.write(`${v}\\n`);",
    "out(printApiKeyOverrideWarning(o, false, false));",
    "out(printApiKeyOverrideWarning(undefined, true, false));",
    "out(printApiKeyOverrideWarning(o, true, false));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", cwd: new URL("..", import.meta.url),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "false\nfalse\ntrue\n", "stdout stays Claude Code's in print runs");
  assert.equal(r.stderr, `${apiKeyOverrideText({ source: "ANTHROPIC_API_KEY", asks: false },
    false)}\n`);
});

test("credit balance too low: the plan advice for every sign-in type", () => {
  for (const auth of ["api_key", "subscription", "unknown", undefined]) {
    assert.equal(creditAdviceApplies(auth, "unknown"), true, String(auth));
    assert.equal(creditAdviceApplies(auth, "free"), true, String(auth));
  }
  // An OAuth token with a paid tier on record already has the plan the advice asks for.
  for (const plan of ["pro", "max", "max_5x", "max_20x", "team", "enterprise"]) {
    assert.equal(creditAdviceApplies("subscription", plan), false, plan);
    assert.equal(creditAdviceApplies("api_key", plan), true, `api_key/${plan}`);
  }
});

test("credit advice: Console sign-in, the plan login, and the env variable case", () => {
  const generic = creditNoticeText(false);
  assert.equal(generic,
    "Anthropic refused Claude Code's request: credit balance too low. Claude Code is billing " +
    "an API key, an Anthropic Console account or a Claude account without a paid plan. ccc " +
    "needs a Pro or Max plan: run `claude`, `/logout`, then `/login` and choose \"Claude " +
    "account with subscription\". If ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, unset it too: it " +
    "beats `/login`.");
  assert.equal(creditNoticeText(false, "ANTHROPIC_API_KEY"),
    "Anthropic refused Claude Code's request: credit balance too low. Claude Code is billing " +
    "an API key, an Anthropic Console account or a Claude account without a paid plan. ccc " +
    "needs a Pro or Max plan: run `claude`, `/logout`, then `/login` and choose \"Claude " +
    "account with subscription\". ANTHROPIC_API_KEY is set, and it beats `/login`: unset it (or run `ccc` " +
    "without it).");
  assert.match(creditNoticeText(false, "apiKeyHelper"), /settings set an apiKeyHelper.*remove/);
  assert.match(creditNoticeText(true), /^\x1b\[33m.*\x1b\[39m$/);
  assert.doesNotMatch(generic, /\n/);
});

test("diagnostics: env_api_key_set is a boolean, from the variables' names only", () => {
  assert.equal(envApiKeySet({ ANTHROPIC_API_KEY: KEY }), true);
  assert.equal(envApiKeySet({ ANTHROPIC_AUTH_TOKEN: "t" }), true);
  assert.equal(envApiKeySet({ ANTHROPIC_API_KEY: " " }), false);
  assert.equal(envApiKeySet({}), false);
  assert.deepEqual(sanitizeContext({ env_api_key_set: true }), { env_api_key_set: true });
  assert.deepEqual(sanitizeContext({ env_api_key_set: KEY }), {}, "never a value");
});
