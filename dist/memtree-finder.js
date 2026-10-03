/**
 * The `memtree` MCP server's server-side finding: `list` (the user's sessions)
 * and `search` across sessions or within one tree by `tree`, in text or vector
 * mode (memtree-mcp.ts wires them up; a text search of one tree uses the
 * per-tree term search instead).
 *
 * Both call the ccc loopback proxy (`/memtree/sessions`, `/memtree/search`),
 * which relays to the server's owner-only `GET /v1/memtree/sessions` and
 * `GET /v1/memtree/search` with the user's key; the key never reaches this
 * process. Results are formatted as plain text for the model, like the
 * single-tree tools (memtree-tools.ts). Every hit names the tree (a pinned
 * reference, or a request id on older servers) and the transcript lines,
 * and says which `read_lines` / `read_node`
 * call opens it: those tools take the tree id as `tree`.
 */
import { ToolInputError } from "./memtree-tools.js";
export const SESSIONS_DEFAULT_LIMIT = 20;
export const SESSIONS_MAX_LIMIT = 100;
export const FINDER_SEARCH_DEFAULT_LIMIT = 10;
export const FINDER_SEARCH_MAX_LIMIT = 50;
export const FINDER_SEARCH_MODES = ["vector", "text"];
const SNIPPET_CHARS = 400;
const TITLE_CHARS = 300;
const PATH_SUMMARY_CHARS = 80;
/** Query string for `/memtree/sessions` from the tool's arguments. */
export function sessionsQuery(args) {
    const params = new URLSearchParams();
    addText(params, "since", args.since);
    addText(params, "until", args.until);
    addText(params, "project", args.project);
    addText(params, "q", args.q);
    addText(params, "cursor", args.cursor);
    addLimit(params, args.limit, SESSIONS_MAX_LIMIT);
    const query = params.toString();
    return query ? `?${query}` : "";
}
/** Query string for `/memtree/search`; `mode` defaults to text; `tree` scopes it to one tree. */
export function searchQuery(args, tree) {
    if (typeof args.query !== "string" || !args.query.trim()) {
        throw new ToolInputError("search: query must be a non-empty string");
    }
    const mode = searchMode(args.mode);
    const params = new URLSearchParams({ q: args.query.trim(), mode });
    if (tree)
        params.set("tree", tree);
    addText(params, "project", args.project);
    addText(params, "since", args.since);
    addText(params, "until", args.until);
    addText(params, "cursor", args.cursor);
    addLimit(params, args.limit, FINDER_SEARCH_MAX_LIMIT);
    return `?${params.toString()}`;
}
export function searchMode(value) {
    if (value === undefined || value === null || value === "")
        return "text";
    const mode = String(value).trim().toLowerCase();
    if (mode === "vector" || mode === "text")
        return mode;
    throw new ToolInputError(`search: mode must be "vector" or "text", got ${JSON.stringify(value)}`);
}
function addText(params, name, value) {
    if (value === undefined || value === null)
        return;
    if (typeof value !== "string") {
        throw new ToolInputError(`${name} must be a string`);
    }
    if (value.trim())
        params.set(name, value.trim());
}
function addLimit(params, value, max) {
    if (value === undefined || value === null || value === "")
        return;
    const n = Number(value);
    if (!Number.isFinite(n))
        throw new ToolInputError("limit must be a number");
    params.set("limit", String(Math.max(1, Math.min(max, Math.floor(n)))));
}
export function formatSessions(body, args) {
    const sessions = body.sessions ?? [];
    if (!sessions.length) {
        return args.cursor
            ? "No more sessions."
            : "No sessions match. Widen the time range (since/until), drop the project or q filter, or check the spelling.";
    }
    const out = [`${sessions.length} session${sessions.length === 1 ? "" : "s"}, most recently active first:`];
    sessions.forEach((s, i) => {
        out.push("", `[${i + 1}] ${oneLine(s.title, TITLE_CHARS) || "(no MemTree yet)"}`);
        const when = [s.first_at, s.last_at].map(shortTime).filter(Boolean);
        out.push("    " +
            [
                sessionLabel(s.kind, s.id, s.session_id),
                when.length ? when.join(" → ") : undefined,
                s.request_count !== undefined ? `${s.request_count} request${s.request_count === 1 ? "" : "s"}` : undefined,
                s.models?.length ? `models ${s.models.join(", ")}` : undefined,
            ]
                .filter(Boolean)
                .join(" · "));
        const project = projectLabel(s.project);
        if (project)
            out.push(`    project: ${project}`);
        if (s.snippet)
            out.push(`    first message: ${oneLine(s.snippet, SNIPPET_CHARS)}`);
        const tree = s.latest_tree;
        if (tree?.request_id) {
            const ref = tree.ref ?? tree.request_id;
            out.push(`    latest tree: ${tree.request_id}${tree.links?.url ? ` (${tree.links.url})` : ""}; ` +
                `browse it with read_node {"tree": "${ref}", "id": 0}, or search it with search {"tree": "${ref}", "query": …}`);
        }
    });
    out.push("", nextPage("list", body.next_cursor));
    return out.join("\n");
}
export function formatSearchResults(body, args) {
    const query = typeof body.query === "string" ? body.query : String(args.query ?? "");
    if (body.groups) {
        const groups = body.groups.filter((g) => g.hits?.length);
        if (!groups.length)
            return noHits(query, "vector", args);
        const out = [
            `Semantic matches for ${JSON.stringify(query)}` +
                (body.charged ? " (charged: one query embedding per model)" : "") +
                ":",
        ];
        if (groups.length > 1) {
            out.push("Each embedding model is ranked on its own; scores are not comparable across groups.");
        }
        for (const group of groups) {
            out.push("", `== ${group.embedding_model} ==`);
            group.hits.forEach((hit, i) => out.push(...formatHit(hit, i + 1)));
        }
        out.push("", nextPage("search", body.next_cursor), OPEN_NOTE);
        return out.join("\n");
    }
    const hits = body.hits ?? [];
    if (!hits.length)
        return noHits(query, "text", args);
    const out = [`${hits.length} text match${hits.length === 1 ? "" : "es"} for ${JSON.stringify(query)}:`];
    hits.forEach((hit, i) => out.push(...formatHit(hit, i + 1)));
    if (body.matches_capped) {
        out.push("", "(Only the newest matching passages were ranked: add words, or narrow with since, until or project.)");
    }
    out.push("", nextPage("search", body.next_cursor), OPEN_NOTE);
    return out.join("\n");
}
const OPEN_NOTE = "Snippets are excerpts. read_node {\"node\": <address>} opens a hit's node (its children and path; the path's " +
    "addresses lead to parents and siblings); read_lines {\"node\": <address>} returns its exact transcript lines.";
function formatHit(hit, n) {
    const tree = hit.tree?.request_id;
    const ref = hit.tree?.ref ?? tree;
    const range = hit.range;
    const head = [
        sessionLabel(hit.kind, hit.id, hit.session_id),
        hit.tree?.created_at ? `tree ${tree} of ${shortTime(hit.tree.created_at)}` : `tree ${tree}`,
        hit.leaf ? `leaf ${hit.leaf}` : undefined,
        range ? `block ${range.block} lines ${range.start}-${range.end}` : undefined,
        typeof hit.score === "number" ? `score ${hit.score.toFixed(3)}` : undefined,
    ]
        .filter(Boolean)
        .join(" · ");
    const lines = ["", `[${n}] ${head}`];
    if (hit.tree?.links?.url)
        lines.push(`    page: ${hit.tree.links.url}`);
    if (hit.path?.length)
        lines.push(`    path: ${formatPath(hit.path, ref)}`);
    if (hit.snippet)
        lines.push(`    ${oneLine(boldToMarkdown(hit.snippet), SNIPPET_CHARS)}`);
    if (hit.address) {
        lines.push(`    address: ${hit.address}`);
    }
    else if (ref && range) {
        lines.push(`    open: read_lines {"tree": "${ref}", "block": ${range.block}, "start": ${range.start}, "end": ${range.end}}`);
    }
    return lines;
}
/** Ancestors root first, ` › `-joined, each with its address when the tree is known. */
export function formatPath(path, ref) {
    return path
        .map((p) => `${oneLine(p.summary, PATH_SUMMARY_CHARS)}${ref ? ` (${ref}#${p.id})` : ` (node ${p.id})`}`)
        .join(" › ");
}
function noHits(query, mode, args) {
    if (args.cursor)
        return "No more matches.";
    const other = mode === "vector"
        ? 'For an exact word, id or path, try mode "text".'
        : 'For meaning rather than exact words, try mode "vector".';
    if (typeof args.tree === "string" && args.tree) {
        return `Nothing in tree ${args.tree} matches ${JSON.stringify(query)} (${mode} search). ${other}`;
    }
    return `No passage in your sessions matches ${JSON.stringify(query)} (${mode} search). ${other} Or widen since/until, or drop the project filter.`;
}
function nextPage(tool, cursor) {
    return cursor
        ? `More results: call ${tool} again with the same arguments and "cursor": "${cursor}".`
        : "No more results.";
}
function sessionLabel(kind, id, sessionId) {
    if (kind === "claude_code_session")
        return `session ${sessionId || id}`;
    if (kind === "conversation")
        return `conversation ${id.replace(/^conversation:/, "").slice(0, 16)}`;
    if (kind === "request")
        return `request ${id.replace(/^request:/, "")}`;
    return `session ${id}`;
}
function projectLabel(project) {
    if (!project)
        return undefined;
    const where = [project.repo, project.dir && project.dir !== project.repo?.split("/").pop() ? `dir ${project.dir}` : undefined]
        .filter(Boolean)
        .join(", ");
    const at = [project.branch, project.commit ? `@ ${project.commit}` : undefined].filter(Boolean).join(" ");
    return [where || project.dir, at].filter(Boolean).join(" · ") || undefined;
}
/** `2026-09-29T01:40:57.018000+00:00` → `2026-09-29 01:40 UTC`. */
function shortTime(value) {
    if (!value)
        return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
function oneLine(text, max) {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
/** Text search snippets mark matched words `<b>…</b>`. */
function boldToMarkdown(text) {
    return text.replace(/<b>/g, "**").replace(/<\/b>/g, "**");
}
//# sourceMappingURL=memtree-finder.js.map