/**
 * `memtree` MCP server: lets the agent search and read its own session's
 * MemTree (tools `search`, `read_node`, `read_lines`, which Claude Code
 * exposes as `mcp__memtree__*`).
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
 * `CLAUDE_CODE_SESSION_ID` Claude Code sets for MCP servers. Reads require
 * this exact session on both the pointer and the authenticated page; missing
 * or mismatched identity fails closed. The host must restart this server with
 * the current id when switching sessions.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatLines,
  formatNode,
  formatSearch,
  MemtreeIndex,
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
export const MEMTREE_TOOL_NAMES = ["search", "read_node", "read_lines"] as const;
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
  "memory shows what was decided and why. Read the exact lines (read_lines) when precision matters.";

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
      properties: { id: { type: "number", description: "Node id (0 is the root)." } },
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
      },
      required: ["block", "start", "end"],
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
  session_id?: string;
  id: string;
  url: string;
}

/** Resolves, fetches and caches the current page. */
export class CurrentTree {
  private cached?: { id: string; index: MemtreeIndex };
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: MemtreeMcpDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  async get(): Promise<MemtreeIndex> {
    const base = this.deps.proxyUrl?.replace(/\/$/, "");
    if (!base) {
      throw new ToolInputError(
        "MemTree tools need a running ccc session: neither CCC_MEMTREE_PROXY nor ANTHROPIC_BASE_URL is set."
      );
    }
    const sessionId = this.deps.sessionId;
    if (!sessionId) throw new ToolInputError("MemTree unavailable: the calling session id is missing");
    const query = `?session=${encodeURIComponent(sessionId)}`;
    const pointer = await this.getJson(`${base}/memtree/current${query}`);
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
    if (current.session_id !== sessionId) {
      throw new ToolInputError("MemTree unavailable: current page belongs to a different or unknown session");
    }
    if (this.cached?.id === current.id) return this.cached.index;

    const page = await this.getJson(`${base}/memtree/${encodeURIComponent(current.id)}.json`);
    if (!page.ok) throw new ToolInputError(`MemTree unavailable (page ${current.id}: ${page.error})`);
    const json = page.body as MemtreePageJson;
    if (!Array.isArray(json?.nodes) || json.nodes.length === 0) {
      // Still building (or an empty tree): not cached, so the next call retries.
      throw new ToolInputError(
        `The MemTree for this session is still being built${json?.status ? ` (${json.status})` : ""}; try again in a minute.`
      );
    }
    if (json.session_id !== sessionId) {
      throw new ToolInputError("MemTree unavailable: page belongs to a different or unknown session");
    }
    const index = new MemtreeIndex(json);
    this.cached = { id: current.id, index };
    return index;
  }

  private async getJson(
    url: string
  ): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: 0, error: String(err) };
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status} ${text.slice(0, 300)}` };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, error: "response was not JSON" };
    }
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
  tree: { get(): Promise<MemtreeIndex> }
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
        const text = await callTool(String(name), args, tree);
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
  tree: { get(): Promise<MemtreeIndex> }
): Promise<string> {
  switch (name) {
    case "search": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new ToolInputError("search: query must be a non-empty string");
      }
      const limit = args.limit === undefined ? undefined : Number(args.limit);
      return formatSearch(await tree.get(), args.query, limit);
    }
    case "read_node":
      return formatNode(await tree.get(), Number(args.id));
    case "read_lines":
      return formatLines(await tree.get(), Number(args.block), Number(args.start), Number(args.end));
    default:
      throw new UnknownToolError(`Unknown tool: ${name}`);
  }
}

/** Serve MCP over this process's stdin/stdout until stdin closes. */
export function runMemtreeMcpServer(env: NodeJS.ProcessEnv = process.env): void {
  const tree = new CurrentTree({
    proxyUrl: env.CCC_MEMTREE_PROXY || env.ANTHROPIC_BASE_URL,
    sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
  });
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
        const response = await handleMcpMessage(message, tree).catch((err) => ({
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
