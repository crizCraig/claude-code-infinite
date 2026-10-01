/**
 * `memtree` MCP server: lets the agent search and read its own session's
 * MemTree (tools `search`, `read_node`, `read_lines`, which Claude Code
 * exposes as `mcp__memtree__*`), and find things in the user's other sessions
 * (`list_sessions`, `search_sessions`, memtree-finder.ts). The three tree
 * tools take an optional `tree` (a request id from those results) to read
 * another session's tree instead of this one's.
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
 * `CLAUDE_CODE_SESSION_ID` Claude Code sets for MCP servers; the proxy uses it
 * only when it has served no page yet (a resumed session's first turn). The
 * page JSON is fetched through the proxy's key-free `/memtree/<id>.json`
 * relay, cached, and refetched when the proxy's newest page changes.
 *
 * `search` asks the server first (`/memtree/<id>/search`, the Step 6 term
 * search, so a long session's page JSON is not downloaded just to search it)
 * and falls back to searching the page JSON locally on a server without that
 * endpoint.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FINDER_SEARCH_DEFAULT_LIMIT,
  FINDER_SEARCH_MAX_LIMIT,
  formatSearchResults,
  formatSessions,
  searchQuery,
  SESSIONS_DEFAULT_LIMIT,
  SESSIONS_MAX_LIMIT,
  sessionsQuery,
} from "./memtree-finder.js";
import {
  formatLines,
  formatNode,
  formatSearch,
  formatSearchHits,
  MemtreeIndex,
  serverSearchHits,
  READ_LINES_MAX_CHARS,
  READ_LINES_MAX_LINES,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  ToolInputError,
  type MemtreePageJson,
} from "./memtree-tools.js";
import { CLIENT_VERSION } from "./memtree.js";

export const MEMTREE_MCP_SERVER_NAME = "memtree";
/** Sent to MemTree as `x-memtree-tools` when this server is configured. */
export const MEMTREE_TOOL_NAMES = [
  "search",
  "read_node",
  "read_lines",
  "list_sessions",
  "search_sessions",
] as const;
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const FETCH_TIMEOUT_MS = 60_000;

/**
 * The MCP server's instructions, which Claude Code places in the system prompt
 * from the first request: the one place that explains the agent's situation
 * before any memory message exists. Constant, so the prompt cache holds.
 */
export const MEMTREE_MCP_INSTRUCTIONS =
  "This session runs in Claude Code Infinite, which lets a conversation continue past the model's context window. " +
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
  "The user's other sessions are searchable too: list_sessions lists them by time and project, and search_sessions " +
  "finds passages across all of them; use these when the user refers to earlier work that is not in this session. " +
  "For search_sessions, vector mode (default) finds meaning: the first page is charged even when the query embedding " +
  "is cached; cursor continuation is free, including when the embedding must be regenerated. Text mode is free. " +
  "Cursors page over live results, not a frozen snapshot; new indexing can change later pages.";

export const MEMTREE_TOOLS = [
  {
    name: "search",
    description:
      "Search this session's MemTree (the index of this conversation; once a memory message has replaced the earlier part, the only way to its detail) for exact details " +
      "(names, ids, numbers, file paths, commands, errors, decisions). Case-insensitive term matching over node summaries and the verbatim " +
      "transcript lines under each leaf; returns the best nodes with their summaries, leaf line ranges and matching lines. " +
      "Use it before re-deriving or guessing something from earlier in the session.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for; distinctive terms work best (e.g. a file name, id or error text)." },
        limit: {
          type: "number",
          description: `Maximum results (default ${SEARCH_DEFAULT_LIMIT}, at most ${SEARCH_MAX_LIMIT}).`,
        },
        tree: {
          type: "string",
          description: "Optional: the exact tree reference from list_sessions or search_sessions, preserving its style and own/served suffix. Legacy request ids also work. Omit for this session.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_node",
    description:
      "Read one MemTree node: its summary, its path from the root (ancestor summaries), its children (id, summary, leaf or branch) and, " +
      "for a leaf, the transcript line range it covers. Node 0 is the root.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Node id (0 is the root)." },
        tree: {
          type: "string",
          description: "Optional: the exact tree reference from list_sessions or search_sessions, preserving its style and own/served suffix. Legacy request ids also work. Omit for this session.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "read_lines",
    description:
      "Read exact transcript lines of the summarized conversation: block and 1-based inclusive start/end lines, as given by a leaf's range. " +
      `At most ${READ_LINES_MAX_LINES} lines / ${READ_LINES_MAX_CHARS} characters per call; the reply says where to continue when capped.`,
    inputSchema: {
      type: "object",
      properties: {
        block: { type: "number", description: "Block index (a leaf's first range number)." },
        start: { type: "number", description: "First line, 1-based." },
        end: { type: "number", description: "Last line, inclusive." },
        tree: {
          type: "string",
          description: "Optional: the exact tree reference from list_sessions or search_sessions, preserving its style and own/served suffix. Legacy request ids also work. Omit for this session.",
        },
      },
      required: ["block", "start", "end"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List the user's own MemTree sessions (this one and others), most recently active first: title (the tree's root summary), " +
      "first message, times, project (directory, git repo, branch, commit), models, request count and the latest tree's id. " +
      "Filter by time, project or words in the title. Free. Open a session's tree with read_node {\"tree\": <id>, \"id\": 0} or search {\"tree\": <id>, ...}.",
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
    name: "search_sessions",
    description:
      "Search the transcripts of all of the user's own sessions at once; each hit names the session, the tree reference, " +
      "the transcript lines and a snippet, and says which read_lines call opens it. mode \"vector\" (default) matches meaning " +
      "and its first page is charged even when the query embedding is cached; cursor continuation is free, including " +
      "when the embedding must be regenerated. Mode \"text\" matches exact words, ids and paths and is free. " +
      "Cursors page over live results, not a frozen snapshot; new indexing can change later pages. " +
      "A passage repeated across a session's successive trees is reported once, from the newest.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for: a question or description (vector), or exact words (text; \"quoted phrase\", or, -word)." },
        mode: { type: "string", enum: ["vector", "text"], description: "vector (default, semantic, first page charged, cursor continuation free) or text (exact words, free)." },
        project: { type: "string", description: "Only sessions in this working directory or git repository (owner/repo, or just repo)." },
        since: { type: "string", description: "Only requests at or after this ISO 8601 time or date." },
        until: { type: "string", description: "Only requests before this ISO 8601 time or date." },
        cursor: { type: "string", description: "next cursor from a previous call, to get the next page (same other arguments)." },
        limit: { type: "number", description: `Hits per page (default ${FINDER_SEARCH_DEFAULT_LIMIT}, at most ${FINDER_SEARCH_MAX_LIMIT}; per model for vector).` },
      },
      required: ["query"],
    },
  },
];

export interface MemtreeMcpDeps {
  /** The ccc loopback proxy, e.g. http://127.0.0.1:1234. */
  proxyUrl?: string;
  sessionId?: string;
  fetch?: typeof fetch;
}

interface CurrentPage {
  id: string;
  url: string;
}

/** A request id in either spelling (UUID or the short leading-hex form). */
const TREE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Other sessions' pages kept in memory at once (each can be several MB). */
const OTHER_TREES_CACHED = 4;

interface ProxyJson {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

/** GET JSON from the loopback proxy; never throws. */
async function proxyGetJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string> = {}
): Promise<ProxyJson> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // not JSON: keep the raw text
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status} ${detail}` };
  }
  try {
    return { ok: true, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: "response was not JSON" };
  }
}

function proxyBase(deps: MemtreeMcpDeps): string {
  const base = deps.proxyUrl?.replace(/\/$/, "");
  if (!base) {
    throw new ToolInputError(
      "MemTree tools need a running ccc session: neither CCC_MEMTREE_PROXY nor ANTHROPIC_BASE_URL is set."
    );
  }
  return base;
}

function checkTreeId(tree: unknown): string | undefined {
  if (tree === undefined || tree === null || tree === "") return undefined;
  if (typeof tree !== "string" || !TREE_ID_RE.test(tree.trim())) {
    throw new ToolInputError("tree must be a request id from list_sessions or search_sessions");
  }
  return tree.trim();
}

/** What the tree tools read: this session's current tree, or another one by id. */
export interface TreeSource {
  get(tree?: string): Promise<MemtreeIndex>;
  /** Term search, formatted; optional so a plain index can stand in (tests). */
  search?(query: string, limit: number | undefined, tree?: string): Promise<string>;
}

/**
 * Resolves, fetches and caches the current page, and other sessions' pages
 * by request id.
 */
export class CurrentTree implements TreeSource {
  private cached?: { id: string; index: MemtreeIndex };
  /** Other trees, least recently used first. */
  private readonly others = new Map<string, MemtreeIndex>();
  /** Set once the server answered 404 to a tree search the page JSON could answer. */
  private serverSearchMissing = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: MemtreeMcpDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  async get(tree?: string): Promise<MemtreeIndex> {
    const other = checkTreeId(tree);
    if (other) return this.getOther(other);
    const id = await this.currentId();
    if (this.cached?.id === id) return this.cached.index;
    const index = await this.loadPage(id, "this session");
    // Only an unpinned prefix can later switch to the request's own tree.
    if (!index.page.served_prefix || index.page.ref === id) this.cached = { id, index };
    return index;
  }

  /**
   * The server's term search over the tree when it has the endpoint (no page
   * download), else the same search over the page JSON here.
   */
  async search(query: string, limit: number | undefined, tree?: string): Promise<string> {
    const other = checkTreeId(tree);
    if (!this.serverSearchMissing) {
      const id = other ?? (await this.currentId());
      const params = new URLSearchParams({ q: query });
      if (limit !== undefined && Number.isFinite(limit)) params.set("limit", String(limit));
      const base = proxyBase(this.deps);
      const answer = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}/search?${params}`);
      const parsed = answer.ok ? serverSearchHits(answer.body) : undefined;
      if (parsed) return formatSearchHits(parsed.hits, query, parsed.terms, other);
      if (answer.status === 202) {
        throw new ToolInputError("That MemTree is still being built; try again in a minute.");
      }
      const result = formatSearch(await this.get(other), query, limit, other);
      if (answer.status === 404 || answer.status === 405) this.serverSearchMissing = true;
      return result;
    }
    return formatSearch(await this.get(other), query, limit, other);
  }

  private async currentId(): Promise<string> {
    const base = proxyBase(this.deps);
    const query = this.deps.sessionId ? `?session=${encodeURIComponent(this.deps.sessionId)}` : "";
    const pointer = await proxyGetJson(this.fetchImpl, `${base}/memtree/current${query}`);
    if (pointer.status === 404) {
      throw new ToolInputError(
        "This session has no MemTree yet: nothing has been indexed or compressed so far, so everything is still in your context."
      );
    }
    if (!pointer.ok) throw new ToolInputError(`MemTree unavailable (current page: ${pointer.error})`);
    const current = pointer.body as CurrentPage;
    if (typeof current?.id !== "string" || !current.id) {
      throw new ToolInputError("MemTree unavailable: the proxy named no current page");
    }
    return current.id;
  }

  private async getOther(id: string): Promise<MemtreeIndex> {
    const hit = this.others.get(id);
    if (hit) {
      this.others.delete(id);
      this.others.set(id, hit);
      return hit;
    }
    const index = await this.loadPage(id, `tree ${id}`);
    if (!index.page.served_prefix || index.page.ref === id) this.others.set(id, index);
    while (this.others.size > OTHER_TREES_CACHED) {
      this.others.delete(this.others.keys().next().value!);
    }
    return index;
  }

  private async loadPage(id: string, label: string): Promise<MemtreeIndex> {
    const base = proxyBase(this.deps);
    const page = await proxyGetJson(this.fetchImpl, `${base}/memtree/${encodeURIComponent(id)}.json`);
    if (!page.ok) throw new ToolInputError(`MemTree unavailable (page ${id}: ${page.error})`);
    const json = page.body as MemtreePageJson;
    if (!Array.isArray(json?.nodes) || json.nodes.length === 0) {
      // Still building (or an empty tree): not cached, so the next call retries.
      throw new ToolInputError(
        `The MemTree for ${label} is still being built${json?.status ? ` (${json.status})` : ""}; try again in a minute.`
      );
    }
    return new MemtreeIndex(json);
  }
}

/** The cross-session tools: formatted text from the proxy's finder relay. */
export interface SessionFinderSource {
  listSessions(args: Record<string, unknown>): Promise<string>;
  searchSessions(args: Record<string, unknown>): Promise<string>;
}

export class SessionFinder implements SessionFinderSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: MemtreeMcpDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  async listSessions(args: Record<string, unknown>): Promise<string> {
    const body = await this.get(`/memtree/sessions${sessionsQuery(args)}`, "list_sessions");
    return formatSessions(body as Parameters<typeof formatSessions>[0], args);
  }

  async searchSessions(args: Record<string, unknown>): Promise<string> {
    const body = await this.get(`/memtree/search${searchQuery(args)}`, "search_sessions");
    return formatSearchResults(body as Parameters<typeof formatSearchResults>[0], args);
  }

  private async get(pathAndQuery: string, tool: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.deps.sessionId) headers["x-claude-code-session-id"] = this.deps.sessionId;
    const answer = await proxyGetJson(this.fetchImpl, `${proxyBase(this.deps)}${pathAndQuery}`, headers);
    if (answer.ok) return answer.body;
    if (answer.status === 404) {
      throw new ToolInputError(`${tool}: this MemTree server does not support finding sessions yet (${answer.error}).`);
    }
    throw new ToolInputError(`${tool} failed: ${answer.error}`);
  }
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * One JSON-RPC message in, the response out (undefined for notifications).
 * Exposed for tests; the stdio loop below is only framing.
 */
export async function handleMcpMessage(
  message: JsonRpcRequest,
  tree: TreeSource,
  finder?: SessionFinderSource
): Promise<object | undefined> {
  const isRequest = message.id !== undefined && message.id !== null;
  const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, text: string) => ({
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
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await callTool(String(name), args, tree, finder);
        return reply({ content: [{ type: "text", text }] });
      } catch (err) {
        if (err instanceof UnknownToolError) return fail(-32602, err.message);
        const text = err instanceof Error ? err.message : String(err);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      if (!isRequest) return undefined; // notifications/initialized, cancelled, …
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

class UnknownToolError extends Error {}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  tree: TreeSource,
  finder?: SessionFinderSource
): Promise<string> {
  const other = name === "list_sessions" || name === "search_sessions" ? undefined : checkTreeId(args.tree);
  switch (name) {
    case "search": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new ToolInputError("search: query must be a non-empty string");
      }
      const limit = args.limit === undefined ? undefined : Number(args.limit);
      if (tree.search) return tree.search(args.query, limit, other);
      return formatSearch(await tree.get(other), args.query, limit, other);
    }
    case "read_node":
      return formatNode(await tree.get(other), Number(args.id), other);
    case "read_lines":
      return formatLines(await tree.get(other), Number(args.block), Number(args.start), Number(args.end), other);
    case "list_sessions":
    case "search_sessions": {
      if (!finder) throw new ToolInputError(`${name} is not available here`);
      return name === "list_sessions" ? finder.listSessions(args) : finder.searchSessions(args);
    }
    default:
      throw new UnknownToolError(`Unknown tool: ${name}`);
  }
}

/** Serve MCP over this process's stdin/stdout until stdin closes. */
export function runMemtreeMcpServer(env: NodeJS.ProcessEnv = process.env): void {
  const deps: MemtreeMcpDeps = {
    proxyUrl: env.CCC_MEMTREE_PROXY || env.ANTHROPIC_BASE_URL,
    sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
  };
  const tree = new CurrentTree(deps);
  const finder = new SessionFinder(deps);
  let buffer = "";
  // Replies go out in arrival order even though tool calls are async.
  let queue: Promise<void> = Promise.resolve();
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      queue = queue.then(async () => {
        const response = await handleMcpMessage(message, tree, finder).catch((err) => ({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: String(err) },
        }));
        if (response) send(response);
      });
    }
  });
  process.stdin.on("end", () => {
    void queue.then(() => process.exit(0));
  });
}

function isMainModule(): boolean {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === self;
  } catch {
    return false;
  }
}

if (isMainModule()) runMemtreeMcpServer();
