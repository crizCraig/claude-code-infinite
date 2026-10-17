import { constants as osConstants } from "node:os";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Conventional shell status for a process terminated by a POSIX signal. */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

/** Preserve a child's numeric status or translate its terminating signal. */
export function exitCodeForChild(
  code: number | null,
  signal: NodeJS.Signals | null
): number {
  if (code !== null) return code;
  return signal === null ? 1 : exitCodeForSignal(signal);
}

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
export function createSignalShutdownHandler(
  actions: SignalShutdownActions
): (signal: ShutdownSignal) => void {
  let received = 0;
  return (signal) => {
    received++;
    actions.forward(signal);
    const code = exitCodeForSignal(signal);
    if (received === 1) actions.shutdown(code);
    else actions.forceExit(code);
  };
}

/** Resolves once `text` is handed to the OS (or the write fails); never rejects. */
export function writeStdout(
  text: string,
  stream: Pick<NodeJS.WriteStream, "write"> = process.stdout
): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Waits for `pending` at most `ms`; a bound for cleanup that must not hang exit. */
export function settleWithin(pending: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    pending.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); }
    );
  });
}
