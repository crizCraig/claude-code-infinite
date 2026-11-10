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
 * `--mcp-config` ccc passes (every session, `-p` included) or one the caller passes
 * (`ccc memtree-mcp`, e.g. the memory recall probe).
 *
 * Which tree: the loopback proxy of the ccc that launched this Claude Code
 * (`CCC_MEMTREE_PROXY`, else the inherited `ANTHROPIC_BASE_URL`) answers
 * `GET /memtree/current?session=<id>` with the newest page it served — the
 * tree the current request was compressed against. The session id is the
 * `CLAUDE_CODE_SESSION_ID` Claude Code sets for MCP servers. Reads of this
 * session's current tree require that exact session on both the proxy's pointer
 * and the page; missing or mismatched identity fails closed. Claude Code does not
 * restart this server when its process switches sessions, so each tool call first
 * asks the proxy which session that process is on (`refreshHostSession`). The page JSON
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
import { HOST_TOKEN_ENV, HOST_TOKEN_HEADER } from "./host-session.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FINDER_SEARCH_DEFAULT_LIMIT, FINDER_SEARCH_MAX_LIMIT, formatSearchResults, searchMode, formatSessions, RECENT_SEARCH_WINDOWS_DAYS, recentSearchArgs, recentSearchFailedNote, recentSearchNote, searchQuery, SESSIONS_DEFAULT_LIMIT, SESSIONS_MAX_LIMIT, sessionsQuery, } from "./memtree-finder.js";
import { formatLines, formatNode, formatSearch, formatSearchHits, formatTail, MemtreeIndex, parseNodeAddress, serverSearchHits, serverTailHits, READ_LINES_MAX_CHARS, READ_LINES_MAX_LINES, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, ToolInputError, } from "./memtree-tools.js";
import { CLIENT_VERSION } from "./memtree.js";
import { formatHandover, formatUserMessages, HANDOVER_DEFAULT_DAYS, HANDOVER_MAX_DAYS, handoverQuery, USER_MESSAGES_MAX_LIMIT, userMessagesQuery, } from "./memtree-handover.js";
import { formatTime } from "./memtree-times.js";
export const MEMTREE_MCP_SERVER_NAME = "memtree";
/**
 * The version of the ccc whose proxy this server talks to, set in the config
 * ccc writes (memtree-mcp-config.ts). Claude Code may (re)start this server
 * mid-session, after an update replaced ccc's files: the server then runs the
 * new code against the old proxy. The proxy's /memtree endpoints only grow, and
 * this server already tolerates a missing one (404), so it keeps working; a
 * failing tool call says why, so the fix (restart ccc) is clear.
 */
export const PROXY_VERSION_ENV = "CCC_PROXY_VERSION";
/** The note added to failed tool calls when this server and its proxy differ. */
export function versionMismatchNote(proxyVersion, ownVersion = CLIENT_VERSION) {
    if (!proxyVersion || proxyVersion === ownVersion)
        return undefined;
    const safe = proxyVersion.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 40);
    return `(These MemTree tools are ccc ${ownVersion} but this session runs ccc ${safe}: ccc was updated during the session. Restart ccc to use one version.)`;
}
/** How often a tool call may re-read the installed package.json (StaleToolsNotice). */
const STALE_CHECK_INTERVAL_MS = 60_000;
/**
 * Says once per session, after a tool's answer, that ccc was updated on disk since
 * this server started: Claude Code keeps an MCP server for the whole session, so
 * the tools stay the version it loaded (an older one may lack message times) until
 * ccc restarts. Silent when the versions match or package.json is unreadable.
 */
export class StaleToolsNotice {
    readInstalled;
    own;
    now;
    startedAt;
    said = false;
    checkedAt = -Infinity;
    constructor(readInstalled = installedVersion, own = CLIENT_VERSION, now = Date.now, startedAt = new Date()) {
        this.readInstalled = readInstalled;
        this.own = own;
        this.now = now;
        this.startedAt = startedAt;
    }
    next() {
        if (this.said || this.now() - this.checkedAt < STALE_CHECK_INTERVAL_MS)
            return undefined;
        this.checkedAt = this.now();
        const installed = this.readInstalled();
        if (!installed || installed === this.own)
            return undefined;
        this.said = true;
        return staleToolsNote(installed, this.own, this.startedAt);
    }
}
export function staleToolsNote(installed, own, startedAt) {
    const safe = installed.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 40);
    const loaded = formatTime(startedAt.toISOString());
    return `(These MemTree tools are ccc ${own}${loaded ? `, loaded ${loaded}` : ""}; ccc ${safe} is installed: restart ccc to use its newer MemTree tools.)`;
}
/** The version in this install's package.json now (ccc may have been updated since it started). */
export function installedVersion() {
    try {
        const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
        return typeof version === "string" ? version : undefined;
    }
    catch {
        return undefined;
    }
}
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export const MEMTREE_TOOL_NAMES = [
    "search",
    "read_node",
    "read_lines",
    "list",
    "user_messages",
    "handover",
];
/** `tree` value naming this session's own current tree. */
export const CURRENT_TREE = "current";
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const FETCH_TIMEOUT_MS = 60_000;
/**
 * A handover pack's first build runs a model call on the server (up to 90 s, plus loading
 * the tree): wait longer for it. Past this, the server still finishes and caches the pack.
 */
const HANDOVER_TIMEOUT_MS = 150_000;
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
    "Until the conversation reaches its size budget you see every message verbatim. The tools reach beyond this " +
    "conversation: when the user refers to earlier work from another session (\"like last time\", \"the " +
    "fix from yesterday\"), search without tree, or list recent sessions, before asking or re-deriving it.\n\n" +
    "Once the conversation reaches the budget, the earlier conversation is replaced by a single memory " +
    "message: that tree, expanded where it looked relevant to the latest request and collapsed elsewhere. The user's own " +
    "messages shown there, and everything after the memory message, stay word for word; the rest of the earlier " +
    "conversation survives only as summaries, which drop exact values, instructions, reasoning and dead ends. The detail " +
    "is not gone: these tools read it back.\n\n" +
    "A nearly full context window is therefore expected and fine. Don't recommend /compact, /clear or a fresh " +
    "session to free context: they discard what MemTree keeps (/ccc:memtree-compact compresses now if the " +
    "user asks). The exception is a ccc notice that MemTree is paused or off: it is not compressing then, " +
    "and that advice is the fallback.\n\n" +
    "So once you see that memory message: when your work depends on something from earlier in the session (what the " +
    "user asked for or ruled out, decisions and why they were made, findings, ids and paths, commands, what was tried " +
    "and failed), search MemTree before re-deriving it from the code or guessing. The code shows what exists; the " +
    "memory shows what was decided and why. Read the exact lines (read_lines) when precision matters.\n\n" +
    "search with \"tree\": \"current\" looks in this session's MemTree; without tree it searches all of the user's " +
    "ccc sessions on any machine (not Codex or plain claude sessions), and list shows those sessions by time and " +
    "project. Text mode (default) matches exact words, ids and paths; vector mode matches meaning. A search costs " +
    "$0.0005 either way: its first page is charged even when cached; cursor continuation is free, even if " +
    "re-embedded, as is a text search of one tree. Hits may include an address (<tree>#<node>) and its path from the root. If the address is unavailable, read_lines with the hit’s tree.ref and range reads its exact lines. With an address: " +
    "read_node {\"node\": address} opens it with its children, and the path's addresses lead to its parent and " +
    "siblings; read_lines {\"node\": address} reads a leaf's exact lines. Cursors page over live results, not a " +
    "frozen snapshot. A tree trails its conversation: the newest messages (often how a session ended) are in no tree " +
    "yet. A text search of one tree also matches them (listed after the tree's hits), list shows how each session " +
    "ended, and read_lines {\"tail\": true} reads them (with tree for another session's page; large tool calls are " +
    "shortened, \"full\": true reads them whole).\n\n" +
    "To take over another session's work, call handover with its session id first; user_messages lists only the " +
    "person's own messages over a time range.\n\n" +
    "A hand-off or kickoff prompt you write for another agent or machine names this session's id and MemTree link " +
    "(list marks this session), so that agent can read this work with list, search and read_node.";
const TREE_DESC = "A tree reference from list or search (keep its style and own/served suffix; legacy request ids work), or \"current\" for this session's tree.";
/**
 * Claude Code's per-tool key (2.1.296): the tool is in the prompt from the
 * first turn, not deferred behind tool search. ccc's own --mcp-config also sets
 * the server's `alwaysLoad`; this covers caller-supplied configs too (the
 * recall probe, `ccc memtree-mcp`).
 */
export const MEMTREE_TOOL_META = { "anthropic/alwaysLoad": true };
/**
 * Said in `search`'s description, the one text a resumed session gets fresh:
 * Claude Code keeps a session's MCP instructions and deferred-tools list as
 * first announced, and never takes a name off that list once the tool is
 * loaded, so a session begun before alwaysLoad still lists these as deferred.
 */
export const MEMTREE_LOADED_NOTE = "It and the other memtree tools are loaded up front: call them directly, with no ToolSearch " +
    "step, even where an older deferred-tools list in the conversation names them.";
export const MEMTREE_TOOLS = [
    {
        name: "search",
        description: "Find what this conversation doesn't show: exact details from earlier in this session that the memory only " +
            "summarizes, or earlier work from the user's other sessions. Search one tree (tree, \"current\" for this session) " +
            "or, without tree, all of the user's ccc sessions on any machine (not Codex or plain claude sessions). " +
            "Use it before re-deriving or guessing something from earlier work. " +
            "mode \"text\" (default) matches words, ids, paths and errors (in one tree: node summaries and transcript " +
            "lines); mode \"vector\" matches meaning, ranked per embedding model. A search costs $0.0005 either way: its " +
            "first page is charged even when cached; cursor continuation and a text search of one tree are free. Cursors page over live results, not a frozen snapshot. " +
            "Hits include a snippet and range; their node address (<tree>#<node>) and path may be unavailable. Without an address, use read_lines with the hit’s tree.ref and range. " +
            "A text search of one tree also lists matching newest messages no tree covers yet (read them with read_lines tail). " +
            "Results show when the messages were written, each matched line its own message's time where recorded. " +
            // Live on every request, unlike the server instructions and Claude Code's
            // deferred-tools list, which a resumed session keeps from its first day.
            MEMTREE_LOADED_NOTE,
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Distinctive words (text; \"quoted phrase\", or, -word across sessions) or a question (vector)." },
                tree: { type: "string", description: `Optional. ${TREE_DESC} Omit to search all sessions.` },
                mode: { type: "string", enum: ["text", "vector"], description: "text (default, exact words) or vector (meaning); first page charged, except text in one tree." },
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
            "for a leaf, the transcript line range it covers. Give node (an address from search) or id (0 is the root) with an optional tree. " +
            "Results show when the messages were written (a leaf: its own messages, where recorded).",
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
            "With tail: true, read the messages after the tree that no tree covers yet (the end of a session usually is there): " +
            "the newest ones, or start/end message positions; add tree for another session's page. Tool calls and results over " +
            "2,000 characters or 40 lines come shortened to their first and last lines; add full: true to read them whole. " +
            "Results show when the messages were written: each message header its own time, where recorded.",
        inputSchema: {
            type: "object",
            properties: {
                node: { type: "string", description: "A leaf's address <tree>#<id> from search; block/start/end then default to its range." },
                block: { type: "number", description: "Block index (a leaf's first range number)." },
                start: { type: "number", description: "First line, 1-based." },
                end: { type: "number", description: "Last line, inclusive." },
                tree: { type: "string", description: `With block/start/end or tail: ${TREE_DESC} Omit for this session.` },
                tail: { type: "boolean", description: "Read the un-indexed messages after the tree instead of lines; start/end are then message positions." },
                full: { type: "boolean", description: "With tail: every message whole, large tool calls and results included." },
            },
        },
    },
    {
        name: "list",
        description: "List the user's own MemTree sessions, most recently active first: every ccc session on any machine using this " +
            "account (this one marked; Codex and plain claude sessions are not included). Each: title (the tree's root summary), " +
            "first message, how it ended (last user message, the tools after it and the last reply, with the time), times, " +
            "project (directory, git repo, branch, commit), models, request count and the latest tree's reference. " +
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
    {
        name: "user_messages",
        description: "The person's own messages in a session over a time range: what they typed, commands they ran, words sent while " +
            "the agent worked, and board messages. Tool results, reminders, prompts the agent scheduled and other agents' " +
            "messages are left out. Use it to learn what the user asked for, decided and corrected. Covers the tree and its " +
            "newest messages no tree covers yet. Returns the newest page, oldest first; cursor lists older ones. Each " +
            "message says where read_lines shows its context. Results show when each message was written.",
        inputSchema: {
            type: "object",
            properties: {
                tree: { type: "string", description: `${TREE_DESC} A session id works too. Omit for this session.` },
                since: { type: "string", description: "Only messages at or after this ISO 8601 time or date (UTC unless an offset is given)." },
                until: { type: "string", description: "Only messages before this ISO 8601 time or date." },
                query: { type: "string", description: "Only messages holding every one of these words." },
                cursor: { type: "string", description: "next cursor from a previous call: older messages (same other arguments)." },
                limit: { type: "number", description: `Messages per page (default 50, at most ${USER_MESSAGES_MAX_LIMIT}).` },
                full: { type: "boolean", description: "Long messages and pastes whole (default: shortened)." },
                context: { type: "boolean", description: "Also the agent's last words before each message (what it answered)." },
            },
        },
    },
    {
        name: "handover",
        description: "A handover pack for taking over or continuing a session's work: the person's messages over its last days (each " +
            "with the agent's words it answered), how the session ended, and a model's reading of their goals, standing " +
            "instructions, decisions with reasons and open questions, each citing its messages. Call it first when you take " +
            "over another session (tree: its session id or tree). The model's lists can be wrong: check one against the " +
            "messages it cites before acting on it. A first call for a session can take up to a minute.",
        inputSchema: {
            type: "object",
            properties: {
                tree: { type: "string", description: `${TREE_DESC} A session id works too. Omit for this session.` },
                days: { type: "number", description: `Days before the session's newest message to cover (default ${HANDOVER_DEFAULT_DAYS}, at most ${HANDOVER_MAX_DAYS}).` },
                since: { type: "string", description: "Instead of days: messages at or after this ISO 8601 time or date." },
                until: { type: "string", description: "Only messages before this ISO 8601 time or date." },
            },
        },
    },
].map((tool) => ({ ...tool, _meta: MEMTREE_TOOL_META }));
/** A request id in either spelling (UUID or the short leading-hex form). */
const TREE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Pages of `list` results a session-id-as-tree lookup reads at most. */
const SESSION_TREE_MAX_PAGES = 3;
/** How long a session-id-as-tree answer is reused (its newest tree can change). */
const SESSION_TREE_TTL_MS = 60_000;
const SESSION_TREES_CACHED = 64;
/** Other sessions' pages kept in memory at once (each can be several MB). */
const OTHER_TREES_CACHED = 4;
/** GET JSON from the loopback proxy; never throws. */
async function proxyGetJson(fetchImpl, url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    let response;
    try {
        response = await fetchImpl(url, {
            headers: { accept: "application/json", ...headers },
            signal: AbortSignal.timeout(timeoutMs),
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
/**
 * Sent with each tool's proxy reads: which tool (`page` is a whole tree's `.json`) and
 * the calling session, which the proxy passes on so the server's one content-free log
 * line per call can say which tool read what (polychat memtree_tool_log.py). Not to be
 * confused with `x-memtree-tools`, the list of configured tools sent on compress calls.
 */
export const MEMTREE_TOOL_HEADER = "x-memtree-tool";
export function toolHeaders(tool, deps) {
    const headers = { [MEMTREE_TOOL_HEADER]: tool };
    if (deps.sessionId)
        headers["x-claude-code-session-id"] = deps.sessionId;
    return headers;
}
/** How long a tool call waits to learn its process's session before using its own id. */
const HOST_SESSION_TIMEOUT_MS = 2_000;
/**
 * Point `deps.sessionId` at the session this server's Claude Code process is on now.
 * Claude Code starts the server with the session id it had at launch and does not
 * restart it when the process moves to another session (a resume through the picker,
 * /resume, /clear), so that id can name a session with no page ("no MemTree yet",
 * 2026-11-09). The proxy of the ccc that launched this Claude Code knows the process's
 * session from its SessionStart hook and answers only that process (`hostPid`: this
 * server's parent, with the token from ccc's MCP config). Without a token (an older
 * ccc's config: its proxy has no such route) nothing is asked; any other answer
 * (another process, no session start seen) leaves the id as it is.
 */
export async function refreshHostSession(deps, hostPid = process.ppid) {
    const base = deps.proxyUrl?.replace(/\/$/, "");
    if (!base || !deps.hostToken)
        return;
    const answer = await proxyGetJson(deps.fetch ?? fetch, `${base}/memtree/host-session?host_pid=${hostPid}`, { [HOST_TOKEN_HEADER]: deps.hostToken }, HOST_SESSION_TIMEOUT_MS);
    const sessionId = answer.ok ? answer.body?.session_id : undefined;
    if (typeof sessionId === "string" && sessionId)
        deps.sessionId = sessionId;
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
    /** The session `cached` was read for: a page is never reused across sessions. */
    cachedSession;
    /** Temporary prefix pages: when each may be fetched again. */
    prefixRetryAt = new Map();
    /** The last fetched temporary prefix per page, served during its cooldown. */
    prefixes = new Map();
    inFlight;
    /** Other trees, least recently used first. */
    others = new Map();
    /** Pages whose per-message times were incomplete: when to refetch them (timesDue). */
    timesRetryAt = new WeakMap();
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
            const answer = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}/search?${params}`, toolHeaders("search", this.deps));
            const parsed = answer.ok ? serverSearchHits(answer.body) : undefined;
            if (parsed) {
                const session = answer.body.session_id;
                if (!other && session !== undefined)
                    this.checkSession(session, this.requireSessionId());
                if (other || session !== undefined) {
                    return formatSearchHits(parsed.hits, query, parsed.terms, other, serverTailHits(answer.body), parsed.treeTimes);
                }
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
    async tail(tree, start, end, full) {
        const other = checkTreeId(tree);
        const id = other ?? (await this.currentId());
        const params = new URLSearchParams();
        if (start !== undefined)
            params.set("start", String(start));
        if (end !== undefined)
            params.set("end", String(end));
        if (full)
            params.set("full", "true");
        const query = params.toString() ? `?${params}` : "";
        const base = proxyBase(this.deps);
        const answer = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}/messages${query}`, toolHeaders("read_lines", this.deps));
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
    /**
     * `/memtree/<id>/<route>`, never cached (the newest messages grow). This session's
     * tree must be this session's (as tail); a 404 without the server's own detail means
     * the server or this ccc's proxy predates the route.
     */
    async serverRead(route, tree, params) {
        const other = checkTreeId(tree);
        const id = other ?? (await this.currentId());
        const query = params.toString() ? `?${params}` : "";
        const answer = await proxyGetJson(this.fetchImpl, `${proxyBase(this.deps)}/memtree/${encodeURIComponent(id)}/${route}${query}`, toolHeaders(route, this.deps), route === "handover" ? HANDOVER_TIMEOUT_MS : FETCH_TIMEOUT_MS);
        if (answer.status === 202)
            throw new ToolInputError("That MemTree is still being built; try again in a minute.");
        if (answer.status === 0 && route === "handover" && /timeout|abort/i.test(answer.error ?? "")) {
            throw new ToolInputError("handover: the pack is still being prepared on the server; call handover again in a minute.");
        }
        if (answer.status === 404 && /^HTTP 404 Not Found$/.test(answer.error ?? "")) {
            throw new ToolInputError(`${route}: this MemTree server (or this ccc) does not have it yet; update ccc or try later.`);
        }
        if (!answer.ok)
            throw new ToolInputError(`${route}: ${(answer.error ?? "").replace(/^HTTP (400|404) /, "")}`);
        if (!other)
            this.checkSession(answer.body.session_id, this.requireSessionId());
        return answer.body;
    }
    async loadCurrent() {
        const id = await this.currentId();
        const sessionId = this.requireSessionId();
        if (this.cached?.id === id && !this.timesDue(this.cached.index))
            return this.cached.index;
        const stale = this.cached?.id === id ? this.cached.index : undefined;
        const index = await this.refreshed(stale, () => this.loadPage(id, "this session", sessionId));
        if (!isTemporaryPrefix(index, id))
            this.cached = { id, index };
        return index;
    }
    /**
     * Whether a cached page's per-message times were incomplete (`line_times_incomplete`:
     * the server's times lookup was slow) and are due a refetch. The page itself is
     * readable meanwhile, so it stays cached; only its times are retried.
     */
    timesDue(index) {
        const at = this.timesRetryAt.get(index);
        return at !== undefined && this.now() >= at;
    }
    /** `load()`, or the readable `stale` copy when that fails (its times retried later). */
    async refreshed(stale, load) {
        if (!stale)
            return load();
        try {
            return await load();
        }
        catch {
            this.timesRetryAt.set(stale, this.now() + PREFIX_RETRY_INTERVAL_MS);
            return stale;
        }
    }
    requireSessionId() {
        const sessionId = this.deps.sessionId;
        if (!sessionId)
            throw new ToolInputError("MemTree unavailable: the calling session id is missing");
        if (this.cachedSession !== sessionId) {
            this.cached = undefined; // the process moved to another session (refreshHostSession)
            this.cachedSession = sessionId;
        }
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
        if (hit && !this.timesDue(hit)) {
            this.others.delete(id);
            this.others.set(id, hit);
            return hit;
        }
        const index = await this.refreshed(hit, () => this.loadPage(id, `tree ${id}`));
        this.others.delete(id);
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
        const page = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}.json`, toolHeaders("page", this.deps));
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
        // Readable now; its incomplete per-message times are refetched after the cooldown.
        if (json.line_times_incomplete === true)
            this.timesRetryAt.set(index, this.now() + PREFIX_RETRY_INTERVAL_MS);
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
/**
 * A page that may still change: a served prefix that may later switch to the request's
 * own tree (a pinned ref never does), or any page whose transcript blocks are still
 * uploading (`blocks_pending`: the tree was just built), so a retry can read them.
 */
function isTemporaryPrefix(index, id) {
    if (index.page.blocks_pending === true)
        return true;
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
        return formatSessions(body, args, this.deps.sessionId);
    }
    sessionTrees = new Map();
    /** sessionTree, remembered for SESSION_TREE_TTL_MS (hits and misses: legacy ids repeat). */
    async sessionTree(sessionId) {
        const known = this.sessionTrees.get(sessionId);
        if (known && this.now() - known.at < SESSION_TREE_TTL_MS)
            return known.ref;
        const ref = await this.lookupSessionTree(sessionId);
        this.sessionTrees.set(sessionId, { ref, at: this.now() });
        while (this.sessionTrees.size > SESSION_TREES_CACHED) {
            this.sessionTrees.delete(this.sessionTrees.keys().next().value);
        }
        return ref;
    }
    async lookupSessionTree(sessionId) {
        // `q` also matches titles and first messages, so sessions quoting the id (a hand-off)
        // can fill the first page: follow the cursor, a few pages at most.
        let cursor;
        for (let page = 0; page < SESSION_TREE_MAX_PAGES; page++) {
            const query = sessionsQuery({ q: sessionId, limit: SESSIONS_MAX_LIMIT, cursor });
            const answer = await this.fetch(`/memtree/sessions${query}`, "list");
            if (!answer.ok)
                return undefined;
            const body = answer.body;
            if (!Array.isArray(body?.sessions))
                return undefined;
            const item = body.sessions.find((s) => s?.session_id === sessionId);
            if (item) {
                const ref = item.latest_tree?.ref ?? item.latest_tree?.request_id;
                return typeof ref === "string" && TREE_ID_RE.test(ref) && ref !== sessionId ? ref : undefined;
            }
            if (typeof body.next_cursor !== "string" || !body.next_cursor || body.next_cursor === cursor) {
                return undefined;
            }
            cursor = body.next_cursor;
        }
        return undefined;
    }
    async searchSessions(args, tree) {
        const first = await this.fetch(`/memtree/search${searchQuery(args, tree)}`, "search");
        let answer = first;
        let narrowed;
        const tried = [];
        for (const days of RECENT_SEARCH_WINDOWS_DAYS) {
            const recent = recentSearchArgs(args, tree, answer.status, this.now(), days);
            if (!recent)
                break;
            narrowed = { args: recent, days };
            tried.push(days);
            answer = await this.fetch(`/memtree/search${searchQuery(recent, tree)}`, "search");
        }
        // No window answered: the first refusal says how to narrow the search, plus what ccc
        // tried and, when the last try failed otherwise, how.
        const body = this.bodyOf(answer.ok ? answer : narrowed
            ? { ...first, error: `${first.error}${recentSearchFailedNote(tried, answer)}` } : first, "search");
        if (tree && (!body || typeof body !== "object" || body.tree !== tree)) {
            throw new ToolInputError("search: server did not confirm the requested tree; update the MemTree server before scoped search");
        }
        const text = formatSearchResults(body, {
            ...(narrowed?.args ?? args), tree,
        });
        if (!narrowed)
            return text;
        const pages = typeof body?.next_cursor === "string";
        return `${recentSearchNote(narrowed.args.since, narrowed.days, pages)}\n\n${text}`;
    }
    now() {
        return this.deps.now?.() ?? Date.now();
    }
    async get(pathAndQuery, tool) {
        return this.bodyOf(await this.fetch(pathAndQuery, tool), tool);
    }
    fetch(pathAndQuery, tool) {
        return proxyGetJson(this.fetchImpl, `${proxyBase(this.deps)}${pathAndQuery}`, toolHeaders(tool, this.deps));
    }
    bodyOf(answer, tool) {
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
export async function handleMcpMessage(input, tree, finder, 
/** versionMismatchNote: appended to failed tool calls. */
versionNote, 
/** A note to append once, to whichever tool answer comes first (StaleToolsNotice). */
notice) {
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
            const withNotice = (text) => {
                const note = notice?.next();
                return note ? `${text}\n\n${note}` : text;
            };
            try {
                const text = await callTool(String(name), args, tree, finder);
                return reply({ content: [{ type: "text", text: withNotice(text) }] });
            }
            catch (err) {
                if (err instanceof UnknownToolError)
                    return fail(-32602, err.message);
                const message = err instanceof Error ? err.message : String(err);
                const text = versionNote ? `${message}\n${versionNote}` : message;
                return reply({ content: [{ type: "text", text: withNotice(text) }], isError: true });
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
    const session = await sessionAsTree(args.tree, finder);
    if (session) {
        const text = await dispatchTool(name, { ...args, tree: session.ref }, tree, finder);
        return `(${session.id} is a session id: this reads its newest tree, ${session.ref}.)\n\n${text}`;
    }
    return dispatchTool(name, args, tree, finder);
}
/** A bare UUID: a session id, or a legacy request id (a ref ends in -v<N>-own/served). */
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A `tree` that is a session id, resolved to that session's newest tree. Hand-offs name
 * session ids (the instructions ask them to), and receiving agents pass them as `tree`:
 * the page lookup then fails with 404, or a tail reads nothing (xsession benchmark,
 * 2026-11-06). Undefined for anything else, including a legacy request id.
 */
async function sessionAsTree(value, finder) {
    if (typeof value !== "string" || !BARE_UUID_RE.test(value.trim()) || !finder?.sessionTree) {
        return undefined;
    }
    const id = value.trim();
    try {
        const ref = await finder.sessionTree(id);
        return ref ? { id, ref } : undefined;
    }
    catch {
        return undefined;
    }
}
async function dispatchTool(name, args, tree, finder) {
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
        case "user_messages":
        case "handover":
            return treeRouteTool(name, args, tree);
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
        return { tree: treeArgument(tree), id };
    }
    return { tree: treeArgument(args.tree), id: Number(args[field]) };
}
function treeArgument(tree) {
    return tree === CURRENT_TREE ? undefined : checkTreeId(tree);
}
/** `user_messages` / `handover`: the server's answer for the tree, formatted. */
async function treeRouteTool(name, args, tree) {
    if (!tree.serverRead)
        throw new ToolInputError(`${name} is not available here`);
    const target = treeArgument(args.tree);
    if (name === "user_messages") {
        return formatUserMessages(await tree.serverRead(name, target, userMessagesQuery(args)), args, target);
    }
    return formatHandover(await tree.serverRead(name, target, handoverQuery(args)), target);
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
        if (args.full !== undefined && typeof args.full !== "boolean") {
            throw new ToolInputError("read_lines: full must be true or false");
        }
        return tree.tail(treeArgument(args.tree), start, end, args.full === true);
    }
    if (args.node === undefined || args.node === null || args.node === "") {
        const target = treeArgument(args.tree);
        return formatLines(await tree.get(target), Number(args.block), Number(args.start), Number(args.end), target);
    }
    const { tree: ref, id } = nodeTarget(args, "id");
    const index = await tree.get(ref);
    const node = index.nodes.get(id);
    const label = ref ?? CURRENT_TREE;
    if (!node)
        throw new ToolInputError(`read_lines: no node ${id} in tree ${label}`);
    if (!index.isLeaf(node)) {
        throw new ToolInputError(`read_lines: node ${label}#${id} is a branch; read_node {"node": "${label}#${id}"} lists the leaves under it`);
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
        hostToken: env[HOST_TOKEN_ENV] || undefined,
    };
    const tree = new CurrentTree(deps);
    const finder = new SessionFinder(deps);
    const versionNote = versionMismatchNote(env[PROXY_VERSION_ENV]);
    const notice = new StaleToolsNotice();
    if (versionNote)
        process.stderr.write(`memtree MCP: ${versionNote}\n`);
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
                // Calls run one at a time, so each reads the session its process is on now.
                if (isToolCall(message))
                    await refreshHostSession(deps);
                const response = await handleMcpMessage(message, tree, finder, versionNote, notice).catch((err) => ({
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
function isToolCall(message) {
    return isRpcRequest(message) && message.method === "tools/call";
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