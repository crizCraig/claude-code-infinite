import { constants as osConstants } from "node:os";
import { signalName } from "./diagnostics-schema.js";
/** Conventional shell status for a process terminated by a POSIX signal. */
export function exitCodeForSignal(signal) {
    const signalNumber = osConstants.signals[signal];
    return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}
/** Preserve a child's numeric status or translate its terminating signal. */
export function exitCodeForChild(code, signal) {
    if (code !== null)
        return code;
    return signal === null ? 1 : exitCodeForSignal(signal);
}
/**
 * Claude Code's exit for diagnostics: the status (clamped by the schema as
 * `code`, unclamped as `code_raw`), its signal, and how long it ran.
 */
export function claudeExitFields(code, signal, startedAt, now = Date.now()) {
    return {
        code: code ?? undefined,
        code_raw: code ?? undefined,
        signal: signalName(signal),
        uptime_ms: Math.max(0, now - startedAt),
    };
}
/**
 * First signal forwards to the child and starts graceful shutdown; a second
 * signal forwards again and becomes an immediate conventional-status escape.
 * Dependencies are injected so this policy can be tested without process.exit.
 */
export function createSignalShutdownHandler(actions) {
    let received = 0;
    return (signal) => {
        received++;
        actions.forward(signal);
        const code = exitCodeForSignal(signal);
        if (received === 1)
            actions.shutdown(code);
        else
            actions.forceExit(code);
    };
}
/** Resolves once `text` is handed to the OS (or the write fails); never rejects. */
export function writeStdout(text, stream = process.stdout) {
    return new Promise((resolve) => {
        try {
            stream.write(text, () => resolve());
        }
        catch {
            resolve();
        }
    });
}
/** Waits for `pending` at most `ms`; a bound for cleanup that must not hang exit. */
export function settleWithin(pending, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        pending.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
}
/** The exit drain's wait for MemTree calls in flight (the final index above all). */
export const SHUTDOWN_MEMTREE_DRAIN_MS = 2_000;
/** Windows: the final index of a large session needs longer than 2 s to upload. */
export const WIN32_MEMTREE_DRAIN_MS = 4_000;
/**
 * Closing a Windows console window (SIGHUP) leaves ccc ~5 s before it is killed, and
 * the final index was cut at 2 s on every close. From the close, each shutdown step
 * ends by its mark here, so the diagnostics flush (exit_index_cut too) still fits.
 */
export const CONSOLE_CLOSE_MARKS_MS = {
    proxyDrain: 1_000, memtreeDrain: 3_500, childWait: 3_750, flush: 4_500,
};
/** How long the exit drain may wait for MemTree calls, starting `now`. */
export function shutdownMemtreeDrainMs(platform, consoleClosedAt, now = Date.now()) {
    const base = platform === "win32" ? WIN32_MEMTREE_DRAIN_MS : SHUTDOWN_MEMTREE_DRAIN_MS;
    return closeBoundedMs(base, consoleClosedAt, CONSOLE_CLOSE_MARKS_MS.memtreeDrain, now);
}
/** `ms`, or less when it would end past `markMs` after the console's close. */
export function closeBoundedMs(ms, consoleClosedAt, markMs, now = Date.now()) {
    if (consoleClosedAt === undefined)
        return ms;
    return Math.max(0, Math.min(ms, consoleClosedAt + markMs - now));
}
//# sourceMappingURL=cli-lifecycle.js.map