/**
 * What Claude itself is told about MemTree's state, and the manual /compact
 * interception.
 *
 * The display notices (notices.ts, payment-notice.ts) reach only the user:
 * hook `systemMessage`s and rendered deltas never enter the model's context.
 * So a model asked "why am I still blocked?" while MemTree was paused guessed
 * about Anthropic credits and Claude plan limits (2026-10-28, ccc 1.0.30).
 * While MemTree is paused or its key is refused, the UserPromptSubmit hook adds
 * one short `additionalContext` notice to the next prompt: what is paused
 * (MemTree, not Claude), why, and what fixes it. It stays in the transcript
 * (a paused MemTree compresses nothing), so it is said once per change of
 * state, and again after Claude Code's own compaction drops it.
 *
 * MemTree's normal state needs no notice: the MCP server's instructions
 * (memtree-mcp.ts) already say context is MemTree's job, with the paused case
 * as the exception these notices announce.
 */
export declare const SUPPORT_EMAIL = "support@polychat.co";
/** A scan that has not found a marker by then restores nothing. */
export declare const TRANSCRIPT_SCAN_MS = 1000;
/** Told once MemTree answers again after a paused or refused-key notice. */
export declare const MEMTREE_ACTIVE_AGAIN_CONTEXT: string;
/** The one line a blocked manual /compact shows (PreCompact hook reason). */
export declare const COMPACT_BLOCKED_REASON: string;
/** A second manual /compact within this long of a blocked one runs. */
export declare const COMPACT_CONFIRM_WINDOW_MS: number;
/** The model's notice for a paused key (402): `detail` is the server's text. */
export declare function pausedModelContext(detail: string, reason: string | null): string;
/** The model's notice for a refused key (401/403). */
export declare function keyInvalidModelContext(keyPageUrl: string): string;
export declare const PAUSED_KIND = "paused";
export declare const KEY_INVALID_KIND = "key-invalid";
/** A notice for the model; `kind` says whether it is news (PAUSED_KIND, KEY_INVALID_KIND). */
export type ModelNotice = {
    kind: string;
    text: string;
};
/** Per-session record of what the model was told, and of blocked /compacts. */
export declare class ModelContextNotices {
    private readonly now;
    private told;
    private compactBlockedAt;
    constructor(now?: () => number);
    /**
     * The notice to add to this session's prompt, given MemTree's current state
     * (undefined: working; null: not known yet, so no news), or undefined when
     * its kind has not changed since the session was last told: a refreshed
     * link alone is no news.
     */
    next(sessionId: string, current: ModelNotice | undefined | null): string | undefined;
    /**
     * A resumed session: what its transcript last told the model (a notice
     * from an earlier ccc process), so a later change is announced.
     */
    restore(sessionId: string, kind: string | undefined): void;
    /** The session's transcript lost its notices (Claude Code compacted it). */
    forget(sessionId: string): void;
    /**
     * The reason to block a manual /compact, or undefined to let it run: always
     * when MemTree is not compressing, and for a repeat within the window.
     */
    blockCompact(sessionId: string, memtreeWorking: boolean): string | undefined;
}
/**
 * The kind of the last notice in a transcript's live part (after its last
 * compaction), undefined when none or "working again".
 */
export declare function lastToldKind(transcript: string): string | undefined;
/**
 * lastToldKind of a transcript file, read backward from its end until the
 * last marker, so a long session's file is not read whole. Undefined when the
 * file is missing or unreadable, or after `budgetMs`. Never throws.
 */
export declare function lastToldKindInFile(file: string, budgetMs?: number, chunkBytes?: number): Promise<string | undefined>;
//# sourceMappingURL=model-context.d.ts.map