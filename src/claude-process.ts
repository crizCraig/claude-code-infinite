// Use the selected executable directly. For npm's Windows batch shim, reuse
// cross-spawn's quoting, without its PATH, shebang interpreter or shell lookup.
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { createRequire } from "node:module";
import { executablePath } from "./executable-path.js";
import { system32Path, windowsShellEnv } from "./claude-locate.js";

interface Invocation {
  command: string;
  args: string[];
  options?: Pick<SpawnOptions, "windowsVerbatimArguments" | "env">;
}

const require = createRequire(import.meta.url);
export function claudeInvocation(command: string, args: string[], env = process.env,
  platform = process.platform, cwd = process.cwd()): Invocation {
  executablePath(command, platform);
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const escape: { command(file: string): string; argument(value: string, twice: boolean): string } =
    require("cross-spawn/lib/util/escape.js");
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const line = [escape.command(command), ...args.map(arg => escape.argument(arg, twice))].join(" ");
  return {
    command: system32Path(env, "cmd.exe"),
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true, env: windowsShellEnv(env, cwd) },
  };
}

export function spawnClaude(command: string, args: string[], options: SpawnOptions) {
  const job = claudeInvocation(command, args, options.env);
  return spawn(executablePath(job.command), job.args, { ...options, ...job.options });
}

export function spawnClaudeSync(command: string, args: string[], options: SpawnSyncOptions) {
  const job = claudeInvocation(command, args, options.env);
  return spawnSync(executablePath(job.command), job.args, { ...options, ...job.options });
}
