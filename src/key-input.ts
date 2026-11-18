// Discard pre-prompt input at both boundaries: Node may already have read a
// chunk, and the terminal can still contain complete or partially typed lines.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { system32Path } from "./claude-locate.js";

export async function askFreshKeyLine(question: string, output: NodeJS.WriteStream = process.stdout): Promise<string | null> {
  const input = process.stdin;
  input.pause();
  while (input.readableLength) input.read(); // only bytes already held by Node
  if (process.platform === "win32") return windowsConsoleLine(question, output);

  const wasRaw = input.isRaw;
  input.setRawMode(true); // make even a partial line available to the drain
  try {
    discardTerminalInput();
    // Raw mode disables tty echo. Give the line editor no output stream so
    // pasted text and redraws cannot reach either the screen or a log.
    const rl = createInterface({ input, terminal: true });
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
        output.write(question);
      });
    } finally {
      rl.close();
    }
  } finally {
    input.setRawMode(wasRaw);
  }
}

// Linux reopens the tty through procfs. On macOS /dev/fd/0 duplicates stdin
// and ignores O_NONBLOCK, so open the actual device with its own file flags.
function discardTerminalInput(): void {
  try {
    const path = process.platform === "linux" ? "/dev/fd/0"
      : execFileSync("/usr/bin/tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trimEnd();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
    try {
      const buffer = Buffer.alloc(4096);
      while (readSync(fd, buffer, 0, buffer.length, null) > 0) { /* discard */ }
    } finally {
      closeSync(fd);
    }
  } catch {
    // EAGAIN means the queue is empty. If the tty can't be reopened or read
    // (e.g. after su), the user can still enter a key on inherited stdin.
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
