/**
 * A session whose MemTree key is unpaid and whose user chose to continue without
 * MemTree (the startup gate's [c], or any print/non-TTY run of an unpaid key).
 *
 * It runs as plain Claude Code: no local proxy, so no context_memory, compress or
 * index calls that would only answer 402, and none of ccc's environment changes.
 * Claude Code keeps its own auto-compaction and its own context-limit refusal
 * (ccc normally turns both off because MemTree fits the conversation instead),
 * and talks to the Anthropic API directly. Payment is checked again at the next
 * ccc start; subscribing at the gate ([Enter]) turns MemTree on for this start.
 *
 * Interactive sessions get one SessionStart banner (a static plugin, no proxy):
 * MemTree is off for this session, and how to turn it back on.
 */
import spawn from "cross-spawn";
import type { AutoUpdateSetup } from "./auto-update-setup.js";
import {
  claudeExitFields,
  createSignalShutdownHandler,
  exitCodeForChild,
  ignoreStreamErrors,
  onHangup,
  settleWithin,
} from "./cli-lifecycle.js";
import { UNREACHABLE_BLOCKING_LIMIT } from "./claude-env.js";
import { type ClaudeLocation, claudeMissingText, withClaudeOnPath } from "./claude-locate.js";
import { type Diagnostics, recordError } from "./diagnostics.js";
import {
  type SessionNoticePlugin,
  createStartupBannerPlugin,
  withSessionNoticePluginArgs,
} from "./hooks.js";

/** How long a forwarded Ctrl+C/SIGTERM waits for Claude Code to exit before ccc does. */
const CHILD_EXIT_WAIT_MS = 5_000;

export type PausedSessionOptions = {
  claude: ClaudeLocation;
  claudeArgs: string[];
  interactive: boolean;
  diagnostics: Diagnostics;
  autoUpdate: AutoUpdateSetup | null;
  /** The SessionStart banner (interactive only); undefined shows none. */
  banner?: string;
};

/** Run Claude Code as if ccc were not there, then exit with its status. Never returns. */
export async function runWithoutMemtree(opts: PausedSessionOptions): Promise<never> {
  const plugin = opts.interactive && opts.banner ? bannerPlugin(opts.banner) : null;
  const args = plugin ? withSessionNoticePluginArgs(opts.claudeArgs, plugin.dir) : opts.claudeArgs;
  const startedAt = Date.now();
  const child = spawn(opts.claude.command, args, {
    env: withClaudeOnPath(plainClaudeEnv(process.env), opts.claude),
    stdio: "inherit",
  });
  const exited = new Promise<number>((resolve) => {
    child.on("error", (err: Error) => resolve(childStartFailed(err, opts.diagnostics)));
    child.on("exit", (code, signal) => {
      if (code !== 0) opts.diagnostics.record("claude_exit", claudeExitFields(code, signal, startedAt));
      resolve(exitCodeForChild(code, signal));
    });
  });
  forwardSignals(child, exited, opts, (code) => void finish(code, plugin, opts));
  opts.autoUpdate?.scheduleInstall(undefined, (result) => {
    opts.diagnostics.record("auto_update", { result });
    opts.diagnostics.flushNow();
  });
  return finish(await exited, plugin, opts);
}

/**
 * The parent's environment minus ccc's own controls: none of the settings ccc
 * gives Claude Code under MemTree (base URL, auto-compaction off, lifted
 * context-limit refusal) apply, so Claude Code behaves exactly as without ccc.
 * A ccc started inside another ccc session (a tool, a script) inherits the outer
 * session's settings (claude-env.ts); those are dropped too.
 */
export function plainClaudeEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  delete env.CCC_AUTO_COMPACT;
  if (insideCccSession(parentEnv)) {
    for (const name of OUTER_CCC_SETTINGS) delete env[name];
    if (env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE === UNREACHABLE_BLOCKING_LIMIT) {
      delete env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
    }
  }
  return env;
}

/**
 * Whether these Claude Code arguments resume or continue an earlier session. Such a
 * session may have grown past the model's window under MemTree, which plain Claude
 * Code could not send or compact, so it keeps ccc's own handling (cli-main.ts).
 */
export function resumesSession(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (["-r", "--resume", "-c", "--continue", "--from-pr"].includes(arg) ||
        arg.startsWith("--resume=") || arg.startsWith("--from-pr=")) {
      return true;
    }
  }
  return false;
}

/** What claudeChildEnv sets for the Claude Code it starts, besides the blocking limit. */
const OUTER_CCC_SETTINGS = [
  "ANTHROPIC_BASE_URL", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD", "DISABLE_AUTO_COMPACT",
];

function insideCccSession(env: NodeJS.ProcessEnv): boolean {
  return env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === "1" &&
    /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(env.ANTHROPIC_BASE_URL ?? "");
}

function bannerPlugin(banner: string): SessionNoticePlugin | null {
  try {
    return createStartupBannerPlugin(banner);
  } catch {
    return null; // The banner is optional: a full temp dir must never stop the session.
  }
}

function forwardSignals(
  child: ReturnType<typeof spawn>, exited: Promise<number>, opts: PausedSessionOptions,
  exit: (code: number) => void
): void {
  const handle = createSignalShutdownHandler({
    forward: (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the check and kill().
      }
    },
    shutdown: (code) => void settleWithin(exited, CHILD_EXIT_WAIT_MS).then(() => exit(code)),
    forceExit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
  // A closed terminal (SIGHUP), as in cli-main.ts. On Windows the update starts first:
  // Windows may end ccc before Claude Code exits.
  onHangup(process, (kind) => {
    opts.diagnostics.record("console_closed");
    if (kind === "console-close") {
      opts.autoUpdate?.installOnExit((result) => opts.diagnostics.record("auto_update", { result }));
      handle("SIGTERM");
      return;
    }
    ignoreStreamErrors([process.stdout, process.stderr]);
    handle("SIGHUP");
  }, Boolean(process.stdout.isTTY || process.stderr.isTTY));
}

let finishing: Promise<never> | null = null;

/** Once: start a pending Windows update, remove the banner, flush diagnostics, exit. */
function finish(
  code: number, plugin: SessionNoticePlugin | null, opts: PausedSessionOptions
): Promise<never> {
  finishing ??= (async (): Promise<never> => {
    opts.autoUpdate?.installOnExit((result) => opts.diagnostics.record("auto_update", { result }));
    plugin?.close();
    await opts.diagnostics.flush();
    process.exit(code);
  })();
  return finishing;
}

function childStartFailed(err: Error, diagnostics: Diagnostics): number {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    diagnostics.record("claude_missing");
    console.error(claudeMissingText());
  } else {
    recordError(diagnostics, "spawn_failed", err);
    console.error("Failed to start claude:", err.message);
  }
  return 1;
}
