/**
 * Whether the MemTree key works, and what to say when it does not.
 *
 * GET /v1/context_memory/status answers 401 (403 from some proxies) for a key
 * polychat does not know: mistyped, or revoked. That is definite, so ccc says
 * so before Claude Code starts — interactive runs offer to paste a new key,
 * print/non-TTY runs get one line on stderr — and mid-session the degraded
 * turn says the key is the reason. Network errors, timeouts, 5xx and other
 * statuses stay "unknown" and quiet: no false alarms.
 */

import { CLIENT_NAME, CLIENT_VERSION } from "./memtree.js";
import { parsePaymentStatus, type PaymentStatus } from "./payment-gate.js";
import { PAYMENT_CONTINUES_LINE } from "./payment-notice.js";
import { recordError, type DiagnosticsRecorder } from "./diagnostics.js";

export { KEY_PAGE_URL, LOCAL_KEY_PAGE_URL, keyPageUrl } from "./key-page.js";

export const KEY_INVALID_TEXT = "Your MemTree key isn't valid (revoked or mistyped)";
export const KEY_GATE_PROMPT =
  "[Enter] paste a new key   [c] use claude without MemTree   [q] quit: ";
export const KEY_PASTE_PROMPT = "Copy your new MemTree key and paste it here: ";

/** The startup check's answer: the payment status, a definitely invalid key, or unknown. */
export type KeyCheck = PaymentStatus | "invalid" | null;
export type KeyChoice = "paste" | "continue" | "quit";
export type KeyGateResult =
  | { action: "quit" }
  | { action: "continue" }
  | { action: "rekeyed"; apiKey: string; check: KeyCheck };

export interface KeyGateDeps {
  keyPageUrl: string;
  ask: (question: string) => Promise<string>;
  open: (url: string) => void;
  /** The headline (the caller styles it). */
  warn: (text: string) => void;
  say: (text: string) => void;
  check: (apiKey: string) => Promise<KeyCheck>;
  saveKey: (apiKey: string) => void;
}

const DEFAULT_TIMEOUT_MS = 2000;

/** A status that says the key itself is unknown or revoked. */
export function isKeyRejected(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Startup check: GET /v1/context_memory/status, bounded by a short timeout,
 * never throws. 401/403 → "invalid"; a paid/unpaid body → its status; any
 * other status, a network error, a timeout or an unexpected body → null.
 */
export async function fetchKeyStatus(
  baseUrl: string,
  apiKey: string,
  options: { timeoutMs?: number; diagnostics?: DiagnosticsRecorder } = {}
): Promise<KeyCheck> {
  const { diagnostics } = options;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/context_memory/status`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-client": CLIENT_NAME,
        "x-client-version": CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const result = isKeyRejected(res.status) ? "invalid"
        : res.status === 402 ? "payment_required" : "unknown";
      diagnostics?.record("key_status", { result, status: res.status });
      return result === "invalid" ? "invalid" : null;
    }
    const status = parsePaymentStatus(await res.json());
    diagnostics?.record("key_status", {
      result: status?.paid === false ? "payment_required" : status ? "ok" : "unknown",
      status: res.status,
    });
    return status;
  } catch (err) {
    if (diagnostics) recordError(diagnostics, "status_probe_failed", err);
    return null;
  }
}

/**
 * Interactive gate for an invalid key: paste a new one (opens the key page),
 * use claude without MemTree, or quit. A pasted key that is invalid too is
 * never saved; one whose status is unknown (network) is, since the user
 * chose it.
 */
export async function runKeyGate(deps: KeyGateDeps): Promise<KeyGateResult> {
  for (;;) {
    deps.warn(`⚠ ${KEY_INVALID_TEXT}. Get a new one at ${deps.keyPageUrl}`);
    const choice = parseKeyChoice(await deps.ask(KEY_GATE_PROMPT));
    if (choice === "quit") return { action: "quit" };
    if (choice === "continue") {
      deps.say("\nStarting claude without MemTree.\n");
      return { action: "continue" };
    }
    deps.open(deps.keyPageUrl);
    const apiKey = (await deps.ask(KEY_PASTE_PROMPT)).trim();
    if (!apiKey) continue;
    const check = await deps.check(apiKey);
    if (check === "invalid") continue;
    deps.saveKey(apiKey);
    deps.say("API key saved.\n");
    return { action: "rekeyed", apiKey, check };
  }
}

/** Map a gate answer to a choice. Enter (empty) or `p` pastes a key. */
export function parseKeyChoice(answer: string): KeyChoice {
  const key = answer.trim().toLowerCase();
  if (key === "" || key === "p" || key === "paste") return "paste";
  if (key === "q" || key === "quit" || key === "exit") return "quit";
  return "continue";
}

/** The one startup line for a print/non-TTY run (stderr). */
export function keyInvalidLine(url: string, command: string): string {
  return `⚠ ${KEY_INVALID_TEXT}. Get a new one at ${url} and run \`${command}\` ` +
    "in a terminal to paste it.";
}

/** The in-session notice for a turn MemTree refused for the key (URL bare on its own line). */
export function keyInvalidNoticeText(url: string): string {
  return [
    "⚠ MemTree is off: your MemTree key isn't valid (revoked or mistyped). " +
      "Get a new one, then restart ccc to paste it:",
    `  ${url}`,
    PAYMENT_CONTINUES_LINE,
  ].join("\n");
}

/** The API error Claude Code shows when only compression could fit the request. */
export function keyInvalidRefusalMessage(url: string): string {
  return `${KEY_INVALID_TEXT}, so this long conversation can't be compressed to fit the ` +
    `model's context window. Get a new key at ${url} and restart ccc to paste it · ` +
    "or start fresh with /clear.";
}
