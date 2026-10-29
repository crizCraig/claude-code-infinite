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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ApiKeyOverride, ApiKeySource, ClaudeAuthType, ClaudePlan } from "./claude-auth.js";

/**
 * What a credit refusal means: the sign-in bills prepaid credit (an API key, or
 * Claude Code's keyless "Anthropic Console account" sign-in, which sends an
 * OAuth token too) or is a Claude account without a paid plan, and that
 * balance is empty.
 */
const CREDIT_ADVICE =
  "Claude Code is billing an Anthropic API account (a Console sign-in, an API key, or a " +
  "Claude account without Pro or Max), and it has no credit left. Your MemTree credit covers " +
  "MemTree, not Claude itself. To use Claude Pro or Max instead, run /login in Claude Code and " +
  "choose \"Claude account with subscription\" (no plan yet? https://claude.ai/upgrade).";
const CREDIT_TEXT =
  `Anthropic refused Claude Code's request: credit balance too low. ${CREDIT_ADVICE}`;
const CREDIT_ENV_HINT =
  " If ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, unset it too: it beats /login.";

/** The file in ccc's config directory holding the last sign-in type Claude Code sent. */
export const SEEN_AUTH_FILE = "claude-auth-seen";
/** Present while Anthropic's last answer to Claude Code was a credit refusal. */
export const CREDIT_REFUSED_FILE = "claude-credit-refused";
const CREDIT_REMINDER_LEAD = "Last time, Anthropic refused Claude Code's requests: credit " +
  "balance too low. ";

export const PAID_PLANS: readonly ClaudePlan[] = [
  "pro", "max", "max_5x", "max_20x", "team", "enterprise",
];
const SEEN_TYPES: readonly ClaudeAuthType[] = ["subscription", "api_key"];
const CLOUD_AUTH: readonly ClaudeAuthType[] = ["bedrock", "vertex", "foundry"];

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
  if (CLOUD_AUTH.includes(auth)) return false;
  if (PAID_PLANS.includes(plan)) return false;
  // Even a "free" plan on record: it may predate an upgrade.
  if (auth === "subscription" || input.subscriptionLogin === true) return false;
  return seen !== "subscription";
}

const INFO_FLAGS = ["--version", "-v", "--help", "-h"];
/** Claude Code subcommands that start no session (`setup-token` makes a subscription token). */
const NO_SESSION_COMMANDS = [
  "setup-token", "doctor", "update", "upgrade", "mcp", "install", "plugin", "plugins",
];

/** `claude --version`, `claude doctor` and the like: no session, so no line. */
export function isInfoOnlyRun(args: readonly string[]): boolean {
  if (args.length > 0 && NO_SESSION_COMMANDS.includes(args[0])) return true;
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((a) => INFO_FLAGS.includes(a));
}

/**
 * Whether a credit_balance_too_low refusal gets the advice at exit: for every
 * sign-in type. An OAuth token is no proof of a plan: Claude Code's "Anthropic
 * Console account" sign-in (API usage billing) sends one too, with no plan tier
 * on record, and that is how most new users met this refusal. Only a
 * subscription token with a paid tier on record is spared the advice to
 * `/login` with a plan it already has.
 */
export function creditAdviceApplies(auth: ClaudeAuthType | undefined, plan: ClaudePlan): boolean {
  return !(auth === "subscription" && PAID_PLANS.includes(plan));
}

/** The credit refusal's advice, naming the env variable or setting when one is known. */
export function creditAdviceText(color: boolean, source?: ApiKeySource): string {
  const text = `${CREDIT_TEXT}${creditSourceHint(source)}`;
  return color ? `\x1b[33m${text}\x1b[39m` : text;
}

export function apiKeyOverrideText(override: ApiKeyOverride, color: boolean): string {
  const text = override.source === "apiKeyHelper"
    ? "Claude Code's settings set an apiKeyHelper, so Claude Code bills that API key instead " +
      "of your Pro/Max plan. Remove apiKeyHelper from settings.json to use your plan."
    : override.asks
      ? `${override.source} is set: if Claude Code asks whether to use it, answer No, or it ` +
        "bills that API key instead of your Pro/Max plan. Unset it to stop the question."
      : `${override.source} is set, so Claude Code bills that API key instead of your Pro/Max ` +
        "plan. Unset it (or run `ccc` without it) to use your plan.";
  return color ? `\x1b[33m${text}\x1b[39m` : text;
}

function creditSourceHint(source: ApiKeySource | undefined): string {
  if (source === "apiKeyHelper") {
    return " Claude Code's settings set an apiKeyHelper, and it beats /login: remove it " +
      "from settings.json.";
  }
  if (source) {
    return ` ${source} is set, and it beats /login: unset it (or run \`ccc\` without it).`;
  }
  return CREDIT_ENV_HINT;
}

export interface CreditReminderInput {
  /** A credit refusal is on file from an earlier session (creditRefusedOnFile). */
  refused: boolean;
  /** From Claude Code's config files (claudePlanFromConfig). */
  plan: ClaudePlan;
}

/** True when an earlier session was refused for credit and no paid tier is on record yet. */
export function needsCreditReminder(input: CreditReminderInput): boolean {
  return input.refused && !PAID_PLANS.includes(input.plan);
}

/**
 * Remembers a credit refusal across launches and sessions: every refusal
 * writes the marker and every answered request removes it, whatever this
 * process saw before, since other ccc sessions share the file.
 */
export class CreditRefusalMemory {
  /** A refusal was on file when this launch started. */
  readonly refusedAtStart: boolean;

  constructor(private readonly configDir: string) {
    this.refusedAtStart = creditRefusedOnFile(configDir);
  }

  refused(): void {
    markCreditRefused(this.configDir);
  }

  answered(): void {
    if (creditRefusedOnFile(this.configDir)) clearCreditRefused(this.configDir);
  }
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

/** Remember a credit refusal for the next launch; never throws. */
export function markCreditRefused(configDir: string): void {
  try {
    fs.writeFileSync(path.join(configDir, CREDIT_REFUSED_FILE), "credit_balance_too_low\n",
      { mode: 0o600 });
  } catch {
    // Best effort: the next launch just goes without the reminder.
  }
}

/** Forget a remembered credit refusal; never throws. */
export function clearCreditRefused(configDir: string): void {
  try {
    fs.rmSync(path.join(configDir, CREDIT_REFUSED_FILE), { force: true });
  } catch {
    // Best effort.
  }
}

export function creditRefusedOnFile(configDir: string): boolean {
  return fs.existsSync(path.join(configDir, CREDIT_REFUSED_FILE));
}

/** Before the first prompt: an earlier session's credit refusal and its advice (uncoloured). */
export function creditReminderText(source: ApiKeySource | undefined): string {
  return `${CREDIT_REMINDER_LEAD}${creditAdviceBody(source)}`;
}

/** The credit advice after its "Anthropic refused…" sentence, with the source hint. */
function creditAdviceBody(source: ApiKeySource | undefined): string {
  return `${CREDIT_ADVICE}${creditSourceHint(source)}`;
}
