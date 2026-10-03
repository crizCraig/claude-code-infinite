/**
 * Claude Code Infinite local proxy (plans/2026-06-09_PLAN_local_proxy_app.md,
 * refined by plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 *
 * Claude Code points ANTHROPIC_BASE_URL at this 127.0.0.1 server. We never
 * read, store, or refresh credentials: Claude Code keeps its native login and
 * sends its own OAuth bearer here, and we forward its headers and query string
 * verbatim to api.anthropic.com (the anthropic-beta flag list churns across CC
 * versions — never reconstruct it). Only the `messages` body is ever altered
 * (compression, plus defensive removal of legacy notice markers);
 * auth, identity, and routing are never touched.
 *
 * Turn classification for POST /v1/messages:
 * - Tool turn (last message isn't a real user input): background indexing,
 *   forward as-is — riding its lane's memory route (routes live in a small
 *   map keyed by request identity: session + main/away/agent-id), on the main
 *   thread the session's stable prefix, or verbatim — while the estimated
 *   size is under the budget, with no compress call. At the budget it
 *   compresses once to the target (planToolCompaction), the same rule human
 *   turns follow; on the main thread the result becomes the stable prefix
 *   later tool and human turns ride. Failure degrades to the old ride or the
 *   verbatim forward. Every identity installs into its own lane — isolation
 *   is structural, not defended.
 * - First user turn (no earlier real user input): background indexing, forward
 *   as-is — nothing is indexed yet, so blocking would be a guaranteed no-op.
 * - Followup user turn: blocking compress + substitute. The compressed body
 *   remains the prefix for that turn's tool loop. On the main thread a
 *   compaction also becomes the session's stable prefix (planEdgeCompaction):
 *   later human turns ride it byte for byte, with no compress call, until
 *   prefix + newer turns reach the budget or the covered messages change.
 * - MemTree failure/timeout degrades to passthrough. A display-only success
 *   notice is queued only when the memory response is selected AND MemTree's
 *   index coverage grew since the last announcement (unchanged coverage means
 *   the turn was appended after an index that learned nothing new); degraded
 *   and unpaid states get their own notices.
 *
 * Every /v1/messages and count_tokens body is run through the legacy notice
 * strip pass before hashing/forwarding. Live notices use Claude Code hooks and
 * upstream response bytes pass through to the client unchanged.
 */
import { capCacheBreakpoints } from "./route-cache.js";
import { PromptAccounting } from "./prompt-accounting.js";
import { fitsFallbackBudget, RouteFallbackFailures } from "./route-fallback.js";
import { routeMessageHash, stablePrefixMessageHash } from "./route-identity.js";
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { brotliDecompressSync, createBrotliDecompress, createGunzip, createInflate, gunzipSync, inflateSync, } from "node:zlib";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedPromptTokenCount, checkCompressedHistory, didMemtreeCompress, MemtreeClient, modelBudgetTokens, normalizeMessagesForMemtree, serverFlattenedMessages, rawPromptTokenCount, } from "./memtree.js";
import { contextLimitForModel, hasEarlierNonToolUserMessage, isAwaySummaryUserMessage, isLocalBashCommandTurn, isNonToolUserMessage, isToolResultUserMessage, lastNonSystemMessage, messagesWithSystem, modelForMemtree, stripSystemReminderText, } from "./turns.js";
import { COMPRESSED_NOTICE, compressedTotalsText, DEGRADED_NOTICE, NOT_COMPRESSED_NOTE, recapLinkText, PAYMENT_REQUIRED_NOTICE, SseNoticeRewriter, sanitizeNoticeDetail, stripNoticeBlocks, stripNoticeSystem, } from "./notices.js";
import { NoticeDeliveryQueue, MEMTREE_COMPACT_COMMAND, MEMTREE_HELP_COMMAND, TRAILER_LABEL, LINK_LABEL, linkLines, isMemtreeViewCommand, sessionCommandArgs, parseNoticeHookInput, terminalSupportsColor, } from "./hooks.js";
import { MEMTREE_LINKS_MAX_SESSIONS } from "./memtree-links.js";
import { describeClaudeCodeRequest, inspectMonitorTranscript, isClaudeCodeSideRequest, memtreeClientMeta, sessionTag, } from "./cc-request.js";
import { approxTokensFromBytes, mergeUsageFromJsonBody, mergeUsageFromSseEvent, } from "./reqlog.js";
const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const HOOK_BODY_LIMIT = 64 * 1024;
// After a recovery attempt returns null (MemTree down, 5xx, or a burned
// timeout budget), suppress the blocking attempt for this long, across every
// lane. A lane's own growth backoff alone would let each over-budget tool turn
// pay the failed call again once its history grew past the retry size, and
// every other lane would pay it too — history grows every turn, so
// compress()'s complete-request dedup never absorbs the repeat.
// Long enough that a real outage costs one stall, short enough that a
// transient blip does not disable recovery for a working session.
const TOOL_RECOVERY_FAILURE_COOLDOWN_MS = 60_000;
const SKIP_REQUEST_HEADERS = new Set([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "upgrade",
    "proxy-authorization",
    "proxy-connection",
    "content-length", // recomputed for buffered/modified bodies
]);
const SKIP_RESPONSE_HEADERS = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
]);
/**
 * Budget fallback until the server reports `model_budget_tokens`: this share
 * of the model's context window (800k of Opus 5.5's 1M, matching the server's
 * large-context threshold).
 */
export const FALLBACK_BUDGET_WINDOW_RATIO = 0.8;
/**
 * An explicit target is capped at this share of the budget: a compaction to
 * the budget itself would be over budget again on the next turn and
 * recompress on every turn.
 */
const MAX_EXPLICIT_TARGET_BUDGET_RATIO = 0.9;
/** The server rejects smaller compression targets and thresholds. */
const SERVER_MIN_TARGET_TOKENS = 10_000;
/** Sessions whose stable prefix / passthrough size is kept (LRU). */
const STABLE_PREFIX_MAX_SESSIONS = 16;
/**
 * Background check of whether a lane's awaited tree exists: its page answers
 * 200 once built (202 while building). Any other answer stops the wait, so a
 * page that never resolves falls back to the growth backoff instead of
 * blocking compaction for good.
 */
function checkAwaitedIndex(opts, attempt, shutdownSignal) {
    const waiting = attempt.awaitingIndex;
    if (!waiting || waiting.checking || shutdownSignal.aborted)
        return;
    waiting.checking = true;
    // Bound both the individual body read and repeated 202 responses. A page
    // that never completes must eventually return the lane to growth backoff.
    const timeoutMs = Math.max(1, Math.min(opts.awaitedIndexProbeTimeoutMs ?? 5_000, waiting.deadline - Date.now()));
    const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(timeoutMs)]);
    opts.memtree
        .fetchMemTree(`/usage/memtree/${waiting.pageId}.json`, "application/json", signal)
        .then((page) => {
        if (page.status === 202 && Date.now() < waiting.deadline)
            return;
        if (attempt.awaitingIndex === waiting)
            attempt.awaitingIndex = undefined;
        // A finished tree is exactly what the backoff was waiting for.
        if (page.status === 200)
            attempt.retryAtTokens = undefined;
    })
        .catch(() => {
        if (attempt.awaitingIndex === waiting)
            attempt.awaitingIndex = undefined;
    })
        .finally(() => {
        waiting.checking = false;
    });
}
/** Growth (share of the budget) a lane waits for after an attempt that failed. */
const TOOL_COMPACTION_RETRY_BUDGET_RATIO = 0.05;
/**
 * Bound on concurrently held route lanes. A route entry is 0.4–4 MB of heap,
 * so 32 lanes is honestly ~128 MB worst case — accepted so a wide agent
 * fan-out (main + away + dozens of live subagents) cannot LRU-evict main's
 * route mid-turn; the cap is enforced by LRU eviction, not assumed.
 */
const MEMORY_ROUTE_MAX_LANES = 32;
const DEFERRED_MAIN_PROMPT_LIMIT = 32;
/**
 * The agent id a request is attributed by, preferring its own id over its
 * parent's. Absence of both is the definition of main-thread attribution, so
 * hasAgentAttribution is this same extraction asked as a yes/no question.
 */
function agentAttributionId(req) {
    return (firstNonEmptyHeader(req, "x-claude-code-agent-id") ??
        firstNonEmptyHeader(req, "x-claude-code-parent-agent-id"));
}
/**
 * Collision-free identity of a memory-route lane: the label the reqlog reports
 * and the key every map is addressed by, classified once from the same headers
 * so the two can never disagree. The tuple tags reserved main/away lanes
 * separately from agent ids, so an agent literally named "main" or "away"
 * cannot alias either reserved lane; JSON array encoding also prevents
 * delimiter collisions between arbitrary session and agent headers.
 * Keying by identity is what makes lane isolation structural: a request can
 * only ever reach its own lane, so foreign-route defense is unnecessary rather
 * than implemented.
 */
function routeIdentity(req, isAwaySummary) {
    const session = requestSessionId(req) ?? "";
    const agent = agentAttributionId(req);
    if (isAwaySummary) {
        return { lane: "away", key: JSON.stringify([session, "away"]) };
    }
    if (agent) {
        return { lane: "agent", key: JSON.stringify([session, "agent", agent]) };
    }
    return { lane: "main", key: JSON.stringify([session, "main"]) };
}
function firstNonEmptyHeader(req, name) {
    const value = req.headers[name];
    const text = Array.isArray(value)
        ? value.find((item) => item.trim() !== "")
        : value;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
}
/** Record notice context without changing any route. */
function recordMainPromptNotice(state, promptId, prompt) {
    state.mainNoticePending = true;
    state.mainPromptId = promptId;
    state.mainPromptText = prompt;
    state.mainPromptGeneration++;
    state.notices.clearForUserRequest();
}
/** Snapshot display accounting before asynchronous work. It never controls forwarding. */
function capturePromptDelivery(state, isMainRequest, lastMsg, sessionId) {
    return { settle: isMainRequest
            ? state.promptAccounting.capture(sessionId, lastMsg) : () => { } };
}
/** Lookup a validated route and update its LRU position. */
function getMemoryRoute(state, key) {
    const route = state.memoryRoutes.get(key);
    if (!route)
        return undefined;
    if (route.routeEpoch !== state.mainRouteEpoch) {
        state.memoryRoutes.delete(key);
        return undefined;
    }
    state.memoryRoutes.delete(key);
    state.memoryRoutes.set(key, route);
    return route;
}
function setMemoryRoute(state, key, route) {
    state.memoryRoutes.delete(key);
    state.memoryRoutes.set(key, route);
    while (state.memoryRoutes.size > MEMORY_ROUTE_MAX_LANES) {
        const oldest = state.memoryRoutes.keys().next().value;
        if (oldest === undefined)
            break;
        state.memoryRoutes.delete(oldest);
    }
}
function resolveUpstream(opts) {
    const url = new URL(opts.upstreamOrigin ?? DEFAULT_UPSTREAM);
    const secure = url.protocol === "https:";
    return {
        module: secure ? https : http,
        host: url.hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
    };
}
export function startProxy(opts) {
    const upstream = resolveUpstream(opts);
    const hookPath = `/_ccc/hooks/${randomBytes(24).toString("hex")}`;
    const activeRequests = new Set();
    const acceptedRequests = new Set();
    const shutdownAbort = new AbortController();
    const state = {
        paymentNoticeShown: false,
        notices: new NoticeDeliveryQueue(),
        mainNoticePending: false,
        mainPromptGeneration: 0,
        promptAccounting: new PromptAccounting(),
        fallbackFailures: new RouteFallbackFailures(),
        activeSubagents: new Set(),
        memoryRoutes: new Map(),
        mainRouteEpoch: 0,
        mainRouteDecisionGeneration: 0,
        routeDecisionsLive: new Map(),
        retiredRouteDecisionFloor: 0,
        toolRecoveryAttemptedLanes: new Map(),
        toolRecoveryCooldownUntil: 0,
        shutdownSignal: shutdownAbort.signal,
        routeInstallFault: opts.routeInstallFault,
        memtreePages: new Map(),
        memtreeCallSeq: 0,
        memtreeLinkStore: opts.memtreeLinkStore,
        memtreeLinkPlacement: opts.memtreeLinkPlacement ?? "turn",
        compactTargets: new Map(),
        defaultCompactOff: opts.defaultCompactTarget === null,
        compactNow: new Set(),
        stablePrefixes: new Map(),
        serverBudgets: new Map(),
        serverReportsBudget: false,
        passthroughSizes: new Map(),
        laneSizes: new Map(),
    };
    installMemtreeLink(state, state.memtreeLinkPlacement);
    const server = http.createServer((req, res) => {
        const accepted = { req, res };
        acceptedRequests.add(accepted);
        const task = handleRequest(req, res, opts, upstream, state, hookPath).catch((err) => {
            try {
                sendAnthropicError(res, `local proxy error: ${err?.message ?? err}`);
            }
            catch {
                // A failed error response must not strand shutdown bookkeeping.
            }
        });
        activeRequests.add(task);
        void task.then(() => {
            activeRequests.delete(task);
            acceptedRequests.delete(accepted);
        }, () => {
            activeRequests.delete(task);
            acceptedRequests.delete(accepted);
        });
        if (shutdownAbort.signal.aborted)
            cancelAcceptedRequest(accepted);
    });
    // Long-running SSE responses must not be cut by idle timeouts.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    let closePromise;
    const beginClose = () => {
        if (closePromise)
            return closePromise;
        closePromise = new Promise((done) => {
            if (!server.listening) {
                done();
                return;
            }
            server.close(() => done());
        });
        return closePromise;
    };
    const drain = async (timeoutMs = 5_000) => {
        const boundedMs = Number.isFinite(timeoutMs) && timeoutMs >= 0
            ? Math.floor(timeoutMs)
            : 5_000;
        const quiesced = (async () => {
            // Once close completes, every accepted request has entered the tracked
            // set.
            await beginClose();
            while (activeRequests.size > 0) {
                await Promise.allSettled([...activeRequests]);
            }
        })();
        let timer;
        const completed = await Promise.race([
            quiesced.then(() => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), boundedMs);
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        if (completed)
            return true;
        // The grace period protects useful in-flight delivery. Once it
        // expires, signal every forwarding path first so each can
        // classify the close as proxy-owned, then tear down any request that was
        // still reading/dispatching before it installed a path-specific listener.
        shutdownAbort.abort();
        for (const accepted of acceptedRequests)
            cancelAcceptedRequest(accepted);
        await quiesced;
        return false;
    };
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            resolve({
                port,
                hookUrl: `http://127.0.0.1:${port}${hookPath}`,
                close: () => {
                    void beginClose();
                },
                drain,
            });
        });
    });
}
/** Final safety net for handlers that have not reached an upstream path yet. */
function cancelAcceptedRequest(accepted) {
    const { req, res } = accepted;
    if (!req.complete && !req.destroyed) {
        // A pass-through upload may not otherwise have an IncomingMessage error
        // listener; consume this proxy-owned teardown error after body readers see it.
        req.once("error", () => { });
        req.destroy(new Error("proxy shutdown"));
    }
    if (!res.destroyed && !res.writableEnded)
        res.destroy();
}
async function handleRequest(req, res, opts, upstream, state, hookPath) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (!isLocalCaller(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "The ccc proxy only serves programs on this machine" }));
        return;
    }
    if (url.pathname === hookPath) {
        return handleNoticeHook(req, res, state, opts.reqlog);
    }
    if (req.method === "GET" &&
        (url.pathname === MEMTREE_CURRENT_PATH || url.pathname === `${MEMTREE_CURRENT_PATH}.json`)) {
        return handleMemTreeCurrent(req, res, opts, state, url);
    }
    const finderPath = req.method === "GET" ? MEMTREE_FINDER_RELAY.get(url.pathname) : undefined;
    if (finderPath) {
        return handleMemTreeFinder(req, res, opts, finderPath, url);
    }
    if (req.method === "GET" && url.pathname.startsWith(MEMTREE_PASSTHROUGH_PREFIX)) {
        return handleMemTreePassthrough(req, res, opts, url);
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
        return handleMessages(req, res, opts, upstream, state);
    }
    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        return handleCountTokens(req, res, opts, upstream, state);
    }
    return passThroughStreaming(req, res, upstream, state.shutdownSignal);
}
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BROWSER_SAME_SITE = new Set(["same-origin", "none"]);
/**
 * Every route acts with the user's MemTree key (the `/memtree/*` relay reads
 * their trees; `/v1/messages` indexes and compresses on their account), so only
 * callers on this machine may use the proxy: Claude Code, agents (curl, the MCP
 * server) and the MemTree page itself when opened from the loopback. A web page
 * on another site can reach the loopback too, either directly (its `origin` or
 * `sec-fetch-site` says so) or by rebinding its own hostname to 127.0.0.1 (its
 * `host` then names it). Same-origin means this exact host and port.
 */
function isLocalCaller(req) {
    const host = req.headers.host;
    if (!host || !isLoopbackHost(host))
        return false;
    const origin = req.headers.origin;
    if (origin !== undefined && !isSameLoopbackOrigin(origin, host))
        return false;
    const site = req.headers["sec-fetch-site"];
    return site === undefined || BROWSER_SAME_SITE.has(String(site));
}
function isLoopbackHost(host) {
    try {
        const url = new URL(`http://${host}`);
        return url.host === host.toLowerCase() && LOOPBACK_HOSTNAMES.has(url.hostname);
    }
    catch {
        return false;
    }
}
function isSameLoopbackOrigin(origin, host) {
    try {
        const url = new URL(origin);
        return url.protocol === "http:" && url.host === new URL(`http://${host}`).host;
    }
    catch {
        return false;
    }
}
/** Loopback prefix for reading the user's own MemTree pages through this proxy. */
const MEMTREE_PASSTHROUGH_PREFIX = "/memtree/";
/**
 * `<request id>`, `<request id>.json`, `<request id>/session.json` (the
 * page's session pane), `<request id>/search` (the server's term search over
 * that tree, `?q=&limit=`), or `sessions/<Claude Code session id>.json` (every
 * page from one session, newest first); nothing that could walk the upstream
 * path. The id is the request UUID or the server's short form of it (leading
 * hex, as in the `/m/<id>` links it hands out) — the server accepts both.
 */
const MEMTREE_PASSTHROUGH_TARGET_RE = /^(?:[A-Za-z0-9-]+(\.json|\/session\.json|\/search)?|sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json)$/;
/**
 * `GET /memtree/<id>[.json][?share=…]` on the loopback: read the user's own
 * MemTree page with their key. Claude Code's child env already carries this
 * server as ANTHROPIC_BASE_URL, so an agent inside a ccc session needs no key
 * handling — the polychat page's 401 body points here first. The upstream
 * response is relayed as-is (status, content type, body); the key never
 * leaves this process.
 */
async function handleMemTreePassthrough(req, res, opts, url) {
    const target = url.pathname.slice(MEMTREE_PASSTHROUGH_PREFIX.length);
    if (!MEMTREE_PASSTHROUGH_TARGET_RE.test(target)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "Not Found" }));
        return;
    }
    try {
        const upstream = await opts.memtree.fetchMemTree(`/usage/memtree/${target}${url.search}`, req.headers.accept ?? "application/json");
        res.writeHead(upstream.status, { "content-type": upstream.contentType });
        res.end(upstream.body);
    }
    catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `MemTree fetch failed: ${String(err)}` }));
    }
}
/**
 * Loopback routes for finding things across the user's own sessions, relayed
 * to the server's owner-only endpoints with the user's key (which never
 * leaves this process): `GET /memtree/sessions?…` lists sessions, `GET
 * /memtree/search?…` searches their trees. Exact paths only; the query string
 * goes on unchanged (the URL parser has already split off any path or
 * fragment). Matched before the page relay, whose id pattern would otherwise
 * take them for page ids.
 *
 * The project meta goes along in `x-client-meta`, and the caller's Claude
 * Code session id when it sends one, so a charged (vector) search's usage row
 * says where it came from.
 */
const MEMTREE_FINDER_RELAY = new Map([
    [`${MEMTREE_PASSTHROUGH_PREFIX}sessions`, "/v1/memtree/sessions"],
    [`${MEMTREE_PASSTHROUGH_PREFIX}search`, "/v1/memtree/search"],
]);
const SESSION_ID_HEADER_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
async function handleMemTreeFinder(req, res, opts, upstreamPath, url) {
    const headers = {};
    const meta = memtreeClientMeta({ project: opts.projectMeta });
    if (Object.keys(meta).length)
        headers["x-client-meta"] = JSON.stringify(meta);
    const sessionId = firstNonEmptyHeader(req, "x-claude-code-session-id");
    if (sessionId && SESSION_ID_HEADER_VALUE.test(sessionId)) {
        headers["x-claude-code-session-id"] = sessionId;
    }
    try {
        const upstream = await opts.memtree.fetchMemTree(`${upstreamPath}${url.search}`, req.headers.accept ?? "application/json", undefined, headers);
        res.writeHead(upstream.status, { "content-type": upstream.contentType });
        res.end(upstream.body);
    }
    catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `MemTree fetch failed: ${String(err)}` }));
    }
}
/**
 * `GET /memtree/current[.json][?session=<Claude Code session id>]`: the page
 * the session's newest main request was served from — what the `memtree` MCP server
 * reads (memtree-mcp.ts). Bare `current` answers the pointer
 * `{id, url, index, session_id, compressed}` without an upstream call, so the
 * MCP server can keep its cached tree until the page changes; `current.json`
 * relays the page JSON itself, like `/memtree/<id>.json`.
 *
 * Every pointer is scoped to the caller's exact session id. Missing session
 * ids never fall back to another conversation served by the same proxy.
 */
async function handleMemTreeCurrent(req, res, opts, state, url) {
    const sessionId = url.searchParams.get("session") || undefined;
    const page = currentMemtreePage(state, sessionId);
    const id = page ? memtreePageId(page.url) : undefined;
    if (!page || !id) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "No MemTree page for this session yet" }));
        return;
    }
    if (!url.pathname.endsWith(".json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id,
            url: page.url,
            index: page.index,
            session_id: page.sessionId ?? null,
            compressed: page.compressed,
        }));
        return;
    }
    try {
        const upstream = await opts.memtree.fetchMemTree(`/usage/memtree/${id}.json`, req.headers.accept ?? "application/json");
        res.writeHead(upstream.status, {
            "content-type": upstream.contentType,
            "x-memtree-page": page.url,
        });
        res.end(upstream.body);
    }
    catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `MemTree fetch failed: ${String(err)}` }));
    }
}
const MEMTREE_CURRENT_PATH = `${MEMTREE_PASSTHROUGH_PREFIX}current`;
function currentMemtreePage(state, sessionId) {
    if (!sessionId)
        return undefined;
    const latest = state.memtreePages.get(sessionId);
    if (latest)
        return latest;
    const stored = state.memtreeLinkStore?.get(sessionId);
    return stored ? { ...stored, sessionId } : undefined;
}
/** The page id in a server-stamped link (`…/m/<id>` or `…/usage/memtree/<id>`). */
export function memtreePageId(pageUrl) {
    try {
        const match = /\/(?:m|usage\/memtree)\/([A-Za-z0-9-]+?)(?:\.json)?$/.exec(new URL(pageUrl).pathname);
        return match?.[1];
    }
    catch {
        return undefined;
    }
}
/** Serve only validated Claude hook POSTs on the randomized localhost path. */
async function handleNoticeHook(req, res, state, reqlog) {
    if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
    }
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > HOOK_BODY_LIMIT) {
        res.writeHead(413);
        res.end();
        req.resume();
        return;
    }
    const raw = await readBody(req);
    if (raw.length > HOOK_BODY_LIMIT) {
        res.writeHead(413);
        res.end();
        return;
    }
    let input;
    try {
        input = JSON.parse(raw.toString("utf-8"));
    }
    catch {
        res.writeHead(400);
        res.end();
        return;
    }
    const parsed = parseNoticeHookInput(input);
    if (!parsed) {
        res.writeHead(400);
        res.end();
        return;
    }
    if (parsed.hook_event_name === "SessionStart") {
        const line = resumeLinkLine(state, parsed);
        if (!line) {
            res.writeHead(204);
            res.end();
            return;
        }
        const body = Buffer.from(JSON.stringify({ systemMessage: line }), "utf-8");
        res.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(body.length),
            "cache-control": "no-store",
        });
        res.end(body);
        return;
    }
    if (parsed.hook_event_name === "UserPromptSubmit") {
        // `/memtree-view`: answered here and blocked, so no model turn runs and
        // the prompt never enters the conversation. Not a human turn either, so
        // none of the turn state below is touched.
        const commandReply = parsed.agent_id === undefined
            ? sessionCommandReply(state, parsed.session_id, parsed.prompt)
            : undefined;
        if (commandReply !== undefined) {
            const body = Buffer.from(JSON.stringify({
                decision: "block",
                reason: commandReply,
                // Claude Code otherwise repeats "Original prompt: /ccc:memtree-view"
                // under the answer. Older releases ignore the flag.
                hookSpecificOutput: {
                    hookEventName: "UserPromptSubmit",
                    suppressOriginalPrompt: true,
                },
            }), "utf-8");
            res.writeHead(200, {
                "content-type": "application/json",
                "content-length": String(body.length),
                "cache-control": "no-store",
            });
            res.end(body);
            return;
        }
        if (parsed.agent_id === undefined) {
            state.promptAccounting.add(parsed.session_id, parsed.prompt_id, parsed.prompt);
            recordMainPromptNotice(state, parsed.prompt_id, parsed.prompt);
        }
        res.writeHead(204);
        res.end();
        return;
    }
    if (parsed.hook_event_name === "SubagentStart") {
        state.activeSubagents.add(parsed.agent_id);
        res.writeHead(204);
        res.end();
        return;
    }
    if (parsed.hook_event_name === "SubagentStop") {
        state.activeSubagents.delete(parsed.agent_id);
        res.writeHead(204);
        res.end();
        return;
    }
    const stopMatchesMainPrompt = parsed.hook_event_name === "Stop" &&
        parsed.agent_id === undefined &&
        (state.mainPromptId === undefined ||
            parsed.prompt_id === undefined ||
            state.mainPromptId === parsed.prompt_id ||
            (parsed.prompt_id !== undefined && state.promptAccounting.hasId(parsed.prompt_id)));
    const output = parsed.hook_event_name === "Stop" && !stopMatchesMainPrompt
        ? null
        : state.notices.claim(parsed);
    if (stopMatchesMainPrompt) {
        state.mainNoticePending = false;
        state.mainPromptId = undefined;
        state.mainPromptText = undefined;
        // Invalidate a response still in flight at Stop. Otherwise its late
        // delivery callback could enqueue a notice after Stop returned.
        state.mainPromptGeneration++;
        // Subagent lifetimes are independent; only their own stop events retire them.
    }
    if (!output) {
        res.writeHead(204);
        res.end();
        return;
    }
    if (parsed.hook_event_name === "MessageDisplay" ||
        parsed.hook_event_name === "Stop") {
        try {
            reqlog?.log({
                kind: "notice",
                event: "claimed",
                via: parsed.hook_event_name,
            });
        }
        catch {
            // Custom/test loggers get RequestLogger's never-break-hook policy.
        }
    }
    const body = Buffer.from(JSON.stringify(output), "utf-8");
    res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "no-store",
    });
    res.end(body);
}
/**
 * Hook-prompt correlation: true only when the armed typed prompt appears as a
 * deliberate top-level text block of the user message — the whole block, or
 * its start/end (Claude Code may append/prepend ambient text around a merged
 * queued prompt). Matching runs on reminder-stripped block text so a
 * coincidental substring inside an appended <system-reminder> (or buried
 * mid-sentence in unrelated text) can never claim or consume the arm.
 */
function messageCarriesPromptText(message, promptText) {
    const prompt = promptText.trim();
    if (!prompt)
        return false;
    if (!message || message.role !== "user")
        return false;
    const content = message.content;
    const parts = typeof content === "string"
        ? [content]
        : Array.isArray(content)
            ? content.map((part) => {
                if (typeof part === "string")
                    return part;
                return part?.type === "text" && typeof part.text === "string"
                    ? part.text
                    : "";
            })
            : [];
    return parts.some((part) => {
        const text = stripSystemReminderText(part);
        return (text === prompt || text.startsWith(prompt) || text.endsWith(prompt));
    });
}
/** Buffer + inspect /v1/messages; classify the turn, strip notices, forward. */
async function handleMessages(req, res, opts, upstream, state) {
    const received = Date.now();
    const rawBody = await readBody(req);
    // One request-log record per /v1/messages, filled in as the request flows
    // through the forward path and written exactly once when the response is
    // done (success or failure) — always on, so a stalled turn leaves a trace.
    const rec = {
        kind: "messages",
        turnType: "unparseable",
        requestBytes: rawBody.length,
    };
    const logged = async (forward) => {
        try {
            await forward;
        }
        finally {
            if (rec.totalMs === undefined)
                rec.totalMs = Date.now() - received;
            opts.reqlog?.log(rec);
        }
    };
    if (opts.claudeCodeOnly && requestSessionId(req) === undefined) {
        rec.turnType = "foreign";
        rec.forwardedBytes = rawBody.length;
        const agent = firstNonEmptyHeader(req, "user-agent");
        if (agent)
            rec.userAgent = agent.slice(0, 80);
        return logged(forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec));
    }
    let body;
    try {
        body = JSON.parse(rawBody.toString("utf-8"));
        if (!Array.isArray(body.messages))
            throw new Error("no messages array");
    }
    catch {
        // Not a shape we understand — forward verbatim rather than break the session.
        return logged(forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec));
    }
    // Defensive legacy strip pass first: old marker-wrapped notices (including
    // one copied into an away-summary or top-level system prompt) must never
    // reach Anthropic or MemTree. Hook-delivered notices never enter this body.
    const stripped = stripNoticeBlocks(body.messages);
    const strippedSystem = stripNoticeSystem(body.system);
    let forwardBody = rawBody;
    if (stripped.stripped || strippedSystem.stripped) {
        body.messages = stripped.messages;
        if (strippedSystem.system === undefined)
            delete body.system;
        else
            body.system = strippedSystem.system;
        forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
        if (opts.debug)
            console.error("[ccc proxy] stripped legacy notice span(s) from request");
    }
    const messages = body.messages;
    // CC 2.1.207 appends ambient role=system blocks after the typed prompt. Use
    // the last non-system conversation message for classification while keeping
    // every system block in the body sent to MemTree/Anthropic.
    const lastMsg = lastNonSystemMessage(messages);
    const isUserTurn = isNonToolUserMessage(lastMsg);
    const isToolResultTurn = isToolResultUserMessage(lastMsg);
    const isAwaySummary = isAwaySummaryUserMessage(lastMsg);
    // Neither a prompt nor a tool result: a background task notification
    // arrives as a trailing role=system block after the assistant's last reply,
    // so the last conversation message is that reply. It carries the whole
    // history like any turn and must live by the budget like a tool turn; it
    // once fell through every branch and forwarded the uncompacted 4.4MB
    // history (Prompt is too long, 2026-09-30).
    const isContinuationTurn = lastMsg !== undefined && !isUserTurn && !isToolResultTurn;
    // Claude Code's security monitor re-sends the whole session as one
    // `<transcript>` message after most actions. Before this check it looked
    // like a main-thread followup: it bumped the route epoch (wiping the main
    // tool loop's compressed route mid-turn, forcing a blocking recompress),
    // cost a MemTree passthrough, and started a from-scratch index of a
    // conversation that already has one. It must touch none of that state, so
    // it is handled here, before anything below mutates it. Anthropic already
    // caches its append-only transcript well, so it goes out verbatim.
    let clientInfo;
    try {
        clientInfo = describeClaudeCodeRequest(body);
        if (clientInfo.suspectedSideRequest) {
            clientInfo.sessionTag = sessionTag(requestSessionId(req));
        }
    }
    catch {
        // logging only; never affects the request
    }
    // The header rule alone is not enough: Claude Code releases before
    // cc_turn_origin existed send main-thread requests with no turn origin, so
    // the monitor's <transcript> block must also be recognised. A candidate
    // whose transcript does not match keeps the ordinary handling (the
    // pre-existing behaviour) and records why, so a format change in Claude
    // Code shows up in requests.jsonl instead of silently misrouting.
    let sideRequest = false;
    if (clientInfo && isClaudeCodeSideRequest(clientInfo)) {
        try {
            rec.transcript = inspectMonitorTranscript(body);
            sideRequest = rec.transcript.ok;
            if (!rec.transcript.ok) {
                console.error(`[ccc proxy] possible side request, transcript format not recognised ` +
                    `(${rec.transcript.reason}${rec.transcript.badLine ? ` at line ${rec.transcript.badLine}` : ""}); ` +
                    `handled as an ordinary request. Claude Code may have changed the monitor format.`);
            }
        }
        catch {
            // never let the format check affect the request
        }
    }
    if (sideRequest && clientInfo) {
        if (typeof body.model === "string")
            rec.model = body.model;
        rec.stream = body.stream === true;
        rec.client = clientInfo;
        recordTurn(rec, "side-request", forwardBody);
        capture(opts, "anthropic-request-side", forwardBody);
        return logged(forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, rec));
    }
    if (isAwaySummary && state.memtreeLinkPlacement !== "off") {
        const sessionId = requestSessionId(req);
        recapLinkAppenders.set(req, (streamedTextChars) => {
            const latest = currentMemtreePage(state, sessionId);
            if (!latest || (sessionId !== undefined && latest.sessionId !== undefined && latest.sessionId !== sessionId)) {
                return undefined;
            }
            return recapLinkText(latest.url, streamedTextChars, latest.compressed ? undefined : NOT_COMPRESSED_NOTE, { hyperlinks: terminalSupportsColor() });
        });
    }
    const isLocalBashCommand = isLocalBashCommandTurn(messages);
    // CC 2.1.207 identifies agent API calls explicitly. Use that wire-level
    // attribution before lifecycle-hook state so an agent request cannot claim
    // or consume a main prompt arm even if SubagentStart ordering is delayed.
    const { lane: requestRouteLane, key: requestRouteKey } = routeIdentity(req, isAwaySummary);
    const isSubagentRequest = requestRouteLane === "agent";
    const isMainRequest = requestRouteLane === "main";
    rec.routeLane = requestRouteLane;
    // Stored by the server on the usage row (client_meta): which Claude Code,
    // lane, agent and model produced this request.
    const clientMeta = memtreeClientMeta({
        info: clientInfo,
        lane: requestRouteLane,
        agentId: firstNonEmptyHeader(req, "x-claude-code-agent-id"),
        parentAgentId: firstNonEmptyHeader(req, "x-claude-code-parent-agent-id"),
        model: body.model,
        project: opts.projectMeta,
    });
    // API identity and validated history alone govern route eligibility.
    const rideableCandidate = getMemoryRoute(state, requestRouteKey);
    const existingRide = rideableCandidate && memoryRoutedToolBody(body, messages, rideableCandidate, state.mainRouteEpoch, requestSessionId(req));
    const isFollowupUserTurn = isUserTurn && hasEarlierNonToolUserMessage(messages);
    const routeEpoch = state.mainRouteEpoch;
    let routeDecisionGeneration = state.mainRouteDecisionGeneration;
    let routeDecisionSettled = false;
    const toolForwarding = capturePromptDelivery(state, isMainRequest, lastMsg, requestSessionId(req));
    if (isFollowupUserTurn) {
        routeDecisionGeneration = ++state.mainRouteDecisionGeneration;
        reserveRouteDecision(state, requestRouteKey, routeDecisionGeneration);
    }
    const hookOwnedMainFollowup = isFollowupUserTurn &&
        !isAwaySummary &&
        !isSubagentRequest &&
        state.mainNoticePending &&
        state.mainPromptText !== undefined &&
        messageCarriesPromptText(lastMsg, state.mainPromptText);
    // Local `!command` turns do not consistently emit UserPromptSubmit, and the
    // API history contains bash wrappers rather than the literal typed command.
    // Their strict main-thread replay shape can safely own its own notice.
    const localCommandMainFollowup = isFollowupUserTurn &&
        !isAwaySummary &&
        !isSubagentRequest &&
        isLocalBashCommand;
    const displayForThisTurn = (hookOwnedMainFollowup || localCommandMainFollowup) &&
        state.activeSubagents.size === 0;
    const noticePromptId = state.mainPromptId;
    const noticePromptGeneration = state.mainPromptGeneration;
    // Extended 1M context arrives as the `context-1m` beta header (Claude Code
    // strips the `[1m]` model suffix on the wire). Current native-1M models send
    // neither, so contextLimitForModel also needs the launcher's native setting.
    const modelContextLimit = contextLimitForModel(body.model, headerText(req.headers, "anthropic-beta"), opts.nativeOneMillionContext !== false);
    requestSendPolicies.set(req, {
        original: rawBody,
        failedRebuild: false,
        allowed: new WeakSet(),
        accept: (buffer) => {
            const allowed = requestSendPolicies.get(req).allowed;
            if (allowed.has(buffer)) {
                if (!routedBodyExceedsContext(body, buffer, modelContextLimit))
                    return true;
                allowed.delete(buffer);
            }
            const budget = resolveBudget(opts, state, body.model, modelContextLimit);
            const sample = isMainRequest && requestSessionId(req)
                ? state.passthroughSizes.get(requestSessionId(req)) : state.laneSizes.get(requestRouteKey);
            const estimatedInput = estimateRequestTokens(sample, rawBody.length).tokens;
            if (fitsFallbackBudget(estimatedInput, typeof body.max_tokens === "number" ? Math.max(0, body.max_tokens) : 0, budget.tokens, modelContextLimit))
                return true;
            const failure = state.fallbackFailures.fail(requestRouteKey);
            rec.forwardedBytes = 0;
            rec.approxInputTokens = 0;
            console.error("[ccc proxy] request exceeds compaction budget; recovery failed", {
                lane: requestRouteKey, attempt: failure.attempt, status: failure.status,
                inputTokens: estimatedInput, outputTokens: body.max_tokens ?? 0,
                budgetTokens: budget.tokens, modelContextLimit,
            });
            res.writeHead(failure.status, { "content-type": "application/json", ...failure.headers });
            res.end(JSON.stringify(failure.body));
            return false;
        },
        delivered: () => { state.fallbackFailures.succeeded(requestRouteKey); toolForwarding.settle(true); },
    });
    const rawMsgsForMemtree = messagesWithSystem(messages, body.system);
    const msgsForMemtree = normalizeMessagesForMemtree(rawMsgsForMemtree);
    const hash = MemtreeClient.hashMessages(msgsForMemtree);
    // Hook state controls notices only. Hidden requests cannot consume main notices.
    if (typeof body.model === "string")
        rec.model = body.model;
    rec.stream = body.stream === true;
    // Observation only: which requests carry Claude Code's turn origin.
    if (clientInfo)
        rec.client = clientInfo;
    if (!isFollowupUserTurn) {
        // Tool turn or FIRST user turn: keep the index fed off the response path
        // and forward as-is (on the lane's memory route or the session's stable
        // prefix when one applies) — except a tool turn whose estimated size
        // reached the budget, which compresses once to the target below
        // (planToolCompaction), exactly like a main human turn.
        // On the first user turn nothing is indexed yet, so a blocking compress
        // would be a guaranteed no-op costing first-token latency
        // (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
        if (opts.debug && isUserTurn) {
            console.error("[ccc proxy] first user turn: index in background, forward verbatim");
        }
        let routedBody = forwardBody;
        let routedTool = false;
        let routeMiss;
        if (isToolResultTurn || isContinuationTurn || isUserTurn) {
            // Reuse only this API session/lane's independently validated prefix.
            const activeRoute = rideableCandidate;
            if (activeRoute) {
                const rewritten = memoryRoutedToolBody(body, messages, activeRoute, state.mainRouteEpoch, requestSessionId(req));
                const overContextWindow = rewritten !== null &&
                    routedBodyExceedsContext(body, rewritten, modelContextLimit);
                if (rewritten && !overContextWindow) {
                    routedBody = rewritten;
                    routedTool = true;
                    if (opts.debug) {
                        console.error("[ccc proxy] tool turn matched active memory route");
                    }
                }
                else {
                    // A mismatch means a different/resumed conversation shape, or two
                    // requesters colliding on one lane (children sharing only a
                    // parent-agent-id land on the same key; their prefix hashes
                    // disagree and the loser lands here). A route stored under this key
                    // always carries this requester's session id — installMemoryRoute
                    // derives both from the same request — so this is by construction a
                    // same-session divergence: rebuild while retaining the previous route.
                    // A matching route that outgrew the request's resolved window must
                    // also rebuild; a smaller window lifts the lane's backoff.
                    routeMiss = "rejected";
                    if (overContextWindow) {
                        regrantSmallerWindowRecovery(state, requestRouteKey, modelContextLimit);
                    }
                    if (opts.debug) {
                        console.error("[ccc proxy] tool turn rejected active memory route");
                    }
                }
            }
            else {
                routeMiss = "missing";
                if (opts.debug) {
                    console.error("[ccc proxy] tool turn has no active memory route");
                }
            }
        }
        const toolSessionId = requestSessionId(req);
        // A concurrently replaced stable prefix takes precedence over an older
        // route. The current prefix still undergoes its own history validation.
        if (routedTool &&
            isMainRequest &&
            toolSessionId !== undefined &&
            rideableCandidate?.stablePrefix !== state.stablePrefixes.get(toolSessionId)) {
            routedTool = false;
            routedBody = forwardBody;
            routeMiss = "superseded";
        }
        if (routeMiss !== undefined)
            rec.routeMiss = routeMiss;
        if (isContinuationTurn)
            rec.continuation = true;
        // Cheap shape check: without an earlier real user message there is
        // nothing MemTree could compress, so no attempt is worth making.
        const canCompress = hasEarlierNonToolUserMessage(messages);
        let toolRide = routedTool
            ? {
                raw: routedBody,
                turnType: "tool-memory",
                sizeHolder: rideableCandidate.stablePrefix ?? rideableCandidate,
            }
            : undefined;
        let toolNeedsOriginal = false;
        if (opts.toolRouteRecovery === false) {
            // Kill switch: no size check and no compress call on any tool turn.
            // A route still rides; a miss forwards whole and records "disabled".
            if ((routeMiss === "missing" || routeMiss === "rejected") && canCompress) {
                rec.routeRecovery = { outcome: "disabled" };
            }
        }
        else if (isToolResultTurn || isContinuationTurn || (isUserTurn && !!existingRide)) {
            // Every lane's tool turn lives by the budget, like a main human turn:
            // under it, forward (on the lane's route or the session's stable
            // prefix, else whole) with no compress call; at it, compress once to
            // the target (planToolCompaction). A "replay" is a client retry of the
            // request that installed the route, forwarded verbatim.
            const plan = planToolCompaction({
                opts,
                state,
                body,
                messages,
                sessionId: toolSessionId,
                routeKey: requestRouteKey,
                isMainRequest,
                modelContextLimit,
                forwardBody,
                rec,
                ride: toolRide,
                canCompress,
            });
            if (plan.kind === "ride")
                toolRide = plan.ride;
            if (plan.kind === "pass" && plan.original) {
                toolRide = undefined;
                toolNeedsOriginal = true;
            }
            if (plan.kind === "compress") {
                requestSendPolicies.get(req).failedRebuild = true;
                // Clear the caller's old ride before any in-flight/backoff/cooldown
                // exit. An over-window prefix cannot remain the implicit fallback.
                toolRide = plan.fallback;
                toolNeedsOriginal = plan.overWindow;
                const prior = state.toolRecoveryAttemptedLanes.get(requestRouteKey);
                if (prior?.awaitingIndex && Date.now() >= prior.awaitingIndex.deadline) {
                    prior.awaitingIndex = undefined;
                }
                if (prior?.inFlight || (!prior && state.toolRecoveryAttemptedLanes.size >= 128 &&
                    [...state.toolRecoveryAttemptedLanes.values()].every((attempt) => attempt.inFlight))) {
                    // A concurrent request of this lane is already compressing.
                    rec.routeRecovery = { outcome: "in-flight" };
                }
                else if (prior?.awaitingIndex && !plan.overWindow) {
                    // The last attempt found no tree for this conversation, so a
                    // compress call could only pass everything through again. Forward
                    // now; the page check lets the next tool turn try once it exists.
                    rec.routeRecovery = { outcome: "awaiting-index" };
                    checkAwaitedIndex(opts, prior, state.shutdownSignal);
                }
                else if (prior?.retryAtTokens !== undefined &&
                    plan.estimateTokens < prior.retryAtTokens &&
                    Date.now() < (prior.retryDeadline ?? 0)) {
                    // This lane's last attempt this human turn produced nothing; wait
                    // for growth instead of paying a blocking call on every tool turn.
                    rec.routeRecovery = { outcome: "backoff" };
                }
                else if (Date.now() < state.toolRecoveryCooldownUntil) {
                    // A recent attempt burned the full compress budget and still
                    // failed. Every tool turn appends a tool_result and rehashes, so
                    // compress() dedup can never absorb the repeat: without this
                    // cooldown a MemTree outage would add the whole blocking budget to
                    // every tool turn over the budget. A cooldown skip does not start
                    // the lane's backoff.
                    rec.routeRecovery = { outcome: "cooldown" };
                }
                else {
                    const recoveryAttempt = { modelContextLimit, inFlight: true };
                    if (!prior && state.toolRecoveryAttemptedLanes.size >= 128) {
                        const idle = [...state.toolRecoveryAttemptedLanes].find(([, attempt]) => !attempt.inFlight);
                        if (idle)
                            state.toolRecoveryAttemptedLanes.delete(idle[0]);
                    }
                    state.toolRecoveryAttemptedLanes.set(requestRouteKey, recoveryAttempt);
                    // Serialized non-system conversation bytes, for the record only —
                    // computed only when an attempt is made.
                    const conversationBytes = Buffer.byteLength(JSON.stringify(messages.filter((m) => m.role !== "system")), "utf-8");
                    return logged(recoverToolRouteMiss({
                        opts,
                        state,
                        req,
                        res,
                        upstream,
                        body,
                        messages,
                        forwardBody: plan.overWindow ? rawBody : forwardBody,
                        originalBody: rawBody,
                        msgsForMemtree,
                        hash,
                        modelContextLimit,
                        routeEpoch,
                        rec,
                        conversationBytes,
                        routeKey: requestRouteKey,
                        isMainRequest,
                        recoveryAttempt,
                        toolForwarding,
                        clientMeta,
                        compaction: { target: plan.target, threshold: plan.threshold },
                        ...(plan.replaces !== undefined
                            ? {
                                stable: {
                                    targetTokens: plan.targetTokens,
                                    explicitTarget: plan.explicitTarget,
                                    modelContextLimit,
                                    replaces: plan.replaces,
                                },
                            }
                            : {}),
                        ...(plan.fallback ? { fallback: plan.fallback } : {}),
                        retryAtTokens: plan.estimateTokens +
                            Math.floor(plan.budgetTokens * TOOL_COMPACTION_RETRY_BUDGET_RATIO),
                    }).finally(() => {
                        recoveryAttempt.inFlight = false;
                    }));
                }
                // No attempt: send the old ride when there is one, else the whole
                // history.
                if (plan.fallback) {
                    toolRide = plan.fallback;
                    rec.compaction.keptPrefix = true;
                }
            }
        }
        if (toolRide)
            requestSendPolicies.get(req)?.allowed.add(toolRide.raw);
        const sendBody = toolRide?.raw ?? (toolNeedsOriginal ? rawBody : forwardBody);
        recordTurn(rec, toolRide ? toolRide.turnType : isUserTurn ? "first-user" : "tool", sendBody);
        opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, toolSessionId, clientMeta, transcriptTimesFor(opts, toolSessionId, agentAttributionId(req)));
        capture(opts, toolRide ? "anthropic-request-memory-tool" : "anthropic-request", sendBody);
        // The size Anthropic reports is the next budget check's anchor: a ride
        // reports to its prefix (or route), a whole request to the session's (or
        // lane's) passthrough size.
        return logged(forwardRaw(req, res, sendBody, opts, upstream, state.shutdownSignal, rec).then((delivered) => {
            toolForwarding.settle(delivered);
            if (toolRide)
                noteRideSize(toolRide.sizeHolder, rec, sendBody.length);
            else {
                noteWholeRequestSize(state, isMainRequest, toolSessionId, requestRouteKey, rec, sendBody.length);
            }
        }));
    }
    // The away recap is a fork of the main conversation: its history is the
    // main thread's plus one question. Ride the main thread's last compressed
    // prefix instead of compressing separately, so the request stays under the
    // window, hits the prompt cache the main thread warmed, and costs no
    // MemTree call. Any mismatch falls through to the recap's own compression.
    if (isAwaySummary) {
        const fork = forkRoutedBody(body, messages, state.lastMainRoute, requestSessionId(req), modelContextLimit);
        if ("body" in fork) {
            requestSendPolicies.get(req)?.allowed.add(fork.body);
            releaseRouteDecision(state, requestRouteKey, routeDecisionGeneration);
            recordTurn(rec, "fork-memory", fork.body);
            capture(opts, "anthropic-request-memory-fork", fork.body);
            return logged(forwardRaw(req, res, fork.body, opts, upstream, state.shutdownSignal, rec));
        }
        rec.forkMiss = fork.miss;
    }
    const markMainPromptDelivered = () => toolForwarding.settle(true);
    // A newer same-lane replacement prevents older asynchronous installation.
    const routeDecisionCurrent = () => state.mainRouteEpoch === routeEpoch &&
        routeDecisionHolds(state, requestRouteKey, routeDecisionGeneration);
    const commitRouteDecision = () => {
        routeDecisionSettled = true;
    };
    const releaseUncommittedRouteDecision = () => {
        if (routeDecisionSettled)
            return;
        releaseRouteDecision(state, requestRouteKey, routeDecisionGeneration);
        routeDecisionSettled = true;
    };
    // An uncompressed fallback releases this replacement reservation. The old
    // validated route remains available to requests whose histories still match.
    const releaseForOriginalFallback = () => {
        requestSendPolicies.get(req).failedRebuild = true;
        releaseUncommittedRouteDecision();
    };
    const sessionId = requestSessionId(req);
    // Stable-prefix (edge) compaction: the main thread's human turns only. The
    // recap rides the main route above; subagents keep per-turn compression.
    const edge = isMainRequest && sessionId !== undefined
        ? planEdgeCompaction({
            opts,
            state,
            body,
            messages,
            sessionId,
            modelContextLimit,
            forwardBody,
            rec,
        })
        : undefined;
    // An active subagent can repeat/embed the human prompt in its own request;
    // producer suppression must also preserve the arm for the later main call.
    if (displayForThisTurn)
        state.mainNoticePending = false;
    /**
     * Forward a compressed body — a fresh compaction, or a ride on the stable
     * prefix — and make it the route for the rest of this human turn's tool
     * loop (and, for a compaction, the session's new stable prefix).
     */
    const forwardCompressed = (compressedBody, compressedRaw, turnType, stable, result) => {
        if (routedBodyExceedsContext(body, compressedRaw, modelContextLimit)) {
            releaseUncommittedRouteDecision();
            recordTurn(rec, "followup-degraded", rawBody);
            return logged(forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec));
        }
        requestSendPolicies.get(req)?.allowed.add(compressedRaw);
        if (opts.debug) {
            console.error(`[ccc proxy] user turn ${turnType}: ${forwardBody.length} → ` +
                `${compressedRaw.length} body bytes`);
        }
        // Claude can consume message_stop, execute a fast local tool, and close the
        // SSE response before Node observes the downstream HTTP `finish` event.
        // Activate the route once the complete Anthropic response has been accepted
        // by the downstream response, so an immediate tool-result request cannot
        // race the later forwardRaw() delivery promise.
        let routeActivationAttempted = false;
        const activateMemoryRoute = () => {
            if (routeActivationAttempted)
                return;
            if (!requestSendPolicies.get(req)?.allowed.has(compressedRaw)) {
                releaseUncommittedRouteDecision();
                routeActivationAttempted = true;
                return;
            }
            if (!routeDecisionCurrent()) {
                releaseUncommittedRouteDecision();
                routeActivationAttempted = true;
                return;
            }
            // Away lane: commit the decision but store nothing. Nothing can ever
            // read an away route — tool turns and count_tokens can never classify as
            // away — so storing it would only mislead and burn heap. All the
            // reservation bookkeeping above and around this stays exactly as for any
            // lane: it is what stops a stale slow away duplicate from stepping on a
            // newer one.
            if (requestRouteLane === "away") {
                commitRouteDecision();
                routeActivationAttempted = true;
                return;
            }
            const installed = installMemoryRoute(state, requestRouteKey, req, body, messages, compressedBody, routeEpoch, routeDecisionGeneration, stable);
            commitRouteDecision();
            // Leave this false if installMemoryRoute unexpectedly throws: the
            // delivery-complete fallback then gets one safe retry.
            routeActivationAttempted = true;
            if (opts.debug) {
                console.error(`[ccc proxy] memory route activation: ${installed ? "installed" : "unavailable"}`);
            }
        };
        // If a newer same-lane decision is live, keep this request's reservation
        // until its protocol-complete activation (or terminal forward failure).
        // The newer request may still end without mutating anything and hand
        // ownership back while this response is in flight. Releasing here would let
        // this request install later with no committed generation protecting that
        // route from an even older completion.
        recordTurn(rec, turnType, compressedRaw);
        capture(opts, turnType === "followup-prefix" ? "anthropic-request-memory-prefix" : "anthropic-request", compressedRaw);
        // Queue the success notice before the stream starts: a long live stream may
        // claim its display notice before message_stop. A prefix ride made no
        // compress call, so there is nothing new to announce.
        if (result) {
            queueCompressionNotice({
                state,
                req,
                displayForThisTurn,
                noticePromptGeneration,
                noticePromptId,
                result,
                rec,
            });
        }
        return logged(forwardRaw(req, res, compressedRaw, opts, upstream, state.shutdownSignal, rec, 
        // Wrapped like the recovery twin's protocol-complete callback — not
        // for behavior (forwardRaw's notify catch swallows a throw either
        // way, and routeActivationAttempted stays false so the
        // delivered-settle retry below still gets its one safe attempt) but
        // for observability: a bare throw here otherwise leaves zero trace,
        // unlike the recovery path's "activation-error" install fate.
        () => {
            try {
                activateMemoryRoute();
            }
            catch (err) {
                if (opts.debug) {
                    console.error(`[ccc proxy] followup route activation threw at protocol-complete: ${err}`);
                }
            }
        }).then((delivered) => {
            // The size Anthropic reported for this request is where the next
            // human turn's budget check starts.
            const sizePrefix = stable
                ? "ride" in stable
                    ? stable.ride
                    : stable.installed
                : undefined;
            if (sizePrefix)
                notePrefixSize(sizePrefix, rec, compressedRaw.length);
            // A route already installed at protocol-complete deliberately survives
            // delivered=false: that settle may be the fast-tool abort (client
            // consumed message_stop, closed the SSE response, and its immediate
            // tool request must ride the prefix). A socket death before flush
            // settles identically; an identical-body retry reuses the same
            // validated compressed prefix with an empty suffix.
            if (!delivered) {
                // Protocol-complete activation may already have installed the route
                // before a fast downstream close. Otherwise this forward made no
                // route decision, so return an uncommitted agent reservation.
                if (!routeActivationAttempted)
                    releaseUncommittedRouteDecision();
                return;
            }
            markMainPromptDelivered();
            // Route the rest of this human turn's tool loop — and the count_tokens
            // calls Claude Code sizes its context with — through the same compressed
            // prefix. Without this the tool loop re-sends the full history, so
            // count_tokens reports the uncompressed conversation and Claude Code
            // auto-compacts a context that memory had already shrunk.
            // Retain delivery completion as a defensive retry if protocol-time
            // route bookkeeping failed unexpectedly. Guarded like the recovery
            // twin: a repeat throw here would reject inside this settle callback
            // and strand the uncommitted reservation, so release it instead.
            try {
                activateMemoryRoute();
            }
            catch (err) {
                if (!routeActivationAttempted)
                    releaseUncommittedRouteDecision();
                if (opts.debug) {
                    console.error(`[ccc proxy] followup route activation retry threw: ${err}`);
                }
            }
        }));
    };
    if (existingRide && (!edge || edge.kind === "off") &&
        !routedBodyExceedsContext(body, existingRide, modelContextLimit)) {
        return forwardCompressed(JSON.parse(existingRide.toString("utf-8")), existingRide, "followup-prefix", undefined, undefined);
    }
    if (edge?.kind === "ride") {
        // The stable prefix still covers this conversation and prefix + newer
        // turns fit the budget: the same prefix bytes as the last request, so
        // Anthropic reads them from cache, and no compress call. MemTree still
        // gets the history to index.
        opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, sessionId, clientMeta, transcriptTimesFor(opts, sessionId, agentAttributionId(req)));
        return forwardCompressed(edge.routed.body, edge.routed.raw, "followup-prefix", { ride: edge.prefix }, undefined);
    }
    /**
     * A compaction that produced no new prefix: send this turn on the old one
     * instead of the whole history when it is still valid. Undefined when there
     * is none, or when the server passed a `/memtree-compact` request through
     * (the conversation is under the asked-for target: send it whole).
     */
    const rideOldPrefix = (passedThrough) => {
        if (edge?.kind !== "compress" || !edge.fallback)
            return undefined;
        if (passedThrough && edge.reason === "manual")
            return undefined;
        rec.compaction.keptPrefix = true;
        return forwardCompressed(edge.fallback.routed.body, edge.fallback.routed.raw, "followup-prefix", { ride: edge.fallback.prefix }, undefined);
    };
    /** A main request about to go out whole: size it and drop any stale prefix. */
    const sendingWhole = () => { requestSendPolicies.get(req).failedRebuild = true; };
    const noteWholeSize = () => {
        if (isMainRequest)
            notePassthroughSize(state, sessionId, rec, forwardBody.length);
    };
    // The complete request upload can outlive its downstream subscriber while
    // MemTree compression is in flight. Track that subscriber locally without
    // feeding its lifetime into MemtreeClient.compress(): compression promises
    // are hash-deduped and may still be serving another live retry.
    let downstreamClosedDuringCompression = res.destroyed && !res.writableFinished;
    const markDownstreamClosedDuringCompression = () => {
        if (!res.writableFinished)
            downstreamClosedDuringCompression = true;
    };
    res.once("close", markDownstreamClosedDuringCompression);
    // The hidden away-summary request compresses too, but its page is not the
    // conversation the user is looking at.
    const linkSeq = isMainRequest && !isAwaySummary ? nextMemtreeCallSeq(state) : undefined;
    let compression;
    try {
        compression = await runBlockingCompression({
            opts,
            state,
            body,
            msgsForMemtree,
            hash,
            modelContextLimit,
            rec,
            sessionId,
            agentId: agentAttributionId(req),
            clientMeta,
            ...(edge?.kind === "compress"
                ? { compaction: { target: edge.target, threshold: edge.threshold } }
                : edge?.kind === "off"
                    ? { compaction: {} }
                    : {}),
        });
    }
    catch {
        const kept = rideOldPrefix(false);
        if (kept)
            return kept;
        releaseUncommittedRouteDecision();
        recordTurn(rec, "followup-degraded", rawBody);
        capture(opts, "anthropic-request", rawBody);
        return logged(forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec)
            .then((delivered) => {
            if (isMainRequest)
                notePassthroughSize(state, sessionId, rec, rawBody.length);
            if (delivered)
                markMainPromptDelivered();
        }));
    }
    finally {
        res.off("close", markDownstreamClosedDuringCompression);
    }
    const { result } = compression;
    noteMemtreeHealth(state, compression);
    if (linkSeq !== undefined) {
        noteMemtreePage(state, linkSeq, sessionId, result);
    }
    // Any answer settles a `/memtree-compact`: a compressed one became the
    // prefix, a passthrough means there was nothing to compact. A failure keeps
    // it pending for the next turn.
    if (result && sessionId !== undefined)
        state.compactNow.delete(sessionId);
    if (downstreamClosedDuringCompression ||
        (res.destroyed && !res.writableFinished)) {
        releaseUncommittedRouteDecision();
        recordTurn(rec, "followup-client-closed", Buffer.alloc(0));
        return logged(Promise.resolve());
    }
    // No await occurs between this check and the selected forwarder's call.
    // Each forwarder installs its own close listener synchronously, so this is
    // an event-loop-atomic handoff of downstream-close ownership.
    if (!result) {
        const kept = rideOldPrefix(false);
        if (kept)
            return kept;
        // MemTree down/slow/402: the user's own Anthropic call is never gated on
        // it. Degrade to passthrough and queue a display-only hook notice for a
        // visible turn. The hidden away-summary request deliberately stays quiet.
        // Unpaid key (402, from this compress OR an earlier background index) gets
        // a payment-specific notice instead of the generic degraded one, at most
        // once per proxy process after it has actually been delivered.
        recordTurn(rec, "followup-degraded", forwardBody);
        releaseForOriginalFallback();
        sendingWhole();
        capture(opts, "anthropic-request", forwardBody);
        const paymentDetail = opts.memtree.paymentRequiredDetail;
        const mayQueueNotice = displayForThisTurn && state.mainPromptGeneration === noticePromptGeneration;
        if (mayQueueNotice && paymentDetail !== null && !state.paymentNoticeShown) {
            const detailFirstLine = sanitizeNoticeDetail(paymentDetail.split(/[\r\n]/, 1)[0]);
            state.notices.queueSuffix(detailFirstLine
                ? `${PAYMENT_REQUIRED_NOTICE}\n${detailFirstLine}`
                : PAYMENT_REQUIRED_NOTICE, () => {
                state.paymentNoticeShown = true;
            }, noticePromptId);
        }
        else if (mayQueueNotice && paymentDetail === null) {
            state.notices.queueSuffix(DEGRADED_NOTICE, undefined, noticePromptId);
        }
        return logged(forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, rec).then((delivered) => {
            noteWholeSize();
            if (delivered)
                markMainPromptDelivered();
        }));
    }
    const actuallyCompressed = didMemtreeCompress(result);
    const historyCheck = checkCompressedHistory(result, msgsForMemtree);
    rec.history = {
        retainedChars: historyCheck.retainedChars,
        priorHistoryChars: historyCheck.priorHistoryChars,
        usable: historyCheck.usable,
    };
    if (!actuallyCompressed || !historyCheck.usable) {
        const kept = rideOldPrefix(!actuallyCompressed);
        if (kept)
            return kept;
        // Two distinct ways to get an unusable answer, one recovery.
        //
        // No cached/indexed tokens means the server is still warming an index and
        // returned the messages as-is. Preserve true passthrough semantics:
        // flattening that no-op response changes Anthropic's structured
        // conversation and made the first request disagree with the full-history
        // tool loop that followed it.
        //
        // A fully indexed response that carries no prior conversation is the more
        // dangerous case: it looks like a perfect compression by every usage-based
        // measure, so nothing downstream would notice that the model is about to be
        // asked to continue a conversation it can no longer see. Forwarding the
        // real history costs context but never silently amnesias the session.
        releaseForOriginalFallback();
        sendingWhole();
        if (actuallyCompressed && opts.debug) {
            console.error(`[ccc proxy] memory response dropped the conversation ` +
                `(retained ${historyCheck.retainedChars} of ` +
                `${historyCheck.priorHistoryChars} prior chars); forwarding history`);
        }
        recordTurn(rec, actuallyCompressed ? "followup-empty-memory" : "followup-noop", forwardBody);
        capture(opts, "anthropic-request", forwardBody);
        return logged(forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, rec).then((delivered) => {
            noteWholeSize();
            if (delivered)
                markMainPromptDelivered();
        }));
    }
    // Invariant from the early return above: past this point the MemTree result
    // actually compressed (actuallyCompressed is true) and the retained history
    // is usable — every remaining path forwards the compressed body.
    let built;
    try {
        built = buildCompressedBody(body, result);
    }
    catch (err) {
        releaseUncommittedRouteDecision();
        throw err;
    }
    if (built === null) {
        const kept = rideOldPrefix(false);
        if (kept)
            return kept;
        // The server compressed but returned no usable `flattened_messages`
        // (pre-flatten server, or a malformed field). The flatten format lives
        // server-side only — the client deliberately has no local fallback, that
        // drift is what caused the append/adherence regressions — so forward the
        // real history instead, exactly like the unusable branch above.
        releaseForOriginalFallback();
        sendingWhole();
        if (opts.debug) {
            console.error("[ccc proxy] compressed result carried no server flatten; " +
                "forwarding history");
        }
        recordTurn(rec, "followup-no-flatten", forwardBody);
        capture(opts, "anthropic-request", forwardBody);
        return logged(forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, rec).then((delivered) => {
            noteWholeSize();
            if (delivered)
                markMainPromptDelivered();
        }));
    }
    // A compaction: this result becomes the session's stable prefix once the
    // response completes. The server may also have compressed on its own
    // (over its budget with no threshold from us): that is a budget compaction.
    let stable;
    if (edge?.kind === "compress") {
        const compaction = rec.compaction;
        compaction.reason ??= compaction.prefixMiss ? "prefix-mismatch" : "budget";
        stable = {
            targetTokens: edge.targetTokens,
            explicitTarget: edge.explicitTarget,
            modelContextLimit,
        };
    }
    return forwardCompressed(built.compressedBody, built.compressedRaw, "followup-compressed", stable, result);
}
function queueCompressionNotice(args) {
    const { state, req, displayForThisTurn, noticePromptGeneration, noticePromptId, result, rec, } = args;
    if (!displayForThisTurn ||
        state.mainPromptGeneration !== noticePromptGeneration) {
        return;
    }
    // Announce only actual (re)indexing, measured as growth in how much of the
    // original prompt the index covers (`cached_tokens`). Unchanged coverage
    // means this turn rode the existing index with the new messages appended
    // after it — MemTree did no new indexing work worth reporting.
    //
    // Deliberately NOT keyed on the memory text: the server unfolds the index
    // against the current question, so its rendering (and length) changes on
    // nearly every turn regardless of indexing. Coverage is missing only on
    // servers old enough that `didMemtreeCompress` would have degraded this
    // turn already; announce rather than suppress on an unknown quantity.
    //
    // A newly ready MemTree page also earns the line: the link rides only the
    // success line (never its own message), so a finished index is announced
    // on the next compressed turn even when coverage stayed flat.
    const indexedTokens = cachedPromptTokenCount(result);
    const sessionId = requestSessionId(req);
    if (indexedTokens !== undefined) {
        const last = state.lastNoticedIndexCoverage;
        // Record every observed coverage, announced or not, so a server-side
        // index rebuild that shrinks coverage re-announces once it grows past
        // its own new baseline rather than staying silent until it beats the old.
        state.lastNoticedIndexCoverage = { sessionId, indexedTokens };
        if (last &&
            last.sessionId === sessionId &&
            indexedTokens <= last.indexedTokens &&
            !state.notices.linkPending(sessionId)) {
            return;
        }
    }
    state.notices.queuePrefix(() => compressedTotalsText(...compressionTotals(rec, result)), undefined, noticePromptId);
}
/**
 * Before and after sizes for the success line, read when the line is shown.
 * Before: the estimated request that would otherwise have been sent (the
 * old prefix plus suffix on recompaction), else the server's raw_prompt_tokens
 * for the original history. After: Anthropic's reported compressed input once
 * usage arrives, else "before" scaled using the bytes of that same estimate.
 */
function compressionTotals(rec, result) {
    const original = rec?.compaction?.estimatedTokens ?? rawPromptTokenCount(result);
    if (!rec)
        return [original, undefined];
    const reported = reportedInputTokens(rec);
    if (reported !== undefined)
        return [original, reported];
    const fwd = rec.forwardedBytes;
    const basisBytes = rec.compaction?.estimatedTokens !== undefined
        ? rec.compaction.estimatedBytes
        : rec.requestBytes;
    if (original === undefined || !fwd || !basisBytes)
        return [original, undefined];
    return [original, Math.round((original * fwd) / basisBytes)];
}
/**
 * The link on the success line: the newest page for the hook's session,
 * exactly as the server stamped it, keyed by the index it was compressed
 * against so it is announced once per newly finished index. The server hands
 * out its short spelling (`/m/<leading hex of the request id>`), which is
 * permanent — it outlives this proxy — and fits a terminal line.
 */
function installMemtreeLink(state, placement) {
    const resolve = (sessionId) => {
        const latest = currentMemtreePage(state, sessionId);
        if (!latest)
            return undefined;
        return {
            key: latest.index,
            link: latest.url,
            ...(latest.compressed ? {} : { note: NOT_COMPRESSED_NOTE }),
        };
    };
    switch (placement) {
        case "success":
            state.notices.setLink(resolve);
            break;
        case "turn":
            // The success line carries the current page on the line below it; the
            // end-of-turn trailer then skips a link that line already showed.
            state.notices.setLink(resolve);
            state.notices.setTrailer(resolve, placement);
            break;
        case "message":
        case "stop":
            // These trailers show on every message or every Stop; no second copy.
            state.notices.setTrailer(resolve, placement);
            break;
        case "off":
            break;
    }
}
/**
 * The link line for a resumed main session: its newest page, from memory when
 * this proxy served it (an in-app `/resume` back to an earlier conversation),
 * else from the on-disk store (a new `ccc --resume` process). Adopts it as the
 * session's current page so trailers continue from it, at a sequence number
 * any later call beats.
 */
function resumeLinkLine(state, input) {
    if (input.agent_id !== undefined || input.source === "compact")
        return undefined;
    if (state.memtreeLinkPlacement === "off")
        return undefined;
    const sessionId = input.session_id;
    const inMemory = state.memtreePages.get(sessionId);
    const page = inMemory && inMemory.sessionId === sessionId
        ? inMemory
        : state.memtreeLinkStore?.get(sessionId);
    if (!page)
        return undefined;
    if (page !== inMemory) {
        rememberMemtreePage(state, sessionId, {
            sessionId,
            url: page.url,
            index: page.index,
            compressed: page.compressed,
            seq: state.memtreeCallSeq,
        });
    }
    return state.notices.resumeLine({
        key: page.index,
        link: page.url,
        ...(page.compressed ? {} : { note: NOT_COMPRESSED_NOTE }),
    }, sessionId);
}
export const MEMTREE_COMPACT_MIN_TOKENS = 20_000;
/** The reply to a ccc slash command, or undefined for an ordinary prompt. */
function sessionCommandReply(state, sessionId, prompt) {
    if (sessionCommandArgs(prompt, MEMTREE_HELP_COMMAND) !== undefined) {
        return [
            "• /memtree-view · show this session's MemTree page link",
            `• /memtree-compact [tokens | off] · compact this session on your next message (default half the budget, at least ${MEMTREE_COMPACT_MIN_TOKENS / 1000}k)`,
        ].join("\n");
    }
    if (isMemtreeViewCommand(prompt))
        return memtreeViewLine(state, sessionId);
    const args = sessionCommandArgs(prompt, MEMTREE_COMPACT_COMMAND);
    if (args === undefined)
        return undefined;
    const keep = "then that compressed history is reused unchanged until the conversation reaches the budget again. /memtree-compact off to stop.";
    if (/^off$/i.test(args)) {
        state.compactTargets.set(sessionId, null);
        state.memoryRoutes.delete(JSON.stringify([sessionId, "main"]));
        state.compactNow.delete(sessionId);
        state.stablePrefixes.delete(sessionId);
        return `${TRAILER_LABEL} compaction off: the conversation is sent whole, and MemTree compresses only when it outgrows the model's budget.`;
    }
    if (args === "") {
        // Back to the automatic target (half the budget, or CCC_COMPACT_TARGET).
        // Under CCC_COMPACT_TARGET=off the default is off, so pin the automatic
        // target for this session instead of falling back to that default.
        if (state.defaultCompactOff)
            state.compactTargets.set(sessionId, undefined);
        else
            state.compactTargets.delete(sessionId);
        state.compactNow.add(sessionId);
        return `${TRAILER_LABEL} compacting: your next message is sent compressed to about half the budget, ${keep}`;
    }
    const target = parseTokenCount(args);
    if (target === undefined || target < MEMTREE_COMPACT_MIN_TOKENS) {
        return `${TRAILER_LABEL} usage: /memtree-compact [tokens, e.g. 400k, at least ${MEMTREE_COMPACT_MIN_TOKENS / 1000}k | off]`;
    }
    state.compactTargets.set(sessionId, target);
    state.compactNow.add(sessionId);
    return `${TRAILER_LABEL} compacting: your next message is sent compressed to about ${Math.round(target / 1000)}k tokens, ${keep}`;
}
/** "50k", "50000", "1.5m" → tokens; undefined when not a positive count. */
export function parseTokenCount(text) {
    const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim());
    if (!match)
        return undefined;
    const scale = { k: 1_000, m: 1_000_000 }[match[2]?.toLowerCase()] ?? 1;
    const value = Math.round(Number(match[1]) * scale);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}
/** The `/memtree-view` answer: this session's newest page, or why there is none. */
function memtreeViewLine(state, sessionId) {
    const inMemory = state.memtreePages.get(sessionId);
    const page = inMemory && (inMemory.sessionId === undefined || inMemory.sessionId === sessionId)
        ? inMemory
        : state.memtreeLinkStore?.get(sessionId);
    if (!page) {
        return `${TRAILER_LABEL} no page yet: this session has not been indexed. The link appears once it has.`;
    }
    return linkLines(LINK_LABEL, page.url, page.compressed ? undefined : NOT_COMPRESSED_NOTE);
}
function nextMemtreeCallSeq(state) {
    return ++state.memtreeCallSeq;
}
/**
 * Adopt a compress response's MemTree page as the conversation's newest,
 * unless a call submitted later already reported one. Only a response that
 * names the index it was compressed against counts: that index is complete,
 * so the page shows a tree right away, and its identity is what makes the
 * link worth announcing. A response without it (pre-view server, failed or
 * uncompressed call) changes nothing.
 */
function noteMemtreePage(state, seq, sessionId, result) {
    const url = result?.memtreeUrl;
    const index = result?.memtreeIndex;
    if (!sessionId || !url || !index)
        return;
    const latest = state.memtreePages.get(sessionId);
    if (latest && latest.seq >= seq)
        return;
    const compressed = didMemtreeCompress(result);
    rememberMemtreePage(state, sessionId, { sessionId, url, index, compressed, seq });
    if (sessionId)
        state.memtreeLinkStore?.put(sessionId, { url, index, compressed });
}
/** Bound optional page state independently of how many sessions use the proxy. */
function rememberMemtreePage(state, sessionId, page) {
    state.memtreePages.delete(sessionId);
    state.memtreePages.set(sessionId, page);
    while (state.memtreePages.size > MEMTREE_LINKS_MAX_SESSIONS) {
        state.memtreePages.delete(state.memtreePages.keys().next().value);
    }
}
/**
 * Record what a blocking operation just proved about MemTree's health: an
 * unopposed live failure arms the tool-recovery cooldown, any live success
 * clears it, and a cached-only result leaves the prior state untouched.
 *
 * Called from BOTH blocking paths and, critically, BEFORE either one checks
 * whether its client is still listening. A null says something about the
 * server, not about the downstream socket — and the full-budget stall that
 * produces a null is itself the likeliest reason a client gives up, so
 * learning only from attempts that outlived their client would blind the
 * cooldown to exactly the outage it exists to bound. Sharing it with the
 * followup path matters in both directions: an outage first seen on a human
 * turn must not cost another full stall on the next tool turn, and a
 * recovered MemTree must not stay locked out for the rest of the window.
 *
 * A live no-op, unusable, or non-shrinking answer still proves the server is
 * responsive and merely unhelpful for this history, and the next turn's
 * larger tail may well succeed — so those clear the outage fuse and keep
 * paying the fast, already-indexed round trip rather than locking recovery
 * out. The asymmetry trades a bounded repeat cost against never suppressing a
 * recovery a warming index is about to make possible.
 *
 * Both directions require evidence about MemTree's health RIGHT NOW; anything
 * weaker leaves the fuse untouched rather than guessing:
 *
 * - Every lane contributes the same shared evidence. A live success clears
 *   the cooldown; a live failure arms it.
 * - Cache-served calls contribute no evidence. compress() memoizes successes
 *   by hash and returns them with zero server contact, so replaying an
 *   identical body cannot "prove" MemTree is up.
 * - A shutdown abort arms nothing. compress() maps abort to the same null as
 *   a server failure, but a draining proxy says nothing about MemTree; it
 *   would only misattribute the drain in the last records written.
 */
function noteMemtreeHealth(state, compression) {
    if (compression.liveHealth === "failure") {
        if (state.shutdownSignal.aborted)
            return;
        state.toolRecoveryCooldownUntil =
            Date.now() + TOOL_RECOVERY_FAILURE_COOLDOWN_MS;
        return;
    }
    if (compression.liveHealth === "success") {
        state.toolRecoveryCooldownUntil = 0;
    }
}
/**
 * Whether the holder of `generation` still owns the route decision: true while
 * no STRICTLY NEWER reservation is live or committed. The holder's own
 * reservation never blocks itself, and a newer reservation that ended up
 * mutating nothing has already removed itself, handing ownership back rather
 * than stranding everyone older.
 */
function routeDecisionHolds(state, key, generation) {
    if (generation <= state.retiredRouteDecisionFloor)
        return false;
    const live = state.routeDecisionsLive.get(key);
    if (!live)
        return true;
    for (const reserved of live) {
        if (reserved > generation)
            return false;
    }
    return true;
}
function reserveRouteDecision(state, key, generation) {
    let live = state.routeDecisionsLive.get(key);
    if (!live) {
        if (state.routeDecisionsLive.size >= 128) {
            const oldest = state.routeDecisionsLive.keys().next().value;
            const retired = state.routeDecisionsLive.get(oldest);
            state.retiredRouteDecisionFloor = Math.max(state.retiredRouteDecisionFloor, ...retired);
            state.routeDecisionsLive.delete(oldest);
        }
        live = new Set();
        state.routeDecisionsLive.set(key, live);
    }
    live.add(generation);
}
function releaseRouteDecision(state, key, generation) {
    const live = state.routeDecisionsLive.get(key);
    if (!live)
        return;
    live.delete(generation);
    if (live.size === 0)
        state.routeDecisionsLive.delete(key);
}
function installMemoryRoute(state, key, req, originalBody, originalMessages, compressedBody, routeEpoch, decisionGeneration, 
/**
 * Main-thread human turns only: the stable prefix these compressed messages
 * start with. `register` stores it as the session's prefix (a compaction);
 * a prefix ride passes the prefix it rode, already stored.
 */
stable) {
    // Same-lane generations order asynchronous installs. Hooks never mutate
    // these guards; a stale completion cannot overwrite a validated replacement.
    if (state.mainRouteEpoch !== routeEpoch ||
        !routeDecisionHolds(state, key, decisionGeneration)) {
        return undefined;
    }
    const sessionId = requestSessionId(req);
    if (!sessionId || !Array.isArray(compressedBody.messages)) {
        state.memoryRoutes.delete(key);
        return undefined;
    }
    // Test-only fault-injection seam (undefined in production): placed after
    // every guard and before the store, exactly where the route object's
    // cloneJson/hash construction could throw, so tests can reach the
    // "activation-error" settle label. See ProxyOptions.routeInstallFault.
    state.routeInstallFault?.();
    const route = {
        sessionId,
        originalSystemHash: routeValueHash(normalizeRouteSystem(originalBody.system)),
        // Include trailing ambient role=system blocks: MemTree consolidated them
        // into compressedBody.system, so treating them as suffix would duplicate
        // those instructions on every tool request.
        originalPrefixHashes: originalMessages.map(routeMessageHash),
        compressedMessages: cloneJson(compressedBody.messages),
        compressedSystem: cloneJson(compressedBody.system),
        hasCompressedSystem: Object.prototype.hasOwnProperty.call(compressedBody, "system"),
        routeEpoch,
    };
    if (stable && "ride" in stable) {
        route.stablePrefix = stable.ride;
    }
    else if (stable) {
        // The route's own fields are the prefix: the hashes of every message this
        // request carried, and the compressed bytes sent for them. Later requests
        // reuse these bytes unchanged, so the prefix stays a cache read.
        route.stablePrefix = storeStablePrefix(state, sessionId, originalMessages, route, stable);
    }
    setMemoryRoute(state, key, route);
    state.routeDecisionsLive.set(key, new Set([decisionGeneration]));
    if (!state.toolRecoveryAttemptedLanes.get(key)?.inFlight)
        state.toolRecoveryAttemptedLanes.delete(key);
    if (key === JSON.stringify([sessionId, "main"]))
        state.lastMainRoute = route;
    return route;
}
/**
 * Store a compaction's compressed bytes as the session's stable prefix. For a
 * tool-turn compaction (`replaces` set) only while the session's prefix is
 * still the one the compaction replaced; undefined when skipped.
 */
function storeStablePrefix(state, sessionId, originalMessages, compressed, stable) {
    if (stable.replaces !== undefined &&
        (state.stablePrefixes.get(sessionId) ?? null) !== stable.replaces) {
        return undefined;
    }
    const prefix = {
        sessionId,
        originalSystemHash: compressed.originalSystemHash,
        originalPrefixHashes: originalMessages.map(stablePrefixMessageHash),
        compressedMessages: compressed.compressedMessages,
        compressedSystem: compressed.compressedSystem,
        hasCompressedSystem: compressed.hasCompressedSystem,
        targetTokens: stable.targetTokens,
        explicitTarget: stable.explicitTarget,
        modelContextLimit: stable.modelContextLimit,
    };
    stable.installed = prefix;
    boundedSet(state.stablePrefixes, sessionId, prefix);
    state.compactNow.delete(sessionId);
    return prefix;
}
/**
 * A fork of the main conversation (the away recap) sent on the main thread's
 * last compressed prefix: that prefix, then the fork's own messages after it.
 * Only session, system and every prefix message are checked; unlike a tool
 * turn, the suffix may end in a plain user message (the fork's question).
 */
function forkRoutedBody(body, messages, route, sessionId, modelContextLimit) {
    if (!route)
        return { miss: "no-route" };
    const miss = prefixMismatch(body, messages, route, sessionId);
    if (miss)
        return { miss };
    const routed = prefixRoutedBody(body, messages, route);
    if (!routed)
        return { miss: "prefix" };
    const buffer = routed.raw;
    if (routedBodyExceedsContext(body, buffer, modelContextLimit))
        return { miss: "too-large" };
    return { body: buffer };
}
/**
 * Why `messages` cannot continue from `prefix`, or null when they can: same
 * session, same system prompt, every message the prefix covers unchanged, and
 * at least one message after them. The suffix may be anything, human turns
 * included.
 */
function prefixMismatch(body, messages, prefix, sessionId, hashMessage = routeMessageHash) {
    if (!sessionId || prefix.sessionId !== sessionId)
        return "session";
    if (routeValueHash(normalizeRouteSystem(body.system)) !== prefix.originalSystemHash) {
        return "system";
    }
    const prefixLength = prefix.originalPrefixHashes.length;
    if (messages.length < prefixLength)
        return "prefix";
    for (let i = 0; i < prefixLength; i++) {
        if (hashMessage(messages[i]) !== prefix.originalPrefixHashes[i]) {
            return "prefix";
        }
    }
    return null;
}
/**
 * Message identity for a stable prefix: routeMessageHash without assistant
 * thinking blocks. A stable prefix spans human turns, and Claude Code does not
 * reliably replay earlier turns' thinking (model switch, resume); those blocks
 * are never sent on the prefix anyway (the compressed bytes stand in for them),
 * so they must not decide whether it still matches.
 */
/**
 * The request sent on a compressed prefix: the prefix's compressed messages
 * (a JSON round trip of the stored bytes, so byte-identical every time), then
 * the messages after the part it covers, verbatim, with Claude Code's current
 * billing header grafted into the compressed system and the cache breakpoints
 * capped at Anthropic's limit (the prefix's own marker always kept).
 */
function prefixRoutedBody(body, messages, prefix) {
    const routed = {
        ...body,
        messages: [
            ...cloneJson(prefix.compressedMessages),
            ...messages.slice(prefix.originalPrefixHashes.length),
        ],
    };
    if (prefix.hasCompressedSystem) {
        routed.system = currentRouteSystem(prefix.compressedSystem, body.system);
    }
    else {
        delete routed.system;
    }
    if (!capCacheBreakpoints(routed, prefix.compressedMessages.length, { preserveSystem: true }))
        return null;
    if (!validCacheTtlOrder(routed))
        return null;
    return { body: routed, raw: Buffer.from(JSON.stringify(routed), "utf-8") };
}
function serverBudgetKey(model, modelContextLimit) {
    return JSON.stringify([typeof model === "string" ? model : "", modelContextLimit]);
}
/**
 * The session's whole-request budget: CCC_BUDGET_TOKENS when set (tests),
 * else the model budget the server last reported for this model and window,
 * else the window times FALLBACK_BUDGET_WINDOW_RATIO (servers that predate
 * `model_budget_tokens`, and the first request before any response).
 */
function resolveBudget(opts, state, model, modelContextLimit) {
    if (opts.budgetTokensOverride !== undefined) {
        return { tokens: opts.budgetTokensOverride, source: "override" };
    }
    const reported = state.serverBudgets.get(serverBudgetKey(model, modelContextLimit));
    if (reported !== undefined)
        return { tokens: reported, source: "server" };
    return {
        tokens: Math.floor(modelContextLimit * FALLBACK_BUDGET_WINDOW_RATIO),
        source: "window-ratio",
    };
}
/** Remember the model budget a compress response reported. */
function noteServerBudget(state, model, modelContextLimit, result) {
    const tokens = result ? modelBudgetTokens(result) : undefined;
    if (tokens === undefined)
        return;
    state.serverReportsBudget = true;
    boundedSet(state.serverBudgets, serverBudgetKey(model, modelContextLimit), tokens);
}
/** `/memtree-compact` for this session, else CCC_COMPACT_TARGET, else automatic. */
function compactionMode(opts, state, sessionId) {
    const configured = sessionId !== undefined && state.compactTargets.has(sessionId)
        ? state.compactTargets.get(sessionId)
        : opts.defaultCompactTarget;
    if (configured === null)
        return { mode: "off" };
    if (configured === undefined)
        return { mode: "auto" };
    return { mode: "explicit", tokens: configured };
}
/** What a compaction aims at: the explicit N (capped under the budget), else budget/2. */
function compactionTarget(mode, budgetTokens) {
    const target = mode.mode === "explicit"
        ? Math.min(mode.tokens, Math.floor(budgetTokens * MAX_EXPLICIT_TARGET_BUDGET_RATIO))
        : Math.floor(budgetTokens / 2);
    return Math.max(SERVER_MIN_TARGET_TOKENS, target);
}
/**
 * Target and threshold for compress calls other than a main-thread human turn
 * or a tool turn (subagent and recap followups). They never build a
 * stable prefix, so they only need to stay under the budget: a server that
 * understands the threshold gets both, an older one gets neither and uses its
 * own model budget. Never a bare target, which would force a compression on
 * every call.
 */
function laneCompaction(opts, state, sessionId, model, modelContextLimit) {
    const mode = compactionMode(opts, state, sessionId);
    if (mode.mode === "off" || !state.serverReportsBudget)
        return {};
    const budget = resolveBudget(opts, state, model, modelContextLimit);
    return {
        target: compactionTarget(mode, budget.tokens),
        threshold: Math.max(SERVER_MIN_TARGET_TOKENS, budget.tokens),
    };
}
/** Calibrated input must leave room for the requested output as well. */
function calibratedSizeExceedsWindow(record, body, modelContextLimit) {
    const outputTokens = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
        ? Math.max(0, body.max_tokens) : 0;
    return record.sizeSource === "reported" &&
        (record.estimatedTokens ?? 0) + outputTokens > modelContextLimit;
}
function calibratedSizeExceedsLimits(record, body, modelContextLimit) {
    return (record.sizeSource === "reported" &&
        (record.estimatedTokens ?? 0) >= record.budgetTokens) ||
        calibratedSizeExceedsWindow(record, body, modelContextLimit);
}
/** Only calibrated usage may force an estimate-driven compaction. */
function budgetCompaction(state, record, target, body, modelContextLimit) {
    if (calibratedSizeExceedsLimits(record, body, modelContextLimit))
        return { target };
    // Older servers may ignore a threshold, so do not send a forcing target
    // until support is known. They can still compact against their own budget.
    if (!state.serverReportsBudget)
        return {};
    const threshold = Math.max(SERVER_MIN_TARGET_TOKENS, record.budgetTokens);
    record.thresholdTokens = threshold;
    return { target, threshold };
}
/** Anthropic's whole input size for a request: uncached + cache read + cache write. */
function reportedInputTokens(rec) {
    const usage = rec.usage;
    if (!usage || typeof usage.input_tokens !== "number")
        return undefined;
    return (usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0));
}
/**
 * Size of a body about to be sent, scaled from the reported size of an earlier
 * request of the same shape by that request's own bytes-per-token ratio.
 * Compressed memory is denser than bytes/4 (about 2.65 bytes per token on a
 * 2026-09-29 Opus session), so a plain bytes/4 fallback undercounted a body
 * that had shrunk slightly since the sample (1.25 KB less: 284k estimated vs
 * 429k reported), which would delay recompression past the budget. Growth
 * uses the denser of the sample's ratio and bytes/4, so the estimate errs
 * high. bytes/4 only when there is no sample.
 */
function estimateRequestTokens(sample, bytes) {
    if (sample && sample.tokens > 0 && sample.forwardedBytes > 0) {
        const bytesPerToken = sample.forwardedBytes / sample.tokens;
        if (bytes <= sample.forwardedBytes) {
            return { tokens: Math.round(bytes / bytesPerToken), source: "reported" };
        }
        const added = bytes - sample.forwardedBytes;
        return {
            tokens: sample.tokens + Math.max(approxTokensFromBytes(added), Math.round(added / bytesPerToken)),
            source: "reported",
        };
    }
    return { tokens: approxTokensFromBytes(bytes), source: "bytes" };
}
/** Keep the newest (largest-body) reported size of a request on this prefix. */
function notePrefixSize(prefix, rec, bytes) {
    const tokens = reportedInputTokens(rec);
    if (tokens === undefined)
        return;
    if (prefix.lastSize && bytes < prefix.lastSize.forwardedBytes)
        return;
    prefix.lastSize = { tokens, forwardedBytes: bytes };
}
/** Record the reported size of a main-thread request forwarded whole. */
function notePassthroughSize(state, sessionId, rec, bytes) {
    const tokens = reportedInputTokens(rec);
    if (sessionId === undefined || tokens === undefined)
        return;
    boundedSet(state.passthroughSizes, sessionId, { tokens, forwardedBytes: bytes });
}
/** Size of a tool turn sent on a ride, recorded on its prefix or route. */
const noteRideSize = notePrefixSize;
/**
 * Record the reported size of a request forwarded whole: the session's
 * passthrough size on the main thread, else its lane's.
 */
function noteWholeRequestSize(state, isMainRequest, sessionId, routeKey, rec, bytes) {
    if (isMainRequest && sessionId !== undefined) {
        notePassthroughSize(state, sessionId, rec, bytes);
        return;
    }
    const tokens = reportedInputTokens(rec);
    if (tokens === undefined)
        return;
    boundedSet(state.laneSizes, routeKey, { tokens, forwardedBytes: bytes }, MEMORY_ROUTE_MAX_LANES);
}
function boundedSet(map, key, value, limit = STABLE_PREFIX_MAX_SESSIONS) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            break;
        map.delete(oldest);
    }
}
/**
 * Stable-prefix (edge) compaction for a main-thread human turn:
 *
 * - With a stored prefix that still matches the conversation and a size
 *   (prefix + newer turns) under the budget: ride it, no compress call.
 * - Otherwise compress: forced to the target when the prefix outgrew the
 *   budget, the window/target changed, or `/memtree-compact` asked; while the
 *   session is still passing through, let the server decide against the
 *   budget (threshold), or — on a server that predates the threshold — force
 *   only once the proxy's own estimate reaches the budget.
 *
 * Fills rec.compaction with the budget, estimate and reason.
 */
function planEdgeCompaction(args) {
    const { opts, state, body, messages, sessionId, modelContextLimit, forwardBody, rec } = args;
    const mode = compactionMode(opts, state, sessionId);
    const budget = resolveBudget(opts, state, body.model, modelContextLimit);
    const compaction = {
        mode: mode.mode,
        budgetTokens: budget.tokens,
        budgetSource: budget.source,
    };
    rec.compaction = compaction;
    if (mode.mode === "off") {
        state.stablePrefixes.delete(sessionId);
        state.compactNow.delete(sessionId);
        return { kind: "off" };
    }
    const targetTokens = compactionTarget(mode, budget.tokens);
    const explicitTarget = mode.mode === "explicit";
    compaction.targetTokens = targetTokens;
    const forced = (reason, fallback) => {
        compaction.reason = reason;
        return {
            kind: "compress",
            ...(reason === "budget"
                ? budgetCompaction(state, compaction, targetTokens, body, modelContextLimit)
                : { target: targetTokens }),
            targetTokens,
            explicitTarget,
            reason,
            ...(fallback ? { fallback } : {}),
        };
    };
    let prefix = state.stablePrefixes.get(sessionId);
    if (prefix) {
        const miss = prefixMismatch(body, messages, prefix, sessionId, stablePrefixMessageHash);
        if (miss) {
            // Rewind, edit, fork, /clear, or a changed system prompt: the prefix no
            // longer stands for this conversation. Start over from passthrough.
            compaction.prefixMiss = miss;
            prefix = undefined;
        }
    }
    if (prefix) {
        boundedSet(state.stablePrefixes, sessionId, prefix);
        const routed = prefixRoutedBody(body, messages, prefix);
        if (!routed) {
            // Cache TTLs are not conversation identity, but a stored 5m prefix
            // cannot precede a new 1h suffix. Rebuild without an invalid fallback;
            // never rewrite the prefix's bytes or the user's marker TTLs.
            return forced("prefix-mismatch");
        }
        const size = estimateRequestTokens(prefix.lastSize, routed.raw.length);
        compaction.estimatedTokens = size.tokens;
        compaction.estimatedBytes = routed.raw.length;
        compaction.sizeSource = size.source;
        const overWindow = routedBodyExceedsContext(body, routed.raw, modelContextLimit) ||
            calibratedSizeExceedsWindow(compaction, body, modelContextLimit);
        const fallback = overWindow ? undefined : { prefix, routed };
        if (state.compactNow.has(sessionId))
            return forced("manual", fallback);
        if (prefix.modelContextLimit !== modelContextLimit ||
            (explicitTarget && prefix.targetTokens !== targetTokens)) {
            return forced("target-change", fallback);
        }
        if (size.tokens >= budget.tokens || overWindow)
            return forced("budget", fallback);
        return { kind: "ride", prefix, routed };
    }
    if (state.compactNow.has(sessionId))
        return forced("manual");
    const size = estimateRequestTokens(state.passthroughSizes.get(sessionId), forwardBody.length);
    compaction.estimatedTokens = size.tokens;
    compaction.estimatedBytes = forwardBody.length;
    compaction.sizeSource = size.source;
    if (calibratedSizeExceedsLimits(compaction, body, modelContextLimit)) {
        return forced(compaction.prefixMiss ? "prefix-mismatch" : "budget");
    }
    if (state.serverReportsBudget) {
        // The server measures the request and compresses only past the budget.
        const threshold = Math.max(SERVER_MIN_TARGET_TOKENS, budget.tokens);
        compaction.thresholdTokens = threshold;
        return { kind: "compress", target: targetTokens, threshold, targetTokens, explicitTarget };
    }
    // Without calibrated usage or threshold support, let the server decide
    // against its own model budget rather than forcing from transport bytes.
    return { kind: "compress", targetTokens, explicitTarget };
}
/**
 * Stable-prefix compaction for a tool turn, on every lane: the rule human
 * turns follow (planEdgeCompaction), minus the server-side threshold call —
 * a tool turn under the budget makes no compress call at all.
 *
 * - The ride: the lane's route (`ride`, already matched), else on the main
 *   thread the session's stable prefix when it still covers this history.
 * - Its size: estimateRequestTokens anchored on the size Anthropic reported
 *   for the previous request of the same shape (the ride's prefix or route,
 *   else the session's / lane's whole-request size), bytes/4 without one.
 * - Under the budget (and within the window): ride, or forward whole.
 * - At the budget: compress, forcing the target only with calibrated usage; on the
 *   main thread the result becomes the stable prefix later tool AND human
 *   turns ride.
 *
 * Fills rec.compaction.
 */
function planToolCompaction(args) {
    const { opts, state, body, messages, sessionId, modelContextLimit, forwardBody, rec } = args;
    const mode = compactionMode(opts, state, sessionId);
    const budget = resolveBudget(opts, state, body.model, modelContextLimit);
    const compaction = {
        mode: mode.mode,
        budgetTokens: budget.tokens,
        budgetSource: budget.source,
    };
    rec.compaction = compaction;
    if (mode.mode === "off")
        return { kind: "off" };
    const targetTokens = compactionTarget(mode, budget.tokens);
    compaction.targetTokens = targetTokens;
    const stableLane = args.isMainRequest && sessionId !== undefined;
    const current = stableLane ? state.stablePrefixes.get(sessionId) : undefined;
    let ride = args.ride;
    let overWindow = false;
    if (!ride && current && !prefixMismatch(body, messages, current, sessionId, stablePrefixMessageHash)) {
        const routed = prefixRoutedBody(body, messages, current);
        if (routed) {
            if (routedBodyExceedsContext(body, routed.raw, modelContextLimit))
                overWindow = true;
            else
                ride = { raw: routed.raw, turnType: "tool-prefix", sizeHolder: current };
        }
    }
    if (!ride) {
        overWindow ||= routedBodyExceedsContext(body, forwardBody, modelContextLimit);
    }
    const sample = ride
        ? ride.sizeHolder.lastSize
        : stableLane
            ? state.passthroughSizes.get(sessionId)
            : state.laneSizes.get(args.routeKey);
    const size = estimateRequestTokens(sample, (ride?.raw ?? forwardBody).length);
    compaction.estimatedTokens = size.tokens;
    compaction.estimatedBytes = (ride?.raw ?? forwardBody).length;
    compaction.sizeSource = size.source;
    overWindow ||= calibratedSizeExceedsWindow(compaction, body, modelContextLimit);
    if (!args.canCompress) {
        if (overWindow)
            return { kind: "pass", original: true };
        return ride ? { kind: "ride", ride } : { kind: "pass" };
    }
    if (size.tokens < budget.tokens && !overWindow) {
        return ride ? { kind: "ride", ride } : { kind: "pass" };
    }
    compaction.reason = "budget";
    return {
        kind: "compress",
        ...budgetCompaction(state, compaction, targetTokens, body, modelContextLimit),
        targetTokens,
        explicitTarget: mode.mode === "explicit",
        estimateTokens: size.tokens,
        budgetTokens: budget.tokens,
        overWindow,
        ...(ride && !overWindow ? { fallback: ride } : {}),
        ...(stableLane ? { replaces: current ?? null } : {}),
    };
}
function memoryRoutedToolBody(body, messages, route, routeEpoch, sessionId) {
    // Model is deliberately not route identity: Claude Code switches models
    // mid-loop (overload fallback, /model, /fast), and the compressed prefix is
    // plain message content valid for any model. Session + prefix hashes pin the
    // conversation; requiring model equality dropped the whole tool loop to
    // full-history passthrough on every mid-turn switch.
    if (!sessionId ||
        route.sessionId !== sessionId ||
        route.routeEpoch !== routeEpoch ||
        routeValueHash(normalizeRouteSystem(body.system)) !==
            route.originalSystemHash) {
        return null;
    }
    const prefixLength = route.originalPrefixHashes.length;
    if (messages.length < prefixLength)
        return null;
    for (let i = 0; i < prefixLength; i++) {
        if (routeMessageHash(messages[i]) !== route.originalPrefixHashes[i]) {
            return null;
        }
    }
    const suffix = messages.slice(prefixLength);
    if (suffix.length && !validToolRouteSuffix(suffix) && !isNonToolUserMessage(suffix[suffix.length - 1]))
        return null;
    const routed = {
        ...body,
        messages: [...cloneJson(route.compressedMessages), ...suffix],
    };
    if (route.hasCompressedSystem) {
        routed.system = currentRouteSystem(route.compressedSystem, body.system);
    }
    else {
        delete routed.system;
    }
    if (!capCacheBreakpoints(routed, route.compressedMessages.length, { preserveSystem: true }))
        return null;
    if (!validCacheTtlOrder(routed))
        return null;
    return Buffer.from(JSON.stringify(routed), "utf-8");
}
/** Size the assembled input (including system/tools) and reserve output room. */
function routedBodyExceedsContext(body, routedBody, modelContextLimit) {
    const outputTokens = typeof body.max_tokens === "number" &&
        Number.isFinite(body.max_tokens) ? Math.max(0, body.max_tokens) : 0;
    // This is the existing local byte estimate, not a tokenizer or a hard cap.
    // Recovery remains best-effort and never calls the provider to count tokens.
    return approxTokensFromBytes(routedBody.length) + outputTokens > modelContextLimit;
}
function regrantSmallerWindowRecovery(state, key, modelContextLimit) {
    const previous = state.toolRecoveryAttemptedLanes.get(key);
    if (previous && !previous.inFlight && modelContextLimit < previous.modelContextLimit) {
        // The route has already been evicted. Dropping the attempt mark lifts its
        // backoff/awaiting-index, and an outage cooldown can defer the new
        // attempt without losing it; the next actual attempt records the smaller
        // capacity before it awaits anything.
        state.toolRecoveryAttemptedLanes.delete(key);
    }
}
/** Deterministic system identity. Message identities use cached per-message hashes. */
function routeValueHash(value) {
    return createHash("sha256")
        .update(JSON.stringify({
        present: value !== undefined,
        value: stableRouteValue(value),
    }))
        .digest("hex");
}
/** Canonicalize semantically identical Anthropic content representations. */
function normalizeRouteContent(content) {
    const blocks = typeof content === "string"
        ? [{ type: "text", text: content }]
        : content;
    return withoutContentBlockCacheControl(normalizeReminderContent(blocks));
}
/**
 * Claude Code changes request-attribution fields such as `cch` and
 * `cc_prev_req` during a tool loop. That synthetic top-level system block is
 * not conversation identity. Ignore exactly one standalone billing block
 * there, while keeping header-like text in messages fully identity-bearing.
 */
function normalizeRouteSystem(system) {
    const normalized = normalizeRouteContent(system);
    const headers = routeBillingHeaders(normalized);
    if (headers.length !== 1)
        return normalized;
    return replaceSingleRouteBillingHeader(normalized, ROUTE_BILLING_HEADER_PLACEHOLDER);
}
function normalizeReminderContent(content) {
    if (typeof content === "string")
        return normalizeRouteText(content);
    if (!Array.isArray(content))
        return content;
    return content.map((part) => {
        if (typeof part === "string")
            return normalizeRouteText(part);
        if (!part || typeof part !== "object")
            return part;
        const copy = { ...part };
        if (copy.type === "text" && typeof copy.text === "string") {
            copy.text = normalizeRouteText(copy.text);
        }
        else if (copy.type === "tool_result") {
            copy.content = normalizeReminderContent(copy.content);
        }
        return copy;
    });
}
const ROUTE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const ROUTE_BILLING_HEADER_PLACEHOLDER = "x-anthropic-billing-header: <dynamic>";
function normalizeRouteText(text) {
    return stripSystemReminderText(text);
}
/** Preserve Claude's current per-request billing metadata after prefix grafting. */
function currentRouteSystem(compressedSystem, currentSystem) {
    const currentHeaders = routeBillingHeaders(currentSystem);
    const compressedHeaders = routeBillingHeaders(compressedSystem);
    if (currentHeaders.length === 1 && compressedHeaders.length === 1) {
        return replaceSingleRouteBillingHeader(cloneJson(compressedSystem), currentHeaders[0]);
    }
    // The one-synthetic-header invariant broke (Claude reordered the header
    // fields, or the compressed system carries duplicate header-like blocks).
    // Never replay the FIRST request's stale cch/cc_prev_req attribution for
    // every tool call in the turn: drop the recognizable billing headers from
    // the routed system instead. Missing attribution is safer than wrong
    // attribution.
    const stripped = withoutRouteBillingHeaders(cloneJson(compressedSystem));
    // JSON.stringify omits undefined-valued keys, so an all-header system is
    // sent with no `system` field rather than an empty block list.
    return Array.isArray(stripped) && stripped.length === 0
        ? undefined
        : stripped;
}
function routeBillingHeaders(value) {
    if (typeof value === "string") {
        return isRouteBillingHeader(value) ? [value] : [];
    }
    if (!Array.isArray(value))
        return [];
    const headers = [];
    for (const item of value) {
        if (typeof item === "string") {
            if (isRouteBillingHeader(item))
                headers.push(item);
            continue;
        }
        if (item &&
            typeof item === "object" &&
            item.type === "text") {
            const text = item.text;
            if (typeof text === "string" && isRouteBillingHeader(text)) {
                headers.push(text);
            }
        }
    }
    return headers;
}
function isRouteBillingHeader(text) {
    if (/[\r\n]/.test(text) ||
        !text.startsWith(ROUTE_BILLING_HEADER_PREFIX)) {
        return false;
    }
    const fields = text.slice(ROUTE_BILLING_HEADER_PREFIX.length).trim();
    return (/^cc_version=[^;]+;/.test(fields) &&
        /(?:^|;\s*)cc_entrypoint=[^;]+;/.test(fields));
}
function replaceSingleRouteBillingHeader(value, replacement) {
    if (typeof value === "string") {
        return isRouteBillingHeader(value) ? replacement : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (typeof item === "string") {
                return isRouteBillingHeader(item) ? replacement : item;
            }
            if (!item ||
                typeof item !== "object" ||
                item.type !== "text") {
                return item;
            }
            const block = item;
            return typeof block.text === "string" &&
                isRouteBillingHeader(block.text)
                ? { ...block, text: replacement }
                : item;
        });
    }
    return value;
}
/** Remove every recognizable synthetic billing-header block from a system value. */
function withoutRouteBillingHeaders(value) {
    if (typeof value === "string") {
        return isRouteBillingHeader(value) ? undefined : value;
    }
    if (!Array.isArray(value))
        return value;
    return value.filter((item) => {
        if (typeof item === "string")
            return !isRouteBillingHeader(item);
        if (!item ||
            typeof item !== "object" ||
            item.type !== "text") {
            return true;
        }
        const text = item.text;
        return !(typeof text === "string" && isRouteBillingHeader(text));
    });
}
/** Anthropic's limit on cache_control breakpoints per request. */
/**
 * Claude Code marks its own blocks with cache_control, but the server's
 * flatten turns the compressed conversation into one plain-string user
 * message, so a compressed request carried no breakpoint at all: Anthropic
 * billed every compressed first request in full and cached nothing
 * (requests.jsonl, 2026-09-26: followup-compressed 51.8M uncached input,
 * 0.06M cache write; tool-recompressed 133.5M uncached, 0 either way).
 * Marking the flattened message caches system + tools + compressed history,
 * and every tool turn that rides the route reads it back.
 */
function withFlattenCacheBreakpoint(body, ttl) {
    const messages = body.messages;
    if (messages.length !== 1)
        return messages;
    const only = messages[0];
    const text = typeof only.content === "string" ? only.content : undefined;
    if (text === undefined)
        return messages;
    const cacheControl = { type: "ephemeral" };
    if (ttl !== undefined)
        cacheControl.ttl = ttl;
    return [{ ...only, content: [{ type: "text", text, cache_control: cacheControl }] }];
}
/**
 * Match the last existing marker in Anthropic's tools/system/messages order.
 * For a valid request it is the shortest TTL, so a new final marker cannot
 * put 1h after a retained 5m marker. Preserve omitted TTLs (default 5m).
 */
function cacheTtlOf(body) {
    let last;
    forEachCacheControl(body, (cc) => { last = cc.ttl; });
    return last;
}
/** A transformed request must not place a 1h breakpoint after a 5m one. */
function validCacheTtlOrder(body) {
    let sawShort = false;
    let valid = true;
    forEachCacheControl(body, (cc) => {
        if (cc.ttl === "1h") {
            if (sawShort)
                valid = false;
        }
        else {
            sawShort = true;
        }
    });
    return valid;
}
function forEachCacheControl(body, visit) {
    const blocks = (value) => {
        if (!Array.isArray(value))
            return;
        for (const item of value) {
            if (item && typeof item === "object" && item.cache_control) {
                visit(item.cache_control);
            }
        }
    };
    // Anthropic prompt order matters for mixed cache TTLs.
    blocks(body.tools);
    blocks(body.system);
    if (Array.isArray(body.messages)) {
        for (const m of body.messages)
            blocks(m?.content);
    }
}
/** Ignore only Anthropic content-block cache metadata, never user/tool data. */
function withoutContentBlockCacheControl(content) {
    if (Array.isArray(content)) {
        return content.map((part) => withoutContentBlockCacheControl(part));
    }
    if (!content || typeof content !== "object")
        return content;
    const { cache_control: _cacheControl, ...block } = content;
    return block;
}
function stableRouteValue(value) {
    if (Array.isArray(value))
        return value.map(stableRouteValue);
    if (!value || typeof value !== "object")
        return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        out[key] = stableRouteValue(value[key]);
    }
    return out;
}
function validToolRouteSuffix(messages) {
    if (!messages.length || messages.some(isNonToolUserMessage))
        return false;
    const toolUses = new Set();
    const toolResults = [];
    for (const message of messages) {
        if (!Array.isArray(message?.content))
            continue;
        for (const part of message.content) {
            if (!part || typeof part !== "object")
                continue;
            if (part.type === "tool_use" && typeof part.id === "string") {
                toolUses.add(part.id);
            }
            else if (part.type === "tool_result" &&
                typeof part.tool_use_id === "string") {
                toolResults.push(part.tool_use_id);
            }
        }
    }
    return (toolUses.size > 0 &&
        toolResults.length > 0 &&
        toolResults.every((id) => toolUses.has(id)));
}
function requestSessionId(req) {
    const value = req.headers["x-claude-code-session-id"];
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
}
function hasAgentAttribution(req) {
    return agentAttributionId(req) !== undefined;
}
function cloneJson(value) {
    if (value === undefined)
        return value;
    return JSON.parse(JSON.stringify(value));
}
/**
 * The blocking-compression step, shared by the main followup path and
 * tool-route miss recovery: the compress call plus the `compress` telemetry
 * record. Callers own downstream-close tracking (compression promises are
 * hash-deduped and may serve another live retry, so a per-request disconnect
 * signal must never feed compress()) and all decisions about the returned
 * result: both `didMemtreeCompress(result)` and
 * `checkCompressedHistory(result, msgsForMemtree).usable` must hold before
 * the result may be forwarded or become a route.
 */
async function runBlockingCompression(args) {
    const { opts, state, body, msgsForMemtree, hash, modelContextLimit, rec } = args;
    const compaction = args.compaction ??
        laneCompaction(opts, state, args.sessionId, body.model, modelContextLimit);
    const messageUsage = args.sessionId !== undefined && opts.transcriptUsage
        ? opts.transcriptUsage.usageFor(args.sessionId, msgsForMemtree, args.agentId)
        : undefined;
    const messageTimes = transcriptTimesFor(opts, args.sessionId, args.agentId)?.(msgsForMemtree);
    const compressStarted = Date.now();
    const compressMeta = {
        // Model + tools drive the server's model-based memory budget
        // (e.g. 800k whole-request target for Fable / Opus 5). Omitting
        // them silently downgrades to the server's static 50k fallback.
        // `[1m]` is re-attached when the session is 1M-context so the
        // server's budget telemetry names the variant it actually served.
        model: modelForMemtree(typeof body.model === "string" ? body.model : undefined, modelContextLimit),
        tools: Array.isArray(body.tools) ? body.tools : undefined,
        ...(compaction.target !== undefined
            ? { compressionTargetTokens: compaction.target }
            : {}),
        ...(compaction.threshold !== undefined
            ? { compressionThresholdTokens: compaction.threshold }
            : {}),
        ...(messageUsage && Object.keys(messageUsage).length ? { messageUsage } : {}),
        ...(messageTimes && Object.keys(messageTimes).length ? { messageTimes } : {}),
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        ...(args.clientMeta ? { clientMeta: args.clientMeta } : {}),
    };
    // Sampled BEFORE the call, while it still describes this call: after the
    // await the hash is in the cache regardless of who put it there.
    const cached = opts.memtree.hasCachedCompress(hash, modelContextLimit, compressMeta);
    // compress() maps every failure to a resolved null (it never rejects).
    // Keep foreground work finite even if a transport ignores its abort signal.
    let deadline;
    const maximumWait = Math.min(30_000, Math.max(1, Number.isFinite(opts.memtree.compressBudgetMs) ? opts.memtree.compressBudgetMs : 15_000));
    const result = await Promise.race([
        opts.memtree.compress(hash, msgsForMemtree, modelContextLimit, state.shutdownSignal, compressMeta),
        new Promise((resolve) => { deadline = setTimeout(() => resolve(null), maximumWait); }),
    ]).finally(() => { if (deadline)
        clearTimeout(deadline); });
    const compressMs = Date.now() - compressStarted;
    noteServerBudget(state, body.model, modelContextLimit, result);
    // Sampled at this call's settle, before a concurrent same-request failure of
    // another class can overwrite the complete-key entry.
    const failureArming = result === null &&
        opts.memtree.lastCompressFailureArming(hash, modelContextLimit, compressMeta);
    const hadLiveSuccess = !cached && result !== null;
    // Only arming-class live failures (network error, timeout, 5xx, 402) are
    // fuse evidence. A responsive server's other 4xx failed THIS call but says
    // nothing about MemTree's health, so it contributes neither failure nor
    // success — the fuse is untouched.
    const hadLiveFailure = !cached && result === null && failureArming;
    rec.compress = {
        ms: compressMs,
        ok: result !== null,
        // Budget-consumed heuristic: the client maps every failure to null, so a
        // null that took (roughly) the whole abort budget was almost certainly
        // the AbortSignal timeout, not a fast server error.
        timedOut: result === null && compressMs >= opts.memtree.compressBudgetMs,
    };
    return {
        result,
        // Cached-only operations leave the existing fuse state untouched.
        liveHealth: hadLiveSuccess
            ? "success"
            : hadLiveFailure
                ? "failure"
                : "none",
    };
}
/**
 * Shared final request shape for a validated compression result: lift any
 * returned system message to `body.system`, and forward the SERVER's flatten
 * of the compressed conversation as the single user message Anthropic
 * receives. The flatten format (closed transcript container, per-human-turn
 * headers, live-tail framing, header escaping) lives server-side only; the
 * client forwards `flattened_messages` verbatim and never re-derives it.
 * Returns null when the server provided no usable flatten (a pre-flatten
 * server, or a malformed field) — callers degrade to forwarding the original
 * history. Route candidates must be created from this `compressedBody` —
 * never from raw `result.messages` — so tool-turn rewrites extend exactly
 * the bytes that were sent.
 */
function buildCompressedBody(body, result) {
    const flattened = serverFlattenedMessages(result);
    if (flattened === null)
        return null;
    const systemMsg = result.messages.find((m) => m.role === "system");
    const compressedBody = {
        ...body,
        messages: flattened,
    };
    if (systemMsg?.content != null) {
        compressedBody.system = systemMsg.content;
    }
    compressedBody.messages = withFlattenCacheBreakpoint(compressedBody, cacheTtlOf(body));
    // Reserve a slot for the prefix even when all four original markers were
    // on retained tools/system blocks. Only this transformed body is capped.
    if (!capCacheBreakpoints(compressedBody, compressedBody.messages.length))
        return null;
    if (!validCacheTtlOrder(compressedBody))
        return null;
    return {
        compressedBody,
        compressedRaw: Buffer.from(JSON.stringify(compressedBody), "utf-8"),
    };
}
/**
 * A tool turn's compaction (planToolCompaction said its estimated size
 * reached the budget): one blocking compression forced to the target,
 * sharing the followup path's complete selection pipeline. This is a soft
 * fuse — any failure, no-op, unusable, or non-shrinking result degrades to
 * the body the turn would otherwise have sent (`fallback`: the old route or
 * prefix ride, recorded as keptPrefix; else the whole history). A validated
 * smaller result forwards exactly one compressed Anthropic leg, claims no
 * human-turn state (no notice, no prompt arm/delivery mutation), and at
 * protocol-complete installs the lane's route and, on the main thread, the
 * session's new stable prefix (`stable`), so later tool and human turns ride
 * it with no compress call. An attempt that produced no prefix sets the
 * lane's backoff (`retryAtTokens`).
 */
async function recoverToolRouteMiss(args) {
    const { opts, state, req, res, upstream, body, messages, forwardBody, msgsForMemtree, hash, modelContextLimit, routeEpoch, rec, conversationBytes, routeKey, isMainRequest, recoveryAttempt, toolForwarding, stable, fallback, } = args;
    const backOff = () => {
        if (args.retryAtTokens !== undefined) {
            recoveryAttempt.retryAtTokens = args.retryAtTokens;
            recoveryAttempt.retryDeadline = Date.now() + TOOL_RECOVERY_FAILURE_COOLDOWN_MS;
        }
    };
    const sessionId = requestSessionId(req);
    const routeOwning = sessionId !== undefined;
    // Only a route-owning recovery reserves the decision generation. A
    // transform-only attempt must not advance it — and, reciprocally, its late
    // completion can never install over (or clear) a route someone else
    // installed after this miss began, because it never activates at all.
    const decisionGeneration = routeOwning
        ? ++state.mainRouteDecisionGeneration
        : state.mainRouteDecisionGeneration;
    if (routeOwning)
        reserveRouteDecision(state, routeKey, decisionGeneration);
    // A reservation that ends up installing nothing must be RETURNED. It was
    // taken before the outcome was known, and while held it marks stale every
    // concurrent install and post-await clear that captured the previous
    // generation. Failing to release it means a failed/no-op/no-gain/
    // client-closed recovery silently suppresses a concurrent followup's
    // install, leaving the conversation with no route at all. Dropping our own
    // entry is unconditional and order-independent: it never moves anyone
    // else's reservation, so releasing before or after a newer sibling makes no
    // difference to who holds the decision.
    const releaseOwnReservation = () => {
        if (routeOwning)
            releaseRouteDecision(state, routeKey, decisionGeneration);
    };
    /**
     * The attempt produced nothing: send what the turn would have sent without
     * it — the old ride (kept prefix) or the whole history — and back off.
     */
    const forwardOriginal = () => {
        requestSendPolicies.get(req).failedRebuild = true;
        backOff();
        if (fallback) {
            requestSendPolicies.get(req)?.allowed.add(fallback.raw);
            if (rec.compaction)
                rec.compaction.keptPrefix = true;
            recordTurn(rec, fallback.turnType, fallback.raw);
            capture(opts, "anthropic-request-memory-tool", fallback.raw);
            return forwardRaw(req, res, fallback.raw, opts, upstream, state.shutdownSignal, rec).then((delivered) => {
                toolForwarding.settle(delivered);
                noteRideSize(fallback.sizeHolder, rec, fallback.raw.length);
            });
        }
        recordTurn(rec, "tool", args.originalBody);
        capture(opts, "anthropic-request", args.originalBody);
        return forwardRaw(req, res, args.originalBody, opts, upstream, state.shutdownSignal, rec).then((delivered) => {
            toolForwarding.settle(delivered);
            noteWholeRequestSize(state, isMainRequest, sessionId, routeKey, rec, args.originalBody.length);
        });
    };
    // Same downstream-close tracking as the followup path: compression
    // promises are hash-deduped and may serve another live retry, so the
    // subscriber's lifetime is tracked locally, never fed into compress().
    let downstreamClosedDuringCompression = res.destroyed && !res.writableFinished;
    const markDownstreamClosed = () => {
        if (!res.writableFinished)
            downstreamClosedDuringCompression = true;
    };
    res.once("close", markDownstreamClosed);
    const linkSeq = isMainRequest ? nextMemtreeCallSeq(state) : undefined;
    let compression;
    try {
        compression = await runBlockingCompression({
            opts,
            state,
            body,
            msgsForMemtree,
            hash,
            modelContextLimit,
            rec,
            sessionId: requestSessionId(req),
            agentId: agentAttributionId(req),
            clientMeta: args.clientMeta,
            ...(args.compaction ? { compaction: args.compaction } : {}),
        });
    }
    catch {
        releaseOwnReservation();
        rec.routeRecovery = { conversationBytes, outcome: "failed" };
        return forwardOriginal();
    }
    finally {
        res.off("close", markDownstreamClosed);
    }
    const { result } = compression;
    // Every lane writes the shared cooldown now: with subagents on the same
    // recovery path, a subagent's compress failure is the same evidence about
    // MemTree's health as main's, and its successes clear the cooldown too.
    noteMemtreeHealth(state, compression);
    if (linkSeq !== undefined) {
        noteMemtreePage(state, linkSeq, requestSessionId(req), result);
    }
    if (downstreamClosedDuringCompression ||
        (res.destroyed && !res.writableFinished)) {
        // The MemTree work keeps its cache/index value, but a dead client gets
        // no Anthropic request and no route.
        rec.routeRecovery = { conversationBytes, outcome: "client-closed" };
        releaseOwnReservation();
        // Same hazard class as the post-forward fates "upstream-failed" /
        // "client-aborted": no route was installed and the client's identical
        // retry is imminent, so no backoff is set and the attempt mark is
        // dropped; the retry compresses again, a compress-cache hit (client
        // closes are deliberately never fed into compress()). Retire only this
        // attempt so a late settle cannot remove a newer attempt.
        if (state.toolRecoveryAttemptedLanes.get(routeKey) === recoveryAttempt) {
            state.toolRecoveryAttemptedLanes.delete(routeKey);
        }
        recordTurn(rec, "tool", Buffer.alloc(0));
        return;
    }
    if (!result) {
        rec.routeRecovery = { conversationBytes, outcome: "failed" };
        releaseOwnReservation();
        // An ordinary server/network failure or timeout retains the background
        // submission: its longer independent budget can still warm the index for
        // a later turn. An unpaid key (402, possibly set by this very compress)
        // or a shutting-down proxy gets no retry.
        if (!state.shutdownSignal.aborted &&
            opts.memtree.paymentRequiredDetail === null) {
            opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, requestSessionId(req), args.clientMeta, transcriptTimesFor(opts, requestSessionId(req), agentAttributionId(req)));
        }
        return forwardOriginal();
    }
    // Any non-null response already submitted this history to the server; an
    // extra indexInBackground for the same request would be a duplicate.
    const actuallyCompressed = didMemtreeCompress(result);
    const historyCheck = checkCompressedHistory(result, msgsForMemtree);
    rec.history = {
        retainedChars: historyCheck.retainedChars,
        priorHistoryChars: historyCheck.priorHistoryChars,
        usable: historyCheck.usable,
    };
    if (!actuallyCompressed || !historyCheck.usable) {
        // Index-warming no-op (flattening it would change structured history for
        // nothing) or an indexed answer that dropped the conversation (amnesia —
        // fatal for a route). Both preserve the original body.
        rec.routeRecovery = {
            conversationBytes,
            outcome: actuallyCompressed ? "unusable" : "noop",
        };
        // No tree yet (nothing indexed): wait for it to be built rather than
        // retrying on growth, which on a fast-growing loop is every tool turn.
        const pageId = result.memtreeUrl ? memtreePageId(result.memtreeUrl) : undefined;
        if (!actuallyCompressed && !(cachedPromptTokenCount(result) ?? 0) && pageId) {
            recoveryAttempt.awaitingIndex = {
                pageId,
                checking: false,
                deadline: Date.now() + (opts.awaitedIndexWaitTimeoutMs ?? 60_000),
            };
            rec.routeRecovery.awaitingIndex = true;
        }
        releaseOwnReservation();
        return forwardOriginal();
    }
    // Serializing the compressed body is the one synchronous step here that can
    // realistically throw: these are the multi-megabyte payloads that court
    // V8's string-length ceiling, which is exactly why this fuse exists. A
    // throw would otherwise escape as a proxy 500 AND strand the reservation,
    // turning a recoverable tool turn into a failed one. Degrade instead — the
    // original body is still forwardable.
    let built;
    try {
        built = buildCompressedBody(body, result);
    }
    catch (err) {
        rec.routeRecovery = { conversationBytes, outcome: "build-failed" };
        releaseOwnReservation();
        if (opts.debug) {
            console.error(`[ccc proxy] recovered body build failed: ${err?.message ?? err}`);
        }
        return forwardOriginal();
    }
    if (built === null) {
        // The server compressed but returned no usable `flattened_messages`
        // (pre-flatten server, or a malformed field). The client never re-derives
        // the flatten locally — that drifted from the server's canonical format
        // once already — so degrade to the original body, same envelope as every
        // other non-forwardable recovery outcome.
        rec.routeRecovery = { conversationBytes, outcome: "no-flatten" };
        releaseOwnReservation();
        if (opts.debug) {
            console.error("[ccc proxy] recovered result carried no server flatten; " +
                "forwarding original body");
        }
        return forwardOriginal();
    }
    const { compressedBody, compressedRaw } = built;
    if (routedBodyExceedsContext(body, compressedRaw, modelContextLimit)) {
        rec.routeRecovery = { conversationBytes, outcome: "unusable" };
        releaseOwnReservation();
        return forwardOriginal();
    }
    if (compressedRaw.length >= (fallback?.raw ?? forwardBody).length) {
        // The final transformed body is the proof of payload recovery; a result
        // with no byte gain over what the turn would send anyway is not worth a
        // route built on it.
        rec.routeRecovery = { conversationBytes, outcome: "no-gain" };
        releaseOwnReservation();
        return forwardOriginal();
    }
    rec.routeRecovery = { conversationBytes, outcome: "compressed" };
    let activationAttempted = false;
    let installFate;
    let installedRoute;
    const activateRecoveredRoute = () => {
        if (activationAttempted)
            return;
        if (!requestSendPolicies.get(req)?.allowed.has(compressedRaw)) {
            releaseOwnReservation();
            activationAttempted = true;
            return;
        }
        if (!routeOwning) {
            // A sessionless request can use this response but cannot store a reusable route.
            activationAttempted = true;
            return;
        }
        // Installation checks the same lane-generation guard before any mutation.
        const installed = installMemoryRoute(state, routeKey, req, body, messages, compressedBody, routeEpoch, decisionGeneration, stable);
        // Leave this false if installMemoryRoute unexpectedly throws: the
        // delivery-complete fallback then gets one safe retry.
        activationAttempted = true;
        installedRoute = installed;
        installFate = installed ? "installed" : "stale";
        // A tool continuation can arrive after message_stop while this HTTP
        // stream is still draining. Its route is already complete, so a smaller
        // window may buy recovery now. Mutate only this attempt's object: a late
        // transport settle must not release a newer attempt in the same lane.
        if (installed)
            recoveryAttempt.inFlight = false;
        if (opts.debug) {
            console.error(`[ccc proxy] recovered memory route activation: ${installed ? "installed" : "unavailable"}`);
        }
    };
    if (opts.debug) {
        console.error(`[ccc proxy] tool-route miss recovered: ${forwardBody.length} → ` +
            `${compressedRaw.length} body bytes`);
    }
    recordTurn(rec, "tool-recompressed", compressedRaw);
    // Tagged as a TOOL memory leg, not a followup one: capture-based tooling
    // must be able to tell a recovered tool request from a normal compressed
    // human turn without cross-referencing reqlog.
    capture(opts, "anthropic-request-memory-tool", compressedRaw);
    // Set when either activation attempt throws. Protocol-complete firing
    // means the upstream served the complete turn and the proxy accepted the
    // message_stop bytes into the response — not that the client received
    // them. A throw there must NOT fall through to "client-aborted" or
    // "upstream-failed" at settle: in the common sub-case (fast-tool abort)
    // the client consumed its answer and no identical-body retry is coming.
    // The close is not always client-owned — an upstream socket error after
    // the data chunk carrying message_stop lands here too — and a socket
    // that dies before the queued bytes flush DOES retry the identical body.
    // Those rarer closes keep the lane's backoff — an accepted, bounded
    // degradation (the retry forwards uncompressed until the history grows
    // past the retry size or the next human turn clears it), because the
    // closes are indistinguishable at settle time and lifting the backoff
    // would fund one blocking recompress per tool turn under a deterministic
    // activation throw.
    let activationThrew = false;
    requestSendPolicies.get(req)?.allowed.add(compressedRaw);
    const delivered = await forwardRaw(req, res, compressedRaw, opts, upstream, state.shutdownSignal, rec, 
    // Protocol-complete (accepted SSE message_stop or a complete 2xx JSON
    // response) is the real activation point, exactly as on the followup
    // path, so a fast tool request right after message_stop can ride.
    () => {
        try {
            activateRecoveredRoute();
        }
        catch {
            // forwardRaw's own guard would swallow this anyway; catching here
            // records that a route was earned but its bookkeeping threw, which
            // the settle label below must be able to tell apart from a
            // mid-stream abort or an upstream failure.
            activationThrew = true;
        }
    });
    toolForwarding.settle(delivered);
    // Defensive delivery-complete fallback, mirroring the followup path. A
    // candidate already activated at message_stop deliberately survives a
    // delivered=false settle (fast-tool abort); an upstream 500/529 or an
    // incomplete response never reached protocol-complete and never installs.
    // Swallow a repeat throw: if it escaped here, the settle logic below
    // would be skipped and the lane's reservation stranded for the rest of
    // the epoch. With no install fate the fallback below still labels
    // ("activation-error" for this corner) and releases; the backoff stays,
    // since the delivered client will not retry.
    if (delivered) {
        try {
            activateRecoveredRoute();
        }
        catch {
            // Fate/release handled by the settle logic below. Remember the throw:
            // this is a fully delivered response with no route, which must not be
            // labeled (or have its backoff lifted) as an upstream failure.
            activationThrew = true;
        }
    }
    rec.routeRecovery.install = !routeOwning
        ? "no-session"
        : // No install fate normally means protocol-complete never fired —
            // split by who owned the close: a client mid-stream abort is not
            // evidence about upstream health, and the attempt-rate tripwire needs
            // to count the two separately. The one exception is a turn the
            // upstream served to protocol-complete whose route bookkeeping threw
            // at an activation attempt (the protocol-complete attempt, the
            // delivered retry, or both): label it distinctly so it neither
            // pollutes the upstream-failure metric nor lifts the backoff. In
            // the common sub-case the client got its answer (a fast-tool abort
            // consumed message_stop first) and no identical-body retry is coming;
            // the rarer closes — a pre-flush socket death (which does retry, into
            // the lane's backoff) or an upstream-owned error after the accepted
            // message_stop chunk — land here too. See the activationThrew comment
            // above for why that trade-off is deliberate.
            installFate ??
                (activationThrew
                    ? "activation-error"
                    : rec.clientAborted
                        ? "client-aborted"
                        : "upstream-failed");
    if (stable)
        rec.routeRecovery.prefix = stable.installed ? "installed" : "not-installed";
    // The compacted request's reported size anchors the next budget check.
    const sizeHolder = stable?.installed ?? installedRoute;
    if (sizeHolder)
        notePrefixSize(sizeHolder, rec, compressedRaw.length);
    // Nothing to ride next turn, or a result that still does not fit the
    // window (the next turn would reject it and compress again): wait for
    // growth before the lane tries again.
    if (!sizeHolder || routedBodyExceedsContext(body, compressedRaw, modelContextLimit))
        backOff();
    // A reservation that lost its race (stale) or never reached
    // protocol-complete (upstream 5xx, truncated stream) installed nothing, so
    // it must stop suppressing whoever is still trying to install.
    if (rec.routeRecovery.install !== "installed")
        releaseOwnReservation();
    // A failed forward AFTER a healthy compress — upstream 5xx/529 or a client
    // mid-stream abort — left no route and the client retries the identical
    // body, so drop the lane's attempt mark, lifting the backoff just set —
    // identity-guarded so a late settle cannot remove a newer lane attempt.
    // The retry's recompress is a compress-cache hit, so the re-attempt is
    // cheap. A later route mismatch deliberately does NOT lift a backoff:
    // siblings sharing a parent-agent fallback lane genuinely mismatch each
    // other every turn, and lifting it there would be one real blocking
    // compress per tool step. The two fates are split in reqlog so the
    // attempt-rate tripwire can tell client behavior from upstream health;
    // the backoff lift treats them alike.
    if ((rec.routeRecovery.install === "upstream-failed" ||
        rec.routeRecovery.install === "client-aborted") &&
        state.toolRecoveryAttemptedLanes.get(routeKey) === recoveryAttempt) {
        state.toolRecoveryAttemptedLanes.delete(routeKey);
    }
}
/** Stamp the classified turn type and forwarded-size fields on the record. */
function recordTurn(rec, turnType, forwardBody) {
    rec.turnType = turnType;
    rec.forwardedBytes = forwardBody.length;
    rec.approxInputTokens = approxTokensFromBytes(forwardBody.length);
}
function headerText(headers, name) {
    const value = headers[name];
    return Array.isArray(value) ? value.join(",") : value ?? "";
}
/**
 * count_tokens: strip notices and mirror an active memory route during its
 * tool loop. The response itself remains byte-transparent.
 */
async function handleCountTokens(req, res, opts, upstream, state) {
    const rawBody = await readBody(req);
    let forwardBody = rawBody;
    try {
        const body = JSON.parse(rawBody.toString("utf-8"));
        if (Array.isArray(body.messages)) {
            const stripped = stripNoticeBlocks(body.messages);
            const strippedSystem = stripNoticeSystem(body.system);
            if (stripped.stripped || strippedSystem.stripped) {
                body.messages = stripped.messages;
                if (strippedSystem.system === undefined)
                    delete body.system;
                else
                    body.system = strippedSystem.system;
                forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
            }
            const lastMsg = lastNonSystemMessage(body.messages);
            // A tool_result tail is never an away-summary probe, so the lane key
            // only distinguishes main vs agent identity here.
            const countRoute = isToolResultUserMessage(lastMsg)
                ? getMemoryRoute(state, routeIdentity(req, false).key)
                : undefined;
            if (countRoute) {
                const routed = memoryRoutedToolBody(body, body.messages, countRoute, state.mainRouteEpoch, requestSessionId(req));
                if (routed)
                    forwardBody = routed;
            }
        }
    }
    catch {
        // Unknown shape: forward verbatim.
    }
    return forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, undefined).then(() => undefined);
}
/**
 * Forward a buffered request and pipe the response back byte-for-byte. A
 * passive observer parses copies of SSE/JSON chunks for request logging and
 * completion validation; its output is discarded and can never change the
 * client response.
 */
/**
 * Requests whose streamed response gets a text block appended: the hidden
 * away-summary (recap) request, so the recap Claude Code shows ends with the
 * MemTree link. Keyed by the incoming request so every forwarding path below
 * picks it up without threading a parameter through each one.
 */
const recapLinkAppenders = new WeakMap();
const requestSendPolicies = new WeakMap();
function forwardRaw(req, res, bodyBuffer, opts, upstream, shutdownSignal, rec, onProtocolComplete) {
    const policy = requestSendPolicies.get(req);
    if (policy && !policy.accept(bodyBuffer))
        return Promise.resolve(false);
    if (policy?.failedRebuild && !policy.allowed.has(bodyBuffer))
        bodyBuffer = policy.original;
    return new Promise((resolve) => {
        const headers = forwardableRequestHeaders(req);
        headers["content-length"] = String(bodyBuffer.length);
        const appendRecapText = recapLinkAppenders.get(req);
        // The passive observer must be able to decode its copy to verify complete
        // delivery (message_stop for SSE, complete JSON otherwise). Constrain the
        // negotiated coding to what the observation decoders support, so an
        // upstream choice like zstd cannot mark a byte-perfectly delivered
        // response as failed.
        // The bytes written to the client stay exact.
        headers["accept-encoding"] = observableAcceptEncoding(headers["accept-encoding"]);
        // Appending needs plain SSE text; the recap is tiny, so skip compression.
        if (appendRecapText)
            headers["accept-encoding"] = "identity";
        const forwardStarted = Date.now();
        let settled = false;
        let upstreamCompleted = false;
        let responseFinished = false;
        let protocolComplete = false;
        let successfulStatus = false;
        let clientAborted = false;
        let shutdownCancelled = false;
        let protocolCompleteNotified = false;
        let upstreamReq;
        let activeUpstreamRes;
        const notifyProtocolComplete = () => {
            if (protocolCompleteNotified ||
                !successfulStatus ||
                onProtocolComplete === undefined) {
                return;
            }
            protocolCompleteNotified = true;
            try {
                onProtocolComplete();
            }
            catch {
                // Route/observer bookkeeping can never affect byte delivery.
            }
        };
        const settle = (ok) => {
            if (settled)
                return;
            settled = true;
            if (ok)
                policy?.delivered();
            res.off("finish", onResponseFinish);
            res.off("close", onResponseClose);
            shutdownSignal.removeEventListener("abort", cancelForShutdown);
            resolve(ok);
        };
        const maybeSettle = () => {
            if (upstreamCompleted && responseFinished) {
                settle(successfulStatus && protocolComplete && !clientAborted);
            }
        };
        const onResponseFinish = () => {
            responseFinished = true;
            maybeSettle();
        };
        const onResponseClose = () => {
            if (res.writableFinished || shutdownCancelled)
                return;
            clientAborted = true;
            // Observability only: lets callers (and reqlog consumers) tell a
            // client-owned close from an upstream failure after the settle.
            if (rec)
                rec.clientAborted = true;
            activeUpstreamRes?.destroy();
            upstreamReq?.destroy();
            settle(false);
        };
        const completeUpstream = (complete) => {
            upstreamCompleted = true;
            protocolComplete = complete;
            if (complete && !res.destroyed)
                notifyProtocolComplete();
            if (res.destroyed && !res.writableFinished && !shutdownCancelled) {
                // The destroy is client-owned here: upstream ended cleanly (its
                // error/aborted handlers settle synchronously before this can run)
                // and the shutdownCancelled guard excludes the proxy-owned destroy —
                // on the decoder path, decoder.end() defers finish() a tick, and a
                // shutdown landing in that gap would otherwise be stamped as a
                // client abort (onResponseClose has the same guard). Stamp directly —
                // this settle detaches onResponseClose before the 'close' event that
                // normally stamps can fire, and losing that race would misclassify a
                // client abort as "upstream-failed" in the recovery settle.
                clientAborted = true;
                if (rec)
                    rec.clientAborted = true;
                settle(false);
                return;
            }
            maybeSettle();
        };
        const cancelForShutdown = () => {
            if (settled || shutdownCancelled)
                return;
            shutdownCancelled = true;
            // Teardown is proxy-owned. Detach the ordinary client-close classifier
            // before destroying either side of the pipe.
            res.off("close", onResponseClose);
            activeUpstreamRes?.destroy();
            upstreamReq?.destroy();
            if (!res.destroyed && !res.writableEnded)
                res.destroy();
            settle(false);
        };
        res.once("finish", onResponseFinish);
        res.once("close", onResponseClose);
        shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
        if (shutdownSignal.aborted) {
            cancelForShutdown();
            return;
        }
        upstreamReq = upstream.module.request({
            host: upstream.host,
            port: upstream.port,
            method: req.method,
            path: req.url, // path + query string verbatim (?beta=true etc.)
            headers,
        }, (upstreamRes) => {
            activeUpstreamRes = upstreamRes;
            const contentType = String(upstreamRes.headers["content-type"] ?? "");
            const isSse = contentType.includes("text/event-stream");
            const contentEncoding = String(upstreamRes.headers["content-encoding"] ?? "identity").trim().toLowerCase();
            const compressed = contentEncoding !== "" && contentEncoding !== "identity";
            let sawFirstByte = false;
            let sawMessageStop = false;
            let observerFailed = false;
            const observeSseEvent = (data) => {
                if (rec) {
                    mergeUsageFromSseEvent(data, rec);
                    if (rec.firstContentMs === undefined &&
                        data?.type === "content_block_delta") {
                        rec.firstContentMs = Date.now() - forwardStarted;
                    }
                }
                if (data?.type === "message_stop") {
                    sawMessageStop = true;
                }
            };
            // Rewrite only a plain, successful SSE stream; anything else passes
            // through untouched and simply carries no link.
            const appendText = appendRecapText &&
                isSse &&
                !compressed &&
                (upstreamRes.statusCode ?? 0) >= 200 &&
                (upstreamRes.statusCode ?? 0) < 300
                ? appendRecapText
                : undefined;
            const sseObserver = isSse
                ? new SseNoticeRewriter({
                    onEvent: observeSseEvent,
                    ...(appendText ? { endOfTurnText: appendText } : {}),
                })
                : null;
            const incrementalDecoder = sseObserver && compressed
                ? createObservationDecoder(contentEncoding)
                : null;
            const observedChunks = !isSse || (compressed && !incrementalDecoder) ? [] : null;
            const observeRawChunk = (chunk) => {
                if (rec && !sawFirstByte) {
                    sawFirstByte = true;
                    rec.ttfbMs = Date.now() - forwardStarted;
                }
                if (sseObserver && !compressed)
                    sseObserver.push(chunk);
                if (observedChunks)
                    observedChunks.push(Buffer.from(chunk));
            };
            if (rec) {
                rec.upstreamStatus = upstreamRes.statusCode ?? 502;
            }
            successfulStatus =
                typeof upstreamRes.statusCode === "number" &&
                    upstreamRes.statusCode >= 200 &&
                    upstreamRes.statusCode < 300;
            res.writeHead(upstreamRes.statusCode ?? 502, forwardableResponseHeaders(upstreamRes));
            if (incrementalDecoder && sseObserver) {
                // Gate each encoded SSE chunk on locally decoding its copy. This
                // guarantees message_start usage is recorded before the identical
                // gzip/Brotli/deflate bytes can trigger Claude's MessageDisplay hook.
                // Only the original bytes are written to the client.
                let decoderFailed = false;
                let pendingForward = null;
                let pendingFinish = null;
                incrementalDecoder.on("data", (chunk) => {
                    if (!decoderFailed)
                        sseObserver.push(chunk);
                });
                incrementalDecoder.on("error", () => {
                    decoderFailed = true;
                    observerFailed = true;
                    const forward = pendingForward;
                    pendingForward = null;
                    forward?.();
                    const finish = pendingFinish;
                    pendingFinish = null;
                    finish?.();
                });
                res.once("close", () => incrementalDecoder.destroy());
                const forwardEncoded = (chunk) => {
                    if (res.destroyed || res.writableEnded) {
                        upstreamRes.destroy();
                        return false;
                    }
                    if (res.write(chunk))
                        upstreamRes.resume();
                    else
                        res.once("drain", () => upstreamRes.resume());
                    return true;
                };
                upstreamRes.on("data", (chunk) => {
                    upstreamRes.pause();
                    observeRawChunk(chunk);
                    if (decoderFailed) {
                        forwardEncoded(chunk);
                        return;
                    }
                    let forwarded = false;
                    let accepted = false;
                    const forwardOnce = () => {
                        if (forwarded)
                            return accepted;
                        forwarded = true;
                        accepted = forwardEncoded(chunk);
                        return accepted;
                    };
                    pendingForward = forwardOnce;
                    try {
                        incrementalDecoder.write(chunk, (err) => {
                            if (err) {
                                decoderFailed = true;
                                observerFailed = true;
                            }
                            if (pendingForward === forwardOnce)
                                pendingForward = null;
                            const chunkAccepted = forwardOnce();
                            if (chunkAccepted &&
                                !decoderFailed &&
                                sawMessageStop) {
                                notifyProtocolComplete();
                            }
                        });
                    }
                    catch {
                        decoderFailed = true;
                        observerFailed = true;
                        if (pendingForward === forwardOnce)
                            pendingForward = null;
                        forwardOnce();
                    }
                });
                upstreamRes.on("end", () => {
                    let finished = false;
                    const finish = () => {
                        if (finished)
                            return;
                        finished = true;
                        pendingFinish = null;
                        sseObserver.flush();
                        if (!res.destroyed && !res.writableEnded)
                            res.end();
                        completeUpstream(!observerFailed && sawMessageStop);
                    };
                    if (decoderFailed) {
                        finish();
                        return;
                    }
                    try {
                        pendingFinish = finish;
                        incrementalDecoder.end(finish);
                    }
                    catch {
                        finish();
                    }
                });
                upstreamRes.on("error", () => {
                    incrementalDecoder.destroy();
                    res.destroy();
                    settle(false);
                });
                upstreamRes.on("aborted", () => {
                    incrementalDecoder.destroy();
                    res.destroy();
                    settle(false);
                });
                return;
            }
            if (appendText && sseObserver) {
                // Same observation as below, but the client gets the rewriter's
                // output (original frames plus the appended block) instead of the
                // raw bytes. Backpressure mirrors pipe().
                upstreamRes.on("data", (chunk) => {
                    if (rec && !sawFirstByte) {
                        sawFirstByte = true;
                        rec.ttfbMs = Date.now() - forwardStarted;
                    }
                    const out = sseObserver.push(chunk);
                    if (!out || res.destroyed || res.writableEnded)
                        return;
                    if (!res.write(out)) {
                        upstreamRes.pause();
                        res.once("drain", () => upstreamRes.resume());
                    }
                    if (sawMessageStop && !observerFailed && !res.destroyed) {
                        notifyProtocolComplete();
                    }
                });
                upstreamRes.on("end", () => {
                    const rest = sseObserver.flush();
                    if (rest && !res.destroyed && !res.writableEnded)
                        res.write(rest);
                    if (!res.destroyed && !res.writableEnded)
                        res.end();
                    completeUpstream(!observerFailed && sawMessageStop);
                });
                upstreamRes.on("error", () => {
                    res.destroy();
                    settle(false);
                });
                upstreamRes.on("aborted", () => {
                    res.destroy();
                    settle(false);
                });
                return;
            }
            upstreamRes.on("data", observeRawChunk);
            upstreamRes.pipe(res);
            if (isSse && !compressed) {
                // Registered after pipe(), so this runs only after the raw chunk
                // containing the complete message_stop frame has been accepted by
                // ServerResponse. The callback still runs synchronously before a
                // client can issue the resulting tool request.
                upstreamRes.on("data", () => {
                    if (sawMessageStop && !observerFailed && !res.destroyed) {
                        notifyProtocolComplete();
                    }
                });
            }
            upstreamRes.on("end", () => {
                let observed = null;
                if (observedChunks) {
                    observed = decodeForObservation(Buffer.concat(observedChunks), contentEncoding);
                    if (rec && observed && !isSse) {
                        mergeUsageFromJsonBody(observed, rec);
                    }
                }
                if (isSse) {
                    if (compressed && !incrementalDecoder) {
                        if (observed)
                            sseObserver?.push(observed);
                        else
                            observerFailed = true;
                    }
                    sseObserver?.flush();
                    completeUpstream(!observerFailed && sawMessageStop);
                }
                else {
                    completeUpstream(observed !== null && isCompleteJsonResponse(req.url, observed));
                }
            });
            upstreamRes.on("error", () => {
                res.destroy();
                settle(false);
            });
            upstreamRes.on("aborted", () => {
                res.destroy();
                settle(false);
            });
        });
        upstreamReq.on("error", (err) => {
            if (!shutdownCancelled) {
                sendAnthropicError(res, `upstream connection failed: ${err.message}`);
            }
            settle(false);
        });
        upstreamReq.end(bodyBuffer);
    });
}
function isCompleteJsonResponse(requestUrl, body) {
    try {
        const parsed = JSON.parse(body.toString("utf-8"));
        const pathname = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
        if (pathname.endsWith("/count_tokens")) {
            return (typeof parsed?.input_tokens === "number" &&
                Number.isFinite(parsed.input_tokens) &&
                parsed.input_tokens >= 0);
        }
        return parsed?.type === "message" && Array.isArray(parsed.content);
    }
    catch {
        return false;
    }
}
/** Transparent streaming passthrough for everything else. */
function passThroughStreaming(req, res, upstream, shutdownSignal) {
    return new Promise((resolve) => {
        const headers = forwardableRequestHeaders(req);
        // The body is piped unmodified here, so keep the client's original
        // content-length (SKIP_REQUEST_HEADERS strips it for the buffered paths,
        // which recompute it); dropping it would silently convert the request to
        // chunked transfer-encoding.
        if (req.headers["content-length"] !== undefined) {
            headers["content-length"] = req.headers["content-length"];
        }
        let settled = false;
        let shutdownCancelled = false;
        let incomingUploadEnded = req.readableEnded;
        let upstreamUploadFinished = false;
        let upstreamResponseEnded = false;
        let downstreamFinished = res.writableFinished;
        let pendingErrorResponse = false;
        let upstreamReq;
        let activeUpstreamRes;
        const settle = () => {
            if (settled)
                return;
            settled = true;
            shutdownSignal.removeEventListener("abort", cancelForShutdown);
            resolve();
        };
        /** Clean completion owns all four independently asynchronous seams. */
        const settleIfComplete = () => {
            if (incomingUploadEnded &&
                upstreamUploadFinished &&
                upstreamResponseEnded &&
                downstreamFinished) {
                settle();
            }
        };
        /** Every abnormal exit tears down the whole duplex exchange exactly once. */
        const tearDown = () => {
            if (settled)
                return;
            // An early upstream response can mark ClientRequest/IncomingMessage as
            // destroyed while their keep-alive socket still awaits the rest of the
            // upload. Capture both transports before stream teardown and close them
            // explicitly so server.close() cannot inherit a half-owned connection.
            const downstreamSocket = req.socket;
            const upstreamSocket = activeUpstreamRes?.socket ?? upstreamReq?.socket;
            activeUpstreamRes?.unpipe(res);
            if (upstreamReq)
                req.unpipe(upstreamReq);
            // Mark settled before destroy(): close/error events can fire reentrantly.
            settle();
            if (!req.destroyed)
                req.destroy();
            if (upstreamReq && !upstreamReq.destroyed)
                upstreamReq.destroy();
            if (activeUpstreamRes && !activeUpstreamRes.destroyed) {
                activeUpstreamRes.destroy();
            }
            if (!res.destroyed)
                res.destroy();
            if (upstreamSocket && !upstreamSocket.destroyed)
                upstreamSocket.destroy();
            if (!downstreamSocket.destroyed)
                downstreamSocket.destroy();
        };
        const onIncomingEnd = () => {
            incomingUploadEnded = true;
            settleIfComplete();
        };
        const onIncomingClose = () => {
            if (settled)
                return;
            if (req.complete) {
                incomingUploadEnded = true;
                settleIfComplete();
            }
            else {
                tearDown();
            }
        };
        const onDownstreamFinish = () => {
            downstreamFinished = true;
            if (pendingErrorResponse)
                tearDown();
            else
                settleIfComplete();
        };
        const onResponseClose = () => {
            if (settled)
                return;
            if (res.writableFinished) {
                downstreamFinished = true;
                if (pendingErrorResponse)
                    tearDown();
                else
                    settleIfComplete();
            }
            else {
                tearDown();
            }
        };
        const cancelForShutdown = () => {
            if (settled || shutdownCancelled)
                return;
            shutdownCancelled = true;
            tearDown();
        };
        req.once("end", onIncomingEnd);
        req.once("aborted", tearDown);
        req.once("error", tearDown);
        req.once("close", onIncomingClose);
        res.once("finish", onDownstreamFinish);
        res.once("error", tearDown);
        res.once("close", onResponseClose);
        shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
        if (shutdownSignal.aborted) {
            cancelForShutdown();
            return;
        }
        upstreamReq = upstream.module.request({
            host: upstream.host,
            port: upstream.port,
            method: req.method,
            path: req.url,
            headers,
        }, (upstreamRes) => {
            if (settled) {
                upstreamRes.destroy();
                return;
            }
            activeUpstreamRes = upstreamRes;
            const onUpstreamResponseEnd = () => {
                upstreamResponseEnded = true;
                settleIfComplete();
            };
            const onUpstreamResponseClose = () => {
                if (!settled && !upstreamResponseEnded)
                    tearDown();
            };
            upstreamRes.once("end", onUpstreamResponseEnd);
            upstreamRes.once("error", tearDown);
            upstreamRes.once("aborted", tearDown);
            upstreamRes.once("close", onUpstreamResponseClose);
            try {
                res.writeHead(upstreamRes.statusCode ?? 502, forwardableResponseHeaders(upstreamRes));
            }
            catch {
                tearDown();
                return;
            }
            upstreamRes.pipe(res);
        });
        upstreamReq.once("finish", () => {
            upstreamUploadFinished = true;
            settleIfComplete();
        });
        upstreamReq.once("close", () => {
            if (!settled && !upstreamUploadFinished && !pendingErrorResponse) {
                tearDown();
            }
        });
        upstreamReq.on("error", (err) => {
            if (settled)
                return;
            if (shutdownCancelled || res.headersSent || res.destroyed) {
                tearDown();
                return;
            }
            // Preserve the existing Anthropic-shaped 502 when no upstream bytes
            // were committed. Ownership remains until that response flushes, then
            // the still-open incoming upload/socket is torn down as one exchange.
            pendingErrorResponse = true;
            if (upstreamReq)
                req.unpipe(upstreamReq);
            activeUpstreamRes?.unpipe(res);
            sendAnthropicError(res, `upstream connection failed: ${err.message}`);
            if (res.writableFinished)
                onDownstreamFinish();
        });
        try {
            req.pipe(upstreamReq);
        }
        catch {
            tearDown();
        }
    });
}
function forwardableRequestHeaders(req) {
    const out = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key.toLowerCase()))
            continue;
        if (value === undefined)
            continue;
        out[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
}
function forwardableResponseHeaders(upstreamRes) {
    const out = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase()))
            continue;
        if (value === undefined)
            continue;
        out[key] = value;
    }
    return out;
}
/** Well-formed Anthropic-shaped error body so Claude Code fails fast, not weird. */
function sendAnthropicError(res, message) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const payload = JSON.stringify({
        type: "error",
        error: { type: "api_error", message },
    });
    res.writeHead(502, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
}
let captureCounter = 0;
/** Test-only diagnostics: dump forwarded bodies for smoke-test inspection. */
function capture(opts, kind, body) {
    const dir = opts.captureDir;
    if (!dir)
        return;
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // mkdir does not tighten a directory reused from an earlier run.
        chmodSync(dir, 0o700);
        const name = `${String(++captureCounter).padStart(4, "0")}-${kind}-${randomBytes(8).toString("hex")}.json`;
        // Never reuse an existing file (which may have permissive old modes).
        writeFileSync(join(dir, name), body, { mode: 0o600, flag: "wx" });
    }
    catch {
        // diagnostics only — never break the proxy path
    }
}
function readBody(req) {
    return readAll(req);
}
const OBSERVABLE_ENCODINGS = new Set(["gzip", "br", "deflate", "identity"]);
/**
 * Restrict a client Accept-Encoding value to codings the passive observer can
 * decode (see createObservationDecoder/decodeForObservation). Client tokens
 * are kept verbatim (q-values included) so negotiation semantics survive —
 * except q=0 tokens, which the client explicitly refuses and so cannot count
 * as an acceptable coding; an absent header means "anything", so advertise
 * the full supported set, and if nothing supported and acceptable remains
 * fall back to identity, which every client accepts.
 */
const REFUSED_Q_ZERO = /;\s*q\s*=\s*0(?:\.0{0,3})?\s*(?:;|$)/i;
function observableAcceptEncoding(clientValue) {
    if (clientValue === undefined)
        return "gzip, br, deflate";
    const kept = clientValue
        .split(",")
        .map((token) => token.trim())
        .filter((token) => OBSERVABLE_ENCODINGS.has(token.split(";", 1)[0].trim().toLowerCase()) &&
        !REFUSED_Q_ZERO.test(token));
    return kept.length > 0 ? kept.join(", ") : "identity";
}
/** Incremental decoder used only to observe a copy of encoded SSE bytes. */
function createObservationDecoder(encoding) {
    if (encoding === "gzip")
        return createGunzip();
    if (encoding === "br")
        return createBrotliDecompress();
    if (encoding === "deflate")
        return createInflate();
    return null;
}
/** Decode a response copy for diagnostics without ever touching forwarded bytes. */
function decodeForObservation(body, encoding) {
    try {
        if (!encoding || encoding === "identity")
            return body;
        if (encoding === "gzip")
            return gunzipSync(body);
        if (encoding === "br")
            return brotliDecompressSync(body);
        if (encoding === "deflate")
            return inflateSync(body);
    }
    catch {
        // Diagnostics only. Unknown/corrupt encodings do not affect proxying.
    }
    return null;
}
function readAll(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}
/** Test seam. */
export const __testCapCacheBreakpoints = capCacheBreakpoints;
export const __testEstimateRequestTokens = estimateRequestTokens;
/** Reads message times from the session's transcript, when there is one. */
function transcriptTimesFor(opts, sessionId, agentId) {
    const source = opts.transcriptUsage;
    if (sessionId === undefined || !source?.timesFor)
        return undefined;
    return (messages) => source.timesFor(sessionId, messages, agentId);
}
//# sourceMappingURL=proxy.js.map