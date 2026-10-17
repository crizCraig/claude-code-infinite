/**
 * `ccc link <session-id>`: print the newest MemTree page of one of the
 * user's Claude Code sessions, for scripts and agents (docs/headless.md).
 *
 * Asks the server's owner-only `GET /v1/memtree/sessions` (what the `list`
 * MCP tool relays) with the saved key, so only the caller's own sessions can
 * answer. `q` also matches titles and snippets that quote the id, so only an
 * item whose `session_id` is exactly this session counts, and cursors are
 * followed (bounded) when other sessions quote it. The printed URL is the
 * server's own `latest_tree.links.url`: shortening a pinned reference can
 * select another tree (memtree-newest.ts).
 *
 * stdout carries the URL (or `--json`) and nothing else; everything else
 * goes to stderr.
 */
import { CLIENT_NAME, CLIENT_VERSION } from "./memtree.js";
import { SESSION_ID, validatedTreeUrl } from "./memtree-newest.js";

/** The whole lookup, every page included, gives up after this long. */
export const LINK_TIMEOUT_MS = 5_000;
export const LINK_EXIT = { ok: 0, error: 1, usage: 2, noTree: 3 } as const;
const SESSIONS_LIMIT = 10;
const MAX_PAGES = 10;
const ERROR_PREVIEW_CHARS = 300;

export const LINK_USAGE =
  "usage: ccc [staging|local] link <session-id> [--json]\n" +
  "  Prints the session's newest MemTree page URL.\n" +
  "  Exit 0 printed, 1 no saved key or the server could not be reached,\n" +
  "  2 bad invocation, 3 the session has no MemTree yet.";

export interface LinkDeps {
  fetch: typeof fetch;
  baseUrl: string;
  /** The saved MemTree key for this environment, if any. */
  apiKey: string | undefined;
  /** `ccc` / `ccc staging` / `ccc local`, for the no-key hint. */
  command: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  timeoutMs?: number;
}

export interface SessionLink {
  session_id: string;
  url: string;
  tree: string;
  updated_at: string | null;
}

type Lookup =
  | { kind: "found"; link: SessionLink }
  | { kind: "none" }
  | { kind: "error"; message: string };

/** Exit codes: LINK_EXIT. */
export async function runLinkCommand(argv: readonly string[], deps: LinkDeps): Promise<number> {
  const parsed = parseLinkArgs(argv);
  if ("error" in parsed) {
    deps.stderr(`${parsed.error ? `ccc link: ${parsed.error}\n` : ""}${LINK_USAGE}\n`);
    return LINK_EXIT.usage;
  }
  if (!deps.apiKey) {
    deps.stderr(`ccc link: no MemTree key saved. Run \`${deps.command}\` once to save one.\n`);
    return LINK_EXIT.error;
  }
  const result = await findSessionLink(parsed.sessionId, deps);
  if (result.kind === "error") {
    deps.stderr(`ccc link: ${result.message}\n`);
    return LINK_EXIT.error;
  }
  if (result.kind === "none") {
    deps.stderr(`ccc link: session ${parsed.sessionId} has no MemTree yet\n`);
    return LINK_EXIT.noTree;
  }
  deps.stdout(`${parsed.json ? JSON.stringify(result.link) : result.link.url}\n`);
  return LINK_EXIT.ok;
}

/** `<session-id> [--json]`, in either order; anything else is a usage error. */
export function parseLinkArgs(
  argv: readonly string[]
): { sessionId: string; json: boolean } | { error: string } {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) return { error: "" };
  if (rest.length > 1) return { error: `unexpected arguments: ${rest.slice(1).join(" ")}` };
  if (!SESSION_ID.test(rest[0])) return { error: `not a session id: ${rest[0]}` };
  return { sessionId: rest[0], json };
}

/** Pages through the owner's sessions matching the id, under one deadline. */
export async function findSessionLink(
  sessionId: string,
  deps: Pick<LinkDeps, "fetch" | "baseUrl" | "apiKey" | "timeoutMs">
): Promise<Lookup> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? LINK_TIMEOUT_MS);
  const query = new URLSearchParams({ q: sessionId, limit: String(SESSIONS_LIMIT) });
  const seen = new Set<string>();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchSessionsPage(deps, query, signal);
      if (typeof body === "string") return { kind: "error", message: body };
      const item = body.sessions.find((s) => s?.session_id === sessionId);
      if (item) return linkFromItem(item, sessionId);
      const cursor = body.next_cursor;
      if (cursor === null || cursor === undefined || cursor === "") return { kind: "none" };
      if (typeof cursor !== "string" || seen.has(cursor)) {
        return { kind: "error", message: "unexpected sessions listing from the server" };
      }
      seen.add(cursor);
      query.set("cursor", cursor);
    }
    return { kind: "error", message: "too many sessions match that id" };
  } catch (err) {
    return { kind: "error", message: networkMessage(err, signal) };
  }
}

interface SessionsPage {
  sessions: ({ session_id?: unknown; last_at?: unknown; latest_tree?: unknown } | null)[];
  next_cursor?: unknown;
}

/** One page of the listing, or an error message for a refusal or a bad body. */
async function fetchSessionsPage(
  deps: Pick<LinkDeps, "fetch" | "baseUrl" | "apiKey">,
  query: URLSearchParams,
  signal: AbortSignal
): Promise<SessionsPage | string> {
  const base = deps.baseUrl.replace(/\/$/, "");
  const res = await deps.fetch(`${base}/v1/memtree/sessions?${query}`, {
    signal,
    headers: {
      authorization: `Bearer ${deps.apiKey}`,
      accept: "application/json",
      "x-client": CLIENT_NAME,
      "x-client-version": CLIENT_VERSION,
    },
  });
  const text = await res.text();
  if (!res.ok) return `HTTP ${res.status} from the MemTree server: ${preview(text)}`;
  try {
    const body = JSON.parse(text);
    if (Array.isArray(body?.sessions)) return body as SessionsPage;
  } catch {
    // Falls through to the message below.
  }
  return "unexpected sessions listing from the server";
}

function linkFromItem(item: NonNullable<SessionsPage["sessions"][number]>, sessionId: string): Lookup {
  const tree = item.latest_tree as
    | { request_id?: unknown; ref?: unknown; links?: { url?: unknown } }
    | null
    | undefined;
  const raw = typeof tree?.links?.url === "string" ? tree.links.url : undefined;
  const url = raw ? validatedTreeUrl(raw) : undefined;
  if (!tree || !url) return { kind: "none" };
  const ref = typeof tree.ref === "string" && tree.ref ? tree.ref : tree.request_id;
  return {
    kind: "found",
    link: {
      session_id: sessionId,
      url,
      tree: typeof ref === "string" ? ref : "",
      updated_at: typeof item.last_at === "string" ? item.last_at : null,
    },
  };
}

function networkMessage(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "the MemTree server did not answer in time";
  const detail = err instanceof Error ? err.message : String(err);
  return `could not reach the MemTree server (${detail})`;
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, ERROR_PREVIEW_CHARS);
}
