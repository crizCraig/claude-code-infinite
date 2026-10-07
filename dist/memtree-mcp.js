/**
 * `memtree` MCP server: lets the agent search and read its own session's
 * MemTree and the user's other sessions (tools `search`, `read_node`,
 * `read_lines`, `list`, which Claude Code exposes as `mcp__memtree__*`).
 * `search` covers all of the user's sessions, or one tree with `tree` ("current"
 * for this session's), in text (default) or vector mode; every hit names its
 * node as an address `<tree>#<node>` with its path from the root, which
 * `read_node` / `read_lines` take as `node`.
 *
 * A minimal JSON-RPC 2.0 server over stdio (newline-delimited messages, the
 * MCP stdio transport); no SDK dependency. Started by Claude Code from the
 * `--mcp-config` ccc passes (interactive sessions) or one the caller passes
 * (`ccc memtree-mcp`, e.g. the memory recall probe).
 *
 * Which tree: the loopback proxy of the ccc that launched this Claude Code
 * (`CCC_MEMTREE_PROXY`, else the inherited `ANTHROPIC_BASE_URL`) answers
 * `GET /memtree/current?session=<id>` with the newest page it served — the
 * tree the current request was compressed against. The session id is the
 * `CLAUDE_CODE_SESSION_ID` Claude Code sets for MCP servers. Reads of this
 * session's current tree require that exact session on both the proxy's pointer
 * and the page; missing or mismatched identity fails closed, and the host must
 * restart this server with the current id when switching sessions. The page JSON
 * is fetched through the proxy's key-free `/memtree/<id>.json` relay and cached
 * once complete.
 *
 * Other trees (the owner's other sessions, by reference from list or search)
 * are read the same way without the session check: they are
 * named explicitly, and the server authorizes them by the user's key.
 *
 * `search` asks the server first (`/memtree/<id>/search`, the Step 6 term
 * search, so a long session's page JSON is not downloaded just to search it)
 * and falls back to searching the page JSON locally on a server without that
 * endpoint.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FINDER_SEARCH_DEFAULT_LIMIT, FINDER_SEARCH_MAX_LIMIT, formatSearchResults, searchMode, formatSessions, searchQuery, SESSIONS_DEFAULT_LIMIT, SESSIONS_MAX_LIMIT, sessionsQuery, } from "./memtree-finder.js";
import { formatLines, formatNode, formatSearch, formatSearchHits, formatTail, MemtreeIndex, parseNodeAddress, serverSearchHits, READ_LINES_MAX_CHARS, READ_LINES_MAX_LINES, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, ToolInputError, } from "./memtree-tools.js";
import { CLIENT_VERSION } from "./memtree.js";
export const MEMTREE_MCP_SERVER_NAME = "memtree";
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export const MEMTREE_TOOL_NAMES = [
    "search",
    "read_node",
    "read_lines",
    "list",
];
/** `tree` value naming this session's own current tree. */
export const CURRENT_TREE = "current";
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const FETCH_TIMEOUT_MS = 60_000;
const PREFIX_RETRY_INTERVAL_MS = 45_000;
/**
 * The MCP server's instructions, which Claude Code places in the system prompt
 * from the first request: the one place that explains the agent's situation
 * before any memory message exists. Constant, so the prompt cache holds.
 */
export const MEMTREE_MCP_INSTRUCTIONS = "This session runs in Claude Code Infinite, which lets a conversation continue past the model's context window. " +
    "MemTree indexes the whole conversation as it goes: a tree of summaries from a one-line overview at the root down to " +
    "leaves, each pointing at the exact transcript lines it summarizes. Indexing runs in the background and trails the " +
    "newest messages slightly.\n\n" +
    "Until the conversation reaches its size budget you see every message verbatim, and these tools are only a way to " +
    "find things in a long history. Once it reaches the budget, the earlier conversation is replaced by a single memory " +
    "message: that tree, expanded where it looked relevant to the latest request and collapsed elsewhere. The user's own " +
    "messages shown there, and everything after the memory message, stay word for word; the rest of the earlier " +
    "conversation survives only as summaries, which drop exact values, instructions, reasoning and dead ends. The detail " +
    "is not gone: these tools read it back.\n\n" +
    "So once you see that memory message: when your work depends on something from earlier in the session (what the " +
    "user asked for or ruled out, decisions and why they were made, findings, ids and paths, commands, what was tried " +
    "and failed), search MemTree before re-deriving it from the code or guessing. The code shows what exists; the " +
    "memory shows what was decided and why. Read the exact lines (read_lines) when precision matters.\n\n" +
    "search with \"tree\": \"current\" looks in this session's MemTree; without tree it searches all of the user's " +
    "sessions (use that when the user refers to earlier work that is not in this session), and list shows those " +
    "sessions by time and project. Text mode (default, free) matches exact words, ids and paths; vector mode matches " +
    "meaning: its first page is charged even when the query embedding is cached; cursor continuation is free, " +
    "including when the embedding must be regenerated. Hits may include an address (<tree>#<node>) and its path from the root. If the address is unavailable, read_lines with the hit’s tree.ref and range reads its exact lines. With an address: " +
    "read_node {\"node\": address} opens it with its children, and the path's addresses lead to its parent and " +
    "siblings; read_lines {\"node\": address} reads a leaf's exact lines. Cursors page over live results, not a " +
    "frozen snapshot. A tree trails its conversation: the newest messages (often how a session ended) are in no tree " +
    "yet, and search does not see them; read_lines {\"tail\": true} reads them verbatim (with tree for another " +
    "session's page).";
const TREE_DESC = "A tree reference from list or search (keep its style and own/served suffix; legacy request ids work), or \"current\" for this session's tree.";
export const MEMTREE_TOOLS = [
    {
        name: "search",
        description: "Search MemTree for exact details or for meaning: one tree (tree, \"current\" for this session) or, without tree, " +
            "all of the user's sessions. Use it before re-deriving or guessing something from earlier work. " +
            "mode \"text\" (default, free) matches words, ids, paths and errors (in one tree: node summaries and transcript " +
            "lines); mode \"vector\" matches meaning, ranked per embedding model; its first page is charged even when the " +
            "query embedding is cached, and cursor continuation is free. Cursors page over live results, not a frozen snapshot. " +
            "Hits include a snippet and range; their node address (<tree>#<node>) and path may be unavailable. Without an address, use read_lines with the hit’s tree.ref and range.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Distinctive words (text; \"quoted phrase\", or, -word across sessions) or a question (vector)." },
                tree: { type: "string", description: `Optional. ${TREE_DESC} Omit to search all sessions.` },
                mode: { type: "string", enum: ["text", "vector"], description: "text (default, exact words, free) or vector (meaning, first page charged)." },
                project: { type: "string", description: "Without tree: only sessions in this working directory or git repository (owner/repo, or just repo)." },
                since: { type: "string", description: "Without tree: only requests at or after this ISO 8601 time or date." },
                until: { type: "string", description: "Without tree: only requests before this ISO 8601 time or date." },
                cursor: { type: "string", description: "next cursor from a previous call, to get the next page (same other arguments)." },
                limit: { type: "number", description: `Hits per page (default ${FINDER_SEARCH_DEFAULT_LIMIT}, at most ${FINDER_SEARCH_MAX_LIMIT}; per model for vector).` },
            },
            required: ["query"],
        },
    },
    {
        name: "read_node",
        description: "Read one MemTree node: its summary, its path from the root (ancestor summaries), its children (id, summary, leaf or branch) and, " +
            "for a leaf, the transcript line range it covers. Give node (an address from search) or id (0 is the root) with an optional tree.",
        inputSchema: {
            type: "object",
            properties: {
                node: { type: "string", description: "A node address <tree>#<id> from search." },
                id: { type: "number", description: "Node id (0 is the root), in tree or this session's tree." },
                tree: { type: "string", description: `With id: ${TREE_DESC} Omit for this session.` },
            },
        },
    },
    {
        name: "read_lines",
        description: "Read exact transcript lines: a leaf's node address (its whole range), or block and 1-based inclusive start/end lines. " +
            `At most ${READ_LINES_MAX_LINES} lines / ${READ_LINES_MAX_CHARS} characters per call; the reply says where to continue when capped. ` +
            "With tail: true, read the messages after the tree that no tree covers yet (the end of a session usually is there, " +
            "and search does not see it): the newest ones, or start/end message positions; add tree for another session's page.",
        inputSchema: {
            type: "object",
            properties: {
                node: { type: "string", description: "A leaf's address <tree>#<id> from search; block/start/end then default to its range." },
                block: { type: "number", description: "Block index (a leaf's first range number)." },
                start: { type: "number", description: "First line, 1-based." },
                end: { type: "number", description: "Last line, inclusive." },
                tree: { type: "string", description: `With block/start/end or tail: ${TREE_DESC} Omit for this session.` },
                tail: { type: "boolean", description: "Read the un-indexed messages after the tree instead of lines; start/end are then message positions." },
            },
        },
    },
    {
        name: "list",
        description: "List the user's own MemTree sessions (this one and others), most recently active first: title (the tree's root summary), " +
            "first message, times, project (directory, git repo, branch, commit), models, request count and the latest tree's reference. " +
            "Filter by time, project or words in the title. Free. Open a session's tree with read_node {\"tree\": <ref>, \"id\": 0} or search {\"tree\": <ref>, ...}.",
        inputSchema: {
            type: "object",
            properties: {
                since: { type: "string", description: "Only activity at or after this ISO 8601 time or date (UTC unless an offset is given), e.g. 2026-09-01." },
                until: { type: "string", description: "Only activity before this ISO 8601 time or date." },
                project: { type: "string", description: "Working directory name or git repository (owner/repo, or just repo), case-insensitive." },
                q: { type: "string", description: "Keep sessions whose title, first message or project contains this text." },
                cursor: { type: "string", description: "next cursor from a previous call, to get the next page (same other arguments)." },
                limit: { type: "number", description: `Sessions per page (default ${SESSIONS_DEFAULT_LIMIT}, at most ${SESSIONS_MAX_LIMIT}).` },
            },
        },
    },
];
/** A request id in either spelling (UUID or the short leading-hex form). */
const TREE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Other sessions' pages kept in memory at once (each can be several MB). */
const OTHER_TREES_CACHED = 4;
/** GET JSON from the loopback proxy; never throws. */
async function proxyGetJson(fetchImpl, url, headers = {}) {
    let response;
    try {
        response = await fetchImpl(url, {
            headers: { accept: "application/json", ...headers },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    }
    catch (err) {
        return { ok: false, status: 0, error: String(err) };
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
        let detail = text.slice(0, 300);
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed?.detail === "string")
                detail = parsed.detail;
        }
        catch {
            // not JSON: keep the raw text
        }
        return { ok: false, status: response.status, error: `HTTP ${response.status} ${detail}` };
    }
    try {
        return { ok: true, status: response.status, body: JSON.parse(text) };
    }
    catch {
        return { ok: false, status: response.status, error: "response was not JSON" };
    }
}
function proxyBase(deps) {
    const base = deps.proxyUrl?.replace(/\/$/, "");
    if (!base) {
        throw new ToolInputError("MemTree tools need a running ccc session: neither CCC_MEMTREE_PROXY nor ANTHROPIC_BASE_URL is set.");
    }
    return base;
}
function checkTreeId(tree) {
    if (tree === undefined || tree === null || tree === "")
        return undefined;
    if (typeof tree !== "string" || !TREE_ID_RE.test(tree.trim())) {
        throw new ToolInputError("tree must be a tree reference from list or search, or \"current\"");
    }
    return tree.trim();
}
/**
 * Resolves, fetches and caches the current page, and other sessions' pages
 * by request id.
 */
export class CurrentTree {
    deps;
    cached;
    /** Temporary prefix pages: when each may be fetched again. */
    prefixRetryAt = new Map();
    /** The last fetched temporary prefix per page, served during its cooldown. */
    prefixes = new Map();
    inFlight;
    /** Other trees, least recently used first. */
    others = new Map();
    /** Set once the server answered 404 to a tree search the page JSON could answer. */
    serverSearchMissing = false;
    fetchImpl;
    now;
    constructor(deps) {
        this.deps = deps;
        this.fetchImpl = deps.fetch ?? globalThis.fetch;
        this.now = deps.now ?? Date.now;
    }
    get(tree) {
        let other;
        try {
            other = checkTreeId(tree);
        }
        catch (err) {
            return Promise.reject(err);
        }
        if (other)
            return this.getOther(other);
        if (this.inFlight)
            return this.inFlight;
        const pending = this.loadCurrent();
        this.inFlight = pending;
        return pending.finally(() => {
            if (this.inFlight === pending)
                this.inFlight = undefined;
        });
    }
    /**
     * The server's term search over the tree when it has the endpoint (no page
     * download), else the same search over the page JSON here.
     */
    async search(query, limit, tree) {
        const other = checkTreeId(tree);
        if (!this.serverSearchMissing) {
            const id = other ?? (await this.currentId());
            const params = new URLSearchParams({ q: query });
            if (limit !== undefined && Number.isFinite(limit))
                params.set("limit", String(limit));
            const base = proxyBase(this.deps);
            const answer = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}/search?${params}`);
            const parsed = answer.ok ? serverSearchHits(answer.body) : undefined;
            if (parsed) {
                const session = answer.body.session_id;
                if (!other && session !== undefined)
                    this.checkSession(session, this.requireSessionId());
                if (other || session !== undefined)
                    return formatSearchHits(parsed.hits, query, parsed.terms, other);
                // Older servers omit identity: search only the session-validated page.
            }
            if (answer.status === 202) {
                throw new ToolInputError("That MemTree is still being built; try again in a minute.");
            }
            const result = formatSearch(await this.get(other), query, limit, other);
            if (answer.status === 404 || answer.status === 405)
                this.serverSearchMissing = true;
            return result;
        }
        return formatSearch(await this.get(other), query, limit, other);
    }
    /**
     * The server's un-indexed tail after the tree (`/messages`), never cached:
     * it grows with the conversation. With no range, the newest messages.
     */
    async tail(tree, start, end) {
        const other = checkTreeId(tree);
        const id = other ?? (await this.currentId());
        const params = new URLSearchParams();
        if (start !== undefined)
            params.set("start", String(start));
        if (end !== undefined)
            params.set("end", String(end));
        const query = params.toString() ? `?${params}` : "";
        const base = proxyBase(this.deps);
        const answer = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}/messages${query}`);
        if (answer.status === 404) {
            return "No un-indexed messages after this tree: everything the server has recorded is in the tree (or the server predates tails).";
        }
        if (answer.status === 416) {
            throw new ToolInputError(`read_lines: ${(answer.error ?? "").replace(/^HTTP 416 /, "")}`);
        }
        if (!answer.ok)
            throw new ToolInputError(`MemTree tail unavailable (page ${id}: ${answer.error})`);
        if (!other)
            this.checkSession(answer.body.session_id, this.requireSessionId());
        return formatTail(answer.body, other);
    }
    async loadCurrent() {
        const id = await this.currentId();
        const sessionId = this.requireSessionId();
        if (this.cached?.id === id)
            return this.cached.index;
        const index = await this.loadPage(id, "this session", sessionId);
        if (!isTemporaryPrefix(index, id))
            this.cached = { id, index };
        return index;
    }
    requireSessionId() {
        const sessionId = this.deps.sessionId;
        if (!sessionId)
            throw new ToolInputError("MemTree unavailable: the calling session id is missing");
        return sessionId;
    }
    /** The proxy's current page for the calling session; fails closed on any other session. */
    async currentId(validatePage = false) {
        const base = proxyBase(this.deps);
        const sessionId = this.requireSessionId();
        const query = `?session=${encodeURIComponent(sessionId)}`;
        const pointer = await proxyGetJson(this.fetchImpl, `${base}/memtree/current${query}`);
        if (pointer.status === 404) {
            throw new ToolInputError("This session has no MemTree yet: nothing has been indexed or compressed so far, so everything is still in your context.");
        }
        if (!pointer.ok)
            throw new ToolInputError(`MemTree unavailable (current page: ${pointer.error})`);
        const current = pointer.body;
        if (typeof current?.id !== "string" || !current.id) {
            throw new ToolInputError("MemTree unavailable: the proxy named no current page");
        }
        if (current.session_id !== sessionId) {
            throw new ToolInputError("MemTree unavailable: current page belongs to a different or unknown session");
        }
        if (validatePage) {
            const index = this.cached?.id === current.id ? this.cached.index
                : await this.loadPage(current.id, "this session", sessionId);
            this.checkSession(index.page.session_id, sessionId);
            if (!isTemporaryPrefix(index, current.id))
                this.cached = { id: current.id, index };
        }
        return current.id;
    }
    checkSession(actual, expected) {
        if (actual !== expected) {
            throw new ToolInputError("MemTree unavailable: page belongs to a different or unknown session");
        }
    }
    async getOther(id) {
        const hit = this.others.get(id);
        if (hit) {
            this.others.delete(id);
            this.others.set(id, hit);
            return hit;
        }
        const index = await this.loadPage(id, `tree ${id}`);
        if (!isTemporaryPrefix(index, id))
            this.others.set(id, index);
        while (this.others.size > OTHER_TREES_CACHED) {
            this.others.delete(this.others.keys().next().value);
        }
        return index;
    }
    /**
     * Fetch one page. ``sessionId`` (the current tree only) must match the page's
     * session. A temporary prefix (the newest completed tree for an earlier part
     * of the conversation, shown until the request's own tree is built) is not
     * cached for good: it is refetched at most every PREFIX_RETRY_INTERVAL_MS, and
     * the last copy is served in between, so successive tools neither hammer the
     * page endpoint nor get an error for a tree they could read.
     */
    async loadPage(id, label, sessionId) {
        const now = this.now();
        const retryAt = this.prefixRetryAt.get(id);
        if (retryAt !== undefined && retryAt > now) {
            const stored = this.prefixes.get(id);
            if (stored) {
                if (sessionId !== undefined)
                    this.checkSession(stored.page.session_id, sessionId);
                return stored;
            }
            throw this.prefixRetryError(retryAt - now);
        }
        // If a previous prefix refresh failed, keep the same cooldown after that
        // failure so successive tools cannot hammer the page endpoint.
        if (retryAt !== undefined)
            this.prefixRetryAt.set(id, now + PREFIX_RETRY_INTERVAL_MS);
        const base = proxyBase(this.deps);
        const page = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}.json`);
        if (!page.ok)
            throw new ToolInputError(`MemTree unavailable (page ${id}: ${page.error})`);
        const json = page.body;
        if (!Array.isArray(json?.nodes) || json.nodes.length === 0) {
            // Still building (or an empty tree): not cached, so the next call retries.
            throw new ToolInputError(`The MemTree for ${label} is still being built${json?.status ? ` (${json.status})` : ""}; try again in a minute.`);
        }
        if (sessionId !== undefined && json.session_id !== sessionId) {
            throw new ToolInputError("MemTree unavailable: page belongs to a different or unknown session");
        }
        const index = new MemtreeIndex(json);
        if (isTemporaryPrefix(index, id)) {
            this.prefixRetryAt.set(id, this.now() + PREFIX_RETRY_INTERVAL_MS);
            this.prefixes.delete(id);
            this.prefixes.set(id, index);
            // Each page can be several MB: keep only the most recent few.
            while (this.prefixes.size > OTHER_TREES_CACHED) {
                this.prefixes.delete(this.prefixes.keys().next().value);
            }
            // Keep the map small if a long-lived MCP process sees many page ids.
            if (this.prefixRetryAt.size > 64) {
                const oldest = this.prefixRetryAt.keys().next().value;
                if (oldest !== undefined)
                    this.prefixRetryAt.delete(oldest);
            }
            return index;
        }
        this.prefixRetryAt.delete(id);
        this.prefixes.delete(id);
        return index;
    }
    prefixRetryError(remainingMs) {
        const seconds = Math.ceil(remainingMs / 1000);
        return new ToolInputError(`This MemTree page is a temporary prefix while newer messages are indexing; try again in ${seconds} second${seconds === 1 ? "" : "s"}.`);
    }
}
/** A served prefix that may later switch to the request's own tree (a pinned ref never does). */
function isTemporaryPrefix(index, id) {
    return index.page.served_prefix === true && index.page.ref !== id;
}
export class SessionFinder {
    deps;
    fetchImpl;
    constructor(deps) {
        this.deps = deps;
        this.fetchImpl = deps.fetch ?? globalThis.fetch;
    }
    async listSessions(args) {
        const body = await this.get(`/memtree/sessions${sessionsQuery(args)}`, "list");
        return formatSessions(body, args);
    }
    async searchSessions(args, tree) {
        const body = await this.get(`/memtree/search${searchQuery(args, tree)}`, "search");
        if (tree && (!body || typeof body !== "object" || body.tree !== tree)) {
            throw new ToolInputError("search: server did not confirm the requested tree; update the MemTree server before scoped search");
        }
        return formatSearchResults(body, { ...args, tree });
    }
    async get(pathAndQuery, tool) {
        const headers = {};
        if (this.deps.sessionId)
            headers["x-claude-code-session-id"] = this.deps.sessionId;
        const answer = await proxyGetJson(this.fetchImpl, `${proxyBase(this.deps)}${pathAndQuery}`, headers);
        if (answer.ok)
            return answer.body;
        if (answer.status === 404) {
            throw new ToolInputError(`${tool}: this MemTree server does not support finding sessions yet (${answer.error}).`);
        }
        throw new ToolInputError(`${tool} failed: ${answer.error}`);
    }
}
/**
 * One JSON-RPC message in, the response out (undefined for notifications).
 * Exposed for tests; the stdio loop below is only framing.
 */
export async function handleMcpMessage(input, tree, finder) {
    if (!isRpcRequest(input)) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const message = input;
    const isRequest = message.id !== undefined && message.id !== null;
    const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code, text) => ({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code, message: text },
    });
    switch (message.method) {
        case "initialize": {
            const requested = message.params?.protocolVersion;
            return reply({
                protocolVersion: typeof requested === "string" ? requested : LATEST_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: MEMTREE_MCP_SERVER_NAME, version: CLIENT_VERSION },
                instructions: MEMTREE_MCP_INSTRUCTIONS,
            });
        }
        case "ping":
            return isRequest ? reply({}) : undefined;
        case "tools/list":
            return reply({ tools: MEMTREE_TOOLS });
        case "tools/call": {
            const name = message.params?.name;
            const args = (message.params?.arguments ?? {});
            try {
                const text = await callTool(String(name), args, tree, finder);
                return reply({ content: [{ type: "text", text }] });
            }
            catch (err) {
                if (err instanceof UnknownToolError)
                    return fail(-32602, err.message);
                const text = err instanceof Error ? err.message : String(err);
                return reply({ content: [{ type: "text", text }], isError: true });
            }
        }
        default:
            if (!isRequest)
                return undefined; // notifications/initialized, cancelled, …
            return fail(-32601, `Method not found: ${message.method}`);
    }
}
function isRpcRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const m = value;
    return typeof m.method === "string" &&
        (m.jsonrpc === undefined || m.jsonrpc === "2.0") &&
        (m.id === undefined || m.id === null || typeof m.id === "string" ||
            (typeof m.id === "number" && Number.isFinite(m.id))) &&
        (m.params === undefined || (!!m.params && typeof m.params === "object" && !Array.isArray(m.params)));
}
class UnknownToolError extends Error {
}
async function callTool(name, args, tree, finder) {
    switch (name) {
        case "search":
            return searchTool(args, tree, finder);
        case "read_node": {
            const target = nodeTarget(args, "id");
            return formatNode(await tree.get(target.tree), target.id, target.tree);
        }
        case "read_lines":
            return readLinesTool(args, tree);
        case "list":
            if (!finder)
                throw new ToolInputError("list is not available here");
            return finder.listSessions(args);
        default:
            throw new UnknownToolError(`Unknown tool: ${name}`);
    }
}
/**
 * `search`: a text search of one tree uses the per-tree term search (summaries
 * and lines); every other combination is the server's search, across sessions
 * or scoped to the tree.
 */
async function searchTool(args, tree, finder) {
    if (typeof args.query !== "string" || !args.query.trim()) {
        throw new ToolInputError("search: query must be a non-empty string");
    }
    const mode = searchMode(args.mode);
    const current = args.tree === CURRENT_TREE;
    const named = current ? undefined : checkTreeId(args.tree);
    if (mode === "text" && (current || named)) {
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        if (tree.search)
            return tree.search(args.query, limit, named);
        return formatSearch(await tree.get(named), args.query, limit, named);
    }
    if (!finder)
        throw new ToolInputError("search across sessions is not available here");
    if (current && !tree.currentId)
        throw new ToolInputError("this session's tree is not available here");
    const scope = current ? await tree.currentId(true) : named;
    return finder.searchSessions(args, scope);
}
/** `{tree, id}` from a node address, or from tree (optional) and the numeric field. */
function nodeTarget(args, field) {
    if (args.node !== undefined && args.node !== null && args.node !== "") {
        const { tree, id } = parseNodeAddress(args.node);
        return { tree: checkTreeId(tree), id };
    }
    return { tree: treeArgument(args.tree), id: Number(args[field]) };
}
function treeArgument(tree) {
    return tree === CURRENT_TREE ? undefined : checkTreeId(tree);
}
/** read_lines by leaf address (its range unless block/start/end are given), by range, or the tail. */
async function readLinesTool(args, tree) {
    if (args.tail === true) {
        if (!tree.tail)
            throw new ToolInputError("read_lines: the un-indexed tail is not available here");
        const position = (v) => (v === undefined || v === null ? undefined : Number(v));
        const [start, end] = [position(args.start), position(args.end)];
        if ([start, end].some((v) => v !== undefined && !Number.isInteger(v))) {
            throw new ToolInputError("read_lines: with tail, start and end are message positions (integers)");
        }
        return tree.tail(treeArgument(args.tree), start, end);
    }
    if (args.node === undefined || args.node === null || args.node === "") {
        const target = treeArgument(args.tree);
        return formatLines(await tree.get(target), Number(args.block), Number(args.start), Number(args.end), target);
    }
    const { tree: ref, id } = nodeTarget(args, "id");
    const index = await tree.get(ref);
    const node = index.nodes.get(id);
    if (!node)
        throw new ToolInputError(`read_lines: no node ${id} in tree ${ref}`);
    if (!index.isLeaf(node)) {
        throw new ToolInputError(`read_lines: node ${ref}#${id} is a branch; read_node {"node": "${ref}#${id}"} lists the leaves under it`);
    }
    const [block, start, end] = node.l;
    const pick = (v, fallback) => (v === undefined || v === null ? fallback : Number(v));
    return formatLines(index, pick(args.block, block), pick(args.start, start), pick(args.end, end), ref);
}
/** Serve MCP over this process's stdin/stdout until stdin closes. */
export function runMemtreeMcpServer(env = process.env) {
    const deps = {
        proxyUrl: env.CCC_MEMTREE_PROXY || env.ANTHROPIC_BASE_URL,
        sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
    };
    const tree = new CurrentTree(deps);
    const finder = new SessionFinder(deps);
    let buffer = "";
    // Replies go out in arrival order even though tool calls are async.
    let queue = Promise.resolve();
    const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line)
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
                continue;
            }
            queue = queue.then(async () => {
                const response = await handleMcpMessage(message, tree, finder).catch((err) => ({
                    jsonrpc: "2.0",
                    id: isRpcRequest(message) ? message.id ?? null : null,
                    error: { code: -32603, message: String(err) },
                }));
                if (response)
                    send(response);
            });
        }
    });
    process.stdin.on("end", () => {
        void queue.then(() => process.exit(0));
    });
}
function isMainModule() {
    try {
        const self = fs.realpathSync(fileURLToPath(import.meta.url));
        return !!process.argv[1] && fs.realpathSync(process.argv[1]) === self;
    }
    catch {
        return false;
    }
}
if (isMainModule())
    runMemtreeMcpServer();
//# sourceMappingURL=memtree-mcp.js.map