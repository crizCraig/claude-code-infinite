/**
 * Last-resort fit for a single tool result too large for the window even
 * after compression (polychat docs/context_memory_request_pipeline.md,
 * "Prepared compression"): keep its head and tail word for word and replace
 * the middle with a pointer to the full output in MemTree, instead of
 * refusing the request.
 *
 * MemTree has the whole result: the proxy sends every main-thread request's
 * full conversation to it for indexing, and its read_lines tool reads the
 * messages no tree covers yet ("tail") by their position.
 */
export interface TruncationPlan {
    /** The rewritten body; the input is never mutated. */
    body: Record<string, any>;
    /** Message index (in the body) of the truncated result. */
    messageIndex: number;
    toolUseId?: string;
    originalChars: number;
    omittedChars: number;
}
/**
 * Truncate the largest text of a tool result in the body's last message so
 * the body loses at least `cutChars` characters, or null when it has no
 * tool result text that large. `memtreePosition` is that message's position
 * in the conversation MemTree receives (the system prompt is its message 0).
 */
export declare function truncateLargestToolResult(body: Record<string, any>, cutChars: number, memtreePosition: number): TruncationPlan | null;
/** The pointer that stands for the omitted middle. */
export declare function pointerText(omittedChars: number, totalChars: number, position: number): string;
//# sourceMappingURL=tool-result-truncation.d.ts.map