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
import { type FinalReplyReader } from "./final-index.js";
import type { MessageTimes, MessageUsage } from "./transcript-usage.js";
import type { RequestLogSink } from "./reqlog.js";
import { type Message } from "./turns.js";
export declare const CLIENT_NAME = "cc-infinite";
export declare const CLIENT_VERSION: string;
/**
 * A main-lane Stop followed by this long without a new request is taken as the
 * session's end, and its final index goes out (exit sends it at once). Shorter
 * pauses spend the server's once-per-30-minutes final index mid-session.
 */
export declare const FINAL_INDEX_IDLE_MS: number;
/** Sessions finalized at exit at most (newest first), inside the 2 s drain. */
export declare const FINAL_INDEX_EXIT_SESSIONS = 3;
export interface MemtreeOptions {
    baseUrl: string;
    apiKey: string;
    compressTimeoutMs?: number;
    debug?: boolean;
    /** Always-on JSONL diagnostics; every MemTree call logs one line. */
    reqlog?: RequestLogSink;
    /**
     * `x-memtree-tools` on compress calls: the memtree MCP tools this Claude
     * Code session has (e.g. "search,read_node,read_lines"), so the server can
     * tell the model how to use them in the memory it returns. Set only when
     * the `memtree` MCP server is configured for the session (memtree-mcp-config.ts).
     */
    memtreeTools?: string;
}
/**
 * Request metadata forwarded to the server so it can resolve a model-based
 * memory budget (e.g. the 800k whole-request target for Fable / Opus 5).
 * Without `model` the server can only apply its static 50k fallback.
 */
export interface CompressRequestMeta {
    model?: string;
    tools?: unknown[];
    /**
     * Explicit whole-request target (server `compression_target_tokens`),
     * overriding the model-based budget. Set by `/memtree-compact` so a session
     * is compressed even while it would still fit the model's window.
     */
    compressionTargetTokens?: number;
    /**
     * Server `compression_threshold_tokens`: compress only when the whole
     * request exceeds this many tokens, and then to `compressionTargetTokens`.
     * Without it the target is also the threshold. Servers that predate the
     * field ignore it (they also omit `model_budget_tokens`, which is how the
     * proxy tells them apart).
     */
    compressionThresholdTokens?: number;
    /**
     * Server `client_input_tokens`: the proxy's own estimate of the request's
     * input tokens, the one its fallback gate refuses over-budget input by.
     * Over the budget, the server compresses even when its char estimate says
     * the request fits, so the two cannot disagree into a stuck session
     * (2026-10-05). Part of the cache key: a different estimate can flip the
     * server's verdict for the same messages.
     */
    clientInputTokens?: number;
    /**
     * Each assistant message's response usage (output, thinking, input), keyed
     * by its position in the messages sent. Archived by the server for the
     * MemTree page; never hashed, never part of the compression cache key.
     */
    messageUsage?: MessageUsage;
    /**
     * When Claude Code wrote each message (ISO), keyed like messageUsage. The
     * server records a time range per MemTree input block; never hashed, never
     * part of the compression cache key.
     */
    messageTimes?: MessageTimes;
    /**
     * Claude Code's session id, sent as `x-claude-code-session-id` so the
     * server can list a session's MemTree pages by it. Also scopes cached pages.
     */
    sessionId?: string;
    /** Sent as `x-client-meta`; stored on the usage row. Not part of the cache key. */
    clientMeta?: Record<string, string>;
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
     * The model's whole-request budget the server computed (tokens), whatever
     * target the request set. Servers that predate it omit the field.
     */
    model_budget_tokens?: number;
    /**
     * Optional explicit unfolded index, consumed only by the memoryChars
     * reqlog diagnostic. Older servers omit it; callers fall back to the first
     * non-system processed message, which is the current server layout.
     */
    unfolded_memory?: string;
    usage?: unknown;
    /** Client-observed latency of the underlying HTTP call (survives retry dedupe). */
    clientLatencyMs?: number;
    /**
     * The per-request MemTree page (`X-Polychat-Memtree-Url`), when the server
     * sent one. `.json` on the same path is the machine-readable tree.
     */
    memtreeUrl?: string;
    /**
     * The completed index this turn was compressed against
     * (`X-Polychat-Memtree-Index`); absent on index-only acks and servers that
     * predate it. A new value means a new index finished and is now in use.
     */
    memtreeIndex?: string;
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
/**
 * Number of original prompt tokens covered by the index MemTree selected.
 *
 * Prefers `usage.indexed_tokens`: since 2026-10-04 the server bills a
 * passthrough's covered input at nothing, so `cached_tokens` is 0 there even
 * when a tree covers the prompt. Older servers only send `cached_tokens`.
 */
export declare function cachedPromptTokenCount(result: CompressResult): number | undefined;
/** The server-reported model budget, when present and sane. */
export declare function modelBudgetTokens(result: CompressResult): number | undefined;
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
    private memtreeTools;
    /** Complete compression request key → in-flight/settled promise (retry dedupe). */
    private compressCache;
    /** Message hashes already submitted for background indexing. */
    private indexedHashes;
    /** In-flight index-only calls, tracked so shutdown cannot outrun their logs. */
    private backgroundIndexes;
    /** Once draining begins, no later request may create another log producer. */
    private backgroundClosing;
    /** Session → its main lane's latest conversation, for the final index. */
    private readonly mainConversations;
    /** Session → its final index waiting for the session to stay idle. */
    private readonly pendingFinals;
    /** Session → hash of the conversation its last final index sent. */
    private readonly finalIndexed;
    private readonly finalPreparing;
    private finalDrainDeadline;
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
    /** Change the `x-memtree-tools` value for later calls (undefined: none). */
    setMemtreeTools(value: string | undefined): void;
    /**
     * GET a MemTree view path (`/usage/memtree/<id>[.json][?share=…]`) on the
     * polychat host with this client's key. Backs the loopback `/memtree/*`
     * passthrough, so an agent inside a ccc session reads the user's own tree
     * through ANTHROPIC_BASE_URL without ever handling the key.
     */
    fetchMemTree(pathAndQuery: string, accept?: string, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<{
        status: number;
        contentType: string;
        body: Buffer;
    }>;
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
    indexInBackground(hash: string, messages: Message[], modelContextLimit: number, sessionId?: string, clientMeta?: Record<string, string>, 
    /** Times for retained original messages, in the positions actually sent. */
    messageTimesFor?: (messages: Message[]) => MessageTimes): void;
    /**
     * The main lane's latest conversation for a session, kept for its final
     * index (scheduleFinalIndex). A new request also means the session did not
     * end at the last Stop: its pending final index is cancelled.
     */
    noteMainConversation(sessionId: string | undefined, conversation: MainConversation): void;
    /**
     * After a main-lane Stop: once the session has been idle `delayMs` (or at
     * shutdown, flushFinalIndexes), send its conversation plus the reply it
     * ended with as one index-only call flagged final_index, so the server
     * indexes the tail even below its 10k-token minimum (at most once per
     * conversation per 30 minutes, server-side). Every per-request index call
     * lacks that reply: it only appears in the next request. `readReply` reads
     * it from the transcript when the call goes out, not inside the hook.
     */
    scheduleFinalIndex(sessionId: string | undefined, readReply: FinalReplyReader, delayMs?: number): void;
    /**
     * At shutdown, before drainBackground: finalize at most the three newest
     * sessions, including sessions that never had a Stop (`-p`
     * and non-TTY runs install no hooks). Never throws: a failure here must not
     * change ccc's exit code. The calls share drainBackground's bounded wait.
     */
    flushFinalIndexes(timeoutMs?: number): void;
    private cancelFinalIndex;
    private fireFinalIndex;
    private sendFinalIndex;
    private submitIndexOnly;
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
/** What noteMainConversation keeps: the last main-lane request as sent to MemTree. */
export interface MainConversation {
    messages: Message[];
    modelContextLimit: number;
    clientMeta?: Record<string, string>;
    messageTimesFor?: (messages: Message[]) => MessageTimes;
    /** The reply the session ended with (Claude Code's transcript), for a final index at exit. */
    readReply?: FinalReplyReader;
}
/** The conversation plus the reply that ended it, unless it already ends with a reply. */
export declare function withFinalReply(messages: Message[], reply: Message | undefined): Message[];
//# sourceMappingURL=memtree.d.ts.map