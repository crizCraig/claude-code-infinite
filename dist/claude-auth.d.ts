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
/** "none": Claude Code says nobody is signed in (claude-auth-status.ts); "unknown": can't tell. */
export declare const CLAUDE_AUTH_TYPES: readonly ["subscription", "api_key", "bedrock", "vertex", "foundry", "none", "unknown"];
export type ClaudeAuthType = (typeof CLAUDE_AUTH_TYPES)[number];
/** A Claude.ai plan tier, by name only. */
export declare const CLAUDE_PLANS: readonly ["free", "pro", "max", "max_5x", "max_20x", "team", "enterprise", "unknown"];
export type ClaudePlan = (typeof CLAUDE_PLANS)[number];
/** Anthropic's 400 for an API key whose organization has no credit left. */
export declare const CREDIT_BALANCE_TOO_LOW = "credit_balance_too_low";
export type UpstreamErrorCode = typeof CREDIT_BALANCE_TOO_LOW;
/** What makes Claude Code bill an API key ahead of a `/login`, by name only. */
export type ApiKeySource = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" | "apiKeyHelper";
/** An API key Claude Code uses (or, `asks`, will ask to use) ahead of a Claude.ai login. */
export interface ApiKeyOverride {
    source: ApiKeySource;
    /** An interactive session asks before using a new ANTHROPIC_API_KEY. */
    asks: boolean;
}
export interface ClaudeAuthOptions {
    env?: NodeJS.ProcessEnv;
    homedir?: string;
    cwd?: string;
    /** The file's text, or null when it cannot be read. */
    readFile?: (file: string) => string | null;
}
/** The sign-in type from env and Claude Code's config, before any request. */
export declare function claudeAuthFromConfig(opts?: ClaudeAuthOptions): ClaudeAuthType;
/**
 * The API key Claude Code uses ahead of a `/login`, in its documented auth
 * precedence: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, then an apiKeyHelper
 * setting, all above a `claude setup-token` token and the Claude.ai login.
 * An interactive session uses ANTHROPIC_API_KEY only once the user approved it
 * (Claude Code keeps the key's last 20 characters in `~/.claude.json`
 * customApiKeyResponses), asks when it is new, and skips a rejected one; print
 * mode always uses it. Only the source's name leaves this function.
 */
export declare function apiKeyOverride(opts: ClaudeAuthOptions & {
    interactive: boolean;
}): ApiKeyOverride | undefined;
/** ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set (names only, for diagnostics). */
export declare function envApiKeySet(env?: NodeJS.ProcessEnv): boolean;
/**
 * Whether a claude.ai login is on file, by key names only: `oauthAccount` in
 * `~/.claude.json` without a Console key, or `claudeAiOauth` in
 * `.credentials.json` (Linux and Windows), or a `claude setup-token` token in
 * the environment. Unlike claudeAuthFromConfig it ignores env API keys, which
 * Claude Code asks about before using.
 */
export declare function claudeSubscriptionLogin(opts?: ClaudeAuthOptions): boolean;
/**
 * The Claude.ai plan tier Claude Code recorded locally: `organizationType` and
 * `organizationRateLimitTier` in `~/.claude.json`, else `subscriptionType` in
 * `.credentials.json` (Linux and Windows). Only those values are matched, and
 * only a known tier name comes out; "unknown" otherwise.
 */
export declare function claudePlanFromConfig(opts?: ClaudeAuthOptions): ClaudePlan;
/** The sign-in type a request's auth headers show, or undefined when they show none. */
export declare function claudeAuthFromHeaders(headers: Record<string, string | string[] | undefined>): ClaudeAuthType | undefined;
/** A known Anthropic error in a JSON error body, by code; undefined otherwise. */
export declare function upstreamErrorCode(body: Buffer | string): UpstreamErrorCode | undefined;
/**
 * Printed once when Anthropic answered credit_balance_too_low, whatever the
 * sign-in: an Anthropic Console login sends an OAuth token just like a plan.
 */
export declare function creditNoticeText(color: boolean, source?: ApiKeySource): string;
/** "claude_max" + "default_claude_max_20x" → "max_20x"; "pro" → "pro". */
export declare function planFrom(type: string | undefined, rateTier: string | undefined): ClaudePlan;
//# sourceMappingURL=claude-auth.d.ts.map