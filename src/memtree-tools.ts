/**
 * Local queries over one MemTree page JSON (`/usage/memtree/<id>.json`): the
 * logic behind the `memtree` MCP server's tools (memtree-mcp.ts).
 *
 * Page shape: `nodes` is a flat list, node 0 the root; each node has a summary
 * `s` and child ids `k`; a leaf has `l = [block, start_line, end_line]`, a
 * 1-based inclusive line range of `blocks[block]`, the raw transcript text the
 * leaf summarizes. Summaries are lossy; leaf lines are ground truth.
 *
 * Search is plain lexical matching: query terms, case-insensitive substring,
 * ranked by how many distinct terms a node covers, then how many one line
 * covers, then total hits. No embeddings and no server calls.
 */

export interface MemtreeNode {
  id: number;
  s?: string;
  k?: number[];
  l?: [number, number, number];
  h?: string;
}

export interface MemtreePageJson {
  request_id?: string;
  session_id?: string;
  nodes?: MemtreeNode[];
  blocks?: string[];
  source_note?: string;
  status?: string;
  [key: string]: unknown;
}

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
export const READ_LINES_MAX_LINES = 400;
export const READ_LINES_MAX_CHARS = 40_000;
const SNIPPETS_PER_LEAF = 3;
const SNIPPET_CHARS = 240;
const SUMMARY_CHARS = 600;

/** A page indexed for repeated queries: parent links, depths, split blocks. */
export class MemtreeIndex {
  readonly nodes = new Map<number, MemtreeNode>();
  readonly parent = new Map<number, number>();
  readonly depth = new Map<number, number>();
  private readonly lines: string[][];
  private readonly lowerLines: string[][];

  constructor(readonly page: MemtreePageJson) {
    for (const node of page.nodes ?? []) {
      if (node && Number.isInteger(node.id)) this.nodes.set(node.id, node);
    }
    // Breadth-first from the root; a node reached twice keeps its first
    // (shallowest) parent, so a malformed tree cannot loop.
    if (this.nodes.has(0)) {
      this.depth.set(0, 0);
      const queue = [0];
      while (queue.length) {
        const id = queue.shift()!;
        for (const child of this.nodes.get(id)?.k ?? []) {
          if (this.depth.has(child) || !this.nodes.has(child)) continue;
          this.parent.set(child, id);
          this.depth.set(child, this.depth.get(id)! + 1);
          queue.push(child);
        }
      }
    }
    this.lines = (page.blocks ?? []).map(splitLines);
    this.lowerLines = this.lines.map((block) => block.map((line) => line.toLowerCase()));
  }

  get blockCount(): number {
    return this.lines.length;
  }

  blockLines(block: number): string[] | undefined {
    return this.lines[block];
  }

  /** Root first, the node's parent last. */
  ancestors(id: number): number[] {
    const path: number[] = [];
    let current = this.parent.get(id);
    while (current !== undefined && path.length < 1000) {
      path.unshift(current);
      current = this.parent.get(current);
    }
    return path;
  }

  isLeaf(node: MemtreeNode): boolean {
    return Array.isArray(node.l) && node.l.length === 3;
  }

  search(query: string, limit = SEARCH_DEFAULT_LIMIT): SearchHit[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    for (const node of this.nodes.values()) {
      const hit = this.scoreNode(node, terms);
      if (hit) hits.push(hit);
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        // Later in the conversation first on ties: the newer state of a fact.
        b.id - a.id
    );
    return hits.slice(0, clampLimit(limit));
  }

  private scoreNode(node: MemtreeNode, terms: string[]): SearchHit | undefined {
    const summary = node.s ?? "";
    const summaryLower = summary.toLowerCase();
    const covered = new Set<string>();
    for (const term of terms) if (summaryLower.includes(term)) covered.add(term);
    const summaryTerms = covered.size;

    const lineMatches: LineMatch[] = [];
    let totalHits = 0;
    let bestLineTerms = 0;
    let range: LeafRange | undefined;
    if (this.isLeaf(node)) {
      const [block, start, end] = node.l!;
      range = { block, start, end };
      const lower = this.lowerLines[block] ?? [];
      const last = Math.min(end, lower.length);
      for (let n = Math.max(1, start); n <= last; n++) {
        const text = lower[n - 1];
        let lineTerms = 0;
        for (const term of terms) {
          const count = occurrences(text, term);
          if (count) {
            lineTerms++;
            totalHits += count;
            covered.add(term);
          }
        }
        if (lineTerms) {
          lineMatches.push({ line: n, terms: lineTerms });
          if (lineTerms > bestLineTerms) bestLineTerms = lineTerms;
        }
      }
    }
    if (!covered.size) return undefined;

    // Coverage of the query dominates; a single line holding several terms
    // beats terms scattered across a leaf; raw hit count breaks the rest.
    // A leaf with line hits outranks a summary-only match of equal coverage.
    const score =
      covered.size * 100 +
      bestLineTerms * 20 +
      summaryTerms * 5 +
      Math.min(totalHits, 50) * 0.1;

    const snippets = lineMatches
      .sort((a, b) => b.terms - a.terms || a.line - b.line)
      .slice(0, SNIPPETS_PER_LEAF)
      .sort((a, b) => a.line - b.line)
      .map(({ line }) => ({
        line,
        text: snippet(this.lines[range!.block][line - 1], terms),
      }));

    return {
      id: node.id,
      depth: this.depth.get(node.id),
      leaf: this.isLeaf(node),
      summary: truncate(summary, SUMMARY_CHARS),
      matchedTerms: terms.filter((t) => covered.has(t)),
      lineHits: lineMatches.length,
      score,
      ...(range ? { range } : {}),
      snippets,
    };
  }
}

export interface LeafRange {
  block: number;
  start: number;
  end: number;
}

interface LineMatch {
  line: number;
  terms: number;
}

export interface SearchHit {
  id: number;
  depth?: number;
  leaf: boolean;
  summary: string;
  matchedTerms: string[];
  /** Lines of the leaf's range that hold at least one term. */
  lineHits: number;
  score: number;
  range?: LeafRange;
  snippets: { line: number; text: string }[];
}

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from how i in is it of on or that the this to was were what when where which who why with you your".split(
    " "
  )
);

/** Lowercased, de-duplicated terms; surrounding punctuation trimmed. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const term = raw.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
    if (!term || STOPWORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
  }
  return terms;
}

function occurrences(text: string, term: string): number {
  let count = 0;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
    count++;
  }
  return count;
}

/** A window of the line around its first hit. */
function snippet(line: string, terms: string[]): string {
  const clean = line.replace(/\s+/g, " ").trim();
  if (clean.length <= SNIPPET_CHARS) return clean;
  const lower = clean.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  const start = Math.max(0, Math.min(first - SNIPPET_CHARS / 3, clean.length - SNIPPET_CHARS));
  const body = clean.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${body}${start + SNIPPET_CHARS < clean.length ? "…" : ""}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}

/** Block text → lines, without the empty tail a final newline leaves. */
function splitLines(block: unknown): string[] {
  if (typeof block !== "string" || block === "") return [];
  const lines = block.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// ---- Tool output (plain text for the model) -------------------------------

export class ToolInputError extends Error {}

export function formatSearch(index: MemtreeIndex, query: string, limit?: number): string {
  const hits = index.search(query, limit ?? SEARCH_DEFAULT_LIMIT);
  const terms = queryTerms(query);
  if (!terms.length) throw new ToolInputError("search: the query has no searchable terms");
  if (!hits.length) {
    return `No node or transcript line matches ${JSON.stringify(query)} (terms: ${terms.join(", ")}). Try other words, fewer terms, or read_node {"id": 0} to browse from the root.`;
  }
  const out = [`${hits.length} best match${hits.length === 1 ? "" : "es"} for ${JSON.stringify(query)} (terms: ${terms.join(", ")}):`];
  for (const hit of hits) {
    const head = [
      `node ${hit.id}`,
      hit.leaf ? "leaf" : "branch",
      hit.depth !== undefined ? `depth ${hit.depth}` : undefined,
      hit.range ? `block ${hit.range.block} lines ${hit.range.start}-${hit.range.end}` : undefined,
      `matched ${hit.matchedTerms.join(", ")}`,
      hit.leaf ? `${hit.lineHits} matching line${hit.lineHits === 1 ? "" : "s"}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    out.push("", `[${head}]`, `  ${hit.summary}`);
    for (const s of hit.snippets) out.push(`  L${s.line}: ${s.text}`);
  }
  out.push(
    "",
    "Summaries are lossy; read_lines {block, start, end} returns the exact transcript lines, read_node {id} a node's children and path from the root."
  );
  return out.join("\n");
}

export function formatNode(index: MemtreeIndex, id: number): string {
  if (!Number.isInteger(id)) throw new ToolInputError("read_node: id must be an integer node id");
  const node = index.nodes.get(id);
  if (!node) {
    throw new ToolInputError(
      `read_node: no node ${id} (this tree has ${index.nodes.size} nodes; node 0 is the root)`
    );
  }
  const out = [
    `node ${id} · ${index.isLeaf(node) ? "leaf" : "branch"}` +
      (index.depth.has(id) ? ` · depth ${index.depth.get(id)}` : ""),
    `summary: ${node.s ?? ""}`,
  ];
  if (index.isLeaf(node)) {
    const [block, start, end] = node.l!;
    out.push(
      `transcript: block ${block} lines ${start}-${end} (${end - start + 1} lines; read_lines {"block": ${block}, "start": ${start}, "end": ${end}})`
    );
  }
  const path = index.ancestors(id);
  if (path.length) {
    out.push("", "path from the root:");
    for (const ancestor of path) {
      out.push(`  node ${ancestor}: ${truncate(index.nodes.get(ancestor)?.s ?? "", SUMMARY_CHARS)}`);
    }
  }
  const children = (node.k ?? []).filter((child) => index.nodes.has(child));
  if (children.length) {
    out.push("", `children (${children.length}):`);
    for (const child of children) {
      const c = index.nodes.get(child)!;
      const tag = index.isLeaf(c) ? `leaf, block ${c.l![0]} lines ${c.l![1]}-${c.l![2]}` : "branch";
      out.push(`  node ${child} (${tag}): ${truncate(c.s ?? "", SUMMARY_CHARS)}`);
    }
  }
  return out.join("\n");
}

export function formatLines(
  index: MemtreeIndex,
  block: number,
  start: number,
  end: number
): string {
  if (![block, start, end].every(Number.isInteger)) {
    throw new ToolInputError("read_lines: block, start and end must be integers");
  }
  if (index.blockCount === 0) {
    const note = typeof index.page.source_note === "string" ? ` (${index.page.source_note})` : "";
    throw new ToolInputError(`read_lines: this MemTree page carries no transcript blocks${note}`);
  }
  const lines = index.blockLines(block);
  if (!lines) {
    throw new ToolInputError(
      `read_lines: no block ${block} (blocks 0-${index.blockCount - 1})`
    );
  }
  if (start < 1) throw new ToolInputError("read_lines: start is 1-based and must be at least 1");
  if (end < start) throw new ToolInputError("read_lines: end must be at least start");
  if (start > lines.length) {
    throw new ToolInputError(`read_lines: block ${block} has ${lines.length} lines; start ${start} is past its end`);
  }
  const notes: string[] = [];
  let last = end;
  if (last > lines.length) {
    last = lines.length;
    notes.push(`block ${block} ends at line ${lines.length}`);
  }
  if (last - start + 1 > READ_LINES_MAX_LINES) {
    last = start + READ_LINES_MAX_LINES - 1;
  }
  const out: string[] = [];
  let chars = 0;
  let shown = start - 1;
  for (let n = start; n <= last; n++) {
    let text = lines[n - 1];
    const room = READ_LINES_MAX_CHARS - chars;
    if (text.length > room) {
      if (n > start) break;
      // A single line longer than the whole budget: show its head.
      text = `${text.slice(0, room)}… [line truncated: ${lines[n - 1].length} chars]`;
    }
    out.push(`${n}\t${text}`);
    chars += text.length + 1;
    shown = n;
  }
  const wanted = Math.min(end, lines.length);
  if (shown < wanted) {
    notes.unshift(
      `capped at ${READ_LINES_MAX_LINES} lines / ${READ_LINES_MAX_CHARS} chars per call: showed ${start}-${shown}; ` +
        `continue with read_lines {"block": ${block}, "start": ${shown + 1}, "end": ${wanted}}`
    );
  }
  const header = `block ${block} lines ${start}-${shown} (line number, tab, exact text):`;
  return [header, ...out, ...(notes.length ? ["", `[${notes.join("; ")}]`] : [])].join("\n");
}
