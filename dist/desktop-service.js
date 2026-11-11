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
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createSessionCa } from "./mitm-ca.js";
import { attachHttpsProxyMode, isInterceptedRequest } from "./https-proxy-mode.js";
import { startProxy } from "./proxy.js";
import { MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { readProjectMeta } from "./project-meta.js";
import { UNREACHABLE_BLOCKING_LIMIT } from "./claude-env.js";
import { MEMTREE_TOOLS_HEADER_VALUE, MEMTREE_MCP_SCRIPT } from "./memtree-mcp-config.js";
import { MEMTREE_MCP_SERVER_NAME, PROXY_TOKEN_HEADER } from "./memtree-mcp.js";
const SESSION_IDLE_MS = 6 * 3600_000;
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
        `case "\${NODE_EXTRA_CA_CERTS-}" in '${paths.caPem}') unset NODE_EXTRA_CA_CERTS ;; esac`,
        `unset CLAUDE_ENV_FILE`,
        "",
    ].join("\n");
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
/**
 * Make (or rotate) the CA and leaf, the token, the port and the Bash env file.
 * A re-run keeps the port and token (the pasted lines stay valid) unless
 * `rotateToken`; the CA always rotates, at the same file path.
 */
export async function setupDesktopFiles(paths, mode, opts = {}) {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.dir, 0o700);
    const previous = readDesktopState(paths);
    const now = Date.now();
    const ca = createSessionCa();
    const state = {
        mode,
        port: previous?.port ?? await freePort(),
        token: !opts.rotateToken && previous?.token ? previous.token : randomBytes(24).toString("hex"),
        createdAt: new Date(now).toISOString(),
        notAfter: new Date(now + 365 * 24 * 3600_000).toISOString(),
    };
    const write = (file, text, mode) => {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text, { mode });
        fs.renameSync(tmp, file);
    };
    write(paths.leafKey, ca.leafKeyPem, 0o600);
    write(paths.leafPem, ca.leafCertPem, 0o600);
    write(paths.caPem, ca.caCertPem, 0o644);
    write(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    write(paths.bashEnv, bashEnvScript(paths, state), 0o644);
    return state;
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
  <key>RunAtLoad</key><true/>
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
    execFileSync("launchctl", ["bootstrap", domain, paths.plist], { stdio: "inherit" });
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
export function registerDesktopMcp(claudeCommand, env = process.env) {
    spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", MEMTREE_MCP_SERVER_NAME], { stdio: "ignore", env });
    const r = spawnSync(claudeCommand, [
        "mcp", "add-json", "--scope", "user", MEMTREE_MCP_SERVER_NAME, desktopMcpServerJson(),
    ], { stdio: "inherit", env });
    return r.status === 0;
}
export function unregisterDesktopMcp(claudeCommand, env = process.env) {
    spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", MEMTREE_MCP_SERVER_NAME], { stdio: "ignore", env });
}
/** Claude Code's system prompt names the session's directory ("Primary working directory: ..."). */
export function workingDirectoryFromBody(body) {
    const m = /Primary working directory: ([^\n"\\]+)/.exec(body);
    const dir = m?.[1]?.trim();
    return dir && path.isAbsolute(dir) ? dir : undefined;
}
export async function startDesktopService(opts) {
    const log = opts.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
    const reqlog = new RequestLogger(path.join(opts.paths.dir, "requests.jsonl"));
    const memtree = new MemtreeClient({
        baseUrl: opts.memtreeBaseUrl,
        apiKey: opts.apiKey,
        debug: opts.debug,
        reqlog,
        // The user-scope MCP entry (registerDesktopMcp) serves these tools in routed sessions.
        memtreeTools: MEMTREE_TOOLS_HEADER_VALUE,
    });
    const common = () => ({
        memtree,
        reqlog,
        debug: opts.debug,
        nativeOneMillionContext: true,
        toolRouteRecovery: true,
        countTokens: true,
        claudeCodeOnly: true,
        ...(opts.upstreamOrigin ? { upstreamOrigin: opts.upstreamOrigin } : {}),
        // Test-only, as in terminal ccc: a small budget so a cheap session crosses it.
        ...(Number(process.env.CCC_BUDGET_TOKENS) > 0 ? { budgetTokensOverride: Number(process.env.CCC_BUDGET_TOKENS) } : {}),
    });
    const fallback = await startProxy(common());
    const sessions = new Map();
    /**
     * The session's proxy, made on its first request. Its project is set once a
     * request names the working directory (Claude Code's first request in a
     * session is often a title or quota call without one); proxy.ts reads
     * `opts.projectMeta` per request, so setting it later on the same object works.
     */
    const sessionProxy = (id, cwd) => {
        let entry = sessions.get(id);
        if (!entry) {
            const started = Date.now();
            const popts = common();
            const created = {
                lastUsed: started,
                opts: popts,
                proxy: startProxy(popts).then((proxy) => {
                    log(`session ${id.slice(0, 8)} proxy on :${proxy.port} (${Date.now() - started} ms)`);
                    return proxy;
                }),
            };
            entry = created;
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
    const server = http.createServer((req, res) => void route(req, res).catch((err) => {
        log(`route error: ${String(err)}`);
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
    async function route(req, res) {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const sessionId = header(req, "x-claude-code-session-id");
        if (isInterceptedRequest(req)) {
            const isModelCall = req.method === "POST" &&
                (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens");
            if (isModelCall && sessionId) {
                const body = await readBody(req);
                if (process.env.CCC_DESKTOP_DEBUG_CWD) {
                    const text = body.toString("utf8");
                    const i = text.search(/working directory/i);
                    log(`debug cwd ${sessionId.slice(0, 8)}: ${i < 0 ? "none" : JSON.stringify(text.slice(Math.max(0, i - 40), i + 120))}`);
                }
                const known = sessions.get(sessionId)?.cwd;
                const entry = sessionProxy(sessionId, known ?? workingDirectoryFromBody(body.subarray(0, 400_000).toString("utf8")));
                // A few ms of git on the session's first request with a directory, so its MemTree calls carry the project.
                await entry.projectReady;
                return forward(req, res, (await entry.proxy).port, body);
            }
            return forward(req, res, fallback.port);
        }
        // Loopback routes (the MCP server's /memtree reads): the token, then the session's proxy.
        if (!tokenMatches(header(req, PROXY_TOKEN_HEADER), opts.state.token)) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: "ccc desktop service: missing or wrong token" }));
            return;
        }
        if (url.pathname === "/ccc-desktop/status") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ sessions: sessions.size }));
            return;
        }
        if (!url.pathname.startsWith("/memtree/")) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: "ccc desktop service: not found" }));
            return;
        }
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        return forward(req, res, entry ? (await entry.proxy).port : fallback.port);
    }
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.state.port, "127.0.0.1", () => resolve());
    });
    log(`ccc desktop service (${opts.state.mode}) listening on 127.0.0.1:${opts.state.port}`);
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [id, entry] of sessions) {
            if (now - entry.lastUsed < SESSION_IDLE_MS)
                continue;
            sessions.delete(id);
            void entry.proxy.then(async (p) => { await p.drain(30_000); p.close(); });
            log(`session ${id.slice(0, 8)} idle: closed`);
        }
    }, SWEEP_MS);
    sweep.unref();
    return {
        port: opts.state.port,
        sessions: () => [...sessions.keys()],
        close: async () => {
            clearInterval(sweep);
            server.close();
            tunnels.blind();
            const all = [...sessions.values()].map((e) => e.proxy);
            sessions.clear();
            await Promise.allSettled(all.map(async (p) => { const proxy = await p; await proxy.drain(10_000); proxy.close(); }));
            await fallback.drain(10_000);
            fallback.close();
            tunnels.all();
        },
    };
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
/** Plain HTTP to one of this process's proxies; status, headers and body streamed back. */
function forward(req, res, port, body) {
    return new Promise((resolve) => {
        const headers = { ...req.headers };
        delete headers[PROXY_TOKEN_HEADER];
        // The inner proxy serves loopback callers only (and sets the upstream Host itself).
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
            if (!res.headersSent)
                res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "ccc desktop service: session proxy unavailable" } }));
            resolve();
        });
        res.on("close", () => { if (!res.writableFinished)
            out.destroy(); });
        if (body)
            out.end(body);
        else
            req.pipe(out);
    });
}
//# sourceMappingURL=desktop-service.js.map