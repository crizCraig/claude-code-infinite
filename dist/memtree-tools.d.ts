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
export declare const SEARCH_DEFAULT_LIMIT = 10;
export declare const SEARCH_MAX_LIMIT = 50;
export declare const READ_LINES_MAX_LINES = 400;
export declare const READ_LINES_MAX_CHARS = 40000;
/** A page indexed for repeated queries: parent links, depths, split blocks. */
export declare class MemtreeIndex {
    readonly page: MemtreePageJson;
    readonly nodes: Map<number, MemtreeNode>;
    readonly parent: Map<number, number>;
    readonly depth: Map<number, number>;
    private readonly lines;
    private readonly lowerLines;
    constructor(page: MemtreePageJson);
    get blockCount(): number;
    blockLines(block: number): string[] | undefined;
    /** Root first, the node's parent last. */
    ancestors(id: number): number[];
    isLeaf(node: MemtreeNode): boolean;
    search(query: string, limit?: number): SearchHit[];
    private scoreNode;
}
export interface LeafRange {
    block: number;
    start: number;
    end: number;
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
    snippets: {
        line: number;
        text: string;
    }[];
    /** `<tree>#<node>` from servers that address hits. */
    address?: string;
    /** Ancestors, root first (servers that address hits). */
    path?: {
        id: number;
        summary: string;
    }[];
}
/** A node address, `<tree>#<node id>` (search hits carry them). */
export declare function parseNodeAddress(value: unknown): {
    tree: string;
    id: number;
};
/** Lowercased, de-duplicated terms; surrounding punctuation trimmed. */
export declare function queryTerms(query: string): string[];
export declare class ToolInputError extends Error {
}
export declare function formatSearch(index: MemtreeIndex, query: string, limit?: number, tree?: string): string;
/**
 * The hits of the server's term search over one tree
 * (`GET /usage/memtree/<id>/search`, a port of MemtreeIndex.search), in the
 * local shape; undefined when the body is not that endpoint's answer.
 */
export declare function serverSearchHits(body: unknown): {
    hits: SearchHit[];
    terms: string[];
} | undefined;
export declare function formatSearchHits(hits: SearchHit[], query: string, terms: string[], tree?: string): string;
export declare function formatNode(index: MemtreeIndex, id: number, tree?: string): string;
export declare function formatLines(index: MemtreeIndex, block: number, start: number, end: number, tree?: string): string;
/**
 * read_lines {"tail": true}: the messages after the tree that no tree covers
 * yet, verbatim, by position in the conversation's newest record.
 */
export declare function formatTail(body: unknown, tree?: string): string;
//# sourceMappingURL=memtree-tools.d.ts.map