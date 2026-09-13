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
import { startProxy } from "./proxy.js";
import { createSessionNoticePlugin, supportsMessageDisplay, terminalSupportsColor, withSessionNoticePluginArgs, } from "./hooks.js";
import { CLIENT_NAME, CLIENT_VERSION, MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { sanitizeNoticeDetail, startupNoticeText } from "./notices.js";
import { checkForUpdate } from "./update-check.js";
import { isPrintInvocation, parseWrapperArgs } from "./cli-args.js";
import { claudeChildEnv, claudeNativeOneMillionContextEnabled, } from "./claude-env.js";
import { createSignalShutdownHandler, exitCodeForChild, } from "./cli-lifecycle.js";
import { getPolychatApiKey, setPolychatApiKey, getLocalPolychatApiKey, setLocalPolychatApiKey, getStagingPolychatApiKey, setStagingPolychatApiKey, } from "./config.js";
// MemTree (polychat) API hosts — /v1/context_memory lives at the app root.
const POLYCHAT_BASE_URL = "https://api.polychat.co";
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
const LOCAL_BASE_URL = "http://localhost:8080";
const POLYCHAT_AUTH_URL = "https://polychat.co/auth?memtree=true";
const SHUTDOWN_PROXY_DRAIN_MS = 5_000;
const SHUTDOWN_MEMTREE_DRAIN_MS = 2_000;
const SHUTDOWN_LOG_FLUSH_MS = 2_000;
function openUrl(url) {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
    platform === "win32"
        ? exec(`${command} "${url}"`, { shell: "cmd.exe" })
        : exec(`${command} "${url}"`);
}
async function promptForApiKey(mode) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const url = mode === "local"
        ? "http://local.polychat.co:5173/memtree-api"
        : POLYCHAT_AUTH_URL;
    await new Promise((resolve) => {
        rl.question(`\nPress Enter to open your browser to obtain your Memtree API key...`, () => resolve());
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
async function warnIfUnpaid(baseUrl, apiKey) {
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/context_memory/status`, {
            headers: {
                authorization: `Bearer ${apiKey}`,
                "x-client": CLIENT_NAME,
                "x-client-version": CLIENT_VERSION,
            },
            signal: AbortSignal.timeout(2000),
        });
        if (!res.ok)
            return;
        const status = (await res.json());
        if (status?.paid === false) {
            console.warn("\x1b[1;33m⚠ MemTree is off — payment required (compression + indexing disabled)." +
                " Visit polychat.co to enable.\x1b[0m" +
                (status.payment_message
                    ? `\n${sanitizeNoticeDetail(status.payment_message)}`
                    : ""));
        }
    }
    catch {
        // status unknown (endpoint missing, network, timeout, bad JSON) — stay quiet
    }
}
function printBanner() {
    console.log(`\n\x1b[38;5;209m∞\x1b[0m \x1b[1;38;5;209mClaude Code Infinite\x1b[0m \x1b[38;5;209m∞\x1b[0m \x1b[38;5;48mfrom \x1b]8;;https://MemTree.dev\x1b\\MemTree\x1b]8;;\x1b\\\x1b[0m\n`);
}
/** Unknown/old versions get the longstanding Stop fallback only. */
function installedClaudeSupportsMessageDisplay() {
    try {
        const result = spawn.sync("claude", ["--version"], { encoding: "utf-8" });
        return supportsMessageDisplay(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
    catch {
        return false;
    }
}
async function main() {
    const parsedArgs = parseWrapperArgs(process.argv.slice(2));
    const isDebugMode = parsedArgs.debug;
    const filteredArgs = parsedArgs.claudeArgs;
    const mode = filteredArgs[0] === "local" ? "local" :
        filteredArgs[0] === "staging" ? "staging" :
            "production";
    const claudeArgs = mode !== "production" ? filteredArgs.slice(1) : filteredArgs;
    printBanner();
    if (isDebugMode) {
        console.log("\x1b[1;36m🔍 DEBUG MODE\x1b[0m\n");
    }
    if (mode === "local") {
        console.log("\x1b[1;33m🏠 LOCAL MODE\x1b[0m\n");
    }
    else if (mode === "staging") {
        console.log("\x1b[1;35m🚧 STAGING MODE\x1b[0m\n");
    }
    // Get or prompt for the MemTree API key (separate keys per environment)
    let polychatApiKey = mode === "local" ? getLocalPolychatApiKey() :
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
        }
        else if (mode === "staging") {
            setStagingPolychatApiKey(polychatApiKey);
        }
        else {
            setPolychatApiKey(polychatApiKey);
        }
        console.log("API key saved.\n");
    }
    const memtreeBaseUrl = mode === "local" ? LOCAL_BASE_URL :
        mode === "staging" ? STAGING_BASE_URL :
            POLYCHAT_BASE_URL;
    // Warn about an unpaid key before claude takes over the terminal. Awaited so
    // the warning can't corrupt the TUI, but bounded (2s) and silent on error —
    // startup never fails or hangs on polychat availability. The npm update
    // check runs concurrently under the same bound; its result goes into the
    // SessionStart banner below, since the TUI covers this terminal within a
    // second. Both resolve rather than reject, so Promise.all cannot throw.
    const [, updateAvailable] = await Promise.all([
        warnIfUnpaid(memtreeBaseUrl, polychatApiKey),
        checkForUpdate({ currentVersion: CLIENT_VERSION }),
    ]);
    if (isDebugMode && updateAvailable) {
        console.log(`[DEBUG] Update available: ${updateAvailable.current} → ${updateAvailable.latest}`);
    }
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
    const nativeOneMillionContext = claudeNativeOneMillionContextEnabled(process.env);
    // Interactive UI only: print/non-TTY invocations are programmatic
    // interfaces whose output must stay byte-for-byte vanilla, and they get no
    // notice plugin to deliver a banner anyway.
    const interactiveUi = !isPrintInvocation(claudeArgs) &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true;
    const proxy = await startProxy({
        memtree,
        debug: isDebugMode,
        reqlog,
        nativeOneMillionContext,
        // Temporary kill switch for tool-route miss RECOVERY only
        // (plans/2026-08-04_PLAN_tool_turn_route_recovery.md): set
        // CCC_TOOL_ROUTE_RECOVERY=0 and relaunch to skip the blocking
        // recompression attempt and forward missed tool turns verbatim with
        // background indexing, as before. It deliberately does NOT revert the
        // other half of that change: classification-time clear gating and
        // same-session-only eviction of a rejected route stay in force, because
        // those are what stop a side request from stranding the tool loop.
        toolRouteRecovery: process.env.CCC_TOOL_ROUTE_RECOVERY !== "0",
    });
    // One unobtrusive (dim) line so users can find the log during an incident.
    console.log(`\x1b[2mRequest log: ${reqlog.path}\x1b[0m\n`);
    if (isDebugMode) {
        console.log(`[DEBUG] Local proxy listening on http://127.0.0.1:${proxy.port}`);
        console.log(`[DEBUG] MemTree API: ${memtreeBaseUrl}`);
        console.log(`[DEBUG] Claude Code auto-compaction: ${process.env.CCC_AUTO_COMPACT === "1"
            ? "native setting (CCC_AUTO_COMPACT=1)"
            : "disabled by ccc"}`);
        console.log(`[DEBUG] Claude Code native 1M context: ${nativeOneMillionContext
            ? "enabled through trusted localhost relay"
            : "disabled by CLAUDE_CODE_DISABLE_1M_CONTEXT"}`);
    }
    // Interactive notices are provided by a minimal, ephemeral plugin. Prepending
    // --plugin-dir composes with user hooks/settings; adding another --settings
    // would not, because Claude keeps only its final --settings occurrence.
    // Print/non-TTY calls are programmatic interfaces: omit all UI hooks so their
    // stdout/events remain byte-for-byte vanilla.
    let noticePlugin = null;
    let childArgs = [...claudeArgs];
    if (interactiveUi) {
        try {
            noticePlugin = createSessionNoticePlugin(proxy.hookUrl, {
                messageDisplay: installedClaudeSupportsMessageDisplay(),
                startupMessage: startupNoticeText(terminalSupportsColor(), updateAvailable),
            });
            // Global option must precede a user-supplied `--`, positional prompt, or
            // subcommand; --plugin-dir itself is repeatable, so existing dirs remain.
            childArgs = withSessionNoticePluginArgs(childArgs, noticePlugin.dir);
        }
        catch (err) {
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
        env: claudeChildEnv(process.env, `http://127.0.0.1:${proxy.port}`),
        stdio: "inherit",
    });
    let shuttingDown = false;
    const shutdown = async (code) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        noticePlugin?.close();
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
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            try {
                child.kill(signal);
            }
            catch {
                // The child may have exited between the state check and kill().
            }
        },
        shutdown: (code) => void shutdown(code),
        // A second signal is an explicit escape hatch from bounded cleanup.
        forceExit: (code) => process.exit(code),
    });
    process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
    process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
    child.on("error", (err) => {
        if (err.code === "ENOENT") {
            console.error("Could not find 'claude' command. Make sure Claude Code is installed.");
        }
        else {
            console.error("Failed to start claude:", err.message);
        }
        void shutdown(1);
    });
    child.on("exit", (code, signal) => {
        void shutdown(exitCodeForChild(code, signal));
    });
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map