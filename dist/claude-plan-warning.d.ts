/**
 * The "no Claude plan" decision from config files, and the credit-refusal
 * advice. ccc runs the user's own Claude Code, so it only works well signed in
 * with a Claude Pro or Max plan; on an API key every token is billed by
 * Anthropic, and a key with no credit is refused outright
 * (credit_balance_too_low, the most common first-prompt failure). What is said
 * before Claude Code starts is sign-in-notice.ts's; this module is its
 * fallback when Claude Code cannot be asked (needsPlanWarning). When
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY or an apiKeyHelper beats a Claude.ai
 * login on file, apiKeyOverrideText says so. A credit refusal gets the plan
 * advice as ccc exits, whatever the sign-in (claude-auth.ts creditNoticeText).
 *
 * A credit refusal is also remembered (CREDIT_REFUSED_FILE, a bare marker) until
 * Anthropic answers a request or a paid tier is on record, so the next launch
 * gives the same advice before the first prompt rather than after it fails.
 *
 * Which sign-in Claude Code really used is only known from its requests'
 * auth headers (claude-auth.ts claudeAuthFromHeaders). The last one seen is
 * kept as a type name in ccc's config directory so the next launch decides on
 * fact rather than on the config files' guess.
 */
import type { ApiKeyOverride, ApiKeySource, ClaudeAuthType, ClaudePlan } from "./claude-auth.js";
/** The file in ccc's config directory holding the last sign-in type Claude Code sent. */
export declare const SEEN_AUTH_FILE = "claude-auth-seen";
/** Present while Anthropic's last answer to Claude Code was a credit refusal. */
export declare const CREDIT_REFUSED_FILE = "claude-credit-refused";
export declare const PAID_PLANS: readonly ClaudePlan[];
export interface PlanWarningInput {
    /** From env and Claude Code's config files (claudeAuthFromConfig). */
    auth: ClaudeAuthType;
    /** From Claude Code's config files (claudePlanFromConfig). */
    plan: ClaudePlan;
    /** What Claude Code's own requests last showed, when known. */
    seen?: ClaudeAuthType;
    /** A claude.ai login is on file (claudeSubscriptionLogin), whatever else is set. */
    subscriptionLogin?: boolean;
}
/**
 * True when Claude Code is on an API key or not signed in, and nothing shows a
 * paid plan. Any sign of a subscription wins, a stale API-key sighting
 * included (the user may have run `/login` outside ccc since), so a subscriber
 * is never warned.
 */
export declare function needsPlanWarning(input: PlanWarningInput): boolean;
/** `claude --version`, `claude doctor` and the like: no session, so no line. */
export declare function isInfoOnlyRun(args: readonly string[]): boolean;
/**
 * Whether a credit_balance_too_low refusal gets the advice at exit: for every
 * sign-in type. An OAuth token is no proof of a plan: Claude Code's "Anthropic
 * Console account" sign-in (API usage billing) sends one too, with no plan tier
 * on record, and that is how most new users met this refusal. Only a
 * subscription token with a paid tier on record is spared the advice to
 * `/login` with a plan it already has.
 */
export declare function creditAdviceApplies(auth: ClaudeAuthType | undefined, plan: ClaudePlan): boolean;
/** The credit refusal's advice, naming the env variable or setting when one is known. */
export declare function creditAdviceText(color: boolean, source?: ApiKeySource): string;
export declare function apiKeyOverrideText(override: ApiKeyOverride, color: boolean): string;
export interface CreditReminderInput {
    /** A credit refusal is on file from an earlier session (creditRefusedOnFile). */
    refused: boolean;
    /** From Claude Code's config files (claudePlanFromConfig). */
    plan: ClaudePlan;
}
/** True when an earlier session was refused for credit and no paid tier is on record yet. */
export declare function needsCreditReminder(input: CreditReminderInput): boolean;
/**
 * Remembers a credit refusal across launches and sessions: every refusal
 * writes the marker and every answered request removes it, whatever this
 * process saw before, since other ccc sessions share the file.
 */
export declare class CreditRefusalMemory {
    private readonly configDir;
    /** A refusal was on file when this launch started. */
    readonly refusedAtStart: boolean;
    constructor(configDir: string);
    refused(): void;
    answered(): void;
}
/** The last sign-in type Claude Code's requests showed, or undefined. */
export declare function readSeenClaudeAuth(configDir: string): ClaudeAuthType | undefined;
/** Keep a subscription or API-key sign-in for the next launch; never throws. */
export declare function writeSeenClaudeAuth(configDir: string, auth: ClaudeAuthType): void;
/** Remember a credit refusal for the next launch; never throws. */
export declare function markCreditRefused(configDir: string): void;
/** Forget a remembered credit refusal; never throws. */
export declare function clearCreditRefused(configDir: string): void;
export declare function creditRefusedOnFile(configDir: string): boolean;
/** Before the first prompt: an earlier session's credit refusal and its advice (uncoloured). */
export declare function creditReminderText(source: ApiKeySource | undefined): string;
//# sourceMappingURL=claude-plan-warning.d.ts.map