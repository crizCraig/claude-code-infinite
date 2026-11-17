import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadStream } from "node:tty";

export interface QuestionInput {
  fd: number;
  close(): void;
}

export interface QuestionRelay extends QuestionInput {
  forward(prefix: Buffer, restoreTerminal: () => void): void;
}

/**
 * readline normally reads a whole paste before the callback for its first Enter.
 * Limit the native read to one byte so closing a required startup prompt leaves
 * the following prompt text in the terminal for Claude.
 */
class StartupPromptStream extends ReadStream {
  // The startup guard owns raw mode across readline.close() and the next prompt.
  override setRawMode(): this { return this; }
}

export function startupPromptInput(): ReadStream | undefined {
  const path = process.platform === "win32" ? "CONIN$" : "/dev/fd/0";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOCTTY);
    const input: ReadStream = new StartupPromptStream(fd, { onread: {
      buffer: Buffer.alloc(1),
      callback(size, buffer): boolean {
        input.emit("data", Buffer.from(buffer.subarray(0, size)));
        return input.readableFlowing === true;
      },
    } });
    return input;
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
  }
}

/** The child keeps its own PID, inherited stdout/stderr, and a real terminal on fd 0. */
export async function prepareQuestionInput(
  input: ReadStream, guardMs: number,
): Promise<QuestionRelay | "queued" | undefined> {
  const script = fileURLToPath(new URL("../scripts/question-input.py", import.meta.url));
  const guard = input.readableLength ? -1 : guardMs;
  const helper = spawn("python3", ["-I", "-S", script, String(guard)], {
    stdio: ["pipe", "pipe", "ignore", input],
  });
  const sink = helper.stdin!;
  const reply = helper.stdout!;
  const startup = setTimeout(close, guardMs + 2000);
  helper.once("error", close);
  let fd: number | undefined;
  let restore: (() => void) | undefined;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    process.off("exit", close);
    if (restore !== undefined) {
      input.unpipe(sink);
      input.pause();
      restore();
    }
    if (fd !== undefined) closeSync(fd);
    helper.kill();
  }
  process.once("exit", close);
  sink.on("error", close);
  try {
    let name = "";
    // The helper returns either "queued" or a PTY device name.
    for await (const chunk of reply) {
      name += chunk.toString();
      if (name.endsWith("\n")) break;
    }
    if (name === "queued\n") {
      close();
      return "queued";
    }
    if (closed) return undefined;
    fd = openSync(name.trimEnd(), constants.O_RDWR | constants.O_NOCTTY);
    return { fd, close, forward(prefix, restoreTerminal) {
      restore = restoreTerminal;
      sink.write(prefix);
      input.pipe(sink);
    } };
  } catch {
    close();
    return undefined;
  } finally {
    clearTimeout(startup);
  }
}

/** Windows can inspect the console input queue in place. Claude inherits it directly. */
export async function readWindowsQuestion(
  question: string, signal: AbortSignal, guard: number, quiet: number, timeout: number,
): Promise<number | null> {
  const script = fileURLToPath(new URL("../scripts/question-input.ps1", import.meta.url));
  const helper = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", script, String(guard),
    String(quiet), String(timeout)], {
    stdio: ["inherit", "inherit", "ignore"], timeout: guard + timeout + 5000,
    env: { ...process.env, CCC_QUESTION_TEXT: question },
  });
  const abort = () => { helper.kill(); };
  signal.addEventListener("abort", abort, { once: true });
  const result = new Promise<number | null>(resolve => {
    helper.once("error", () => resolve(null));
    helper.once("exit", resolve);
  });
  if (signal.aborted) abort();
  const code = await result;
  signal.removeEventListener("abort", abort);
  return code;
}
