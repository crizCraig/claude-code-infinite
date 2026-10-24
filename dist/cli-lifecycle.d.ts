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
/** The exit drain's wait for MemTree calls in flight (the final index above all). */
export declare const SHUTDOWN_MEMTREE_DRAIN_MS = 2000;
/**
 * On Windows: closing the console window (SIGHUP) leaves ccc a few seconds before it is
 * killed (~5 s observed), and a cut final index was logged on every close at 2 s. The
 * drain there is 4 s, counted from the close, so the diagnostics flush after it still fits.
 */
export declare const WIN32_MEMTREE_DRAIN_MS = 4000;
/** How long the exit drain may wait for MemTree calls, `now` being when it starts. */
export declare function shutdownMemtreeDrainMs(platform: NodeJS.Platform, consoleClosedAt: number | undefined, now?: number): number;
//# sourceMappingURL=cli-lifecycle.d.ts.map