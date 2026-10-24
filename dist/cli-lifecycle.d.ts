export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
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
/** Windows: the final index of a large session needs longer than 2 s to upload. */
export declare const WIN32_MEMTREE_DRAIN_MS = 4000;
/**
 * Closing a Windows console window (SIGHUP) leaves ccc ~5 s before it is killed, and
 * the final index was cut at 2 s on every close. From the close, each shutdown step
 * ends by its mark here, so the diagnostics flush (exit_index_cut too) still fits.
 */
export declare const CONSOLE_CLOSE_MARKS_MS: {
    readonly proxyDrain: 1000;
    readonly memtreeDrain: 3500;
    readonly childWait: 3750;
    readonly flush: 4500;
};
/**
 * How a closed terminal reaches ccc. Windows: the console window closed, and Windows ends
 * ccc ~5 s later ("console-close", each shutdown step ends by its mark). macOS and Linux:
 * the terminal hung up ("terminal-hangup"); nothing ends ccc after it, but its terminal is
 * gone. Either way it is SIGHUP, whose default is to exit at once: before this, closing a
 * macOS or Linux terminal killed ccc with no final index.
 */
export type HangupKind = "console-close" | "terminal-hangup";
/** Calls `handler` on every SIGHUP, on every platform, with the kind of close it means. */
export declare function onHangup(proc: Pick<NodeJS.Process, "on" | "platform">, handler: (kind: HangupKind) => void): void;
/** After a hangup, writes to the gone terminal fail (EIO, EPIPE): never fatal to the drain. */
export declare function ignoreStreamErrors(streams: Array<Pick<NodeJS.EventEmitter, "on">>): void;
/**
 * The exit drain's wait for MemTree calls after a terminal hangup (macOS, Linux): nobody
 * waits for ccc then, and a large session's final index takes seconds to upload.
 */
export declare const HANGUP_MEMTREE_DRAIN_MS = 10000;
/** How long the exit drain may wait for MemTree calls, starting `now`. */
export declare function shutdownMemtreeDrainMs(platform: NodeJS.Platform, consoleClosedAt: number | undefined, now?: number): number;
/** `ms`, or less when it would end past `markMs` after the console's close. */
export declare function closeBoundedMs(ms: number, consoleClosedAt: number | undefined, markMs: number, now?: number): number;
//# sourceMappingURL=cli-lifecycle.d.ts.map