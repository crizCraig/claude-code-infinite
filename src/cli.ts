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
import { MemtreeClient } from "./memtree.js";
import {
  projectTranscriptDir,
  startTranscriptScrubber,
  sweepTranscripts,
} from "./scrub.js";
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

function printBanner() {
  console.log(
    `\n\x1b[1;38;5;209mClaude Code Infinite:\x1b[0m \x1b[38;5;48mMaximizing Claude's intelligence with context-management from \x1b]8;;https://MemTree.dev\x1b\\MemTree.dev\x1b]8;;\x1b\\\x1b[0m\n`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const isDebugMode = args.includes("--debug");
  const filteredArgs = args.filter((arg) => arg !== "--debug");

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

  // Start the local proxy. Claude Code's OAuth token flows through it straight
  // to api.anthropic.com and never reaches polychat.co.
  const memtree = new MemtreeClient({
    baseUrl: memtreeBaseUrl,
    apiKey: polychatApiKey,
    debug: isDebugMode,
  });
  const proxy = await startProxy({ memtree, debug: isDebugMode });

  if (isDebugMode) {
    console.log(`[DEBUG] Local proxy listening on http://127.0.0.1:${proxy.port}`);
    console.log(`[DEBUG] MemTree API: ${memtreeBaseUrl}`);
  }

  // Transcript scrubbing: injected inline notices are ephemeral — remove them
  // from CC's saved .jsonl continuously (watcher) with sweeps as backstop, so
  // resumes/forks are clean under both ccc and vanilla claude.
  //
  // Sweeps skip recently-modified transcripts: a concurrent ccc/claude session
  // in this project may be appending to one, and the sweep's rewrite+rename
  // would swap the inode under its open append handle and lose its remaining
  // history. We can't identify our own session's transcript (claude picks the
  // session id itself), so the guard applies to the exit sweep too — the
  // watcher's in-place patches have already scrubbed the live file, and a
  // later sweep drops any leftover padding once it goes quiet.
  const sweepSkipRecentMs = 5 * 60 * 1000;
  const transcriptDir = projectTranscriptDir(process.cwd());
  await sweepTranscripts(transcriptDir, {
    debug: isDebugMode,
    skipRecentMs: sweepSkipRecentMs,
  }).catch(() => 0);
  const scrubber = startTranscriptScrubber(transcriptDir, { debug: isDebugMode });

  // Never set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY — Claude Code keeps its
  // native login and sends its own OAuth bearer to the local base URL.
  const child = spawn("claude", claudeArgs, {
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
    scrubber.close();
    proxy.close();
    process.exit(1);
  });

  child.on("exit", (code: number | null) => {
    scrubber.close();
    // Exit sweep: our child has exited, but other sessions in this project may
    // still be appending — keep the recent-mtime guard (see above).
    void sweepTranscripts(transcriptDir, {
      debug: isDebugMode,
      skipRecentMs: sweepSkipRecentMs,
    })
      .catch(() => 0)
      .then(() => {
        proxy.close();
        process.exit(code ?? 0);
      });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
