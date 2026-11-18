// All Claude launches, including the auth probe and resume, use this resolution.
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { executablePath } from "./executable-path.js";

export function claudeInvocation(command: string, args: string[], platform = process.platform,
  readManifest = (file: string) => readFileSync(file, "utf8")) {
  executablePath(command, platform);
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args };

  // npm places global shims in the prefix and local ones in node_modules/.bin.
  // Its JS shim can invoke bare `node`, so resolve the package's bin without
  // executing batch code or passing Claude's arguments through cmd.exe.
  const dir = win32.dirname(command);
  const modules = /[\\/]node_modules[\\/]\.bin$/i.test(dir) ? win32.dirname(dir) : win32.join(dir, "node_modules");
  const pkg = win32.join(modules, "@anthropic-ai", "claude-code");
  const { bin } = JSON.parse(readManifest(win32.join(pkg, "package.json")));
  const entry = typeof bin === "string" ? bin : bin?.claude;
  if (typeof entry !== "string" || !/\.(?:[cm]?js|exe)$/i.test(entry)) {
    throw new Error("Claude Code's npm package has no supported claude executable.");
  }
  const file = win32.join(pkg, entry);
  return /\.exe$/i.test(file) ? { command: file, args } : { command: process.execPath, args: [file, ...args] };
}

export function spawnClaude(command: string, args: string[], options: SpawnOptions) {
  const job = claudeInvocation(command, args);
  return spawn(executablePath(job.command), job.args, options);
}

export function spawnClaudeSync(command: string, args: string[], options: SpawnSyncOptions) {
  const job = claudeInvocation(command, args);
  return spawnSync(executablePath(job.command), job.args, options);
}
