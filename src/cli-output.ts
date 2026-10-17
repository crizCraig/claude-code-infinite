/**
 * Where ccc's own lines go. In print (`-p`) and non-TTY runs stdout belongs
 * to Claude Code: agents parse `--output-format json|stream-json` from it, so
 * ccc's banner, mode line, request-log path and debug lines go to stderr
 * instead (uncoloured when stderr is not a terminal). Claude Code itself
 * inherits the real stdout and is unaffected.
 */
import { format } from "node:util";

interface ConsoleLike {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

interface StreamLike {
  isTTY?: boolean;
  write(text: string): boolean;
}

/** Send `console.log`/`info`/`debug` to stderr for the rest of this process. */
export function routeConsoleToStderr(
  target: ConsoleLike = console,
  stderr: StreamLike = process.stderr
): void {
  const plain = stderr.isTTY !== true;
  const write = (...args: unknown[]): void => {
    const text = format(...args);
    stderr.write(`${plain ? stripAnsi(text) : text}\n`);
  };
  target.log = write;
  target.info = write;
  target.debug = write;
}

/** SGR colour codes and OSC 8 hyperlinks (keeping their text) removed. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
