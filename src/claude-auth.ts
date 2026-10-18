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

export const CLAUDE_AUTH_TYPES = [
  "subscription", "api_key", "bedrock", "vertex", "foundry", "unknown",
] as const;
export type ClaudeAuthType = (typeof CLAUDE_AUTH_TYPES)[number];

/** A Claude.ai plan tier, by name only. */
export const CLAUDE_PLANS = [
  "free", "pro", "max", "max_5x", "max_20x", "team", "enterprise", "unknown",
] as const;
export type ClaudePlan = (typeof CLAUDE_PLANS)[number];

/** Anthropic's 400 for an API key whose organization has no credit left. */
export const CREDIT_BALANCE_TOO_LOW = "credit_balance_too_low";
export type UpstreamErrorCode = typeof CREDIT_BALANCE_TOO_LOW;

export interface ClaudeAuthOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  cwd?: string;
  /** The file's text, or null when it cannot be read. */
  readFile?: (file: string) => string | null;
}

/** The sign-in type from env and Claude Code's config, before any request. */
export function claudeAuthFromConfig(opts: ClaudeAuthOptions = {}): ClaudeAuthType {
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? readTextOrNull;
  if (envFlag(env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (envFlag(env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (envFlag(env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  if (nonEmpty(env.ANTHROPIC_API_KEY) || nonEmpty(env.ANTHROPIC_AUTH_TOKEN)) return "api_key";
  const home = opts.homedir ?? os.homedir();
  const configDir = nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR! : path.join(home, ".claude");
  if (settingsFiles(configDir, opts.cwd ?? process.cwd()).some((f) => hasApiKeyHelper(read(f)))) {
    return "api_key";
  }
  const globalConfig = nonEmpty(env.CLAUDE_CONFIG_DIR)
    ? path.join(env.CLAUDE_CONFIG_DIR!, ".claude.json")
    : path.join(home, ".claude.json");
  return authFromGlobalConfig(read(globalConfig));
}

/**
 * The Claude.ai plan tier Claude Code recorded locally: `organizationType` and
 * `organizationRateLimitTier` in `~/.claude.json`, else `subscriptionType` in
 * `.credentials.json` (Linux and Windows). Only those values are matched, and
 * only a known tier name comes out; "unknown" otherwise.
 */
export function claudePlanFromConfig(opts: ClaudeAuthOptions = {}): ClaudePlan {
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? readTextOrNull;
  const home = opts.homedir ?? os.homedir();
  const dir = nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR! : null;
  const global = read(dir ? path.join(dir, ".claude.json") : path.join(home, ".claude.json"));
  const fromGlobal = planFrom(
    stringField(global, "organizationType"), stringField(global, "organizationRateLimitTier"));
  if (fromGlobal !== "unknown") return fromGlobal;
  const credentials = read(path.join(dir ?? path.join(home, ".claude"), ".credentials.json"));
  return planFrom(stringField(credentials, "subscriptionType"), undefined);
}

/** The sign-in type a request's auth headers show, or undefined when they show none. */
export function claudeAuthFromHeaders(
  headers: Record<string, string | string[] | undefined>
): ClaudeAuthType | undefined {
  if (nonEmpty(first(headers["x-api-key"]))) return "api_key";
  const auth = first(headers["authorization"]);
  if (!auth) return undefined;
  const token = /^Bearer\s+(\S+)/i.exec(auth.trim())?.[1] ?? "";
  if (token.startsWith("sk-ant-oat")) return "subscription";
  if (token.startsWith("sk-ant-api")) return "api_key";
  return "unknown";
}

/** A known Anthropic error in a JSON error body, by code; undefined otherwise. */
export function upstreamErrorCode(body: Buffer | string): UpstreamErrorCode | undefined {
  const text = typeof body === "string" ? body : body.subarray(0, 16 * 1024).toString("utf8");
  let message: unknown;
  try {
    message = JSON.parse(text)?.error?.message;
  } catch {
    return undefined;
  }
  return typeof message === "string" && /credit balance is too low/i.test(message)
    ? CREDIT_BALANCE_TOO_LOW
    : undefined;
}

/** Printed once when Anthropic refused an API key for having no credit. */
export function creditNoticeText(color: boolean): string {
  const text =
    "ccc isn't free Claude: it runs your own Claude Code, and this API key has no credit. " +
    "Sign in with a Claude Pro or Max plan (run `claude`, then /login) or add credit to the key.";
  return color ? `\x1b[33m${text}\x1b[39m` : text;
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

function settingsFiles(configDir: string, cwd: string): string[] {
  return [
    path.join(configDir, "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
}

function hasApiKeyHelper(text: string | null): boolean {
  if (text === null) return false;
  try {
    const helper = JSON.parse(text)?.apiKeyHelper;
    return typeof helper === "string" && helper.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Key names only: the file holds account details (and, for a Console login on
 * some systems, the key), none of which is parsed out or kept.
 */
function authFromGlobalConfig(text: string | null): ClaudeAuthType {
  if (text === null) return "unknown";
  if (/"oauthAccount"\s*:\s*\{/.test(text)) return "subscription";
  if (/"primaryApiKey"\s*:\s*"[^"]/.test(text)) return "api_key";
  return "unknown";
}

/** "claude_max" + "default_claude_max_20x" → "max_20x"; "pro" → "pro". */
export function planFrom(type: string | undefined, rateTier: string | undefined): ClaudePlan {
  const t = (type ?? "").toLowerCase();
  const tier = (rateTier ?? "").toLowerCase();
  if (/max/.test(t)) return /20x/.test(tier) ? "max_20x" : /5x/.test(tier) ? "max_5x" : "max";
  for (const plan of ["pro", "team", "enterprise", "free"] as const) {
    if (new RegExp(`(^|_)${plan}($|_)`).test(t)) return plan;
  }
  return "unknown";
}

/** One short `"key": "value"` string (letters, digits, `_`), without parsing the rest. */
function stringField(text: string | null, key: string): string | undefined {
  if (text === null) return undefined;
  return new RegExp(`"${key}"\\s*:\\s*"([A-Za-z0-9_]{1,40})"`).exec(text)?.[1];
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function envFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
