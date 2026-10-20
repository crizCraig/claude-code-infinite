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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeAuthType, ClaudePlan } from "./claude-auth.js";

export const NO_PLAN_TEXT =
  "ccc needs Claude Code signed in with a Claude Pro or Max plan (run `claude`, then `/login`). " +
  "With an API key you pay Anthropic per token, and a key with no credit won't work.";

/** The file in ccc's config directory holding the last sign-in type Claude Code sent. */
export const SEEN_AUTH_FILE = "claude-auth-seen";

const PAID_PLANS: readonly ClaudePlan[] = ["pro", "max", "max_5x", "max_20x", "team", "enterprise"];
const SEEN_TYPES: readonly ClaudeAuthType[] = ["subscription", "api_key"];

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
export function needsPlanWarning(input: PlanWarningInput): boolean {
  const { auth, plan, seen } = input;
  if (auth === "bedrock" || auth === "vertex" || auth === "foundry") return false;
  if (PAID_PLANS.includes(plan)) return false;
  // Even a "free" plan on record: it may predate an upgrade.
  if (auth === "subscription" || input.subscriptionLogin === true) return false;
  return seen !== "subscription";
}

const INFO_FLAGS = ["--version", "-v", "--help", "-h"];

/** `claude --version`, `claude mcp --help` and the like: no session, so no line. */
export function isInfoOnlyRun(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((a) => INFO_FLAGS.includes(a));
}

export function noPlanWarningText(color: boolean): string {
  return color ? `\x1b[33m${NO_PLAN_TEXT}\x1b[39m` : NO_PLAN_TEXT;
}

/**
 * The line on stderr when it applies: stdout stays Claude Code's in print
 * runs, and in a terminal stderr shows above the session just the same.
 * Returns whether it was printed.
 */
export function printNoPlanWarning(input: PlanWarningInput, color: boolean): boolean {
  if (!needsPlanWarning(input)) return false;
  process.stderr.write(`${noPlanWarningText(color)}\n`);
  return true;
}

/** The last sign-in type Claude Code's requests showed, or undefined. */
export function readSeenClaudeAuth(configDir: string): ClaudeAuthType | undefined {
  try {
    const value = fs.readFileSync(path.join(configDir, SEEN_AUTH_FILE), "utf8").trim();
    return (SEEN_TYPES as readonly string[]).includes(value) ? value as ClaudeAuthType : undefined;
  } catch {
    return undefined;
  }
}

/** Keep a subscription or API-key sign-in for the next launch; never throws. */
export function writeSeenClaudeAuth(configDir: string, auth: ClaudeAuthType): void {
  if (!SEEN_TYPES.includes(auth)) return;
  try {
    fs.writeFileSync(path.join(configDir, SEEN_AUTH_FILE), `${auth}\n`, { mode: 0o600 });
  } catch {
    // Best effort: the next launch falls back to the config files.
  }
}
