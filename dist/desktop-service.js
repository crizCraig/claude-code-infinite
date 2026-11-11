/**
 * PROTOTYPE (proto/desktop-app): MemTree for the Claude desktop app's Code tab.
 *
 * The desktop app starts its own Claude Code binary with ANTHROPIC_BASE_URL
 * forced to api.anthropic.com and its own OAuth token in the env, so ccc can't
 * wrap it or be its base URL. What the Code tab does honour is HTTPS_PROXY and
 * NODE_EXTRA_CA_CERTS from a saved local environment (Desktop's environment
 * editor), which applies only to the sessions started from that environment.
 *
 * So `ccc desktop setup` makes a long-lived loopback service (a launchd agent on
 * macOS) that is those sessions' HTTPS proxy:
 *
 * - CONNECT api.anthropic.com:443 with the service token: TLS is terminated with
 *   a leaf from a CA name-constrained to api.anthropic.com (mitm-ca.ts). The CA
 *   key is discarded at setup; only the leaf key is kept (0600). Every other
 *   CONNECT is a blind tunnel (https-proxy-mode.ts, unchanged).
 * - Each decrypted POST /v1/messages and /v1/messages/count_tokens goes to a
 *   per-session ccc proxy (proxy.ts's startProxy, in this process, on its own
 *   loopback port), picked by Claude Code's `x-claude-code-session-id` and made
 *   on that session's first request with the session's project (its working
 *   directory, read from the request's system prompt). Everything else
 *   (bridge/Remote Control, OAuth, telemetry, files) and session-less model
 *   calls go to a shared "default" proxy, whose intercepted handling passes them
 *   through verbatim as in terminal proxy mode.
 * - The loopback routes (`/memtree/*` for the MemTree MCP server) need the
 *   service token (header) as well, since this port is fixed and long-lived.
 * - Idle sessions (no request for SESSION_IDLE_MS) are drained and closed.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createSessionCa } from "./mitm-ca.js";
import { attachHttpsProxyMode, isInterceptedRequest } from "./https-proxy-mode.js";
import { startProxy } from "./proxy.js";
import { MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { readProjectMeta } from "./project-meta.js";
import { ClaudeTranscriptUsage } from "./transcript-usage.js";
import { StablePrefixStore } from "./prefix-store.js";
import { ToolOutputStore } from "./tool-output-store.js";
import { UNREACHABLE_BLOCKING_LIMIT } from "./claude-env.js";
import { MEMTREE_TOOLS_HEADER_VALUE, MEMTREE_MCP_SCRIPT } from "./memtree-mcp-config.js";
import { MEMTREE_MCP_SERVER_NAME, PROXY_TOKEN_HEADER } from "./memtree-mcp.js";
/** A session idle this long is closed and final-indexed (as a terminal ccc at exit). */
const SESSION_IDLE_MS = 30 * 60_000;
const SWEEP_MS = 10 * 60_000;
const LAUNCHD_LABEL = "co.polychat.ccc-desktop";
export function desktopPaths(configDir, mode) {
    const dir = path.join(configDir, mode === "production" ? "desktop" : `desktop-${mode}`);
    const label = mode === "production" ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}-${mode}`;
    return {
        dir,
        caPem: path.join(dir, "ca.pem"),
        leafPem: path.join(dir, "leaf.pem"),
        leafKey: path.join(dir, "leaf-key.pem"),
        state: path.join(dir, "service.json"),
        bashEnv: path.join(dir, "bash-env.sh"),
        log: path.join(dir, "service.log"),
        plist: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`),
    };
}
function launchdLabel(mode) {
    return mode === "production" ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}-${mode}`;
}
/** The lines to paste into Desktop's environment editor (one KEY=value per line). */
export function desktopEnvLines(paths, state) {
    return [
        `HTTPS_PROXY=http://ccc:${state.token}@127.0.0.1:${state.port}`,
        `NODE_EXTRA_CA_CERTS=${paths.caPem}`,
        `DISABLE_AUTO_COMPACT=1`,
        `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=${UNREACHABLE_BLOCKING_LIMIT}`,
        `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=1000000000`,
        `CLAUDE_ENV_FILE=${paths.bashEnv}`,
    ];
}
/**
 * Bash-tool commands get the session's env minus ccc's proxy and CA (else curl,
 * Python and others would fail TLS to api.anthropic.com), each only while it
 * still holds ccc's value (Claude Code's sandbox sets its own first).
 */
function bashEnvScript(paths, state) {
    return [
        "# ccc desktop: written by `ccc desktop setup`; sourced by Claude Code before each Bash command.",
        `case "\${HTTPS_PROXY-}" in http://ccc:*@127.0.0.1:${state.port}) unset HTTPS_PROXY https_proxy ;; esac`,
        `case "\${NODE_EXTRA_CA_CERTS-}" in ${shellQuote(paths.caPem)}) unset NODE_EXTRA_CA_CERTS ;; esac`,
        // Programs started from Bash (a nested `claude -p`, an SDK script) aren't routed through
        // ccc, so they get Claude Code's own compaction back.
        `[ "\${DISABLE_AUTO_COMPACT-}" = 1 ] && unset DISABLE_AUTO_COMPACT`,
        `[ "\${CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE-}" = ${UNREACHABLE_BLOCKING_LIMIT} ] && unset CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`,
        `[ "\${CLAUDE_CODE_RESUME_TOKEN_THRESHOLD-}" = 1000000000 ] && unset CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`,
        `unset CLAUDE_ENV_FILE`,
        "true",
        "",
    ].join("\n");
}
/** One shell word, literal (also as a `case` pattern: quoted, so no glob). */
export function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function freePort() {
    return new Promise((resolve, reject) => {
        const s = http.createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}
export function readDesktopState(paths) {
    try {
        return JSON.parse(fs.readFileSync(paths.state, "utf8"));
    }
    catch {
        return undefined;
    }
}
/** Setup rotates the CA when it expires within this. */
export const CA_ROTATE_BEFORE_MS = 30 * 24 * 3600_000;
/**
 * Make the CA and leaf, the token, the port and the Bash env file. A re-run keeps
 * the port and token (the pasted lines stay valid) unless `rotateToken`, and keeps
 * the CA (live sessions trust only the one they started with) unless `rotateCa`,
 * it is missing or unreadable, or it expires within CA_ROTATE_BEFORE_MS.
 */
export async function setupDesktopFiles(paths, mode, opts = {}) {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.dir, 0o700);
    const previous = readDesktopState(paths);
    const now = Date.now();
    const write = (file, text, mode) => {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text, { mode });
        fs.renameSync(tmp, file);
    };
    const caUsable = previous !== undefined && Date.parse(previous.notAfter) - now > CA_ROTATE_BEFORE_MS &&
        [paths.caPem, paths.leafPem, paths.leafKey].every((f) => fs.existsSync(f));
    const caRotated = opts.rotateCa === true || !caUsable;
    if (caRotated) {
        const ca = createSessionCa();
        write(paths.leafKey, ca.leafKeyPem, 0o600);
        write(paths.leafPem, ca.leafCertPem, 0o600);
        write(paths.caPem, ca.caCertPem, 0o644);
    }
    const state = {
        mode,
        port: previous?.port ?? await pickServicePort(),
        token: !opts.rotateToken && previous?.token ? previous.token : randomBytes(24).toString("hex"),
        createdAt: caRotated || !previous ? new Date(now).toISOString() : previous.createdAt,
        notAfter: caRotated || !previous ? new Date(now + 365 * 24 * 3600_000).toISOString() : previous.notAfter,
        ...(previous?.mcpRegistered ? { mcpRegistered: true } : {}),
    };
    write(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    write(paths.bashEnv, bashEnvScript(paths, state), 0o644);
    return { ...state, caRotated };
}
export function writeDesktopState(paths, state) {
    const { mode, port, token, createdAt, notAfter, mcpRegistered } = state;
    const tmp = `${paths.state}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ mode, port, token, createdAt, notAfter, mcpRegistered }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, paths.state);
}
/**
 * A fixed port for the pasted lines: below the macOS ephemeral range (49152+), so an
 * outgoing connection can't hold it when the service restarts. Free when chosen.
 */
async function pickServicePort() {
    for (let i = 0; i < 50; i++) {
        const port = 41000 + Math.floor(Math.random() * 7000);
        if (await portFree(port))
            return port;
    }
    return freePort();
}
function portFree(port) {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.once("error", () => resolve(false));
        s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
}
/** The launchd agent: `node <cli.js> [staging|local] desktop serve`, kept alive. */
export function launchdPlist(mode, paths, cliPath) {
    const args = [process.execPath, cliPath, ...(mode === "production" ? [] : [mode]), "desktop", "serve"];
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel(mode)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(`${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ExitTimeOut</key><integer>45</integer>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(paths.log)}</string>
  <key>StandardErrorPath</key><string>${esc(paths.log)}</string>
</dict>
</plist>
`;
}
export function installLaunchAgent(mode, paths, cliPath) {
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
    fs.writeFileSync(paths.plist, launchdPlist(mode, paths, cliPath), { mode: 0o644 });
    const domain = `gui/${process.getuid?.() ?? 501}`;
    spawnSync("launchctl", ["bootout", `${domain}/${launchdLabel(mode)}`], { stdio: "ignore" });
    // bootout returns before the job is fully gone (it may take its ExitTimeOut to final-index);
    // wait for it to leave, then bootstrap, retrying the transient 5/37 errors.
    for (let i = 0; i < 200 && spawnSync("launchctl", ["print", `${domain}/${launchdLabel(mode)}`], { stdio: "ignore" }).status === 0; i++) {
        spawnSync("sleep", ["0.25"]);
    }
    let last = "";
    for (let attempt = 0; attempt < 40; attempt++) {
        const r = spawnSync("launchctl", ["bootstrap", domain, paths.plist], { encoding: "utf8" });
        if (r.status === 0)
            return;
        last = `${r.status}: ${(r.stderr || "").trim()}`;
        spawnSync("sleep", ["0.25"]);
    }
    throw new Error(`launchctl bootstrap failed (${last})`);
}
export function uninstallLaunchAgent(mode, paths) {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    spawnSync("launchctl", ["bootout", `${domain}/${launchdLabel(mode)}`], { stdio: "ignore" });
    fs.rmSync(paths.plist, { force: true });
}
/**
 * The `memtree` MCP server for every Claude Code on this account (Desktop
 * re-delivers ~/.claude.json's stdio servers to its sessions). It is inert
 * (no tools) unless the session's HTTPS_PROXY is a ccc proxy or it runs
 * under terminal ccc (memtree-mcp.ts desktopMcpTarget). Registered through
 * `claude mcp add-json --scope user`, never by editing ~/.claude.json directly.
 */
export function desktopMcpServerJson() {
    return JSON.stringify({
        type: "stdio",
        command: process.execPath,
        args: [MEMTREE_MCP_SCRIPT],
        env: { CCC_MEMTREE_MCP_DESKTOP: "1" },
        alwaysLoad: true,
    });
}
/** The file `claude mcp --scope user` edits: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function userClaudeJsonPath(env = process.env) {
    return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}
/**
 * Who owns the user-scope `memtree` entry (read only; never written here). A file that
 * exists but can't be read or parsed is "other": ccc then touches nothing.
 */
export function userMcpOwner(claudeJsonPath = userClaudeJsonPath()) {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    }
    catch (err) {
        return err?.code === "ENOENT" ? "none" : "other";
    }
    const entry = config.mcpServers?.[MEMTREE_MCP_SERVER_NAME];
    if (!entry)
        return "none";
    return entry.env?.CCC_MEMTREE_MCP_DESKTOP === "1" ? "ccc-desktop" : "other";
}
/**
 * Register (or refresh) ccc's entry. Someone else's `memtree` entry is left alone
 * (false, with the reason): the user decides.
 */
export function registerDesktopMcp(claudeCommand, env = process.env) {
    const owner = userMcpOwner(userClaudeJsonPath(env));
    if (owner === "other") {
        return { ok: false, reason: "a user-scope MCP server named `memtree` that ccc didn't add already exists" };
    }
    if (owner === "ccc-desktop") {
        spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", MEMTREE_MCP_SERVER_NAME], { stdio: "ignore", env });
    }
    const r = spawnSync(claudeCommand, [
        "mcp", "add-json", "--scope", "user", MEMTREE_MCP_SERVER_NAME, desktopMcpServerJson(),
    ], { stdio: "inherit", env });
    return r.status === 0 ? { ok: true } : { ok: false, reason: `\`claude mcp add-json\` exited ${r.status}` };
}
/** Remove ccc's entry only, and only when no other ccc desktop mode still uses it. */
export function unregisterDesktopMcp(claudeCommand, otherModesInstalled, env = process.env) {
    if (otherModesInstalled || userMcpOwner(userClaudeJsonPath(env)) !== "ccc-desktop")
        return;
    spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", MEMTREE_MCP_SERVER_NAME], { stdio: "ignore", env });
}
/** How long a closing session's final index and background calls may take. */
const FINAL_DRAIN_MS = 10_000;
/**
 * The session's directory, from Claude Code's environment block ("Primary working
 * directory: ..."): in the top-level `system` text, or (Claude Code 2.1.322) in a
 * `role: "system"` entry of `messages`. Never user or assistant text.
 */
export function workingDirectoryFromBody(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return undefined;
    }
    const textsOf = (content) => typeof content === "string" ? [content]
        : Array.isArray(content) ? content.map((b) => (b && typeof b === "object" && typeof b.text === "string"
            ? b.text : "")) : [];
    const systemMessages = Array.isArray(parsed.messages)
        ? parsed.messages.filter((m) => m?.role === "system")
            .flatMap((m) => textsOf(m.content))
        : [];
    for (const text of [...textsOf(parsed.system), ...systemMessages]) {
        const m = /^\s*-?\s*Primary working directory: (.+)$/m.exec(text);
        const dir = m?.[1]?.trim();
        if (dir && path.isAbsolute(dir))
            return dir;
    }
    return undefined;
}
export async function startDesktopService(opts) {
    const log = opts.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
    const reqlog = new RequestLogger(path.join(opts.paths.dir, "requests.jsonl"));
    // The inner proxies answer only this process (ProxyOptions.innerToken): they are
    // ordinary loopback listeners, so without it any local user could reach them.
    const innerToken = randomBytes(24).toString("hex");
    const newMemtree = () => new MemtreeClient({
        baseUrl: opts.memtreeBaseUrl,
        apiKey: opts.apiKey,
        debug: opts.debug,
        reqlog,
        // Set per session from its model calls' tool list (toolsOffered).
        memtreeTools: undefined,
    });
    const proxyOptions = (memtree, transcriptUsage) => ({
        memtree,
        reqlog,
        innerToken,
        stablePrefixStore,
        toolOutputs,
        debug: opts.debug,
        nativeOneMillionContext: true,
        toolRouteRecovery: true,
        countTokens: true,
        claudeCodeOnly: true,
        // Usage and the final reply come from the session's transcript, as in terminal ccc.
        ...(transcriptUsage ? { transcriptUsage } : {}),
        ...(opts.upstreamOrigin ? { upstreamOrigin: opts.upstreamOrigin } : {}),
        // Test-only, as in terminal ccc: a small budget so a cheap session crosses it.
        ...(Number(process.env.CCC_BUDGET_TOKENS) > 0 ? { budgetTokensOverride: Number(process.env.CCC_BUDGET_TOKENS) } : {}),
    });
    // As in terminal ccc (cli-main.ts): a session's adopted compressed prefix, so a fresh
    // proxy for it (after an idle close or a restart) rides it instead of blocking on a
    // compress; and full copies of tool results shortened to fit the window (the safety net).
    const stablePrefixStore = new StablePrefixStore();
    const toolOutputs = new ToolOutputStore();
    const fallbackMemtree = newMemtree();
    const fallback = await startProxy(proxyOptions(fallbackMemtree));
    const sessions = new Map();
    /**
     * The session's proxy, made on its first request. Its project is set once a
     * request names the working directory (Claude Code's first request in a
     * session is often a title or quota call without one); proxy.ts reads
     * `opts.projectMeta` per request, so setting it later on the same object works.
     * A session seen again after it was closed (resumed) gets a fresh proxy, as a
     * terminal `ccc --resume` gets a fresh process: its transcript is caught up first.
     */
    const sessionProxy = (id, cwd) => {
        let entry = sessions.get(id);
        if (!entry) {
            const started = Date.now();
            const memtree = newMemtree();
            const transcriptUsage = new ClaudeTranscriptUsage();
            transcriptUsage.catchUp(id);
            const popts = proxyOptions(memtree, transcriptUsage);
            entry = {
                lastUsed: started,
                inFlight: 0,
                memtree,
                opts: popts,
                proxy: startProxy(popts).then((proxy) => {
                    log(`session ${id.slice(0, 8)} proxy on :${proxy.port} (${Date.now() - started} ms)`);
                    return proxy;
                }),
            };
            const created = entry;
            // A failed start (EMFILE, ...) must not stick: the next request retries.
            created.proxy.catch((err) => {
                if (sessions.get(id) === created)
                    sessions.delete(id);
                log(`session ${id.slice(0, 8)} proxy failed to start: ${String(err)}`);
            });
            sessions.set(id, entry);
        }
        if (cwd && entry.cwd === undefined) {
            const target = entry;
            target.cwd = cwd;
            target.projectReady = readProjectMeta(cwd).then((meta) => {
                target.opts.projectMeta = meta;
                log(`session ${id.slice(0, 8)} project ${meta.git_repo ?? path.basename(cwd)}${meta.git_branch ? `@${meta.git_branch}` : ""}`);
            }, () => { });
        }
        entry.lastUsed = Date.now();
        return entry;
    };
    /** As at a terminal ccc's exit: drain, final-index the conversation, finish background calls. */
    const closeSession = async (entry, drainMs) => {
        const proxy = await entry.proxy;
        await proxy.drain(drainMs);
        entry.memtree.flushFinalIndexes(FINAL_DRAIN_MS);
        await entry.memtree.drainBackground(FINAL_DRAIN_MS);
        proxy.close();
    };
    const server = http.createServer((req, res) => void route(req, res).catch((err) => {
        log(`route error: ${String(err)}`);
        if (res.destroyed)
            return;
        if (!res.headersSent)
            res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "ccc desktop service error" } }));
    }));
    const tunnels = attachHttpsProxyMode(server, {
        ca: {
            caCertPem: fs.readFileSync(opts.paths.caPem, "utf8"),
            leafCertPem: fs.readFileSync(opts.paths.leafPem, "utf8"),
            leafKeyPem: fs.readFileSync(opts.paths.leafKey, "utf8"),
        },
        proxyToken: opts.state.token,
        ...(opts.tracePath ? { tracePath: opts.tracePath } : {}),
    });
    let closing = false;
    const pendingRoutes = new Set();
    async function route(req, res) {
        if (closing) {
            res.writeHead(503, { "content-type": "application/json", connection: "close" });
            res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "ccc desktop service is restarting" } }));
            return;
        }
        const task = routeInner(req, res);
        pendingRoutes.add(task);
        try {
            await task;
        }
        finally {
            pendingRoutes.delete(task);
        }
    }
    async function routeInner(req, res) {
        // A client that goes away while we wait (body, git, proxy start) must not still be sent upstream.
        let gone = false;
        res.on("close", () => { if (!res.writableFinished)
            gone = true; });
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const sessionId = header(req, "x-claude-code-session-id");
        if (isInterceptedRequest(req)) {
            const isModelCall = req.method === "POST" &&
                (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens");
            if (isModelCall && sessionId) {
                const body = await readBody(req);
                const known = sessions.get(sessionId)?.cwd;
                const text = body.toString("utf8");
                const entry = sessionProxy(sessionId, known ?? workingDirectoryFromBody(text));
                // Say the memory tools exist once this session's model calls carry them (an inert or
                // disabled MCP server never sends them). Sticky per session: a concurrent side call
                // with another tool list (WebSearch helper, a restricted subagent) must not clear it
                // under the main conversation's compress (Codex r3). The client holds one value per
                // session, so per-call precision would need it carried with each compress call.
                if (url.pathname === "/v1/messages" && toolsOffered(text) === true) {
                    entry.memtree.setMemtreeTools(MEMTREE_TOOLS_HEADER_VALUE);
                }
                entry.inFlight++;
                try {
                    // A few ms of git on the session's first request with a directory, so its MemTree calls carry the project.
                    await entry.projectReady;
                    const port = (await entry.proxy).port;
                    if (gone)
                        return;
                    await forward(req, res, port, innerToken, true, body);
                }
                finally {
                    entry.inFlight--;
                    entry.lastUsed = Date.now();
                }
                return;
            }
            return forward(req, res, fallback.port, innerToken, true);
        }
        // Loopback routes (the MCP server's /memtree reads): the token, then the session's proxy.
        if (!tokenMatches(header(req, PROXY_TOKEN_HEADER), opts.state.token)) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: "ccc desktop service: missing or wrong token" }));
            return;
        }
        if (url.pathname === "/ccc-desktop/status") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ service: "ccc-desktop", mode: opts.state.mode, sessions: sessions.size }));
            return;
        }
        if (!url.pathname.startsWith("/memtree/")) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: "ccc desktop service: not found" }));
            return;
        }
        // The MCP server names the session in a header, or as `?session=` (/memtree/current).
        const forSession = sessionId ?? (url.searchParams.get("session") || undefined);
        const entry = forSession ? sessions.get(forSession) : undefined;
        const port = entry ? (await entry.proxy).port : fallback.port;
        if (gone)
            return;
        return forward(req, res, port, innerToken, false);
    }
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.state.port, "127.0.0.1", () => resolve());
    });
    log(`ccc desktop service (${opts.state.mode}) listening on 127.0.0.1:${opts.state.port}`);
    // Idle closes in progress, so shutdown waits for their final indexes too (Codex r3).
    const idleClosing = new Set();
    const closeIdle = async (idleMs = SESSION_IDLE_MS) => {
        const now = Date.now();
        const closing = [];
        for (const [id, entry] of sessions) {
            if (entry.inFlight > 0 || now - entry.lastUsed < idleMs)
                continue;
            sessions.delete(id);
            log(`session ${id.slice(0, 8)} idle: closing (final index)`);
            const done = closeSession(entry, 30_000).catch((err) => log(`session ${id.slice(0, 8)} close: ${String(err)}`));
            idleClosing.add(done);
            void done.finally(() => idleClosing.delete(done));
            closing.push(done);
        }
        await Promise.all(closing);
    };
    const sweep = setInterval(() => void closeIdle(), SWEEP_MS);
    sweep.unref();
    return {
        port: opts.state.port,
        sessions: () => [...sessions.keys()],
        closeIdle,
        close: async () => {
            clearInterval(sweep);
            closing = true;
            server.close();
            tunnels.blind();
            // Requests already being routed get a moment to reach their session proxy before the
            // snapshot. Bounded: a long stream or long-poll is cut by the proxies' own drain
            // deadline below, not waited for here (Codex r3).
            await Promise.race([
                Promise.allSettled([...pendingRoutes]),
                new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
            ]);
            const all = [...sessions.values()];
            sessions.clear();
            await Promise.allSettled([
                ...all.map((e) => closeSession(e, 10_000)),
                ...idleClosing,
                (async () => {
                    await fallback.drain(10_000);
                    await fallbackMemtree.drainBackground(FINAL_DRAIN_MS);
                    fallback.close();
                })(),
            ]);
            tunnels.all();
            await reqlog.flush(2_000);
        },
    };
}
/**
 * Whether a /v1/messages body offers the memtree tools: true / false when it has a
 * `tools` list with or without them, undefined when it has none (a side call: no change).
 */
export function toolsOffered(body) {
    if (!body.includes('"tools"'))
        return undefined;
    try {
        const tools = JSON.parse(body).tools;
        if (!Array.isArray(tools) || tools.length === 0)
            return undefined;
        return tools.some((t) => typeof t?.name === "string" && t.name.startsWith(`mcp__${MEMTREE_MCP_SERVER_NAME}__`));
    }
    catch {
        return undefined;
    }
}
function header(req, name) {
    const v = req.headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
}
function tokenMatches(got, expected) {
    if (!got)
        return false;
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
/**
 * Plain HTTP to one of this process's inner proxies, with the inner token and, for a
 * request decrypted from api.anthropic.com, the intercepted marker (proxy.ts
 * acceptInnerRequest). Status, headers and body are streamed back.
 */
function forward(req, res, port, innerToken, intercepted, body) {
    return new Promise((resolve) => {
        const headers = { ...req.headers };
        delete headers[PROXY_TOKEN_HEADER];
        delete headers["x-ccc-intercepted"];
        headers["x-ccc-inner"] = innerToken;
        if (intercepted)
            headers["x-ccc-intercepted"] = "1";
        // A loopback (MCP) call keeps the loopback-caller checks of the inner proxy.
        else
            headers.host = `127.0.0.1:${port}`;
        if (body) {
            headers["content-length"] = String(body.length);
            delete headers["transfer-encoding"];
        }
        const out = http.request({
            host: "127.0.0.1", port, method: req.method, path: req.url, headers,
        }, (upstream) => {
            res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.rawHeaders);
            upstream.pipe(res);
            upstream.on("end", resolve);
            upstream.on("error", () => { res.destroy(); resolve(); });
        });
        out.on("error", () => {
            if (res.destroyed)
                return resolve();
            if (!res.headersSent)
                res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "ccc desktop service: session proxy unavailable" } }));
            resolve();
        });
        res.on("close", () => { if (!res.writableFinished) {
            out.destroy();
            resolve();
        } });
        if (body)
            out.end(body);
        else
            req.pipe(out);
    });
}
//# sourceMappingURL=desktop-service.js.map