#!/usr/bin/env node

/**
 * Claude Code Infinite launcher (plans/2026-06-09_PLAN_local_proxy_app.md).
 *
 * Starts the local proxy on 127.0.0.1 and execs `claude` with only
 * ANTHROPIC_BASE_URL set. Auth is untouched by design ("mirror vanilla"):
 * Claude Code keeps its native login — token refresh, plan-default model
 * resolution, and limit handling behave exactly like vanilla — and its OAuth
 * token never leaves this machine. polychat.co only ever sees message content
 * for compression/indexing, authenticated by the user's MemTree API key.
 */

import spawn from "cross-spawn";
import { exec } from "node:child_process";
import * as readline from "node:readline";
import { startProxy } from "./proxy.js";
import {
  DEFAULT_GRADE_PREFIX_TOKENS,
  DEFAULT_PREFIX_TIMEOUT_MS,
  DEFAULT_GRADER_TIMEOUT_MS,
  DEFAULT_GRADER_MODEL,
} from "./ab-routing.js";
import {
  createSessionNoticePlugin,
  supportsMessageDisplay,
  withSessionNoticePluginArgs,
  type SessionNoticePlugin,
} from "./hooks.js";
import { CLIENT_NAME, CLIENT_VERSION, MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { sanitizeNoticeDetail } from "./notices.js";
import { projectTranscriptDir, startTranscriptScrubber } from "./scrub.js";
import {
  getPolychatApiKey,
  setPolychatApiKey,
  getLocalPolychatApiKey,
  setLocalPolychatApiKey,
  getStagingPolychatApiKey,
  setStagingPolychatApiKey,
} from "./config.js";

// MemTree (polychat) API hosts — /v1/context_memory lives at the app root.
const POLYCHAT_BASE_URL = "https://api.polychat.co";
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
const LOCAL_BASE_URL = "http://localhost:8080";
const POLYCHAT_AUTH_URL = "https://polychat.co/auth?memtree=true";

type Mode = "production" | "staging" | "local";

// Parse a CCC_AB_* numeric env var. resolveAbRoutingOptions silently replaces
// invalid values (NaN, zero, negative) with defaults, so a mistyped tuning
// knob would otherwise take effect as the default with no indication. Warn on
// stderr here — where the variable name and raw value are still known — and
// return undefined so the documented default applies.
function abEnvPositiveNumber(name: string, fallback: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `\x1b[1;33m⚠ Ignoring ${name}="${raw}" — expected a positive number; using default ${fallback}.\x1b[0m`
    );
    return undefined;
  }
  return value;
}

// Parse CCC_AB_GRADER_MODEL. resolveAbRoutingOptions only substitutes the
// default for undefined (`??`), so an empty/whitespace value would flow through
// as `model: ""` and every grader request would be rejected 400 — silently
// falling back to memory while still paying the double-leg cost. Warn on
// stderr and return undefined so the documented default applies.
function abEnvGraderModel(): string | undefined {
  const raw = process.env.CCC_AB_GRADER_MODEL;
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") {
    console.warn(
      `\x1b[1;33m⚠ Ignoring CCC_AB_GRADER_MODEL="${raw}" — expected a model id; using default ${DEFAULT_GRADER_MODEL}.\x1b[0m`
    );
    return undefined;
  }
  return value;
}

function openUrl(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";

  platform === "win32"
    ? exec(`${command} "${url}"`, { shell: "cmd.exe" })
    : exec(`${command} "${url}"`);
}

async function promptForApiKey(mode: Mode): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const url =
    mode === "local"
      ? "http://local.polychat.co:5173/memtree-api"
      : POLYCHAT_AUTH_URL;

  await new Promise<void>((resolve) => {
    rl.question(
      `\nPress Enter to open your browser to obtain your Memtree API key...`,
      () => resolve()
    );
  });

  openUrl(url);

  return new Promise((resolve) => {
    rl.question("Copy your API key and paste it here: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Startup payment check: GET /v1/context_memory/status and warn if the key is
 * unpaid, so the user learns why compression/indexing will be off BEFORE the
 * first degraded turn. The endpoint may not be deployed yet — 404/405/401/503,
 * network errors, and timeouts all mean "unknown": stay quiet. Bounded by a
 * short timeout and silent on every error so startup is never gated on it.
 */
async function warnIfUnpaid(baseUrl: string, apiKey: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/context_memory/status`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-client": CLIENT_NAME,
        "x-client-version": CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    const status = (await res.json()) as {
      paid?: boolean;
      payment_message?: string | null;
    };
    if (status?.paid === false) {
      console.warn(
        "\x1b[1;33m⚠ MemTree is off — payment required (compression + indexing disabled)." +
          " Visit polychat.co to enable.\x1b[0m" +
          (status.payment_message
            ? `\n${sanitizeNoticeDetail(status.payment_message)}`
            : "")
      );
    }
  } catch {
    // status unknown (endpoint missing, network, timeout, bad JSON) — stay quiet
  }
}

function printBanner() {
  console.log(
    `\n\x1b[1;38;5;209mClaude Code Infinite:\x1b[0m \x1b[38;5;48mMaximizing Claude's intelligence with context-management from \x1b]8;;https://MemTree.dev\x1b\\MemTree.dev\x1b]8;;\x1b\\\x1b[0m\n`
  );
}

function isPrintInvocation(args: string[]): boolean {
  return args.includes("-p") || args.includes("--print");
}

/** Unknown/old versions get the longstanding Stop fallback only. */
function installedClaudeSupportsMessageDisplay(): boolean {
  try {
    const result = spawn.sync("claude", ["--version"], { encoding: "utf-8" });
    return supportsMessageDisplay(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isDebugMode = args.includes("--debug");
  // Research escape hatch: retain the old buffer-both-then-commit A/B mode
  // instead of the default speculative commit-A-immediately delivery.
  const isAbBuffered = args.includes("--ab-buffered");
  const filteredArgs = args.filter(
    (arg) => arg !== "--debug" && arg !== "--ab-buffered"
  );

  const mode: Mode =
    filteredArgs[0] === "local" ? "local" :
    filteredArgs[0] === "staging" ? "staging" :
    "production";

  const claudeArgs = mode !== "production" ? filteredArgs.slice(1) : filteredArgs;

  printBanner();

  if (isDebugMode) {
    console.log("\x1b[1;36m🔍 DEBUG MODE\x1b[0m\n");
  }

  if (mode === "local") {
    console.log("\x1b[1;33m🏠 LOCAL MODE\x1b[0m\n");
  } else if (mode === "staging") {
    console.log("\x1b[1;35m🚧 STAGING MODE\x1b[0m\n");
  }

  // Get or prompt for the MemTree API key (separate keys per environment)
  let polychatApiKey =
    mode === "local" ? getLocalPolychatApiKey() :
    mode === "staging" ? getStagingPolychatApiKey() :
    getPolychatApiKey();

  if (!polychatApiKey) {
    polychatApiKey = await promptForApiKey(mode);
    if (!polychatApiKey) {
      console.error("A MemTree API key is required.");
      process.exit(1);
    }
    if (mode === "local") {
      setLocalPolychatApiKey(polychatApiKey);
    } else if (mode === "staging") {
      setStagingPolychatApiKey(polychatApiKey);
    } else {
      setPolychatApiKey(polychatApiKey);
    }
    console.log("API key saved.\n");
  }

  const memtreeBaseUrl =
    mode === "local" ? LOCAL_BASE_URL :
    mode === "staging" ? STAGING_BASE_URL :
    POLYCHAT_BASE_URL;

  // Warn about an unpaid key before claude takes over the terminal. Awaited so
  // the warning can't corrupt the TUI, but bounded (2s) and silent on error —
  // startup never fails or hangs on polychat availability.
  await warnIfUnpaid(memtreeBaseUrl, polychatApiKey);

  // Always-on request/timing log (reqlog.ts): messages, MemTree calls, and
  // successful notice claims, so incidents can be reconstructed after the
  // fact without --debug. Never blocks or throws.
  const reqlog = new RequestLogger();

  // Start the local proxy. Claude Code's OAuth token flows through it straight
  // to api.anthropic.com and never reaches polychat.co.
  const memtree = new MemtreeClient({
    baseUrl: memtreeBaseUrl,
    apiKey: polychatApiKey,
    debug: isDebugMode,
    reqlog,
  });
  const abRouting =
    process.env.CCC_AB_ROUTING === "0"
      ? undefined
      : {
          graderModel: abEnvGraderModel(),
          prefixChars: (() => {
            const tokens = abEnvPositiveNumber(
              "CCC_AB_PREFIX_TOKENS",
              DEFAULT_GRADE_PREFIX_TOKENS
            );
            return tokens === undefined ? undefined : tokens * 4;
          })(),
          prefixTimeoutMs: abEnvPositiveNumber(
            "CCC_AB_PREFIX_TIMEOUT_MS",
            DEFAULT_PREFIX_TIMEOUT_MS
          ),
          graderTimeoutMs: abEnvPositiveNumber(
            "CCC_AB_GRADER_TIMEOUT_MS",
            DEFAULT_GRADER_TIMEOUT_MS
          ),
          sampleWhenNoPrior: process.env.CCC_AB_SAMPLE_NO_PRIOR !== "0",
          forceComparison: process.env.CCC_AB_FORCE_COMPARISON === "1",
          speculative: !isAbBuffered,
        };
  const proxy = await startProxy({
    memtree,
    debug: isDebugMode,
    reqlog,
    abRouting,
  });

  // One unobtrusive (dim) line so users can find the log during an incident.
  console.log(`\x1b[2mRequest log: ${reqlog.path}\x1b[0m\n`);

  if (isDebugMode) {
    console.log(`[DEBUG] Local proxy listening on http://127.0.0.1:${proxy.port}`);
    console.log(`[DEBUG] MemTree API: ${memtreeBaseUrl}`);
    console.log(`[DEBUG] A/B memory routing: ${abRouting ? "enabled" : "disabled"}`);
  }

  // Legacy transcript cleanup: releases before display-only hooks injected
  // marker-wrapped assistant blocks. Keep removing those from old/forked
  // .jsonl files so resumes stay clean. In-place patches only (the watcher scans
  // pre-existing transcripts from byte 0 at startup, then patches appends as
  // they land) — no rewrite+rename pass, ever: we can't identify our own
  // session's transcript (claude picks the session id itself), and renaming a
  // file another live session holds an open append handle on silently loses
  // the rest of its history.
  const transcriptDir = projectTranscriptDir(process.cwd());
  let scrubber;
  try {
    scrubber = startTranscriptScrubber(transcriptDir, { debug: isDebugMode });
  } catch (err) {
    proxy.close();
    throw err;
  }

  // Interactive notices are provided by a minimal, ephemeral plugin. Prepending
  // --plugin-dir composes with user hooks/settings; adding another --settings
  // would not, because Claude keeps only its final --settings occurrence.
  // Print/non-TTY calls are programmatic interfaces: omit all UI hooks so their
  // stdout/events remain byte-for-byte vanilla.
  let noticePlugin: SessionNoticePlugin | null = null;
  let childArgs = [...claudeArgs];
  if (
    !isPrintInvocation(claudeArgs) &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  ) {
    try {
      noticePlugin = createSessionNoticePlugin(proxy.hookUrl, {
        messageDisplay: installedClaudeSupportsMessageDisplay(),
      });
      // Global option must precede a user-supplied `--`, positional prompt, or
      // subcommand; --plugin-dir itself is repeatable, so existing dirs remain.
      childArgs = withSessionNoticePluginArgs(childArgs, noticePlugin.dir);
    } catch (err) {
      // Notices are optional UI. A full/unwritable temp directory must never
      // prevent the underlying Claude session from launching.
      if (isDebugMode) {
        console.error(`[DEBUG] Notice plugin disabled: ${String(err)}`);
      }
    }
  }

  // Never set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY — Claude Code keeps its
  // native login and sends its own OAuth bearer to the local base URL.
  const child = spawn("claude", childArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
    },
    stdio: "inherit",
  });

  child.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Could not find 'claude' command. Make sure Claude Code is installed.");
    } else {
      console.error("Failed to start claude:", err.message);
    }
    noticePlugin?.close();
    scrubber.close();
    proxy.close();
    process.exit(1);
  });

  child.on("exit", (code: number | null) => {
    // Final in-place pass: the last turn's notice may have just been appended.
    void scrubber.flush().then(() => {
      noticePlugin?.close();
      scrubber.close();
      proxy.close();
      process.exit(code ?? 0);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
