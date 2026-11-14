/**
 * MemTree for the Claude desktop app's Code tab.
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
import path from "node:path";
import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { attachHttpsProxyMode, type InterceptUpstream } from "./https-proxy-mode.js";
import { INTERCEPT_HOST } from "./mitm-ca.js";
import { HTTPS_PROXY_MODE_ENV, httpsProxyModeDecision } from "./https-proxy-eligibility.js";
import {
  INNER_INTERCEPTED_HEADER, INNER_TOKEN_HEADER, startProxy, type ProxyOptions, type RunningProxy,
} from "./proxy.js";
import { MemtreeClient } from "./memtree.js";
import { RequestLogger } from "./reqlog.js";
import { readProjectMeta } from "./project-meta.js";
import { ClaudeTranscriptUsage } from "./transcript-usage.js";
import { StablePrefixStore } from "./prefix-store.js";
import { ToolOutputStore } from "./tool-output-store.js";
import { MEMTREE_TOOLS_HEADER_VALUE } from "./memtree-mcp-config.js";
import { MEMTREE_MCP_SERVER_NAME, PROXY_TOKEN_HEADER } from "./memtree-mcp.js";
import type { DesktopPaths, DesktopState } from "./desktop-setup.js";

/** A session idle this long is closed and final-indexed (as a terminal ccc at exit). */
const SESSION_IDLE_MS = 30 * 60_000;
const SWEEP_MS = 10 * 60_000;

// ------------------------------------------------------------------ service

export interface DesktopServiceOptions {
  paths: DesktopPaths;
  state: DesktopState;
  memtreeBaseUrl: string;
  apiKey: string;
  /** Test-only: a loopback mock in place of api.anthropic.com. */
  upstreamOrigin?: ProxyOptions["upstreamOrigin"];
  tracePath?: string;
  debug?: boolean;
  log?: (line: string) => void;
}

export interface RunningDesktopService {
  port: number;
  sessions: () => string[];
  /** Close sessions idle for longer than `idleMs` (the sweep's job; exposed for tests). */
  closeIdle: (idleMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

interface SessionEntry {
  proxy: Promise<RunningProxy>;
  /** This session's own MemTree client: its conversations, final index and background work. */
  memtree: MemtreeClient;
  /** The options object the proxy was started with (projectMeta is set on it later). */
  opts: ProxyOptions;
  lastUsed: number;
  inFlight: number;
  cwd?: string;
  projectReady?: Promise<void>;
  /** Why this session's project can't be routed through ccc (its settings), once known. */
  refused?: string;
}

/** How long a closing session's final index and background calls may take. */
const FINAL_DRAIN_MS = 10_000;

/**
 * The session's directory, from Claude Code's environment block ("Primary working
 * directory: ..."): in the top-level `system` text, or (Claude Code 2.1.322) in a
 * `role: "system"` entry of `messages`. Never user or assistant text.
 */
export function workingDirectoryFromBody(body: string): string | undefined {
  let parsed: { system?: unknown; messages?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return undefined;
  }
  const textsOf = (content: unknown): string[] => typeof content === "string" ? [content]
    : Array.isArray(content) ? content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
      ? (b as { text: string }).text : "")) : [];
  const systemMessages = Array.isArray(parsed.messages)
    ? parsed.messages.filter((m) => (m as { role?: unknown })?.role === "system")
      .flatMap((m) => textsOf((m as { content?: unknown }).content))
    : [];
  for (const text of [...textsOf(parsed.system), ...systemMessages]) {
    const m = /^\s*-?\s*Primary working directory: (.+)$/m.exec(text);
    const dir = m?.[1]?.trim();
    if (dir && path.isAbsolute(dir)) return dir;
  }
  return undefined;
}

export async function startDesktopService(opts: DesktopServiceOptions): Promise<RunningDesktopService> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const reqlog = new RequestLogger(path.join(opts.paths.dir, "requests.jsonl"));
  // The inner proxies answer only this process (ProxyOptions.innerToken): they are
  // ordinary loopback listeners, so without it any local user could reach them.
  const innerToken = randomBytes(24).toString("hex");
  const newMemtree = (): MemtreeClient => new MemtreeClient({
    baseUrl: opts.memtreeBaseUrl,
    apiKey: opts.apiKey,
    debug: opts.debug,
    reqlog,
    // Set per session from its model calls' tool list (toolsOffered).
    memtreeTools: undefined,
  });
  const proxyOptions = (memtree: MemtreeClient, transcriptUsage?: ClaudeTranscriptUsage): ProxyOptions => ({
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
  } as ProxyOptions);
  // As in terminal ccc (cli-main.ts): a session's adopted compressed prefix, so a fresh
  // proxy for it (after an idle close or a restart) rides it instead of blocking on a
  // compress; and full copies of tool results shortened to fit the window (the safety net).
  const stablePrefixStore = new StablePrefixStore();
  const toolOutputs = new ToolOutputStore();
  const fallbackMemtree = newMemtree();
  const fallback = await startProxy(proxyOptions(fallbackMemtree));
  const sessions = new Map<string, SessionEntry>();
  /**
   * The session's proxy, made on its first request. Its project is set once a
   * request names the working directory (Claude Code's first request in a
   * session is often a title or quota call without one); proxy.ts reads
   * `opts.projectMeta` per request, so setting it later on the same object works.
   * A session seen again after it was closed (resumed) gets a fresh proxy, as a
   * terminal `ccc --resume` gets a fresh process: its transcript is caught up first.
   */
  const sessionProxy = (id: string, cwd: string | undefined): SessionEntry => {
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
        if (sessions.get(id) === created) sessions.delete(id);
        log(`session ${id.slice(0, 8)} proxy failed to start: ${String(err)}`);
      });
      sessions.set(id, entry);
    }
    if (cwd && entry.cwd === undefined) {
      const target = entry;
      target.cwd = cwd;
      target.refused = projectRefusal(cwd);
      if (target.refused) log(`session ${id.slice(0, 8)} refused: ${target.refused}`);
      target.projectReady = readProjectMeta(cwd).then((meta) => {
        target.opts.projectMeta = meta;
        log(`session ${id.slice(0, 8)} project ${meta.git_repo ?? path.basename(cwd)}${meta.git_branch ? `@${meta.git_branch}` : ""}`);
      }, () => {});
    }
    entry.lastUsed = Date.now();
    return entry;
  };

  /** As at a terminal ccc's exit: drain, final-index the conversation, finish background calls. */
  const closeSession = async (entry: SessionEntry, drainMs: number): Promise<void> => {
    const proxy = await entry.proxy;
    await proxy.drain(drainMs);
    entry.memtree.flushFinalIndexes(FINAL_DRAIN_MS);
    await entry.memtree.drainBackground(FINAL_DRAIN_MS);
    proxy.close();
  };

  // `intercepted`: decrypted from a token-authenticated CONNECT api.anthropic.com:443.
  const handler = (intercepted: boolean): http.RequestListener => (req, res) =>
    void route(req, res, intercepted).catch((err) => {
      log(`route error: ${String(err)}`);
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error",
        error: { type: "api_error", message: "ccc desktop service error" } }));
    });
  const server = http.createServer(handler(false));
  const tunnels = attachHttpsProxyMode(server, handler(true), interceptUpstream(opts.upstreamOrigin), {
    ca: {
      leafCertPem: fs.readFileSync(opts.paths.leafPem, "utf8"),
      leafKeyPem: fs.readFileSync(opts.paths.leafKey, "utf8"),
    },
    proxyToken: opts.state.token,
    ...(opts.tracePath ? { tracePath: opts.tracePath } : {}),
  });

  let closing = false;
  const pendingRoutes = new Set<Promise<void>>();
  async function route(
    req: http.IncomingMessage, res: http.ServerResponse, intercepted: boolean
  ): Promise<void> {
    if (closing) {
      res.writeHead(503, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "ccc desktop service is restarting" } }));
      return;
    }
    const task = routeInner(req, res, intercepted);
    pendingRoutes.add(task);
    try { await task; } finally { pendingRoutes.delete(task); }
  }

  async function routeInner(
    req: http.IncomingMessage, res: http.ServerResponse, intercepted: boolean
  ): Promise<void> {
    // A client that goes away while we wait (body, git, proxy start) must not still be sent upstream.
    let gone = false;
    res.on("close", () => { if (!res.writableFinished) gone = true; });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sessionId = header(req, "x-claude-code-session-id");
    if (intercepted) {
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
        if (entry.refused) return refuseSession(res, entry.refused);
        entry.inFlight++;
        try {
          // A few ms of git on the session's first request with a directory, so its MemTree calls carry the project.
          await entry.projectReady;
          const port = (await entry.proxy).port;
          if (gone) return;
          await forward(req, res, port, innerToken, true, body);
        } finally {
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
    if (gone) return;
    return forward(req, res, port, innerToken, false);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.state.port, "127.0.0.1", () => resolve());
  });
  log(`ccc desktop service (${opts.state.mode}) listening on 127.0.0.1:${opts.state.port}`);

  // Idle closes in progress, so shutdown waits for their final indexes too (Codex r3).
  const idleClosing = new Set<Promise<void>>();
  const closeIdle = async (idleMs = SESSION_IDLE_MS): Promise<void> => {
    const now = Date.now();
    const closing: Promise<void>[] = [];
    for (const [id, entry] of sessions) {
      if (entry.inFlight > 0 || now - entry.lastUsed < idleMs) continue;
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
export function toolsOffered(body: string): boolean | undefined {
  if (!body.includes('"tools"')) return undefined;
  try {
    const tools = (JSON.parse(body) as { tools?: { name?: unknown }[] }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    return tools.some((t) => typeof t?.name === "string" && t.name.startsWith(`mcp__${MEMTREE_MCP_SERVER_NAME}__`));
  } catch {
    return undefined;
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

function tokenMatches(got: string | undefined, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Plain HTTP to one of this process's inner proxies, with the inner token and, for a
 * request decrypted from api.anthropic.com, the intercepted marker (proxy.ts
 * acceptInnerRequest). Status, headers and body are streamed back.
 */
function forward(
  req: http.IncomingMessage, res: http.ServerResponse, port: number, innerToken: string,
  intercepted: boolean, body?: Buffer
): Promise<void> {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    delete headers[PROXY_TOKEN_HEADER];
    delete headers[INNER_INTERCEPTED_HEADER];
    headers[INNER_TOKEN_HEADER] = innerToken;
    if (intercepted) headers[INNER_INTERCEPTED_HEADER] = "1";
    // A loopback (MCP) call keeps the loopback-caller checks of the inner proxy.
    else headers.host = `127.0.0.1:${port}`;
    if (body) {
      headers["content-length"] = String(body.length);
      delete headers["transfer-encoding"];
    }
    const out = http.request({
      host: "127.0.0.1", port, method: req.method, path: req.url, headers,
    }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.rawHeaders as unknown as http.OutgoingHttpHeaders);
      upstream.pipe(res);
      upstream.on("end", resolve);
      upstream.on("error", () => { res.destroy(); resolve(); });
    });
    out.on("error", () => {
      if (res.destroyed) return resolve();
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "ccc desktop service: session proxy unavailable" } }));
      resolve();
    });
    res.on("close", () => { if (!res.writableFinished) { out.destroy(); resolve(); } });
    if (body) out.end(body);
    else req.pipe(out);
  });
}

/** Where a WebSocket upgrade on a decrypted stream goes: api.anthropic.com, or a test's mock. */
function interceptUpstream(origin: string | undefined): InterceptUpstream {
  const url = new URL(origin ?? `https://${INTERCEPT_HOST}`);
  const secure = url.protocol === "https:";
  return { host: url.hostname, port: url.port ? Number(url.port) : secure ? 443 : 80, secure };
}

/**
 * Why a Desktop session in `cwd` must not run through ccc: its project's (or the user's,
 * re-read now) Claude Code settings turn on the Bash sandbox, whose proxy would forward
 * through this service with the token and lose its private-address check, or set a proxy,
 * NO_PROXY, CA or env file that breaks the routing (Codex r1 P1). Setup checks only what
 * it can see; each project is checked here, on its session's first model call.
 */
export function projectRefusal(cwd: string): string | undefined {
  const decision = httpsProxyModeDecision({
    env: { [HTTPS_PROXY_MODE_ENV]: "1" }, platform: process.platform, claudeArgs: [], cwd,
  });
  return decision.mode === "base-url" && decision.requested ? decision.reason : undefined;
}

/** The session's model calls get an error it shows, instead of running unprotected. */
function refuseSession(res: http.ServerResponse, reason: string): void {
  const message = `ccc desktop can't serve this session: ${reason}. Start it from another ` +
    "Desktop environment (without the ccc lines), or change that setting.";
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
}
