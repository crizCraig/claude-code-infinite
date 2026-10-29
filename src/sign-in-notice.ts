/**
 * What ccc says about Claude Code's sign-in before Claude Code starts, and the
 * diagnostics that show whether it helped.
 *
 * Claude Code's own answer (claude-auth-status.ts) decides when it is
 * available; otherwise the config-file guess does, as before
 * (claude-plan-warning.ts). Not signed in at all is the case that stalls new
 * users (they open Claude Code, never finish its sign-in and never send a
 * message), so in a terminal that message waits for Enter: Claude Code's
 * screen would cover a printed line within a second. API billing (a Console
 * sign-in or an API key) is said without blocking, again inside Claude Code
 * at its first SessionStart.
 *
 * The sign-in type is kept between launches (SIGN_IN_STATE_FILE, a type name
 * and a time, nothing else) so a later launch can tell that the user signed
 * in after a warning and how long that took.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AuthProbe } from "./claude-auth-status.js";
import type { ApiKeyOverride, ApiKeySource, ClaudeAuthType, ClaudePlan } from "./claude-auth.js";
import {
  apiKeyOverrideText,
  creditReminderText,
  needsCreditReminder,
  needsPlanWarning,
  PAID_PLANS,
  type PlanWarningInput,
} from "./claude-plan-warning.js";

export const PLAN_URL = "https://claude.ai/upgrade";
export const MEMTREE_CREDIT_LINE = "Your MemTree credit covers MemTree, not Claude itself.";
export const NOT_SIGNED_IN_LINES = [
  "Claude Code isn't signed in to a Claude plan yet. ccc needs Claude Pro or Max.",
  "  - Have one? Choose \"Claude account with subscription\" when Claude Code asks, " +
    "or run /login.",
  `  - Don't have one? Get Pro at ${PLAN_URL}, then run /login.`,
  MEMTREE_CREDIT_LINE,
] as const;
export const PRESS_ENTER_TEXT = "Press Enter to continue to Claude Code.";
const SWITCH_TO_PLAN =
  "To use Claude Pro or Max instead, run /login in Claude Code and choose " +
  "\"Claude account with subscription\".";

/** Which message was shown (diagnostics no_plan_warning.kind). */
export const SIGN_IN_WARNING_KINDS = [
  "not_signed_in", "api_billing", "unknown", "credit_reminder", "key_override",
] as const;
export type SignInWarningKind = (typeof SIGN_IN_WARNING_KINDS)[number];

/** The file in ccc's config directory holding the last sign-in type Claude Code reported. */
export const SIGN_IN_STATE_FILE = "claude-sign-in-state.json";

const CLOUD_AUTH: readonly ClaudeAuthType[] = ["bedrock", "vertex", "foundry"];

export interface SignInNoticeInput {
  probe: AuthProbe;
  /** The config-file guess and the last sign-in a request showed (claude-plan-warning.ts). */
  fallback: PlanWarningInput;
  /** A credit refusal from an earlier session is on file. */
  creditRefused: boolean;
  override: ApiKeyOverride | undefined;
  color: boolean;
}

export interface SignInNotice {
  kind: SignInWarningKind;
  lines: string[];
  /** Wait for Enter before Claude Code takes the terminal. */
  pause: boolean;
  /** Repeated inside Claude Code at its first SessionStart. */
  sessionLine?: string;
}

/** The sign-in message before Claude Code starts, or undefined when there is nothing to say. */
export function signInNotice(input: SignInNoticeInput): SignInNotice | undefined {
  const status = input.probe.status;
  const auth = status?.auth ?? input.fallback.auth;
  if (CLOUD_AUTH.includes(auth)) return undefined;
  const plan = PAID_PLANS.includes(status?.plan ?? "unknown") ? status!.plan : input.fallback.plan;
  if (needsCreditReminder({ refused: input.creditRefused, plan }) && auth !== "none") {
    const source = input.override?.asks ? undefined : input.override?.source;
    return notice("credit_reminder", [yellow(creditReminderText(source), input.color)]);
  }
  if (status && status.auth !== "unknown") {
    return noticeFromStatus(status.auth, status.plan, status.keySource, input);
  }
  return noticeFromConfig(input);
}

/** The lines on stderr (stdout stays Claude Code's in print runs). */
export function printSignInNotice(notice: SignInNotice): void {
  for (const line of notice.lines) process.stderr.write(`${line}\n`);
}

export interface PresentOptions {
  /** A terminal on both ends that Claude Code's TUI will take over. */
  interactive: boolean;
  /** The sign-in type for the diagnostics event. */
  auth: ClaudeAuthType;
  record: (name: string, fields: Record<string, unknown>) => void;
  tracker: SignInTracker;
  wait?: () => Promise<{ ms: number; quit: boolean }>;
}

/**
 * Print the notice, wait for Enter when it asks to (interactive only), and
 * record it. Resolves false when the user quit at the prompt (Ctrl+C).
 */
export async function presentSignInNotice(
  notice: SignInNotice, opts: PresentOptions
): Promise<boolean> {
  printSignInNotice(notice);
  opts.tracker.warned();
  const waited = notice.pause && opts.interactive
    ? await (opts.wait ?? (() => waitForEnter(process.stdin, process.stderr)))()
    : undefined;
  opts.record("no_plan_warning", {
    auth: opts.auth, kind: notice.kind, ...(waited ? { waited_ms: waited.ms } : {}),
  });
  return waited?.quit !== true;
}

/**
 * Wait for Enter (or Ctrl+C / end of input) so the message is read before
 * Claude Code covers it. Resolves with how long it waited; never rejects.
 */
export function waitForEnter(
  input: NodeJS.ReadableStream, output: NodeJS.WritableStream, now: () => number = Date.now
): Promise<{ ms: number; quit: boolean }> {
  const started = now();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let answered = false;
    rl.on("close", () => {
      if (!answered) resolve({ ms: now() - started, quit: true });
    });
    rl.on("SIGINT", () => rl.close());
    rl.question(`${PRESS_ENTER_TEXT} `, () => {
      answered = true;
      rl.close();
      resolve({ ms: now() - started, quit: false });
    });
  });
}

export interface SignInState {
  auth: ClaudeAuthType;
  /** Epoch ms of the last warning, kept until a Claude plan sign-in is seen. */
  warnedAt?: number;
}

export function readSignInState(configDir: string): SignInState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, SIGN_IN_STATE_FILE), "utf8"));
    if (typeof raw?.auth !== "string") return undefined;
    const warnedAt = Number.isFinite(raw.warnedAt) ? { warnedAt: raw.warnedAt as number } : {};
    return { auth: raw.auth as ClaudeAuthType, ...warnedAt };
  } catch {
    return undefined;
  }
}

/** Never throws: the next launch only loses the between-starts comparison. */
export function writeSignInState(configDir: string, state: SignInState): void {
  try {
    fs.writeFileSync(path.join(configDir, SIGN_IN_STATE_FILE), `${JSON.stringify(state)}\n`,
      { mode: 0o600 });
  } catch {
    // Best effort.
  }
}

export interface SignInEvent {
  from: ClaudeAuthType;
  auth: ClaudeAuthType;
  where: "between_starts" | "mid_session";
  since_warning_ms?: number;
}

/**
 * Follows the sign-in from launch to launch and through the session: a
 * sign-in that turns into a Claude plan after ccc warned (or after "none"),
 * reported once per process through `report`.
 */
export class SignInTracker {
  private state: SignInState | undefined;
  private reported = false;
  private warnedAt: number | undefined;

  constructor(
    private readonly configDir: string,
    private readonly report: (event: SignInEvent) => void,
    private readonly now: () => number = Date.now
  ) {
    this.state = readSignInState(configDir);
  }

  /** Claude Code's answer at launch (probe ok only): compares with the last launch's. */
  started(auth: ClaudeAuthType): void {
    const before = this.state;
    if (before && signedInToPlan(before.auth, auth)) {
      this.emit(before.auth, auth, "between_starts", before.warnedAt);
    }
    this.save({ auth, ...(auth !== "subscription" && before?.warnedAt
      ? { warnedAt: before.warnedAt } : {}) });
  }

  /** ccc showed a sign-in warning now. */
  warned(): void {
    this.warnedAt = this.now();
    this.save({ auth: this.state?.auth ?? "unknown", warnedAt: this.warnedAt });
  }

  /** The sign-in a request's auth header showed (subscription or api_key). */
  requestAuth(auth: ClaudeAuthType): void {
    const before = this.state?.auth;
    if (before === undefined || before === auth) return;
    if (signedInToPlan(before, auth) || before === "none") {
      this.emit(before, auth, "mid_session", this.warnedAt ?? this.state?.warnedAt);
    }
    this.save({ auth });
  }

  /** Milliseconds since this process's warning, or undefined when none was shown. */
  sinceWarningMs(): number | undefined {
    return this.warnedAt === undefined ? undefined : Math.max(0, this.now() - this.warnedAt);
  }

  private emit(
    from: ClaudeAuthType, auth: ClaudeAuthType, where: SignInEvent["where"], warnedAt?: number
  ): void {
    if (this.reported) return;
    this.reported = true;
    const since = warnedAt === undefined
      ? {} : { since_warning_ms: Math.max(0, this.now() - warnedAt) };
    this.report({ from, auth, where, ...since });
  }

  private save(state: SignInState): void {
    this.state = state;
    writeSignInState(this.configDir, state);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noticeFromStatus(
  auth: ClaudeAuthType, plan: ClaudePlan, source: ApiKeySource | undefined,
  input: SignInNoticeInput
): SignInNotice | undefined {
  if (auth === "none") return notSignedIn(input.color, true);
  if (auth === "api_key") {
    // A Claude plan on file that a key beats: the key's own line says how to drop it.
    if (input.override && input.fallback.subscriptionLogin === true) {
      return notice("key_override", [apiKeyOverrideText(input.override, input.color)]);
    }
    const asks = input.override?.source === source && input.override?.asks === true;
    return apiBilling(source ?? input.override?.source, asks, input.color);
  }
  if (auth === "subscription" && plan === "free") return apiBilling(undefined, false, input.color);
  return undefined;
}

/** Claude Code could not be asked: the config files' guess, without blocking. */
function noticeFromConfig(input: SignInNoticeInput): SignInNotice | undefined {
  const { fallback, override, color } = input;
  if (needsPlanWarning(fallback)) {
    if (fallback.auth === "api_key" || fallback.seen === "api_key") {
      return apiBilling(override?.source, override?.asks, color);
    }
    const shown = notSignedIn(color, false);
    return { ...shown, kind: "unknown" };
  }
  if (override && fallback.subscriptionLogin === true) {
    return notice("key_override", [apiKeyOverrideText(override, color)]);
  }
  return undefined;
}

function notSignedIn(color: boolean, pause: boolean): SignInNotice {
  return { kind: "not_signed_in", lines: NOT_SIGNED_IN_LINES.map((l) => yellow(l, color)), pause };
}

function apiBilling(
  source: ApiKeySource | undefined, asks: boolean | undefined, color: boolean
): SignInNotice {
  const text = apiBillingText(source, asks === true);
  return { ...notice("api_billing", [yellow(text, color)]), sessionLine: text };
}

/** The API-billing message, naming the env variable or setting when one is known. */
export function apiBillingText(source: ApiKeySource | undefined, asks: boolean): string {
  if (source === "apiKeyHelper") {
    return "Claude Code's settings set an apiKeyHelper, so Claude bills that API key per " +
      `token, not a Claude plan. ${MEMTREE_CREDIT_LINE} To use Claude Pro or Max instead, ` +
      "remove apiKeyHelper from settings.json, then run /login.";
  }
  if (source && asks) {
    return `${source} is set: if Claude Code asks whether to use it, Yes bills that API key ` +
      `per token. ${MEMTREE_CREDIT_LINE} To use Claude Pro or Max, answer No and sign in ` +
      "with \"Claude account with subscription\".";
  }
  if (source) {
    return `${source} is set, so Claude bills that API key per token, not a Claude plan. ` +
      `${MEMTREE_CREDIT_LINE} To use Claude Pro or Max instead, unset it, then run /login.`;
  }
  return "Claude Code is signed in for API billing (an Anthropic Console account), so Claude " +
    `bills that account per token, not a Claude plan. ${MEMTREE_CREDIT_LINE} ${SWITCH_TO_PLAN}`;
}

function notice(kind: SignInWarningKind, lines: string[]): SignInNotice {
  return { kind, lines, pause: false };
}

function yellow(text: string, color: boolean): string {
  return color ? `\x1b[33m${text}\x1b[39m` : text;
}

/** From not signed in, unknown or API billing to a Claude login. */
function signedInToPlan(before: ClaudeAuthType, after: ClaudeAuthType): boolean {
  return after === "subscription" && before !== "subscription";
}
