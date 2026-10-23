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
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { MEMTREE_COMPACT_MIN_TOKENS, parseTokenCount, startProxy } from "./proxy.js";
import { MemtreeLinkStore } from "./memtree-links.js";
import { FirstTreeMarker } from "./first-tree.js";
import { StablePrefixStore } from "./prefix-store.js";
import { NewestTreeLookup } from "./memtree-newest.js";
import { ClaudeTranscriptUsage } from "./transcript-usage.js";
import { createSessionNoticePlugin, supportsMessageDisplay, terminalSupportsColor, withSessionNoticePluginArgs, } from "./hooks.js";
import { CLIENT_NAME, CLIENT_VERSION, MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { memtreeOffNoticeText, startupNoticeText, updateInstalledNoticeText, updateNoticeText, } from "./notices.js";
import { FALLBACK_SUBSCRIBE_URL, MEMTREE_OFF_LINE, PRINT_PAUSED_LINE, RESUMED_PAUSED_LINE, formatPaymentNotice, parsePaymentChoice, paymentGatePrompt, hyperlink, } from "./payment-gate.js";
import { PaymentLinkCache, fetchPaymentLink } from "./payment-link.js";
import { resumesSession, runWithoutMemtree } from "./paused-session.js";
import { KEY_PAGE_URL, LOCAL_KEY_PAGE_URL, fetchKeyStatus, keyPageUrl, resolveInvalidKey, } from "./key-status.js";
import { UPDATE_CHECK_CACHE_FILE, checkForUpdate } from "./update-check.js";
import { setupAutoUpdate } from "./auto-update-setup.js";
import { compactTargetFromEnv, isPrintInvocation, parseWrapperArgs, memtreeLinkPlacementFromEnv, environmentOf, isVersionRequest, subcommandArgs, } from "./cli-args.js";
import { routeConsoleToStderr } from "./cli-output.js";
import { runMemtreeFetchCommand } from "./memtree-fetch.js";
import { runLinkCommand } from "./link-command.js";
import { runMemtreeMcpServer } from "./memtree-mcp.js";
import { readProjectMeta } from "./project-meta.js";
import { projectTreesHintFor } from "./project-trees.js";
import { planMemtreeMcp, withMemtreeMcpArgs, writeMemtreeMcpConfig, } from "./memtree-mcp-config.js";
import { claudeChildEnv, claudeNativeOneMillionContextEnabled, } from "./claude-env.js";
import { createSignalShutdownHandler, claudeExitFields, exitCodeForChild, settleWithin, writeStdout, } from "./cli-lifecycle.js";
import { getPolychatApiKey, setPolychatApiKey, getLocalPolychatApiKey, setLocalPolychatApiKey, getStagingPolychatApiKey, setStagingPolychatApiKey, getConfigDir, loadConfig, } from "./config.js";
import { repairStrandedResume, resumeSessionId } from "./resume-repair.js";
import { Diagnostics, DiagnosticsRequestSink, recordError } from "./diagnostics.js";
import { PACKAGE_DIR, detectInstallMethod, takeUnreportedOutcome, updateFiles, } from "./auto-update.js";
import { claudeDesktopInstalled, claudeDesktopOnlyText, claudeMissingText, cwdHintText, locateClaude, withClaudeOnPath, } from "./claude-locate.js";
import { INSTALL_PROMPT_ENV, offerClaudeInstall, runInstaller } from "./claude-install.js";
import { RateLimitNotices, rateLimitNoticeText } from "./rate-limit.js";
import { apiKeyOverride, claudeAuthFromConfig, claudePlanFromConfig, claudeSubscriptionLogin, creditNoticeText, envApiKeySet, } from "./claude-auth.js";
import { CreditRefusalMemory, creditAdviceApplies, isInfoOnlyRun, printStartupSignInLines, readSeenClaudeAuth, writeSeenClaudeAuth, } from "./claude-plan-warning.js";
import { exitResumeHint } from "./resume-hint.js";
// MemTree (polychat) API hosts — /v1/context_memory lives at the app root.
const POLYCHAT_BASE_URL = "https://api.polychat.co";
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
const LOCAL_BASE_URL = "http://localhost:8080";
const SHUTDOWN_PROXY_DRAIN_MS = 5_000;
const SHUTDOWN_MEMTREE_DRAIN_MS = 2_000;
const SHUTDOWN_LOG_FLUSH_MS = 2_000;
/** Shutdown's wait for the child's exit and the resume hint's (asynchronous) write. */
const SHUTDOWN_OUTPUT_FLUSH_MS = 1_000;
// Payment gate: how long "subscribe now" waits for the Stripe webhook to flip
// the key to paid, and how often it re-asks the status probe meanwhile.
const SUBSCRIBE_WAIT_MS = 180_000;
const SUBSCRIBE_POLL_MS = 3_000;
/** This launch's diagnostics, for the top-level error handler. */
let activeDiagnostics = null;
function openUrl(url) {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
    platform === "win32"
        ? exec(`${command} "${url}"`, { shell: "cmd.exe" })
        : exec(`${command} "${url}"`);
}
async function promptForApiKey(mode, output) {
    const rl = readline.createInterface({ input: process.stdin, output });
    const url = mode === "local" ? LOCAL_KEY_PAGE_URL : KEY_PAGE_URL;
    // The label is a clickable link (OSC 8) where the terminal supports it, and
    // the URL is printed too, for other terminals and for opening it elsewhere.
    console.log(`\nGet your ${hyperlink("MemTree API key", url)}:\n  ${url}`);
    await new Promise((resolve) => {
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
 * The startup check said the key is invalid (401/403): interactive runs get
 * the paste-a-new-key gate (q quits, c carries on without MemTree, like the
 * payment gate); print/non-TTY runs get one line on stderr and carry on.
 * Anything else passes through unchanged.
 */
async function handleInvalidKey(check, ctx) {
    if (check === "invalid" && ctx.interactive)
        ctx.diagnostics.flushNow(); // may quit at the gate
    const color = terminalSupportsColor();
    const result = await resolveInvalidKey(check, ctx.apiKey, {
        interactive: ctx.interactive,
        command: ctx.mode === "production" ? "ccc" : `ccc ${ctx.mode}`,
        keyPageUrl: keyPageUrl(ctx.baseUrl),
        // console.log is routed to stderr (uncoloured off a terminal) in print/non-TTY runs.
        stderrLine: (text) => console.log(text),
        ask: askLine,
        open: openUrl,
        warn: (text) => console.warn(color ? `\x1b[1;33m${text}\x1b[0m` : text),
        say: (text) => console.log(text),
        check: (apiKey) => fetchKeyStatus(ctx.baseUrl, apiKey, { diagnostics: ctx.diagnostics }),
        saveKey: (apiKey) => saveApiKey(ctx.mode, apiKey, ctx.diagnostics),
    });
    if (result === "quit") {
        await ctx.diagnostics.flush();
        process.exit(0);
    }
    return result;
}
/** Save `apiKey` as this environment's key; diagnostics now go by it. */
function saveApiKey(mode, apiKey, diagnostics) {
    diagnostics.record("key_saved");
    diagnostics.setApiKey(apiKey);
    if (mode === "local")
        setLocalPolychatApiKey(apiKey);
    else if (mode === "staging")
        setStagingPolychatApiKey(apiKey);
    else
        setPolychatApiKey(apiKey);
}
/** The payment status in a key check; null when the key is invalid or unknown. */
function paymentOnly(check) {
    return check === "invalid" ? null : check;
}
/**
 * Interactive gate for an unpaid key. The TUI covers the terminal within a
 * second of launch, so a printed warning is never read; instead stop here
 * until the user picks: subscribe now (open the short checkout link, then wait
 * for the webhook to flip the key to paid), continue without MemTree (plain
 * Claude Code for this session), or quit. Resolves true when MemTree is on.
 */
async function runPaymentGate(status, recheck, links, diagnostics, resumed) {
    const color = terminalSupportsColor();
    for (;;) {
        const link = await links.get();
        console.warn(`\n${formatPaymentNotice(status, { hyperlinks: true, color, link })}`);
        const choice = parsePaymentChoice(await askLine(paymentGatePrompt(link)));
        diagnostics.record("payment_gate", { choice });
        if (choice === "quit") {
            await diagnostics.flush();
            process.exit(0);
        }
        if (choice === "continue") {
            console.log(`\n${resumed ? RESUMED_PAUSED_LINE : MEMTREE_OFF_LINE}\n`);
            return false;
        }
        // A link left on screen past its hour is replaced before it is opened.
        openUrl((await links.get())?.url ?? status.url ?? FALLBACK_SUBSCRIBE_URL);
        console.log("\nOpened the subscribe page. Waiting for payment to complete…");
        const paid = await waitUntilPaid(recheck, SUBSCRIBE_WAIT_MS, SUBSCRIBE_POLL_MS);
        diagnostics.record("payment_gate", { choice: paid ? "paid" : "still_unpaid" });
        if (paid) {
            console.log("\x1b[1;32m✓ MemTree is on — thank you.\x1b[0m\n");
            return true;
        }
        console.warn("\nStill unpaid.");
    }
}
/** Poll the status probe until it reports paid, or give up after `totalMs`. */
async function waitUntilPaid(recheck, totalMs, everyMs) {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        const status = await recheck();
        if (status?.paid === true)
            return true;
    }
    return false;
}
/**
 * Claude Code isn't installed: offer to install it when someone can answer
 * (claude-install.ts), else say how. Null when it is still not installed.
 */
async function installMissingClaude(desktopOnly, interactiveUi, diagnostics) {
    diagnostics.record("claude_missing");
    const canAsk = interactiveUi || process.env[INSTALL_PROMPT_ENV] === "1";
    if (!canAsk) {
        console.error(desktopOnly ? claudeDesktopOnlyText() : claudeMissingText());
        return null;
    }
    // A forced prompt without a terminal (CI) keeps stdout for Claude Code.
    const out = interactiveUi ? process.stdout : process.stderr;
    const claude = await offerClaudeInstall({
        canAsk, desktopOnly,
        ask: (question) => askAnswer(question, out),
        runInstaller: (installer) => runInstaller(installer, out === process.stderr),
        locate: () => locateClaude(),
        print: (text) => out.write(`${text}\n`),
        record: (name, fields) => diagnostics.record(name, fields),
        flushNow: () => diagnostics.flushNow(),
    });
    if (claude)
        diagnostics.setContext({ claude_found: claude.source });
    return claude;
}
/** One typed line, or null when stdin ends or Ctrl+C is pressed first. */
function askAnswer(question, output) {
    const rl = readline.createInterface({ input: process.stdin, output });
    return new Promise((resolve) => {
        let answered = false;
        rl.on("close", () => {
            if (!answered)
                resolve(null);
        });
        rl.on("SIGINT", () => rl.close());
        rl.question(question, (answer) => {
            answered = true;
            rl.close();
            resolve(answer);
        });
    });
}
function askLine(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
function printBanner() {
    console.log(`\n\x1b[38;5;209m∞\x1b[0m \x1b[1;38;5;209mClaude Code Infinite\x1b[0m \x1b[38;5;209m∞\x1b[0m \x1b[38;5;48mfrom \x1b]8;;https://MemTree.dev\x1b\\MemTree\x1b]8;;\x1b\\\x1b[0m\n`);
}
/**
 * `ccc --version`: ccc's version, then Claude Code's (its own `--version` line) when it is
 * installed, else how to install it. Needs no key, so it never prompts for one.
 */
function printVersions() {
    console.log(`${CLIENT_VERSION} (Claude Code Infinite)`);
    const claude = locateClaude();
    if (!claude) {
        console.error(claudeDesktopInstalled() ? claudeDesktopOnlyText() : claudeMissingText());
        return;
    }
    spawn.sync(claude.command, ["--version"], { stdio: "inherit" });
}
/** Unknown/old versions get the longstanding Stop fallback only. */
function installedClaudeSupportsMessageDisplay(command) {
    try {
        const result = spawn.sync(command, ["--version"], { encoding: "utf-8" });
        return supportsMessageDisplay(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
    catch {
        return false;
    }
}
/** `ccc link` in this environment: its server, its saved key, real stdio. */
function linkDeps(mode) {
    return {
        fetch: globalThis.fetch,
        baseUrl: mode === "local" ? LOCAL_BASE_URL : mode === "staging" ? STAGING_BASE_URL : POLYCHAT_BASE_URL,
        apiKey: mode === "local" ? getLocalPolychatApiKey() :
            mode === "staging" ? getStagingPolychatApiKey() :
                getPolychatApiKey(),
        command: mode === "production" ? "ccc" : `ccc ${mode}`,
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
    };
}
async function main() {
    const parsedArgs = parseWrapperArgs(process.argv.slice(2));
    const isDebugMode = parsedArgs.debug;
    const filteredArgs = parsedArgs.claudeArgs;
    // `ccc fetch <memtree-url>`: read one of the user's MemTree pages with the
    // stored key and print it. No proxy, no Claude — an agent's escape hatch
    // when it is not running inside a ccc session.
    // `ccc memtree-mcp`: the `memtree` MCP server over stdio (memtree-mcp.ts),
    // for an --mcp-config a caller writes (e.g. the memory recall probe). It
    // reads the tree through the ccc proxy in its inherited ANTHROPIC_BASE_URL.
    // Both also follow `local`/`staging`, whose proxy the base URL already is.
    const subcommand = subcommandArgs(filteredArgs);
    if (subcommand?.name === "fetch") {
        process.exit(await runMemtreeFetchCommand(subcommand.args));
    }
    if (subcommand?.name === "memtree-mcp") {
        runMemtreeMcpServer();
        return;
    }
    if (isVersionRequest(filteredArgs)) {
        printVersions();
        return;
    }
    const mode = environmentOf(filteredArgs);
    // `ccc [staging|local] link <session-id>`: the session's newest MemTree page.
    if (subcommand?.name === "link") {
        // exitCode, not exit(): a piped stdout (async on macOS) gets its line out first.
        process.exitCode = await runLinkCommand(subcommand.args, linkDeps(mode));
        return;
    }
    const claudeArgs = mode !== "production" ? filteredArgs.slice(1) : filteredArgs;
    // Interactive UI only: print/non-TTY invocations are programmatic
    // interfaces whose output must stay byte-for-byte vanilla, and they get no
    // notice plugin to deliver a banner anyway. Their stdout is Claude's alone:
    // ccc's own lines (banner, mode, request log, debug) go to stderr.
    const interactiveUi = !isPrintInvocation(claudeArgs) &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true;
    if (!interactiveUi)
        routeConsoleToStderr();
    printBanner();
    const cwdTip = interactiveUi ? cwdHintText(process.cwd()) : null;
    if (cwdTip)
        console.log(`\x1b[2m${cwdTip}\x1b[0m\n`);
    if (isDebugMode) {
        console.log("\x1b[1;36m🔍 DEBUG MODE\x1b[0m\n");
    }
    if (mode === "local") {
        console.log("\x1b[1;33m🏠 LOCAL MODE\x1b[0m\n");
    }
    else if (mode === "staging") {
        console.log("\x1b[1;35m🚧 STAGING MODE\x1b[0m\n");
    }
    // CCC_LOCAL_BASE_URL: local mode's server elsewhere than :8080 (tests use a free port).
    const memtreeBaseUrl = mode === "local" ? (process.env.CCC_LOCAL_BASE_URL || LOCAL_BASE_URL) :
        mode === "staging" ? STAGING_BASE_URL :
            POLYCHAT_BASE_URL;
    // Get or prompt for the MemTree API key (separate keys per environment)
    let polychatApiKey = mode === "local" ? getLocalPolychatApiKey() :
        mode === "staging" ? getStagingPolychatApiKey() :
            getPolychatApiKey();
    // Client diagnostics (diagnostics.ts): versions, OS and errors, never content.
    // Started before the key prompt so a signup that stalls there is visible too.
    const diagnostics = startDiagnostics(mode, memtreeBaseUrl, polychatApiKey);
    // Before the key prompt: someone without Claude Code learns that first.
    const found = locateClaude();
    // Only the desktop app (its Claude Code is not a terminal command) gets its own message.
    const desktopOnly = !found && claudeDesktopInstalled();
    // One read each of Claude Code's config files (~/.claude.json can be large).
    const readFile = memoizedTextReader();
    const claudeSignIn = {
        auth: claudeAuthFromConfig({ readFile }),
        plan: claudePlanFromConfig({ readFile }),
        seen: readSeenClaudeAuth(getConfigDir()),
        subscriptionLogin: claudeSubscriptionLogin({ readFile }),
    };
    diagnostics.setContext({
        claude_found: desktopOnly ? "desktop_only" : found?.source,
        claude_auth: claudeSignIn.auth,
        claude_plan: claudeSignIn.plan,
        env_api_key_set: envApiKeySet(),
    });
    // Not installed: offered in a terminal (claude-install.ts), else how to install it.
    const claude = found ?? await installMissingClaude(desktopOnly, interactiveUi, diagnostics);
    if (!claude) {
        await diagnostics.flush();
        process.exit(1);
    }
    if (isDebugMode)
        console.log(`[DEBUG] Claude Code: ${claude.command} (${claude.source})`);
    if (!polychatApiKey) {
        diagnostics.record("sign_in_prompt");
        // The user may quit at the prompt: send what is known now.
        diagnostics.flushNow();
        // Only a terminal can answer; a print run's stdout stays Claude's.
        polychatApiKey = process.stdin.isTTY === true
            ? await promptForApiKey(mode, interactiveUi ? process.stdout : process.stderr)
            : undefined;
        if (!polychatApiKey) {
            console.error("A MemTree API key is required: run `ccc` in a terminal once to save one.");
            await diagnostics.flush();
            process.exit(1);
        }
        saveApiKey(mode, polychatApiKey, diagnostics);
        console.log("API key saved.\n");
    }
    // Check the key (valid? paid?) before claude takes over the terminal.
    // Bounded (2s) and null on error — startup never fails or hangs on polychat
    // availability. The npm update check runs concurrently under the same
    // bound (1.5s, and usually answered from a day-long cache); its result goes
    // into the SessionStart banner below, since the TUI covers this terminal
    // within a second. Print/non-TTY runs have no banner, so they skip it. Both
    // resolve rather than reject, so Promise.all cannot throw.
    // The project (directory, git repo, branch, commit) goes with every MemTree
    // call so sessions can be found by project; read once, never fails.
    const config = loadConfig();
    const [keyCheck, updateAvailable, projectMeta] = await Promise.all([
        fetchKeyStatus(memtreeBaseUrl, polychatApiKey, { diagnostics }),
        interactiveUi
            ? checkForUpdate({
                currentVersion: CLIENT_VERSION,
                config,
                cacheFile: path.join(getConfigDir(), UPDATE_CHECK_CACHE_FILE),
            })
            : Promise.resolve(null),
        readProjectMeta(process.cwd()),
    ]);
    // A definite 401/403: the key is mistyped or revoked. Say so before claude
    // starts; interactive runs may paste a new one, others carry on without MemTree.
    const checked = await handleInvalidKey(keyCheck, {
        mode, baseUrl: memtreeBaseUrl, apiKey: polychatApiKey, interactive: interactiveUi, diagnostics,
    });
    polychatApiKey = checked.apiKey;
    const paymentStatus = paymentOnly(checked.check);
    const linkKey = polychatApiKey;
    // The short checkout link (payment-link.ts): the gate's, and later the
    // in-session paused notices' when the key runs out mid-session.
    const paymentLinks = new PaymentLinkCache(() => fetchPaymentLink({
        baseUrl: memtreeBaseUrl, apiKey: linkKey,
        headers: { "x-client": CLIENT_NAME, "x-client-version": CLIENT_VERSION },
    }));
    // Unpaid: [c] (or any print run) is plain Claude Code for this session, with
    // no MemTree calls that would only answer 402 (paused-session.ts).
    let memtreeOff = false;
    if (paymentStatus?.paid === false) {
        const key = polychatApiKey;
        if (interactiveUi) {
            memtreeOff = !(await runPaymentGate(paymentStatus, async () => paymentOnly(await fetchKeyStatus(memtreeBaseUrl, key)), paymentLinks, diagnostics, resumesSession(claudeArgs)));
        }
        else {
            console.error(resumesSession(claudeArgs) ? `ccc: ${RESUMED_PAUSED_LINE}` : PRINT_PAUSED_LINE);
            memtreeOff = true;
        }
    }
    if (isDebugMode && updateAvailable) {
        console.log(`[DEBUG] Update available: ${updateAvailable.current} → ${updateAvailable.latest}`);
    }
    // Interactive only (print/non-TTY runs never install): see auto-update.ts.
    const autoUpdate = interactiveUi
        ? setupAutoUpdate({
            update: updateAvailable,
            currentVersion: CLIENT_VERSION,
            config,
            configDir: getConfigDir(),
            color: terminalSupportsColor(),
            scriptPath: process.argv[1],
        })
        : null;
    if (isDebugMode && autoUpdate)
        console.log(`[DEBUG] ${autoUpdate.debugLine}`);
    diagnostics.setContext({ interactive: interactiveUi });
    recordAutoUpdateDecision(diagnostics, autoUpdate);
    // A resumed session may be past the window under MemTree; plain Claude Code
    // could not send or compact it, so it keeps ccc's paused handling (402 notices).
    if (memtreeOff && !resumesSession(claudeArgs)) {
        await runWithoutMemtree({
            claude, claudeArgs, interactive: interactiveUi, diagnostics, autoUpdate,
            banner: memtreeOffNoticeText(terminalSupportsColor(), pausedUpdateLine(autoUpdate)),
        });
    }
    // Always-on request/timing log (reqlog.ts): messages, MemTree calls, and
    // successful notice claims, so incidents can be reconstructed after the
    // fact without --debug. Never blocks or throws.
    const reqlog = new RequestLogger();
    // The proxy and MemTree client log through this tee: unchanged lines in the
    // request log, plus a few allowlisted numbers for diagnostics.
    // Anthropic refusing for no credit gets one line as ccc exits, whatever the sign-in.
    let creditTooLow = false;
    // Anthropic's 429/529 (rate-limit.ts): said on the next prompt and at exit, or
    // right away on stderr in a print run. Claude Code's own retries are untouched.
    const rateLimits = new RateLimitNotices();
    // An API key that beats the user's `/login` (claude-auth.ts), by source name only.
    const keyOverride = apiKeyOverride({ readFile, interactive: interactiveUi });
    // A refusal is also remembered for the next launch's startup line, until
    // Anthropic answers a request (claude-plan-warning.ts CREDIT_REFUSED_FILE).
    const creditMemory = new CreditRefusalMemory(getConfigDir());
    const observedLog = new DiagnosticsRequestSink(reqlog, diagnostics, (auth) => {
        if (!creditAdviceApplies(auth, claudeSignIn.plan))
            return;
        creditTooLow = true;
        creditMemory.refused();
    }, (auth) => {
        // The next launch's no-plan line goes by what Claude Code really sent.
        if (auth !== claudeSignIn.seen)
            writeSeenClaudeAuth(getConfigDir(), auth);
        claudeSignIn.seen = auth;
    }, () => creditMemory.answered(), (info, startedAt) => {
        if (!info)
            rateLimits.answered(startedAt);
        else if (rateLimits.observe(info) && !interactiveUi)
            console.error(rateLimitNoticeText(info));
    });
    // The `memtree` MCP server (memtree-mcp-config.ts): registered by ccc for
    // every session, interactive or print/non-TTY, unless CCC_MEMTREE_MCP=0,
    // the caller's own --mcp-config names a `memtree` server, or its
    // --disallowedTools covers all four tools. MemTree is told
    // (x-memtree-tools) only which tools the session really has.
    const memtreeMcpPlan = planMemtreeMcp(claudeArgs, process.env);
    // Start the local proxy. Claude Code's OAuth token flows through it straight
    // to api.anthropic.com and never reaches polychat.co.
    const memtree = new MemtreeClient({
        baseUrl: memtreeBaseUrl,
        apiKey: polychatApiKey,
        debug: isDebugMode,
        reqlog: observedLog,
        // Mutable below: a failed config write withdraws it before any call.
        memtreeTools: memtreeMcpPlan.tools.length ? memtreeMcpPlan.tools.join(",") : undefined,
        paymentLinks,
    });
    // Earlier sessions in this project, named to the model at session start
    // (project-trees.ts). Asked now so the answer is in before Claude Code's
    // first SessionStart hook; interactive sessions with the memtree tools only.
    // Not after an invalid key or [c] at the payment gate (a resumed session
    // reaches here paused): the lookup could only fail.
    const projectTrees = projectTreesHintFor({
        interactive: interactiveUi, keyCheck: checked.check, memtreeOff,
        tools: memtreeMcpPlan.tools, meta: projectMeta, env: process.env,
        fetchJson: (pathAndQuery, signal) => memtree.fetchMemTree(pathAndQuery, "application/json", signal),
    });
    projectTrees?.prefetch();
    const nativeOneMillionContext = claudeNativeOneMillionContextEnabled(process.env);
    const memtreeLinkPlacement = memtreeLinkPlacementFromEnv(process.env.CCC_MEMTREE_LINK);
    const memtreeLinkStore = new MemtreeLinkStore();
    const transcriptUsage = new ClaudeTranscriptUsage();
    const proxy = await startProxy({
        memtree,
        debug: isDebugMode,
        reqlog: observedLog,
        diagnostics,
        nativeOneMillionContext,
        // Kill switch for tool-turn COMPACTION only: CCC_TOOL_ROUTE_RECOVERY=0
        // makes tool turns pure passthrough — no size check, no compress call;
        // they ride their lane's route when one exists and otherwise go out whole
        // (with background indexing). Human turns keep compacting. It
        // deliberately does NOT revert classification-time clear gating or
        // same-session-only eviction of a rejected route, because those are what
        // stop a side request from stranding the tool loop.
        toolRouteRecovery: process.env.CCC_TOOL_ROUTE_RECOVERY !== "0",
        // Exact sizes from Count Tokens where an estimate would decide alone
        // (unknown, a big jump near the budget, or a refusal). CCC_COUNT_TOKENS=0
        // keeps estimates only.
        countTokens: process.env.CCC_COUNT_TOKENS !== "0",
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
        memtreeLinkStore,
        // A session's first tree gets a one-time notice saying what it is.
        firstTreeIntro: new FirstTreeMarker(memtreeLinkStore),
        // Each session's adopted compressed prefix, so a resumed session's first
        // turn rides it instead of blocking on a fresh compress.
        stablePrefixStore: new StablePrefixStore(),
        // The link shown to the user follows the session's newest tree on the server.
        newestTrees: new NewestTreeLookup((path, signal) => memtree.fetchMemTree(path, "application/json", signal)),
        transcriptUsage,
        projectMeta,
        // "✔ ccc X installed · restart ccc to use it" (or the hint after a failed
        // install) on a later SessionStart of this session, once.
        sessionStartNotice: autoUpdate ? () => autoUpdate.notices.sessionStartLine() : undefined,
        promptSubmitNotice: interactiveUi ? () => rateLimits.promptLine() : undefined,
        projectTrees,
    });
    // One unobtrusive (dim) line so users can find the log during an incident.
    console.log(`\x1b[2mRequest log: ${reqlog.path}\x1b[0m\n`);
    // On an API key or not signed in: one line before the first prompt (stderr).
    const stderrColor = process.stderr.isTTY === true && terminalSupportsColor();
    // An earlier session's credit refusal (its advice, in place of the no-plan
    // line), else the no-plan line; then a subscriber whose env or settings make
    // Claude Code bill an API key instead.
    // Not right after ccc installed Claude Code: it has just said Claude Code asks to sign in.
    if (found && !isInfoOnlyRun(claudeArgs) && printStartupSignInLines({
        refused: creditMemory.refusedAtStart, plan: claudeSignIn.plan, signIn: claudeSignIn,
        override: keyOverride, color: stderrColor,
    })) {
        diagnostics.record("no_plan_warning", { auth: claudeSignIn.seen ?? claudeSignIn.auth });
    }
    reportStrandedResumeRepair(claudeArgs, nativeOneMillionContext, claude.command);
    // The first request after a resume must count the whole session's thinking.
    const resumedSession = resumeSessionId(claudeArgs);
    if (resumedSession !== undefined)
        transcriptUsage.catchUp(resumedSession);
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
                messageDisplay: installedClaudeSupportsMessageDisplay(claude.command),
                startupMessage: startupNoticeText(terminalSupportsColor(), autoUpdate?.bannerUpdate ?? null, autoUpdate?.bannerInstalled ?? null),
                // Also carries the unpaid-key notice on resume, so it is on even
                // when MemTree links are off (the proxy then answers links-free).
                resumeLink: true,
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
    let memtreeMcpConfig = null;
    if (memtreeMcpPlan.register) {
        try {
            memtreeMcpConfig = writeMemtreeMcpConfig(`http://127.0.0.1:${proxy.port}`);
            childArgs = withMemtreeMcpArgs(childArgs, memtreeMcpConfig.path, memtreeMcpPlan.tools);
        }
        catch (err) {
            // Optional like the notice plugin; without it MemTree must not name
            // tools the session lacks (ccc registers only when the caller has none).
            memtree.setMemtreeTools(undefined);
            projectTrees?.disable();
            if (isDebugMode) {
                console.error(`[DEBUG] MemTree MCP server disabled: ${String(err)}`);
            }
        }
    }
    // Never set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY — Claude Code keeps its
    // native login and sends its own OAuth bearer to the local base URL.
    const claudeStartedAt = Date.now();
    const child = spawn(claude.command, childArgs, {
        env: withClaudeOnPath(claudeChildEnv(process.env, `http://127.0.0.1:${proxy.port}`), claude),
        stdio: "inherit",
    });
    let shuttingDown = false;
    // Settles once the child has exited and the resume hint (if any) is written,
    // or the child failed to start. Awaited (bounded) just before exiting, so a
    // signal whose cleanup finishes first still lets the hint print.
    let markChildDone = () => { };
    const childDone = new Promise((resolve) => { markChildDone = resolve; });
    const shutdown = async (code) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        // Windows installs only now, first: the runner waits for this process to exit,
        // so a second Ctrl+C or a crash during the drains below cannot skip it.
        autoUpdate?.installOnExit((result) => diagnostics.record("auto_update", { result }));
        noticePlugin?.close();
        memtreeMcpConfig?.close();
        // Stop new proxy work and give active handlers a bounded chance to
        // finalize their records. Background indexing is a separate log producer:
        // stop and drain it too before waiting for scheduled JSONL appends on
        // disk.
        await proxy.drain(SHUTDOWN_PROXY_DRAIN_MS);
        // A session ending now sends its final index at once (the idle timer
        // would never fire), inside the same bounded background drain.
        memtree.flushFinalIndexes();
        await memtree.drainBackground(SHUTDOWN_MEMTREE_DRAIN_MS);
        // Before the final flushes, so a late child exit's diagnostics event is sent.
        await settleWithin(childDone, SHUTDOWN_OUTPUT_FLUSH_MS);
        await Promise.all([reqlog.flush(SHUTDOWN_LOG_FLUSH_MS), diagnostics.flush()]);
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
    if (process.platform === "win32") {
        // Closing the console window (SIGHUP) gives ccc a few seconds: start the
        // update first, since the drains in shutdown may not finish in time.
        process.on("SIGHUP", () => {
            diagnostics.record("console_closed");
            autoUpdate?.installOnExit((result) => diagnostics.record("auto_update", { result }));
            handleShutdownSignal("SIGTERM");
        });
    }
    // The background install starts once Claude Code is up; it outlives this
    // process if the session ends first.
    autoUpdate?.scheduleInstall(undefined, (result) => {
        diagnostics.record("auto_update", { result });
        diagnostics.flushNow();
    });
    child.on("error", (err) => {
        if (err.code === "ENOENT") {
            diagnostics.record("claude_missing");
            console.error(claudeMissingText());
        }
        else {
            recordError(diagnostics, "spawn_failed", err);
            console.error("Failed to start claude:", err.message);
        }
        markChildDone();
        void shutdown(1);
    });
    child.on("exit", (code, signal) => {
        if (code !== 0) {
            diagnostics.record("claude_exit", claudeExitFields(code, signal, claudeStartedAt));
        }
        // Under Claude Code's own "claude --resume <id>", which would skip MemTree.
        const hint = exitResumeHint({
            interactive: interactiveUi,
            sessionId: proxy.mainSessionId(),
            mode,
            color: terminalSupportsColor(),
        });
        // Print/non-TTY stdout is Claude's alone: the notice goes to stderr there.
        // A new key the user may have declined at Claude Code's question isn't named.
        const source = keyOverride?.asks ? undefined : keyOverride?.source;
        if (creditTooLow && !interactiveUi)
            console.error(creditNoticeText(false, source));
        const credit = creditTooLow && interactiveUi
            ? `${creditNoticeText(terminalSupportsColor(), source)}\n`
            : "";
        const limit = interactiveUi ? rateLimits.exitLine() : undefined;
        const exitText = `${limit ? `${limit}\n` : ""}${credit}${hint ?? ""}`;
        // Writes to a Windows console or a pipe are asynchronous: let it land before exit.
        void (exitText ? writeStdout(exitText) : Promise.resolve()).then(markChildDone);
        void shutdown(exitCodeForChild(code, signal));
    });
}
main().catch(async (err) => {
    console.error(err);
    if (activeDiagnostics) {
        recordError(activeDiagnostics, "startup_failed", err);
        await activeDiagnostics.flush();
    }
    process.exit(1);
});
/**
 * This launch's diagnostics: environment context, install method, the first
 * run of this install, and a periodic background flush. Off under any opt-out.
 */
function startDiagnostics(mode, baseUrl, apiKey) {
    const diagnostics = new Diagnostics({
        baseUrl, configDir: getConfigDir(), clientName: CLIENT_NAME, clientVersion: CLIENT_VERSION,
        config: loadConfig(), apiKey,
    });
    activeDiagnostics = diagnostics;
    if (!diagnostics.enabled)
        return diagnostics;
    try {
        const method = detectInstallMethod({
            packageDir: PACKAGE_DIR, env: process.env, uid: process.getuid?.(),
            scriptPath: process.argv[1], probeWrites: false,
        });
        diagnostics.setContext({ mode, install_method: method.kind });
    }
    catch {
        diagnostics.setContext({ mode });
    }
    if (diagnostics.firstRun)
        diagnostics.record("first_run");
    diagnostics.start();
    return diagnostics;
}
/** A file reader that reads each path once (null when unreadable). */
function memoizedTextReader() {
    const cache = new Map();
    return (file) => {
        if (!cache.has(file)) {
            let text = null;
            try {
                text = readFileSync(file, "utf8");
            }
            catch {
                // Missing or unreadable: no answer from it.
            }
            cache.set(file, text);
        }
        return cache.get(file);
    };
}
/**
 * auto_update events: a skip with its reason, an install that landed, and
 * (once) the result of the last background install, which its detached
 * runner cannot send itself.
 */
function recordAutoUpdateDecision(diagnostics, autoUpdate) {
    const decision = autoUpdate?.decision;
    // Windows' "installs when you exit" banner is an install, not a hint.
    if (autoUpdate?.bannerUpdate && decision?.action === "skip") {
        diagnostics.record("update_hint", { latest: autoUpdate.bannerUpdate.latest });
    }
    if (decision?.action === "skip" && decision.code !== "no-update") {
        diagnostics.record("auto_update", { result: "skipped", reason: decision.code });
    }
    else if (decision?.action === "installed") {
        diagnostics.record("auto_update", { result: "installed" });
    }
    if (!autoUpdate || !diagnostics.enabled)
        return;
    const files = updateFiles(getConfigDir());
    const outcome = takeUnreportedOutcome(files.stateFile, files.lockDir);
    if (outcome)
        diagnostics.record("auto_update", { result: outcome });
}
/** `CCC_COMPACT_TARGET` ("500k", "20000", "off"): see cli-args.ts. */
/**
 * A resumed session whose last response was recorded past Claude Code's limit
 * would refuse every prompt; lower that record first (resume-repair.ts).
 * Never blocks the launch.
 */
function reportStrandedResumeRepair(claudeArgs, nativeOneMillionContext, claudeCommand) {
    try {
        const repair = repairStrandedResume(claudeArgs, { nativeOneMillionContext, claudeCommand });
        if (!repair)
            return;
        const k = (tokens) => `${Math.round(tokens / 1000)}k`;
        console.log(`\x1b[2mThis session last recorded ${k(repair.recordedTokens)} tokens, past Claude ` +
            `Code's limit; lowered to ${k(repair.loweredTokens)} so MemTree can compress the ` +
            `next message. Backup: ${repair.backupPath}\x1b[0m\n`);
    }
    catch (err) {
        console.error(`\x1b[2mCould not check the resumed session's size: ${String(err)}\x1b[0m`);
    }
}
function defaultCompactTargetFromEnv(raw) {
    const { value, warning } = compactTargetFromEnv(raw, parseTokenCount, MEMTREE_COMPACT_MIN_TOKENS);
    if (warning)
        console.error(warning);
    return value;
}
/** `CCC_BUDGET_TOKENS` ("60k"): a test-only whole-request budget, or undefined. */
function budgetFromEnv(raw) {
    if (!raw)
        return undefined;
    const budget = parseTokenCount(raw);
    if (budget === undefined || budget < 2 * MEMTREE_COMPACT_MIN_TOKENS) {
        console.error(`ccc: ignoring CCC_BUDGET_TOKENS=${raw} (use a token count of at least ${(2 * MEMTREE_COMPACT_MIN_TOKENS) / 1000}k)`);
        return undefined;
    }
    return budget;
}
/** The update line a paused session's banner carries (the normal banner's, see notices.ts). */
function pausedUpdateLine(autoUpdate) {
    const color = terminalSupportsColor();
    if (autoUpdate?.bannerInstalled)
        return updateInstalledNoticeText(autoUpdate.bannerInstalled, color);
    return autoUpdate?.bannerUpdate ? updateNoticeText(autoUpdate.bannerUpdate, color) : null;
}
//# sourceMappingURL=cli-main.js.map