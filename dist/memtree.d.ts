/**
 * Client for the polychat.co MemTree API (/v1/context_memory).
 *
 * Two modes, mirroring the server's lazy-compression path (cc_api.py):
 * - Tool turns: fire-and-forget indexing POST, off the response path.
 * - User turns: blocking compression call with a hard timeout; the caller
 *   degrades to transparent pass-through on any failure (including 402 —
 *   compression is the paid feature, the user's own Anthropic call is never
 *   gated on it). A 402 from either mode additionally records
 *   payment-required state (paymentRequiredDetail) so the proxy can tell the
 *   user WHY MemTree is off instead of implying a transient outage; any later
 *   successful call clears it (the user paid mid-session).
 *
 * Compression work is deduped per complete request key, while background
 * indexing is deduped per messages hash. Claude Code retries therefore cannot
 * amplify identical HTTP calls, and budget-changing inputs never reuse a
 * stale compression result.
 */
import type { RequestLogSink } from "./reqlog.js";
import { type Message } from "./turns.js";
export declare const CLIENT_NAME = "cc-infinite";
export declare const CLIENT_VERSION: string;
export interface MemtreeOptions {
    baseUrl: string;
    apiKey: string;
    compressTimeoutMs?: number;
    debug?: boolean;
    /** Always-on JSONL diagnostics; every MemTree call logs one line. */
    reqlog?: RequestLogSink;
}
/**
 * Request metadata forwarded to the server so it can resolve a model-based
 * memory budget (e.g. the 500k whole-request target for Fable / Opus 4.8).
 * Without `model` the server can only apply its static 50k fallback.
 */
export interface CompressRequestMeta {
    model?: string;
    tools?: unknown[];
}
export interface CompressResult {
    /** Processed (compressed) messages from the server; system role may be included. */
    messages: Message[];
    /**
     * The server-side flatten of `messages`: exactly one user message whose
     * string content is the whole compressed conversation, produced by the
     * server's `flatten_to_single_user_message` (the single implementation of
     * the flatten format). Returned when the request asked for `flatten: true`;
     * pre-flatten servers omit it. The client treats these bytes as opaque —
     * it no longer has a flatten of its own — so a result without this field
     * cannot be forwarded compressed (see serverFlattenedMessages).
     */
    flattened_messages?: Message[];
    /**
     * Explicit server verdict on whether the conversation was rewritten. False
     * on a passthrough (request already under the model budget, or no index
     * yet), where `messages` is the conversation as-is and the server also
     * omits `flattened_messages`. Older servers omit this field; callers fall
     * back to the cached_tokens heuristic (see didMemtreeCompress).
     */
    compressed?: boolean;
    /**
     * Optional explicit unfolded index, consumed only by the memoryChars
     * reqlog diagnostic. Older servers omit it; callers fall back to the first
     * non-system processed message, which is the current server layout.
     */
    unfolded_memory?: string;
    usage?: unknown;
    /** Client-observed latency of the underlying HTTP call (survives retry dedupe). */
    clientLatencyMs?: number;
}
/**
 * The server-flattened single user message of a compressed result, or null
 * when the server did not provide a valid one (a pre-flatten server, or a
 * malformed field). The flatten format lives server-side ONLY — the client
 * must never re-derive or post-process it — so a null here means the result
 * cannot be forwarded in compressed form and the caller degrades to the
 * original history. Returns a fresh single-message array so callers may
 * embed it in a request body without sharing structure with the result.
 */
export declare function serverFlattenedMessages(result: CompressResult): Message[] | null;
/**
 * Whether the server actually rewrote the conversation. A successful
 * context_memory response is not enough: the endpoint returns the messages
 * as-is while an index is still warming AND whenever the request already fits
 * the model budget. The server's explicit `compressed` verdict is
 * authoritative. The cached_tokens fallback only covers servers that predate
 * it: cached_tokens is a billing prediction, not a compression signal, and is
 * > 0 on most under-budget passthroughs — so on such servers those turns are
 * flattened and Anthropic's prefix cache misses every human turn.
 */
export declare function didMemtreeCompress(result: CompressResult): boolean;
/** Number of original prompt tokens covered by the index MemTree selected. */
export declare function cachedPromptTokenCount(result: CompressResult): number | undefined;
/**
 * MemTree's informational estimate of the original, pre-consolidation prompt.
 * Newer servers include images as visual-token estimates and deliberately keep
 * this value separate from billable Context Memory usage.
 */
export declare function rawPromptTokenCount(result: CompressResult): number | undefined;
/**
 * Minimum conversation content, beyond any verbatim echo of the current turn,
 * that a compressed response must carry before we will send it to Anthropic in
 * place of the real history.
 *
 * Sized well below any useful memory (the server's own semantic floor is 15k
 * chars) and well above an empty answer, so this fires only on genuine context
 * loss and never on a legitimately aggressive compression.
 */
export declare const MIN_RETAINED_HISTORY_CHARS = 2000;
export interface CompressedHistoryCheck {
    /** Flattened conversation characters, falling back to structured messages. */
    retainedChars: number;
    /** Characters in the turn that prompted this request (as sent). */
    currentTurnChars: number;
    /** Non-system characters of prior conversation we asked it to compress. */
    priorHistoryChars: number;
    /** False when the response carries no usable prior conversation. */
    usable: boolean;
}
/**
 * Decide whether a compressed response still contains the conversation.
 *
 * This is deliberately NOT derived from `usage`. Every usage-derived signal —
 * `cached_tokens` and the `raw - cached` tail — measures how much of the prompt
 * the server's INDEX covered, not how much context it put in the response. A
 * server that indexes every message and then allocates zero characters to
 * memory (because fixed system+tool overhead exceeded its whole-request budget)
 * reports perfect coverage while returning nothing at all, and the tail metric
 * scores that empty answer as the best possible result. Only the body itself
 * says what the model will actually see.
 *
 * "Retained prior conversation" is measured as the result's conversation
 * characters minus only the part that verbatim-echoes the SENT current turn —
 * not minus the current turn's full size. A turn the server itself shrank
 * (e.g. a 100k-char pasted log returned as a 5k summary) leaves no verbatim
 * echo, so its compressed rendering counts as retained context instead of
 * sinking the score below zero and disabling compression on exactly the turns
 * that need it. The failure the floor exists to catch — the server echoing the
 * current turn back with essentially nothing of the prior conversation — still
 * scores ~0, because every verbatim echo (whole, truncated, or embedded in a
 * larger message) is fully subtracted, and a double echo — the turn embedded
 * in the memory block AND replayed as the tail, or carried twice within one
 * memory blob — is charged for every copy rather than netting out to a
 * single turn's worth of "retained" text. An echo fragmented across
 * consecutive text blocks is caught by re-checking each run of adjacent
 * plain-text pieces as one coalesced passage. Fragments below a small length
 * floor are never counted as echo, so a turn that quotes prior messages
 * cannot sink the genuine memory that contains those same fragments. A rewritten-but-still-empty answer can
 * in principle slip through; the trade is deliberate, since rewriting proves
 * the server did compression work rather than dropping context.
 */
export declare function checkCompressedHistory(result: CompressResult, sentMessages: Message[], minRetainedChars?: number): CompressedHistoryCheck;
/**
 * Remove model-specific reasoning blocks from the copy sent to MemTree.
 *
 * Claude Code does not reliably replay prior-turn thinking after a model
 * change or process resume. Thinking text, redacted payloads, and signatures
 * are required when present in the live Anthropic request, but none is stable
 * conversation identity for indexing.
 *
 * Scope this narrowly to assistant thinking blocks. A field named `signature`
 * inside tool input/result data can be real user data and must remain intact.
 * The original request is never mutated and still goes to Anthropic verbatim.
 */
export declare function normalizeMessagesForMemtree(messages: Message[]): Message[];
export declare class MemtreeClient {
    private baseUrl;
    private apiKey;
    private compressTimeoutMs;
    private debug;
    private reqlog;
    /** Complete compression request key → in-flight/settled promise (retry dedupe). */
    private compressCache;
    /** Message hashes already submitted for background indexing. */
    private indexedHashes;
    /** In-flight index-only calls, tracked so shutdown cannot outrun their logs. */
    private backgroundIndexes;
    /** Once draining begins, no later request may create another log producer. */
    private backgroundClosing;
    /** FastAPI `detail` text from the most recent 402, or null while paid. */
    private unpaidDetail;
    /** Complete compression request key → whether its latest failure arms fuse. */
    private compressFailureArming;
    /**
     * Non-null when the server last answered 402 (unpaid MemTree key): the
     * server's human-readable detail text. Set by both compression and
     * background-indexing calls; cleared by any subsequent success.
     */
    get paymentRequiredDetail(): string | null;
    /**
     * The blocking-compress abort budget. Exposed so the proxy's request log
     * can label a failed compress that consumed (roughly) the whole budget as a
     * timeout rather than a fast server error.
     */
    get compressBudgetMs(): number;
    constructor(opts: MemtreeOptions);
    static hashMessages(messages: Message[]): string;
    /**
     * Whether compress(hash, limit, meta) would answer without contacting the server: an
     * already-settled success, or a leg another caller has in flight. Callers
     * that read a compress result as evidence about the SERVER's health must
     * consult this first — a memoized answer proves only that the server was
     * alive whenever that entry was created, which may be many minutes and one
     * outage ago. In-flight entries count as cached here even though they are
     * real round trips: conservatively discarding live evidence only forgoes an
     * optimization, whereas trusting a stale one suppresses a real outage.
     */
    hasCachedCompress(hash: string, modelContextLimit: number, meta?: CompressRequestMeta): boolean;
    /**
     * Fuse classification for the most recent live compress failure of `hash`.
     * The entry is recorded before the failed promise settles null, and a
     * concurrent same-request retry MAY overwrite it with a different class — so
     * callers must sample at their own leg's settle (a .then on the compress
     * promise), not after awaiting other work; only that keeps the read paired
     * with the failure it describes.
     * Arming failures are evidence about the SERVER's health: no response at
     * all (network error or the abort-budget timeout), any 5xx, and 402 —
     * unpaid is global and persistent, so it must keep arming. Any other 4xx
     * came from a responsive server rejecting this one request and must not
     * open the shared fuse. Unclassified failures default to arming: muting
     * the fuse needs positive evidence of a responsive server.
     */
    lastCompressFailureArming(hash: string, modelContextLimit: number, meta?: CompressRequestMeta): boolean;
    /**
     * Blocking user-turn compression. Returns null on ANY failure (timeout,
     * network, 4xx/5xx including 402) — the caller must degrade to passthrough.
     * On 402 the failure is additionally recorded in paymentRequiredDetail so
     * the caller can distinguish "unpaid" from "outage".
     */
    compress(hash: string, messages: Message[], modelContextLimit: number, signal?: AbortSignal, meta?: CompressRequestMeta): Promise<CompressResult | null>;
    /**
     * Fire-and-forget background indexing for tool and first-user turns. Keeps
     * the server index fed during tool loops; adds zero latency to the response
     * path. A tool turn whose route-miss recovery got any non-null compress()
     * response skips this: that call already submitted the same history. A
     * recovery that returned null skips it too when the client has already
     * disconnected, or on shutdown/402 — only an ordinary failure with a live
     * client keeps the longer-budget background retry.
     */
    indexInBackground(hash: string, messages: Message[], modelContextLimit: number): void;
    /**
     * Stop accepting background indexes and wait boundedly for those already in
     * flight. Calls still running after the grace period are aborted, and this
     * method does not return until their final request-log records are produced.
     * The boolean is true for a graceful drain and false when abort was needed.
     */
    drainBackground(timeoutMs?: number): Promise<boolean>;
    private compressKey;
    private remember;
    private callContextMemory;
    private log;
}
//# sourceMappingURL=memtree.d.ts.map