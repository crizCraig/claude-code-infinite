// Discard pre-prompt input at both boundaries: Node may already have read a
// chunk, and the terminal can still contain complete or partially typed lines.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { system32Path } from "./claude-locate.js";

export async function askFreshKeyLine(question: string, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  const input = process.stdin;
  input.pause();
  while (input.readableLength) input.read(); // only bytes already held by Node
  if (process.platform === "win32") return windowsConsoleLine(question, output);

  const wasRaw = input.isRaw;
  input.setRawMode(true); // make even a partial line available to the drain
  try {
    // Raw mode disables tty echo. Give the line editor no output stream so
    // pasted text and redraws cannot reach either the screen or a log.
    const rl = createInterface({ input, terminal: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.once("close", () => reject(new Error("MemTree key entry cancelled.")));
        rl.once("SIGINT", () => rl.close());
        rl.once("line", answer => {
          output.write("\n");
          resolve(answer);
          rl.close();
        });
        discardTerminalInput();
        output.write(question);
      });
    } finally {
      rl.close();
    }
  } finally {
    input.setRawMode(wasRaw);
  }
}

// Called in raw mode, synchronously with the prompt write. Opening a separate
// nonblocking descriptor leaves the flags on inherited stdin untouched.
function discardTerminalInput(): void {
  const fd = openSync("/dev/fd/0", constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const buffer = Buffer.alloc(4096);
    while (readSync(fd, buffer, 0, buffer.length, null) > 0) { /* discard */ }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
  } finally {
    closeSync(fd);
  }
}

// The console reader owns the flush, prompt and read. The answer travels only
// over its stdout pipe; neither the command line nor an error includes it.
function windowsConsoleLine(question: string, output: NodeJS.WriteStream): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$Host.UI.RawUI.FlushInputBuffer()",
    "[Console]::Error.Write($env:CCC_KEY_PROMPT)",
    "$line = [Text.StringBuilder]::new()",
    `while ($true) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq 'Enter') { break }
      if ($key.Key -eq 'Backspace') {
        if ($line.Length) { $line.Length-- }
      } elseif (-not [char]::IsControl($key.KeyChar)) {
        [void]$line.Append($key.KeyChar)
      }
    }`,
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
      else reject(new Error("Could not read fresh input from the Windows console."));
    });
  });
}
