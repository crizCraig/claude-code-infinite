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
    /** Characters of the tool result texts shortened, and of them omitted. */
    originalChars: number;
    omittedChars: number;
    /** Where each shortened text was saved whole. */
    savedAt: string[];
}
/**
 * Shorten the tool result texts sent verbatim in the body (every user message's
 * tool_result blocks; a compressed prefix carries none), largest first, until
 * the body loses at least `cutChars` characters (or every text worth
 * shortening keeps only the minimum), or null when there is none or
 * `saveFull` could not save one. `saveFull` stores a whole text, returns where.
 * Every message, not only the newest: Claude Code resends an oversized result
 * on the turns after it, and each is shortened the same way again.
 */
export declare function truncateToolResults(body: Record<string, any>, cutChars: number, saveFull: (text: string) => string | undefined): TruncationPlan | null;
/** The pointer that stands for the omitted middle. */
export declare function pointerText(omittedChars: number, totalChars: number, savedAt: string): string;
//# sourceMappingURL=tool-result-truncation.d.ts.map