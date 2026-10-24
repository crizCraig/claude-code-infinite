import { constants as osConstants } from "node:os";
import { signalName } from "./diagnostics-schema.js";

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

/**
 * Claude Code's exit for diagnostics: the status (clamped by the schema as
 * `code`, unclamped as `code_raw`), its signal, and how long it ran.
 */
export function claudeExitFields(
  code: number | null,
  signal: NodeJS.Signals | null,
  startedAt: number,
  now: number = Date.now()
): Record<string, number | string | undefined> {
  return {
    code: code ?? undefined,
    code_raw: code ?? undefined,
    signal: signalName(signal),
    uptime_ms: Math.max(0, now - startedAt),
  };
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

/** The exit drain's wait for MemTree calls in flight (the final index above all). */
export const SHUTDOWN_MEMTREE_DRAIN_MS = 2_000;
/**
 * On Windows: closing the console window (SIGHUP) leaves ccc a few seconds before it is
 * killed (~5 s observed), and a cut final index was logged on every close at 2 s. The
 * drain there is 4 s, counted from the close, so the diagnostics flush after it still fits.
 */
export const WIN32_MEMTREE_DRAIN_MS = 4_000;

/** How long the exit drain may wait for MemTree calls, `now` being when it starts. */
export function shutdownMemtreeDrainMs(
  platform: NodeJS.Platform, consoleClosedAt: number | undefined, now = Date.now()
): number {
  if (platform !== "win32") return SHUTDOWN_MEMTREE_DRAIN_MS;
  if (consoleClosedAt === undefined) return WIN32_MEMTREE_DRAIN_MS;
  const left = consoleClosedAt + WIN32_MEMTREE_DRAIN_MS - now;
  return Math.max(0, Math.min(WIN32_MEMTREE_DRAIN_MS, left));
}
