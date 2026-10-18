// How Claude Code is signed in (claude-auth.ts): a type and a plan name only,
// from env names, config key names and the request's auth header shape; and
// Anthropic's "credit balance too low" as an error code with one exit line.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_AUTH_TYPES,
  CLAUDE_PLANS,
  CREDIT_BALANCE_TOO_LOW,
  claudeAuthFromConfig,
  claudeAuthFromHeaders,
  claudePlanFromConfig,
  creditNoticeText,
  planFrom,
  upstreamErrorCode,
} from "../dist/claude-auth.js";
import { Diagnostics, DiagnosticsRequestSink } from "../dist/diagnostics.js";
import {
  CLAUDE_AUTH_TYPES as SCHEMA_AUTH,
  CLAUDE_PLANS as SCHEMA_PLANS,
  sanitizeContext,
} from "../dist/diagnostics-schema.js";

const HOME = "/home/ada";
const OAUTH = "sk-ant-oat01-AbCdEf0123456789";
const API = "sk-ant-api03-ZyXw9876543210";

/** Claude Code's ~/.claude.json for a Claude.ai login (identifiers included, as on disk). */
const GLOBAL_CONFIG = JSON.stringify({
  numStartups: 12,
  oauthAccount: {
    accountUuid: "0a1b2c3d-1111-2222-3333-444455556666", emailAddress: "ada@example.com",
    organizationUuid: "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff", organizationName: "Ada's Org",
    organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x",
    billingType: "stripe_subscription", displayName: "Ada",
  },
});

function files(map) {
  return (file) => (Object.prototype.hasOwnProperty.call(map, file) ? map[file] : null);
}

function auth(env, map = {}) {
  return claudeAuthFromConfig({ env, homedir: HOME, cwd: "/work/app", readFile: files(map) });
}

test("config: provider env flags, then API key env, then apiKeyHelper, then the Claude.ai login", () => {
  assert.equal(auth({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: API }), "bedrock");
  assert.equal(auth({ CLAUDE_CODE_USE_VERTEX: "true" }), "vertex");
  assert.equal(auth({ CLAUDE_CODE_USE_FOUNDRY: "1" }), "foundry");
  assert.equal(auth({ CLAUDE_CODE_USE_BEDROCK: "0" }), "unknown");
  assert.equal(auth({ ANTHROPIC_API_KEY: API }, { [`${HOME}/.claude.json`]: GLOBAL_CONFIG }), "api_key");
  assert.equal(auth({ ANTHROPIC_AUTH_TOKEN: "gw-token" }), "api_key");
  assert.equal(auth({ ANTHROPIC_API_KEY: "  " }), "unknown");
  const helper = JSON.stringify({ apiKeyHelper: "~/bin/get-key.sh" });
  assert.equal(auth({}, { [`${HOME}/.claude/settings.json`]: helper }), "api_key");
  assert.equal(auth({}, { "/work/app/.claude/settings.local.json": helper }), "api_key");
  assert.equal(auth({}, { [`${HOME}/.claude.json`]: GLOBAL_CONFIG }), "subscription");
  assert.equal(auth({}, { [`${HOME}/.claude.json`]: '{"primaryApiKey": "sk-ant-api03-x"}' }), "api_key");
  assert.equal(auth({ CLAUDE_CONFIG_DIR: "/cfg" }, { "/cfg/.claude.json": GLOBAL_CONFIG }), "subscription");
  assert.equal(auth({}, { [`${HOME}/.claude.json`]: "not json {" }), "unknown");
  assert.equal(auth({}), "unknown");
});

test("headers: the auth header's shape decides; its value never comes out", () => {
  assert.equal(claudeAuthFromHeaders({ authorization: `Bearer ${OAUTH}` }), "subscription");
  assert.equal(claudeAuthFromHeaders({ "x-api-key": API }), "api_key");
  assert.equal(claudeAuthFromHeaders({ authorization: `Bearer ${API}` }), "api_key");
  assert.equal(claudeAuthFromHeaders({ authorization: "Bearer gateway-token" }), "unknown");
  assert.equal(claudeAuthFromHeaders({}), undefined);
});

test("plan: the tier name only, from organizationType/rate tier or credentials' subscriptionType", () => {
  const plan = (map, env = {}) => claudePlanFromConfig({ env, homedir: HOME, readFile: files(map) });
  assert.equal(plan({ [`${HOME}/.claude.json`]: GLOBAL_CONFIG }), "max_20x");
  const pro = GLOBAL_CONFIG.replace("claude_max", "claude_pro").replace("default_claude_max_20x", "x");
  assert.equal(plan({ [`${HOME}/.claude.json`]: pro }), "pro");
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: OAUTH, subscriptionType: "team" } });
  assert.equal(plan({ [`${HOME}/.claude/.credentials.json`]: creds }), "team");
  assert.equal(plan({ "/cfg/.credentials.json": creds }, { CLAUDE_CONFIG_DIR: "/cfg" }), "team");
  assert.equal(plan({}), "unknown");
  assert.equal(planFrom("claude_max", "default_claude_max_5x"), "max_5x");
  assert.equal(planFrom("max", undefined), "max");
  assert.equal(planFrom("enterprise", undefined), "enterprise");
  assert.equal(planFrom("claude_enterprise", undefined), "enterprise");
  assert.equal(planFrom("acme_corp_secret", undefined), "unknown", "anything else is not passed on");
  assert.equal(planFrom("prod", undefined), "unknown");
});

test("credit balance too low: recognised in Anthropic's error body, nothing else is", () => {
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } });
  assert.equal(upstreamErrorCode(Buffer.from(body)), CREDIT_BALANCE_TOO_LOW);
  assert.equal(upstreamErrorCode('{"error":{"message":"prompt is too long"}}'), undefined);
  assert.equal(upstreamErrorCode("<html>"), undefined);
  assert.match(creditNoticeText(false), /isn't free Claude.*Pro or Max.*add credit/);
  assert.doesNotMatch(creditNoticeText(false), /\n/);
});

test("the schema allows exactly these types and plans, and drops anything else", () => {
  assert.deepEqual([...SCHEMA_AUTH], [...CLAUDE_AUTH_TYPES]);
  assert.deepEqual([...SCHEMA_PLANS], [...CLAUDE_PLANS]);
  assert.deepEqual(
    sanitizeContext({ claude_auth: "subscription", claude_plan: "pro", context_window_k: 200,
                      claude_found: "native" }),
    { claude_auth: "subscription", claude_plan: "pro", claude_found: "native", context_window_k: 200 });
  assert.deepEqual(sanitizeContext({ claude_auth: OAUTH, claude_plan: "ada@example.com",
                                     claude_found: "C:\\Users\\ada", context_window_k: "1m" }), {});
});

test("the tee: auth type and window from requests, the credit error as a code, callback once each", async () => {
  const sent = [];
  const diagnostics = new Diagnostics({
    baseUrl: "https://api.example.test/", configDir: mkdtempSync(join(tmpdir(), "ccc-auth-")),
    clientName: "cc-infinite", clientVersion: "1.0.25", env: {}, config: {},
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 202 }; },
    now: () => 1_760_640_000_000,
  });
  let credit = 0;
  const sink = new DiagnosticsRequestSink(undefined, diagnostics, () => { credit += 1; });
  const rec = { kind: "messages", turnType: "first-user", requestBytes: 1000, upstreamStatus: 400,
                claudeAuth: "api_key", contextWindow: 200_000, upstreamError: CREDIT_BALANCE_TOO_LOW };
  sink.log(rec);
  sink.log(rec);
  await diagnostics.flush(1000);
  const body = sent[0];
  assert.equal(body.context.claude_auth, "api_key");
  assert.equal(body.context.context_window_k, 200);
  const errors = body.events.filter((e) => e.name === "error");
  assert.deepEqual(errors[0], { code: "credit_balance_too_low", name: "error", t: 1_760_640_000_000 });
  assert.equal(credit, 2, "ccc prints its line once itself; the tee reports each");
  assert.doesNotMatch(JSON.stringify(sent), /sk-ant|ada@example/);
});
