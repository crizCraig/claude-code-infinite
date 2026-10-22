/**
 * The "no Claude plan" line. ccc runs the user's own Claude Code, so it only
 * works well signed in with a Claude Pro or Max plan; on an API key every token
 * is billed by Anthropic, and a key with no credit is refused outright
 * (credit_balance_too_low, the most common first-prompt failure). The line is
 * printed once before Claude Code starts when its sign-in is an API key or
 * missing, and never for a subscription. When ANTHROPIC_AUTH_TOKEN,
 * ANTHROPIC_API_KEY or an apiKeyHelper beats a Claude.ai login on file, a
 * line says so instead. A credit refusal gets the plan advice as ccc exits,
 * whatever the sign-in (claude-auth.ts creditNoticeText).
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

export const NO_PLAN_TEXT =
  "ccc needs Claude Code signed in with a Claude Pro or Max plan (run `claude`, then `/login`). " +
  "With an API key you pay Anthropic per token, and a key with no credit won't work.";

/**
 * What a credit refusal means: the sign-in bills prepaid credit (an API key, or
 * Claude Code's keyless "Anthropic Console account" sign-in, which sends an
 * OAuth token too) or is a Claude account without a paid plan, and that
 * balance is empty.
 */
const CREDIT_ADVICE =
  "Claude Code is billing an API key, an Anthropic Console account or a Claude account " +
  "without a paid plan. ccc needs a Pro or Max plan: run `claude`, `/logout`, then `/login` " +
  "and choose \"Claude account with subscription\".";
const CREDIT_TEXT =
  `Anthropic refused Claude Code's request: credit balance too low. ${CREDIT_ADVICE}`;
const CREDIT_ENV_HINT =
  " If ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, unset it too: it beats `/login`.";

/** The file in ccc's config directory holding the last sign-in type Claude Code sent. */
export const SEEN_AUTH_FILE = "claude-auth-seen";
/** Present while Anthropic's last answer to Claude Code was a credit refusal. */
export const CREDIT_REFUSED_FILE = "claude-credit-refused";
const CREDIT_REMINDER_LEAD = "Last time, Anthropic refused Claude Code's requests: credit " +
  "balance too low. ";

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

/**
 * The line when an API key beats a Claude.ai login that is on file (stderr,
 * like the no-plan line). Returns whether it was printed.
 */
export function printApiKeyOverrideWarning(
  override: ApiKeyOverride | undefined, subscriptionLogin: boolean, color: boolean
): boolean {
  if (!override || !subscriptionLogin) return false;
  process.stderr.write(`${apiKeyOverrideText(override, color)}\n`);
  return true;
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
    return " Claude Code's settings set an apiKeyHelper, and it beats `/login`: remove it " +
      "from settings.json.";
  }
  if (source) {
    return ` ${source} is set, and it beats \`/login\`: unset it (or run \`ccc\` without it).`;
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
 * The remembered refusal's advice on stderr before the first prompt, when it
 * applies. Returns whether it was printed.
 */
export function printCreditReminder(
  input: CreditReminderInput, color: boolean, source?: ApiKeySource
): boolean {
  if (!needsCreditReminder(input)) return false;
  const text = `${CREDIT_REMINDER_LEAD}${creditAdviceBody(source)}`;
  process.stderr.write(`${color ? `\x1b[33m${text}\x1b[39m` : text}\n`);
  return true;
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

/** The credit advice after its "Anthropic refused…" sentence, with the source hint. */
function creditAdviceBody(source: ApiKeySource | undefined): string {
  return `${CREDIT_ADVICE}${creditSourceHint(source)}`;
}
