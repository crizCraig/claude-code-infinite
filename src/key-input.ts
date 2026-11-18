// Discard pre-prompt input at both boundaries: Node may already have read a
// chunk, and the terminal can still contain complete or partially typed lines.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { executablePath } from "./executable-path.js";
import { system32Path } from "./claude-locate.js";

export type AskKeyLine = (question: string, output?: NodeJS.WriteStream) => Promise<string | null>;

/** Keep echo off from the first prompt through the last status check. */
export async function withMutedKeyInput<T>(run: (ask: AskKeyLine) => Promise<T>): Promise<T> {
  const input = process.stdin;
  if (!input.isTTY) return run(askFreshKeyLine);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  try {
    return await run(askFreshKeyLine);
  } finally {
    try {
      // A successful check can hand the terminal straight to Claude or a
      // payment prompt. Discard a replacement pasted during that check too.
      discardBufferedInput();
      if (process.platform === "win32") {
        execFileSync(system32Path(process.env, "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoLogo", "-NoProfile", "-Command", "$ErrorActionPreference='Stop'; $Host.UI.RawUI.FlushInputBuffer()"],
          { stdio: ["inherit", "ignore", "inherit"] });
      } else if (!discardTerminalInput()) {
        throw new Error("Could not clear pending terminal input after checking the MemTree key.");
      }
    } finally {
      input.setRawMode(wasRaw);
    }
  }
}

function discardBufferedInput(): void {
  const input = process.stdin;
  input.pause();
  while (input.readableLength) input.read(); // only bytes already held by Node
}

async function askFreshKeyLine(question: string, output: NodeJS.WriteStream = process.stdout): Promise<string | null> {
  const input = process.stdin;
  discardBufferedInput();
  if (process.platform === "win32") return windowsConsoleLine(question, output);

  // Closing a terminal readline normally re-enables echo. Keep the tty in
  // the enclosing validation scope and give the editor only its input bytes.
  const bytes = new PassThrough();
  const rl = createInterface({ input: bytes, terminal: true });
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.once("SIGINT", () => {
        output.write("\n");
        rl.close();
      });
      rl.once("line", answer => {
        output.write("\n");
        resolve(answer);
        rl.close();
      });
      // Show the prompt at the empty-queue boundary, before closing a device
      // or waiting for stty to restore VMIN. Only then start the line reader.
      if (discardTerminalInput(() => output.write(question))) input.pipe(bytes);
      else {
        output.write("Could not clear pending terminal input. Cancelling the prompt.\n");
        rl.close();
      }
    });
  } finally {
    input.unpipe(bytes);
    bytes.destroy();
    rl.close();
  }
}

function drain(fd: number): boolean {
  const buffer = Buffer.alloc(4096);
  try {
    while (readSync(fd, buffer, 0, buffer.length, null) > 0) { /* discard */ }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EAGAIN" || code === "EWOULDBLOCK";
  }
}

// Linux reopens the tty through procfs. On macOS /dev/fd/0 duplicates stdin
// and ignores O_NONBLOCK, so open the actual device with its own file flags.
function discardTerminalInput(onEmpty?: () => void): boolean {
  let fd: number | undefined;
  try {
    const path = process.platform === "linux" ? "/dev/fd/0"
      : execFileSync(executablePath("/usr/bin/tty"), { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trimEnd();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch { /* after su, only inherited stdin may be readable */ }
  if (fd !== undefined) {
    try {
      if (drain(fd)) {
        onEmpty?.();
        return true;
      }
    } finally {
      try { closeSync(fd); } catch { /* the read already established whether the queue was empty */ }
    }
  }

  // In raw mode VMIN=0, VTIME=0 makes even a blocking inherited fd return
  // when the queue empties. Restore raw mode's VMIN before Node starts reading.
  const stty = (min: string) => execFileSync(executablePath("/bin/stty"), ["min", min, "time", "0"],
    { stdio: ["inherit", "ignore", "ignore"] });
  try {
    stty("0");
    try {
      if (!drain(process.stdin.fd)) return false;
      onEmpty?.();
    } finally {
      stty("1");
    }
    return true;
  } catch {
    return false;
  }
}

// The console reader owns the flush, prompt and read. The answer travels only
// over its stdout pipe; neither the command line nor an error includes it.
function windowsConsoleLine(question: string, output: NodeJS.WriteStream): Promise<string | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$previous = [Console]::TreatControlCAsInput",
    `try {
      [Console]::TreatControlCAsInput = $true
      $Host.UI.RawUI.FlushInputBuffer()
      [Console]::Error.Write($env:CCC_KEY_PROMPT)
      $line = [Text.StringBuilder]::new()
      while ($true) {
        $key = [Console]::ReadKey($true)
        if ([int]$key.KeyChar -eq 3) { [Console]::Error.WriteLine(); exit 130 }
        if ($key.Key -eq 'Enter') { break }
        if ($key.Key -eq 'Backspace') {
          if ($line.Length) { $line.Length-- }
        } elseif (-not [char]::IsControl($key.KeyChar)) {
          [void]$line.Append($key.KeyChar)
        }
      }
    } finally { [Console]::TreatControlCAsInput = $previous }`,
    "[Console]::Error.WriteLine()",
    "[Console]::Out.Write($line.ToString())",
  ].join("; ");
  const child = spawn(system32Path(process.env, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-Command", script], {
      env: { ...process.env, CCC_KEY_PROMPT: question }, stdio: ["inherit", "pipe", output],
    });
  return new Promise((resolve, reject) => {
    let answer = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { answer += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve(answer);
      else if (code === 130) resolve(null);
      else reject(new Error("Could not read fresh input from the Windows console."));
    });
  });
}
