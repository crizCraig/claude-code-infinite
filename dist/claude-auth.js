/**
 * How Claude Code is signed in, as a type only (and, for a Claude.ai login,
 * the plan tier's name), for diagnostics and for one notice: `subscription` (a Claude.ai login, Pro/Max), `api_key`
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, an apiKeyHelper or a Console key),
 * `bedrock`, `vertex`, `foundry`, or `unknown`.
 *
 * No secret or account identifier is ever kept or sent. At startup the answer
 * comes from env variable names being set, settings keys being present and
 * `~/.claude.json` naming an `oauthAccount` (whose contents are not read out).
 * Once Claude Code sends a request through the proxy, its auth header's shape
 * decides it: an OAuth token (`sk-ant-oat…`) is a subscription, an
 * `x-api-key` or `sk-ant-api…` bearer is an API key. Only that classification
 * leaves this module.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { creditAdviceText } from "./claude-plan-warning.js";
/** "none": Claude Code says nobody is signed in (claude-auth-status.ts); "unknown": can't tell. */
export const CLAUDE_AUTH_TYPES = [
    "subscription", "api_key", "bedrock", "vertex", "foundry", "none", "unknown",
];
/** A Claude.ai plan tier, by name only. */
export const CLAUDE_PLANS = [
    "free", "pro", "max", "max_5x", "max_20x", "team", "enterprise", "unknown",
];
/** Anthropic's 400 for an API key whose organization has no credit left. */
export const CREDIT_BALANCE_TOO_LOW = "credit_balance_too_low";
/** The sign-in type from env and Claude Code's config, before any request. */
export function claudeAuthFromConfig(opts = {}) {
    const env = opts.env ?? process.env;
    const read = opts.readFile ?? readTextOrNull;
    if (envFlag(env.CLAUDE_CODE_USE_BEDROCK))
        return "bedrock";
    if (envFlag(env.CLAUDE_CODE_USE_VERTEX))
        return "vertex";
    if (envFlag(env.CLAUDE_CODE_USE_FOUNDRY))
        return "foundry";
    if (nonEmpty(env.ANTHROPIC_API_KEY) || nonEmpty(env.ANTHROPIC_AUTH_TOKEN))
        return "api_key";
    const home = opts.homedir ?? os.homedir();
    const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
    if (settingsFiles(configDir, opts.cwd ?? process.cwd()).some((f) => hasApiKeyHelper(read(f)))) {
        return "api_key";
    }
    // `claude setup-token`'s long-lived subscription token; below the keys, as in Claude Code.
    if (nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN))
        return "subscription";
    const globalConfig = nonEmpty(env.CLAUDE_CONFIG_DIR)
        ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : path.join(home, ".claude.json");
    return authFromGlobalConfig(read(globalConfig));
}
/**
 * The API key Claude Code uses ahead of a `/login`, in its documented auth
 * precedence: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, then an apiKeyHelper
 * setting, all above a `claude setup-token` token and the Claude.ai login.
 * An interactive session uses ANTHROPIC_API_KEY only once the user approved it
 * (Claude Code keeps the key's last 20 characters in `~/.claude.json`
 * customApiKeyResponses), asks when it is new, and skips a rejected one; print
 * mode always uses it. Only the source's name leaves this function.
 */
export function apiKeyOverride(opts) {
    const env = opts.env ?? process.env;
    const read = opts.readFile ?? readTextOrNull;
    if (cloudProvider(env))
        return undefined;
    if (nonEmpty(env.ANTHROPIC_AUTH_TOKEN))
        return { source: "ANTHROPIC_AUTH_TOKEN", asks: false };
    if (nonEmpty(env.ANTHROPIC_API_KEY)) {
        const answer = opts.interactive
            ? envKeyAnswer(read(globalConfigPath(env, opts.homedir)), env.ANTHROPIC_API_KEY)
            : "approved";
        if (answer !== "rejected")
            return { source: "ANTHROPIC_API_KEY", asks: answer === "new" };
    }
    const configDir = claudeConfigDir(env, opts.homedir);
    if (settingsFiles(configDir, opts.cwd ?? process.cwd()).some((f) => hasApiKeyHelper(read(f)))) {
        return { source: "apiKeyHelper", asks: false };
    }
    return undefined;
}
/** ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set (names only, for diagnostics). */
export function envApiKeySet(env = process.env) {
    return nonEmpty(env.ANTHROPIC_API_KEY) || nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
}
/**
 * Whether a claude.ai login is on file, by key names only: `oauthAccount` in
 * `~/.claude.json` without a Console key, or `claudeAiOauth` in
 * `.credentials.json` (Linux and Windows), or a `claude setup-token` token in
 * the environment. Unlike claudeAuthFromConfig it ignores env API keys, which
 * Claude Code asks about before using.
 */
export function claudeSubscriptionLogin(opts = {}) {
    const env = opts.env ?? process.env;
    const read = opts.readFile ?? readTextOrNull;
    const home = opts.homedir ?? os.homedir();
    if (nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN))
        return true;
    const dir = nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : null;
    const global = read(dir ? path.join(dir, ".claude.json") : path.join(home, ".claude.json"));
    if (authFromGlobalConfig(global) === "subscription")
        return true;
    const credentials = read(path.join(dir ?? path.join(home, ".claude"), ".credentials.json"));
    return credentials !== null && /"claudeAiOauth"\s*:\s*\{/.test(credentials);
}
/**
 * The Claude.ai plan tier Claude Code recorded locally: `organizationType` and
 * `organizationRateLimitTier` in `~/.claude.json`, else `subscriptionType` in
 * `.credentials.json` (Linux and Windows). Only those values are matched, and
 * only a known tier name comes out; "unknown" otherwise.
 */
export function claudePlanFromConfig(opts = {}) {
    const env = opts.env ?? process.env;
    const read = opts.readFile ?? readTextOrNull;
    const home = opts.homedir ?? os.homedir();
    const dir = nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : null;
    const global = read(dir ? path.join(dir, ".claude.json") : path.join(home, ".claude.json"));
    const fromGlobal = planFrom(stringField(global, "organizationType"), stringField(global, "organizationRateLimitTier"));
    if (fromGlobal !== "unknown")
        return fromGlobal;
    const credentials = read(path.join(dir ?? path.join(home, ".claude"), ".credentials.json"));
    return planFrom(stringField(credentials, "subscriptionType"), undefined);
}
/** The sign-in type a request's auth headers show, or undefined when they show none. */
export function claudeAuthFromHeaders(headers) {
    if (nonEmpty(first(headers["x-api-key"])))
        return "api_key";
    const auth = first(headers["authorization"]);
    if (!auth)
        return undefined;
    const token = /^Bearer\s+(\S+)/i.exec(auth.trim())?.[1] ?? "";
    if (token.startsWith("sk-ant-oat"))
        return "subscription";
    if (token.startsWith("sk-ant-api"))
        return "api_key";
    return "unknown";
}
/** A known Anthropic error in a JSON error body, by code; undefined otherwise. */
export function upstreamErrorCode(body) {
    const text = typeof body === "string" ? body : body.subarray(0, 16 * 1024).toString("utf8");
    let message;
    try {
        message = JSON.parse(text)?.error?.message;
    }
    catch {
        return undefined;
    }
    return typeof message === "string" && /credit balance is too low/i.test(message)
        ? CREDIT_BALANCE_TOO_LOW
        : undefined;
}
/**
 * Printed once when Anthropic answered credit_balance_too_low, whatever the
 * sign-in: an Anthropic Console login sends an OAuth token just like a plan.
 */
export function creditNoticeText(color, source) {
    return creditAdviceText(color, source);
}
// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------
function settingsFiles(configDir, cwd) {
    return [
        path.join(configDir, "settings.json"),
        path.join(cwd, ".claude", "settings.json"),
        path.join(cwd, ".claude", "settings.local.json"),
    ];
}
function claudeConfigDir(env, homedir) {
    return nonEmpty(env.CLAUDE_CONFIG_DIR)
        ? env.CLAUDE_CONFIG_DIR
        : path.join(homedir ?? os.homedir(), ".claude");
}
function globalConfigPath(env, homedir) {
    return nonEmpty(env.CLAUDE_CONFIG_DIR)
        ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : path.join(homedir ?? os.homedir(), ".claude.json");
}
/**
 * Claude Code's recorded answer for this env key, compared in memory by the
 * last 20 characters as Claude Code does; nothing about the key is kept.
 */
function envKeyAnswer(text, key) {
    const block = text === null ? null : /"customApiKeyResponses"\s*:\s*(\{[^{}]*\})/.exec(text);
    if (!block)
        return "new";
    let responses;
    try {
        responses = JSON.parse(block[1]);
    }
    catch {
        return "new";
    }
    const tail = key.trim().slice(-20);
    if (Array.isArray(responses.approved) && responses.approved.includes(tail))
        return "approved";
    if (Array.isArray(responses.rejected) && responses.rejected.includes(tail))
        return "rejected";
    return "new";
}
function cloudProvider(env) {
    return envFlag(env.CLAUDE_CODE_USE_BEDROCK) || envFlag(env.CLAUDE_CODE_USE_VERTEX)
        || envFlag(env.CLAUDE_CODE_USE_FOUNDRY);
}
function hasApiKeyHelper(text) {
    if (text === null)
        return false;
    try {
        const helper = JSON.parse(text)?.apiKeyHelper;
        return typeof helper === "string" && helper.trim() !== "";
    }
    catch {
        return false;
    }
}
/**
 * Key names only: the file holds account details (and, for a Console login on
 * some systems, the key), none of which is parsed out or kept.
 */
function authFromGlobalConfig(text) {
    if (text === null)
        return "unknown";
    // A Console (API billing) login stores a key and may also record oauthAccount.
    if (/"primaryApiKey"\s*:\s*"[^"]/.test(text))
        return "api_key";
    if (/"oauthAccount"\s*:\s*\{/.test(text))
        return "subscription";
    return "unknown";
}
/** "claude_max" + "default_claude_max_20x" → "max_20x"; "pro" → "pro". */
export function planFrom(type, rateTier) {
    const t = (type ?? "").toLowerCase();
    const tier = (rateTier ?? "").toLowerCase();
    if (/max/.test(t))
        return /20x/.test(tier) ? "max_20x" : /5x/.test(tier) ? "max_5x" : "max";
    for (const plan of ["pro", "team", "enterprise", "free"]) {
        if (new RegExp(`(^|_)${plan}($|_)`).test(t))
            return plan;
    }
    return "unknown";
}
/** One short `"key": "value"` string (letters, digits, `_`), without parsing the rest. */
function stringField(text, key) {
    if (text === null)
        return undefined;
    return new RegExp(`"${key}"\\s*:\\s*"([A-Za-z0-9_]{1,40})"`).exec(text)?.[1];
}
function readTextOrNull(file) {
    try {
        return fs.readFileSync(file, "utf8");
    }
    catch {
        return null;
    }
}
function first(value) {
    return Array.isArray(value) ? value[0] : value;
}
function nonEmpty(value) {
    return typeof value === "string" && value.trim() !== "";
}
function envFlag(value) {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
//# sourceMappingURL=claude-auth.js.map