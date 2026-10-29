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
import type { AuthProbe } from "./claude-auth-status.js";
import type { ApiKeyOverride, ApiKeySource, ClaudeAuthType } from "./claude-auth.js";
import { type PlanWarningInput } from "./claude-plan-warning.js";
export declare const PLAN_URL = "https://claude.ai/upgrade";
export declare const MEMTREE_CREDIT_LINE = "Your MemTree credit covers MemTree, not Claude itself.";
export declare const NOT_SIGNED_IN_LINES: readonly ["Claude Code isn't signed in to a Claude plan yet. ccc needs Claude Pro or Max.", string, "  - Don't have one? Get Pro at https://claude.ai/upgrade, then run /login.", "Your MemTree credit covers MemTree, not Claude itself."];
export declare const PRESS_ENTER_TEXT = "Press Enter to continue to Claude Code.";
/** Which message was shown (diagnostics no_plan_warning.kind). */
export declare const SIGN_IN_WARNING_KINDS: readonly ["not_signed_in", "api_billing", "unknown", "credit_reminder", "key_override"];
export type SignInWarningKind = (typeof SIGN_IN_WARNING_KINDS)[number];
/** The file in ccc's config directory holding the last sign-in type Claude Code reported. */
export declare const SIGN_IN_STATE_FILE = "claude-sign-in-state.json";
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
export declare function signInNotice(input: SignInNoticeInput): SignInNotice | undefined;
/** The lines on stderr (stdout stays Claude Code's in print runs). */
export declare function printSignInNotice(notice: SignInNotice): void;
export interface PresentOptions {
    /** A terminal on both ends that Claude Code's TUI will take over. */
    interactive: boolean;
    /** The sign-in type for the diagnostics event. */
    auth: ClaudeAuthType;
    record: (name: string, fields: Record<string, unknown>) => void;
    tracker: SignInTracker;
    wait?: () => Promise<{
        ms: number;
        quit: boolean;
    }>;
}
/**
 * Print the notice, wait for Enter when it asks to (interactive only), and
 * record it. Resolves false when the user quit at the prompt (Ctrl+C).
 */
export declare function presentSignInNotice(notice: SignInNotice, opts: PresentOptions): Promise<boolean>;
/**
 * Wait for Enter (or Ctrl+C / end of input) so the message is read before
 * Claude Code covers it. Resolves with how long it waited; never rejects.
 */
export declare function waitForEnter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, now?: () => number): Promise<{
    ms: number;
    quit: boolean;
}>;
export interface SignInState {
    auth: ClaudeAuthType;
    /** Epoch ms of the last warning, kept until a Claude plan sign-in is seen. */
    warnedAt?: number;
}
export declare function readSignInState(configDir: string): SignInState | undefined;
/** Never throws: the next launch only loses the between-starts comparison. */
export declare function writeSignInState(configDir: string, state: SignInState): void;
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
export declare class SignInTracker {
    private readonly configDir;
    private readonly report;
    private readonly now;
    private state;
    private reported;
    private warnedAt;
    constructor(configDir: string, report: (event: SignInEvent) => void, now?: () => number);
    /** Claude Code's answer at launch (probe ok only): compares with the last launch's. */
    started(auth: ClaudeAuthType): void;
    /** ccc showed a sign-in warning now. */
    warned(): void;
    /** The sign-in a request's auth header showed (subscription or api_key). */
    requestAuth(auth: ClaudeAuthType): void;
    /** Milliseconds since this process's warning, or undefined when none was shown. */
    sinceWarningMs(): number | undefined;
    private emit;
    private save;
}
/** The API-billing message, naming the env variable or setting when one is known. */
export declare function apiBillingText(source: ApiKeySource | undefined, asks: boolean): string;
//# sourceMappingURL=sign-in-notice.d.ts.map