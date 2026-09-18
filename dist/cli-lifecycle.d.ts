export type ShutdownSignal = "SIGINT" | "SIGTERM";
/** Conventional shell status for a process terminated by a POSIX signal. */
export declare function exitCodeForSignal(signal: NodeJS.Signals): number;
/** Preserve a child's numeric status or translate its terminating signal. */
export declare function exitCodeForChild(code: number | null, signal: NodeJS.Signals | null): number;
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
//# sourceMappingURL=cli-lifecycle.d.ts.map