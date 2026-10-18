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
export declare const CLAUDE_AUTH_TYPES: readonly ["subscription", "api_key", "bedrock", "vertex", "foundry", "unknown"];
export type ClaudeAuthType = (typeof CLAUDE_AUTH_TYPES)[number];
/** A Claude.ai plan tier, by name only. */
export declare const CLAUDE_PLANS: readonly ["free", "pro", "max", "max_5x", "max_20x", "team", "enterprise", "unknown"];
export type ClaudePlan = (typeof CLAUDE_PLANS)[number];
/** Anthropic's 400 for an API key whose organization has no credit left. */
export declare const CREDIT_BALANCE_TOO_LOW = "credit_balance_too_low";
export type UpstreamErrorCode = typeof CREDIT_BALANCE_TOO_LOW;
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
/** Printed once when Anthropic refused an API key for having no credit. */
export declare function creditNoticeText(color: boolean): string;
/** "claude_max" + "default_claude_max_20x" → "max_20x"; "pro" → "pro". */
export declare function planFrom(type: string | undefined, rateTier: string | undefined): ClaudePlan;
//# sourceMappingURL=claude-auth.d.ts.map