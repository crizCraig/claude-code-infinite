/**
 * Whether the MemTree key works, and what to say when it does not.
 *
 * GET /v1/context_memory/status answers 401 for a key polychat does not know:
 * mistyped, or revoked (a 403 counts only with polychat's own detail, see
 * key-page.ts). That is definite, so ccc says
 * so before Claude Code starts — interactive runs offer to paste a new key,
 * print/non-TTY runs get one line on stderr — and mid-session the degraded
 * turn says the key is the reason. Network errors, timeouts, 5xx and other
 * statuses stay "unknown" and quiet: no false alarms.
 */
import { type PaymentStatus } from "./payment-gate.js";
import { type DiagnosticsRecorder } from "./diagnostics.js";
export { KEY_PAGE_URL, LOCAL_KEY_PAGE_URL, isKeyRejected, keyPageUrl } from "./key-page.js";
export declare const KEY_INVALID_TEXT = "Your MemTree key isn't valid (revoked or mistyped)";
export declare const KEY_GATE_PROMPT = "[Enter] paste a new key   [c] use claude without MemTree   [q] quit: ";
export declare const KEY_PASTE_PROMPT = "Copy your new MemTree key and paste it here: ";
export declare const KEY_STILL_INVALID = "That key isn't valid either.";
/** The startup check's answer: the payment status, a definitely invalid key, or unknown. */
export type KeyCheck = PaymentStatus | "invalid" | null;
export type KeyChoice = "paste" | "continue" | "quit";
export type KeyGateResult = {
    action: "quit";
} | {
    action: "continue";
} | {
    action: "rekeyed";
    apiKey: string;
    check: KeyCheck;
};
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
/**
 * Startup check: GET /v1/context_memory/status, bounded by a short timeout,
 * never throws. 401/403 → "invalid"; a paid/unpaid body → its status; any
 * other status, a network error, a timeout or an unexpected body → null.
 */
export declare function fetchKeyStatus(baseUrl: string, apiKey: string, options?: {
    timeoutMs?: number;
    diagnostics?: DiagnosticsRecorder;
}): Promise<KeyCheck>;
/**
 * Interactive gate for an invalid key: paste a new one (opens the key page),
 * use claude without MemTree, or quit. A pasted key that is invalid too is
 * never saved; one whose status is unknown (network) is, since the user
 * chose it.
 */
export declare function runKeyGate(deps: KeyGateDeps): Promise<KeyGateResult>;
/**
 * The startup check's answer, after dealing with an invalid key: a print or
 * non-TTY run gets one line (`stderrLine`; their stdout is Claude's alone) and
 * carries on without MemTree; an interactive run gets the gate, which may
 * re-key or quit. Anything but "invalid" passes through unchanged.
 */
export declare function resolveInvalidKey(check: KeyCheck, apiKey: string, deps: KeyGateDeps & {
    interactive: boolean;
    command: string;
    stderrLine: (text: string) => void;
}): Promise<{
    apiKey: string;
    check: KeyCheck;
} | "quit">;
/** Map a gate answer to a choice. Enter (empty) or `p` pastes a key. */
export declare function parseKeyChoice(answer: string): KeyChoice;
/** The one startup line for a print/non-TTY run (stderr). */
export declare function keyInvalidLine(url: string, command: string): string;
/** The in-session notice for a turn MemTree refused for the key (URL bare on its own line). */
export declare function keyInvalidNoticeText(url: string): string;
/** The API error Claude Code shows when only compression could fit the request. */
export declare function keyInvalidRefusalMessage(url: string): string;
//# sourceMappingURL=key-status.d.ts.map