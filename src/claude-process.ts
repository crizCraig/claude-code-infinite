// All Claude launches, including the auth probe and resume, use this resolution.
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";
import { executablePath } from "./executable-path.js";
import { claudeNpmBin, windowsShellEnv } from "./claude-locate.js";

const require = createRequire(import.meta.url);

export function claudeInvocation(command: string, args: string[], platform = process.platform,
  readManifest?: (file: string) => string, options: Pick<SpawnOptions, "env" | "cwd"> = {}) {
  executablePath(command, platform);
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const file = claudeNpmBin(command, readManifest);
  if (file) {
    return /\.exe$/i.test(file) ? { command: file, args } : { command: process.execPath, args: [file, ...args] };
  }

  const cwd = options.cwd ?? process.cwd();
  const env = windowsShellEnv(options.env ?? process.env, typeof cwd === "string" ? cwd : fileURLToPath(cwd));
  // Use cross-spawn's batch quoting only. We already resolved both the shell and the wrapper.
  const escape: { command(file: string): string; argument(value: string, twice: boolean): string } =
    require("cross-spawn/lib/util/escape.js");
  const doubleEscape = /[\\/]node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const line = [escape.command(win32.normalize(command)), ...args.map(arg => escape.argument(arg, doubleEscape))].join(" ");
  return {
    command: env.ComSpec,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { env, windowsVerbatimArguments: true },
  };
}

export function spawnClaude(command: string, args: string[], options: SpawnOptions) {
  const job = claudeInvocation(command, args, process.platform, undefined, options);
  return spawn(executablePath(job.command), job.args, { ...options, ...job.options });
}

export function spawnClaudeSync(command: string, args: string[], options: SpawnSyncOptions) {
  const job = claudeInvocation(command, args, process.platform, undefined, options);
  return spawnSync(executablePath(job.command), job.args, { ...options, ...job.options });
}
