/**
 * Last-resort fit for a single tool result too large for the window even
 * after compression (polychat docs/context_memory_request_pipeline.md,
 * "Prepared compression"): keep its head and tail word for word and replace
 * the middle with a pointer to the full output, instead of refusing the
 * request. The full output is saved first (`saveFull`, tool-output-store.ts),
 * and the pointer names that file, which the model reads verbatim, page by
 * page, with Claude Code's own Read tool (MemTree indexes the conversation
 * too, but its tail read returns at most 40,000 characters of one message).
 */
export interface TruncationPlan {
    /** The rewritten body; the input is never mutated. */
    body: Record<string, any>;
    /** Message index (in the body) of the truncated result. */
    messageIndex: number;
    toolUseId?: string;
    originalChars: number;
    omittedChars: number;
    /** Where the full output was saved. */
    savedAt: string;
}
/**
 * Truncate the largest text of a tool result in the body's last message so
 * the body loses at least `cutChars` characters (or keeps the minimum), or
 * null when it has none worth shortening or `saveFull` could not save it.
 * `saveFull` stores the whole text and returns where.
 */
export declare function truncateLargestToolResult(body: Record<string, any>, cutChars: number, saveFull: (text: string) => string | undefined): TruncationPlan | null;
/** The pointer that stands for the omitted middle. */
export declare function pointerText(omittedChars: number, totalChars: number, savedAt: string): string;
//# sourceMappingURL=tool-result-truncation.d.ts.map