/**
 * The "no Claude plan" line. ccc runs the user's own Claude Code, so it only
 * works well signed in with a Claude Pro or Max plan; on an API key every token
 * is billed by Anthropic, and a key with no credit is refused outright
 * (credit_balance_too_low, the most common first-prompt failure). The line is
 * printed once before Claude Code starts when its sign-in is an API key or
 * missing, and never for a subscription; the credit refusal gets the same text
 * as ccc exits (claude-auth.ts creditNoticeText).
 *
 * Which sign-in Claude Code really used is only known from its requests'
 * auth headers (claude-auth.ts claudeAuthFromHeaders). The last one seen is
 * kept as a type name in ccc's config directory so the next launch decides on
 * fact rather than on the config files' guess.
 */
import type { ClaudeAuthType, ClaudePlan } from "./claude-auth.js";
export declare const NO_PLAN_TEXT: string;
/** The file in ccc's config directory holding the last sign-in type Claude Code sent. */
export declare const SEEN_AUTH_FILE = "claude-auth-seen";
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
export declare function noPlanWarningText(color: boolean): string;
/**
 * The line on stderr when it applies: stdout stays Claude Code's in print
 * runs, and in a terminal stderr shows above the session just the same.
 * Returns whether it was printed.
 */
export declare function printNoPlanWarning(input: PlanWarningInput, color: boolean): boolean;
/** The last sign-in type Claude Code's requests showed, or undefined. */
export declare function readSeenClaudeAuth(configDir: string): ClaudeAuthType | undefined;
/** Keep a subscription or API-key sign-in for the next launch; never throws. */
export declare function writeSeenClaudeAuth(configDir: string, auth: ClaudeAuthType): void;
//# sourceMappingURL=claude-plan-warning.d.ts.map