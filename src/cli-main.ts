#!/usr/bin/env node

/**
 * Claude Code Infinite launcher (plans/2026-06-09_PLAN_local_proxy_app.md).
 *
 * Starts the local proxy on 127.0.0.1 and execs `claude` with
 * ANTHROPIC_BASE_URL pointed at it. Claude Code's automatic compaction is
 * disabled because MemTree owns context management; manual `/compact` remains
 * available. Auth is untouched by design ("mirror vanilla"):
 * Claude Code keeps its native login — token refresh, plan-default model
 * resolution, and limit handling behave exactly like vanilla — and its OAuth
 * token never leaves this machine. polychat.co only ever sees message content
 * for compression/indexing, authenticated by the user's MemTree API key.
 */

import spawn from "cross-spawn";
import { exec } from "node:child_process";
import * as readline from "node:readline";
import { MEMTREE_COMPACT_MIN_TOKENS, parseTokenCount, startProxy } from "./proxy.js";
import { MemtreeLinkStore } from "./memtree-links.js";
import { NewestTreeLookup } from "./memtree-newest.js";
import { ClaudeTranscriptUsage } from "./transcript-usage.js";
import {
  createSessionNoticePlugin,
  supportsMessageDisplay,
  terminalSupportsColor,
  withSessionNoticePluginArgs,
  type SessionNoticePlugin,
} from "./hooks.js";
import { CLIENT_NAME, CLIENT_VERSION, MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { startupNoticeText } from "./notices.js";
import {
  FALLBACK_SUBSCRIBE_URL,
  PAYMENT_GATE_PROMPT,
  formatPaymentNotice,
  parsePaymentChoice,
  parsePaymentStatus,
  type PaymentStatus,
  hyperlink,
} from "./payment-gate.js";
import { checkForUpdate } from "./update-check.js";
import {
  compactTargetFromEnv,
  isPrintInvocation,
  parseWrapperArgs,
  memtreeLinkPlacementFromEnv,
} from "./cli-args.js";
import { runMemtreeFetchCommand } from "./memtree-fetch.js";
import { runMemtreeMcpServer } from "./memtree-mcp.js";
import { readProjectMeta } from "./project-meta.js";
import {
  argsConfigureMemtreeMcp,
  MEMTREE_TOOLS_HEADER_VALUE,
  memtreeMcpEnabledByEnv,
  withMemtreeMcpArgs,
  writeMemtreeMcpConfig,
  type MemtreeMcpConfigFile,
} from "./memtree-mcp-config.js";
import {
  claudeChildEnv,
  claudeNativeOneMillionContextEnabled,
} from "./claude-env.js";
import {
  createSignalShutdownHandler,
  exitCodeForChild,
} from "./cli-lifecycle.js";
import {
  getPolychatApiKey,
  setPolychatApiKey,
  getLocalPolychatApiKey,
  setLocalPolychatApiKey,
  getStagingPolychatApiKey,
  setStagingPolychatApiKey,
} from "./config.js";
import { repairStrandedResume, resumeSessionId } from "./resume-repair.js";

// MemTree (polychat) API hosts — /v1/context_memory lives at the app root.
const POLYCHAT_BASE_URL = "https://api.polychat.co";
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
const LOCAL_BASE_URL = "http://localhost:8080";
const POLYCHAT_AUTH_URL = "https://polychat.co/auth?memtree=true";
const SHUTDOWN_PROXY_DRAIN_MS = 5_000;
const SHUTDOWN_MEMTREE_DRAIN_MS = 2_000;
const SHUTDOWN_LOG_FLUSH_MS = 2_000;
// Payment gate: how long "subscribe now" waits for the Stripe webhook to flip
// the key to paid, and how often it re-asks the status probe meanwhile.
const SUBSCRIBE_WAIT_MS = 180_000;
const SUBSCRIBE_POLL_MS = 3_000;

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

  // The label is a clickable link (OSC 8) where the terminal supports it, and
  // the URL is printed too, for other terminals and for opening it elsewhere.
  console.log(`\nGet your ${hyperlink("MemTree API key", url)}:\n  ${url}`);
  await new Promise<void>((resolve) => {
    rl.question(`\nPress Enter to open it in your browser...`, () => resolve());
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
 * Startup payment check: GET /v1/context_memory/status, so an unpaid key is
 * handled BEFORE the first degraded turn. The endpoint may not be deployed
 * yet — 404/405/401/503, network errors, timeouts and unexpected bodies all
 * mean "unknown" (null): the caller stays quiet. Bounded by a short timeout
 * and never throws, so startup is never gated on polychat availability.
 */
async function fetchPaymentStatus(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 2000
): Promise<PaymentStatus | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/context_memory/status`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-client": CLIENT_NAME,
        "x-client-version": CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parsePaymentStatus(await res.json());
  } catch {
    return null;
  }
}

/**
 * Interactive gate for an unpaid key. The TUI covers the terminal within a
 * second of launch, so a printed warning is never read; instead stop here
 * until the user picks: subscribe now (open the checkout link, then wait for
 * the webhook to flip the key to paid), use claude without MemTree (launch
 * uncompressed, the in-session notice still fires), or quit.
 */
async function runPaymentGate(
  status: PaymentStatus,
  recheck: () => Promise<PaymentStatus | null>
): Promise<void> {
  let current = status;
  for (;;) {
    console.warn(
      `\x1b[1;33m${formatPaymentNotice(current, { hyperlinks: true })}\x1b[0m\n`
    );
    const choice = parsePaymentChoice(await askLine(PAYMENT_GATE_PROMPT));
    if (choice === "quit") process.exit(0);
    if (choice === "continue") {
      console.log("\nStarting claude without MemTree.\n");
      return;
    }
    openUrl(current.url ?? FALLBACK_SUBSCRIBE_URL);
    console.log("\nOpened the subscribe page. Waiting for payment to complete…");
    const paid = await waitUntilPaid(recheck, SUBSCRIBE_WAIT_MS, SUBSCRIBE_POLL_MS);
    if (paid) {
      console.log("\x1b[1;32m✓ MemTree is on — thank you.\x1b[0m\n");
      return;
    }
    console.warn("\nStill unpaid.\n");
  }
}

/** Poll the status probe until it reports paid, or give up after `totalMs`. */
async function waitUntilPaid(
  recheck: () => Promise<PaymentStatus | null>,
  totalMs: number,
  everyMs: number
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    const status = await recheck();
    if (status?.paid === true) return true;
  }
  return false;
}

function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function printBanner() {
  console.log(
    `\n\x1b[38;5;209m∞\x1b[0m \x1b[1;38;5;209mClaude Code Infinite\x1b[0m \x1b[38;5;209m∞\x1b[0m \x1b[38;5;48mfrom \x1b]8;;https://MemTree.dev\x1b\\MemTree\x1b]8;;\x1b\\\x1b[0m\n`
  );
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
  const parsedArgs = parseWrapperArgs(process.argv.slice(2));
  const isDebugMode = parsedArgs.debug;
  const filteredArgs = parsedArgs.claudeArgs;

  // `ccc fetch <memtree-url>`: read one of the user's MemTree pages with the
  // stored key and print it. No proxy, no Claude — an agent's escape hatch
  // when it is not running inside a ccc session.
  if (filteredArgs[0] === "fetch") {
    process.exit(await runMemtreeFetchCommand(filteredArgs.slice(1)));
  }

  // `ccc memtree-mcp`: the `memtree` MCP server over stdio (memtree-mcp.ts),
  // for an --mcp-config a caller writes (e.g. the memory recall probe). It
  // reads the tree through the ccc proxy in its inherited ANTHROPIC_BASE_URL.
  if (filteredArgs[0] === "memtree-mcp") {
    runMemtreeMcpServer();
    return;
  }

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

  // Interactive UI only: print/non-TTY invocations are programmatic
  // interfaces whose output must stay byte-for-byte vanilla, and they get no
  // notice plugin to deliver a banner anyway.
  const interactiveUi =
    !isPrintInvocation(claudeArgs) &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true;

  // Check the key's payment status before claude takes over the terminal.
  // Bounded (2s) and null on error — startup never fails or hangs on polychat
  // availability. The npm update check runs concurrently under the same
  // bound; its result goes into the SessionStart banner below, since the TUI
  // covers this terminal within a second. Both resolve rather than reject, so
  // Promise.all cannot throw.
  // The project (directory, git repo, branch, commit) goes with every MemTree
  // call so sessions can be found by project; read once, never fails.
  const [paymentStatus, updateAvailable, projectMeta] = await Promise.all([
    fetchPaymentStatus(memtreeBaseUrl, polychatApiKey),
    checkForUpdate({ currentVersion: CLIENT_VERSION }),
    readProjectMeta(process.cwd()),
  ]);
  if (paymentStatus?.paid === false) {
    if (interactiveUi) {
      await runPaymentGate(paymentStatus, () =>
        fetchPaymentStatus(memtreeBaseUrl, polychatApiKey)
      );
    } else {
      console.warn(`\x1b[1;33m${formatPaymentNotice(paymentStatus)}\x1b[0m`);
    }
  }
  if (isDebugMode && updateAvailable) {
    console.log(
      `[DEBUG] Update available: ${updateAvailable.current} → ${updateAvailable.latest}`
    );
  }

  // Always-on request/timing log (reqlog.ts): messages, MemTree calls, and
  // successful notice claims, so incidents can be reconstructed after the
  // fact without --debug. Never blocks or throws.
  const reqlog = new RequestLogger();

  // The `memtree` MCP server (memtree-mcp-config.ts): registered by ccc for
  // interactive sessions unless CCC_MEMTREE_MCP=0; print/non-TTY runs have it
  // only when their own --mcp-config names it. Either way MemTree is told
  // (x-memtree-tools) only when the session really has the tools.
  const autoMemtreeMcp = interactiveUi && memtreeMcpEnabledByEnv(process.env);
  const memtreeToolsConfigured = autoMemtreeMcp || argsConfigureMemtreeMcp(claudeArgs);

  // Start the local proxy. Claude Code's OAuth token flows through it straight
  // to api.anthropic.com and never reaches polychat.co.
  const memtree = new MemtreeClient({
    baseUrl: memtreeBaseUrl,
    apiKey: polychatApiKey,
    debug: isDebugMode,
    reqlog,
    // Mutable below: a failed config write withdraws it before any call.
    memtreeTools: memtreeToolsConfigured ? MEMTREE_TOOLS_HEADER_VALUE : undefined,
  });
  const nativeOneMillionContext =
    claudeNativeOneMillionContextEnabled(process.env);
  const memtreeLinkPlacement = memtreeLinkPlacementFromEnv(process.env.CCC_MEMTREE_LINK);
  const transcriptUsage = new ClaudeTranscriptUsage();
  const proxy = await startProxy({
    memtree,
    debug: isDebugMode,
    reqlog,
    nativeOneMillionContext,
    // Kill switch for tool-turn COMPACTION only: CCC_TOOL_ROUTE_RECOVERY=0
    // makes tool turns pure passthrough — no size check, no compress call;
    // they ride their lane's route when one exists and otherwise go out whole
    // (with background indexing). Human turns keep compacting. It
    // deliberately does NOT revert classification-time clear gating or
    // same-session-only eviction of a rejected route, because those are what
    // stop a side request from stranding the tool loop.
    toolRouteRecovery: process.env.CCC_TOOL_ROUTE_RECOVERY !== "0",
    // Programs launched from inside Claude Code inherit ANTHROPIC_BASE_URL;
    // only Claude Code's own requests get MemTree. CCC_CLAUDE_CODE_ONLY=0
    // turns the filter off.
    claudeCodeOnly: process.env.CCC_CLAUDE_CODE_ONLY !== "0",
    defaultCompactTarget: defaultCompactTargetFromEnv(process.env.CCC_COMPACT_TARGET),
    // Debugging: write every forwarded Anthropic request body to this directory.
    ...(process.env.CCC_CAPTURE_DIR ? { captureDir: process.env.CCC_CAPTURE_DIR } : {}),
    // Test-only: a small budget so a cheap session crosses it in a few turns.
    budgetTokensOverride: budgetFromEnv(process.env.CCC_BUDGET_TOKENS),
    // CCC_MEMTREE_LINK=message|stop|success|off picks where the MemTree page
    // link is shown while the placement is being tried out; see ProxyOptions.
    memtreeLinkPlacement,
    memtreeLinkStore: new MemtreeLinkStore(),
    // The link shown to the user follows the session's newest tree on the server.
    newestTrees: new NewestTreeLookup((path, signal) =>
      memtree.fetchMemTree(path, "application/json", signal)
    ),
    transcriptUsage,
    projectMeta,
  });

  // One unobtrusive (dim) line so users can find the log during an incident.
  console.log(`\x1b[2mRequest log: ${reqlog.path}\x1b[0m\n`);
  reportStrandedResumeRepair(claudeArgs, nativeOneMillionContext);
  // The first request after a resume must count the whole session's thinking.
  const resumedSession = resumeSessionId(claudeArgs);
  if (resumedSession !== undefined) transcriptUsage.catchUp(resumedSession);

  if (isDebugMode) {
    console.log(`[DEBUG] Local proxy listening on http://127.0.0.1:${proxy.port}`);
    console.log(`[DEBUG] MemTree API: ${memtreeBaseUrl}`);
    console.log(
      `[DEBUG] Claude Code auto-compaction: ${
        process.env.CCC_AUTO_COMPACT === "1"
          ? "native setting (CCC_AUTO_COMPACT=1)"
          : "disabled by ccc"
      }`
    );
    console.log(
      `[DEBUG] Claude Code native 1M context: ${
        nativeOneMillionContext
          ? "enabled through trusted localhost relay"
          : "disabled by CLAUDE_CODE_DISABLE_1M_CONTEXT"
      }`
    );
  }

  // Interactive notices are provided by a minimal, ephemeral plugin. Prepending
  // --plugin-dir composes with user hooks/settings; adding another --settings
  // would not, because Claude keeps only its final --settings occurrence.
  // Print/non-TTY calls are programmatic interfaces: omit all UI hooks so their
  // stdout/events remain byte-for-byte vanilla.
  let noticePlugin: SessionNoticePlugin | null = null;
  let childArgs = [...claudeArgs];
  if (interactiveUi) {
    try {
      noticePlugin = createSessionNoticePlugin(proxy.hookUrl, {
        messageDisplay: installedClaudeSupportsMessageDisplay(),
        startupMessage: startupNoticeText(terminalSupportsColor(), updateAvailable),
        resumeLink: memtreeLinkPlacement !== "off",
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

  let memtreeMcpConfig: MemtreeMcpConfigFile | null = null;
  if (autoMemtreeMcp) {
    try {
      memtreeMcpConfig = writeMemtreeMcpConfig(`http://127.0.0.1:${proxy.port}`);
      childArgs = withMemtreeMcpArgs(childArgs, memtreeMcpConfig.path);
    } catch (err) {
      // Optional like the notice plugin; without it MemTree must not name
      // tools the session lacks.
      if (!argsConfigureMemtreeMcp(claudeArgs)) memtree.setMemtreeTools(undefined);
      if (isDebugMode) {
        console.error(`[DEBUG] MemTree MCP server disabled: ${String(err)}`);
      }
    }
  }

  // Never set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY — Claude Code keeps its
  // native login and sends its own OAuth bearer to the local base URL.
  const child = spawn("claude", childArgs, {
    env: claudeChildEnv(
      process.env,
      `http://127.0.0.1:${proxy.port}`
    ),
    stdio: "inherit",
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    noticePlugin?.close();
    memtreeMcpConfig?.close();
    // Stop new proxy work and give active handlers a bounded chance to
    // finalize their records. Background indexing is a separate log producer:
    // stop and drain it too before waiting for scheduled JSONL appends on
    // disk.
    await proxy.drain(SHUTDOWN_PROXY_DRAIN_MS);
    await memtree.drainBackground(SHUTDOWN_MEMTREE_DRAIN_MS);
    await reqlog.flush(SHUTDOWN_LOG_FLUSH_MS);
    process.exit(code);
  };

  const handleShutdownSignal = createSignalShutdownHandler({
    forward: (signal) => {
      // A terminal normally signals the whole foreground process group, while
      // `kill <ccc-pid>` reaches only this wrapper. Forwarding covers the
      // latter; duplicate delivery to Claude is harmless.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the state check and kill().
      }
    },
    shutdown: (code) => void shutdown(code),
    // A second signal is an explicit escape hatch from bounded cleanup.
    forceExit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));

  child.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Could not find 'claude' command. Make sure Claude Code is installed.");
    } else {
      console.error("Failed to start claude:", err.message);
    }
    void shutdown(1);
  });

  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    void shutdown(exitCodeForChild(code, signal));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


/** `CCC_COMPACT_TARGET` ("500k", "20000", "off"): see cli-args.ts. */
/**
 * A resumed session whose last response was recorded past Claude Code's limit
 * would refuse every prompt; lower that record first (resume-repair.ts).
 * Never blocks the launch.
 */
function reportStrandedResumeRepair(claudeArgs: string[], nativeOneMillionContext: boolean) {
  try {
    const repair = repairStrandedResume(claudeArgs, { nativeOneMillionContext });
    if (!repair) return;
    const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
    console.log(
      `\x1b[2mThis session last recorded ${k(repair.recordedTokens)} tokens, past Claude ` +
        `Code's limit; lowered to ${k(repair.loweredTokens)} so MemTree can compress the ` +
        `next message. Backup: ${repair.backupPath}\x1b[0m\n`
    );
  } catch (err) {
    console.error(`\x1b[2mCould not check the resumed session's size: ${String(err)}\x1b[0m`);
  }
}

function defaultCompactTargetFromEnv(raw: string | undefined): number | null | undefined {
  const { value, warning } = compactTargetFromEnv(raw, parseTokenCount, MEMTREE_COMPACT_MIN_TOKENS);
  if (warning) console.error(warning);
  return value;
}

/** `CCC_BUDGET_TOKENS` ("60k"): a test-only whole-request budget, or undefined. */
function budgetFromEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const budget = parseTokenCount(raw);
  if (budget === undefined || budget < 2 * MEMTREE_COMPACT_MIN_TOKENS) {
    console.error(
      `ccc: ignoring CCC_BUDGET_TOKENS=${raw} (use a token count of at least ${(2 * MEMTREE_COMPACT_MIN_TOKENS) / 1000}k)`
    );
    return undefined;
  }
  return budget;
}
