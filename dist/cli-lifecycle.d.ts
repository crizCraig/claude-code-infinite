export type ShutdownSignal = "SIGINT" | "SIGTERM";
/** Conventional shell status for a process terminated by a POSIX signal. */
export declare function exitCodeForSignal(signal: NodeJS.Signals): number;
/** Preserve a child's numeric status or translate its terminating signal. */
export declare function exitCodeForChild(code: number | null, signal: NodeJS.Signals | null): number;
/**
 * Claude Code's exit for diagnostics: the status (clamped by the schema as
 * `code`, unclamped as `code_raw`), its signal, and how long it ran.
 */
export declare function claudeExitFields(code: number | null, signal: NodeJS.Signals | null, startedAt: number, now?: number): Record<string, number | string | undefined>;
export interface SignalShutdownActions {
    forward(signal: ShutdownSignal): void;
    shutdown(code: number): void;
    forceExit(code: number): void;
}
/**
 * First signal forwards to the child and starts graceful shutdown; a second
 * signal forwards again and becomes an immediate conventional-status escape.
 * Dependencies are injected so this policy can be tested without process.exit.
 */
export declare function createSignalShutdownHandler(actions: SignalShutdownActions): (signal: ShutdownSignal) => void;
/** Resolves once `text` is handed to the OS (or the write fails); never rejects. */
export declare function writeStdout(text: string, stream?: Pick<NodeJS.WriteStream, "write">): Promise<void>;
/** Waits for `pending` at most `ms`; a bound for cleanup that must not hang exit. */
export declare function settleWithin(pending: Promise<unknown>, ms: number): Promise<void>;
//# sourceMappingURL=cli-lifecycle.d.ts.map