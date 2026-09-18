import { constants as osConstants } from "node:os";
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
//# sourceMappingURL=cli-lifecycle.js.map