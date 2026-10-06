/**
 * Always-on request/timing log (append-only JSONL) for post-hoc incident
 * reconstruction — when a turn stalls for minutes we want a client-side
 * record without asking the user to relaunch with --debug.
 *
 * Hard constraints:
 * - NEVER throw and NEVER block the proxy path: every filesystem touch is
 *   wrapped in try/catch and writes are fire-and-forget (async appendFile
 *   with an ignored error callback). A broken log path degrades to silence.
 * - Append-only single file at ~/.claude-code-infinite/logs/requests.jsonl,
 *   with one rotation slot: if the file exceeds ~20MB at proxy startup it is
 *   renamed to requests.jsonl.1 (overwriting any previous .1).
 *
 * One JSON object per line. `ts` (ISO 8601) and `pid` (the ccc process, which
 * tells apart concurrent ccc sessions sharing this file) are stamped here so
 * callers only supply event fields. Token counts under `approxInputTokens` are a rough
 * bytes/4 chars→tokens proxy, NOT real tokenizer output — exact usage, when
 * the response format lets us extract it cheaply, lands under `usage`.
 */
import type { ClaudeCodeRequestInfo, TranscriptShape } from "./cc-request.js";
/** Rough bytes→tokens estimate (bytes/4). Label the result approximate. */
export declare function approxTokensFromBytes(bytes: number): number;
export declare function defaultLogPath(): string;
export type TurnType = "first-user" | "tool"
/** A tool turn sent on its lane's memory route (compressed prefix + suffix). */
 | "tool-memory"
/**
 * A main-thread tool turn sent on the session's stable prefix directly (no
 * lane route to ride, e.g. after a tool-turn compaction made while a typed
 * prompt was pending): the prefix bytes, then every later message verbatim.
 */
 | "tool-prefix"
/**
 * A tool turn that compressed: its estimated size reached the budget (see
 * `compaction`, reason "budget"), or its lane's route no longer fitted the
 * context window. Validated compressed bytes were sent to Anthropic; on the
 * main thread the result is also the session's new stable prefix.
 */
 | "tool-recompressed" | "followup-compressed"
/**
 * A main-thread human turn sent on the session's stable compressed prefix:
 * the prefix bytes stored at the last compaction, then every message after
 * the part it covers, verbatim. No compress call (the history still goes
 * to MemTree as a background index_only call), and the prefix is a prompt
 * cache read. See `compaction` for the size check that allowed it.
 */
 | "followup-prefix" | "followup-noop"
/** Indexed response that carried no prior conversation; history forwarded. */
 | "followup-empty-memory"
/**
 * Compressed result carried no server `flattened_messages` (pre-flatten
 * server or malformed field); history forwarded.
 */
 | "followup-no-flatten" | "followup-degraded"
/**
 * A fork of the main conversation (the away recap) rode the main thread's
 * last compressed prefix: same bytes the main thread sent, so Anthropic's
 * prompt cache hits, and no MemTree call was made.
 */
 | "fork-memory"
/**
 * Claude Code's own side request (the security monitor): forwarded
 * untouched, no MemTree call, main-thread route state left alone.
 */
 | "side-request"
/**
 * Not from Claude Code (no X-Claude-Code-Session-Id): another program that
 * inherited ccc's ANTHROPIC_BASE_URL. Forwarded untouched, no MemTree.
 */
 | "foreign" | "followup-client-closed" | "unparseable";
/** Real token usage parsed from Anthropic's response, when available. */
export interface UsageRecord {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
}
/**
 * One /v1/messages request through the proxy. Built up mutably as the request
 * flows through the forward path (the forwarders fill in upstream timing) and
 * written once when the response finishes. Fields that a given path can't
 * derive cheaply are simply omitted.
 */
/** One actual Count Tokens HTTP attempt; never includes body, credentials or token counts. */
export interface CountTokensRecord {
    statusClass: string;
    ms: number;
}
export interface MessagesRecord {
    kind: "messages";
    turnType: TurnType;
    /** Body bytes as received from Claude Code. */
    requestBytes: number;
    model?: string;
    stream?: boolean;
    /** For a foreign request: the opening of its User-Agent, to name the program. */
    userAgent?: string;
    /**
     * What Claude Code's billing header says about this request (see
     * cc-request.ts). Logged to measure which request kinds lack
     * `cc_turn_origin` before any of them are kept away from MemTree.
     */
    client?: ClaudeCodeRequestInfo;
    /**
     * For a request shaped like Claude Code's security monitor (billing header,
     * no turn origin, no tools): whether its `<transcript>` block has the known
     * format. `ok: false` means it was handled as an ordinary request, and is
     * the signal that Claude Code changed the format.
     */
    transcript?: TranscriptShape;
    /** Body bytes actually sent to Anthropic (after notice strip / compression). */
    forwardedBytes?: number;
    /** forwardedBytes/4 — rough chars→tokens proxy, not a tokenizer count. */
    approxInputTokens?: number;
    /** Present when a blocking MemTree compress was attempted for this turn. */
    compress?: {
        /** Overall wall time of the compress step (all concurrent legs). */
        ms: number;
        /**
         * The compress call returned a result. NOT a
         * "forwarded compressed history" flag: the proxy can still discard the
         * result afterwards (no-op response, or indexed-but-empty memory) and
         * forward the full history — `turnType` (followup-noop /
         * followup-empty-memory vs followup-compressed) and `history.usable`
         * record what actually happened.
         */
        ok: boolean;
        /**
         * The compress call consumed (roughly) the whole compress budget and
         * returned nothing.
         */
        timedOut: boolean;
    };
    /**
     * How much conversation the compressed response actually carried. Recorded
     * separately from `compress.ok` because a fully indexed response can still
     * return an empty conversation; this is the field that shows it.
     */
    history?: {
        retainedChars: number;
        priorHistoryChars: number;
        usable: boolean;
    };
    /**
     * Which memory-route lane this request keys to: the away-summary side
     * channel, a request carrying agent attribution, or the main thread. This
     * is what splits verbatim `tool` rows into main-miss vs subagent traffic
     * when evaluating recovery behaviour after the fact.
     */
    routeLane?: "main" | "away" | "agent";
    /**
     * Tool turns that missed their lane's route: "missing" (empty lane),
     * "rejected" (a route was present in this lane but unusable for this
     * request), or "replay" (the body was an exact replay of the request that
     * installed the route — a client retry after a pre-flush socket death —
     * forwarded verbatim with the route retained and no recovery attempt).
     * "rejected" covers every OTHER reason memoryRoutedToolBody refuses:
     * a changed system/prefix hash, a conversation that shrank below the
     * stored prefix, an unexpected tool suffix shape, or an assembled route
     * estimated to exceed the destination context window. (An epoch-stale
     * route never reaches rejection: getMemoryRoute drops it on lookup, so
     * that case logs "missing".) "superseded": a main-thread route built on
     * an older stable prefix than the session's current one (a later tool-turn
     * compaction replaced the prefix without owning the route); dropped, and
     * the turn rides the current prefix instead.
     * Absent means there was no applicable miss — hits and away-summary turns
     * never emit it. "none" is deliberately not a value.
     */
    routeMiss?: "missing" | "rejected" | "replay" | "superseded";
    /**
     * The request's last conversation message was neither a user prompt nor a
     * tool result: e.g. a background task notification, which Claude Code
     * sends as a trailing role=system block after the assistant's last reply.
     * Handled like a tool turn (stable-prefix ride, budget compaction) without
     * consulting the lane's route. Absent on every other request.
     */
    continuation?: true;
    /**
     * Why a fork of the main conversation (away recap) did not ride the main
     * thread's last prefix and fell back to its own compression; absent when it
     * rode (turnType "fork-memory") or was not a fork.
     */
    forkMiss?: "no-route" | "session" | "system" | "prefix" | "too-large";
    /**
     * Stable-prefix (edge) compaction: the budget the turn was measured
     * against, the size estimate, and, when it compacted, why. Recorded on
     * main-thread human turns and on every lane's tool turns (a tool turn under
     * the budget forwards with no compress call; at the budget it compresses
     * once, reason "budget"). Absent on other requests, and on tool turns under
     * the CCC_TOOL_ROUTE_RECOVERY=0 kill switch.
     */
    compaction?: CompactionRecord;
    /** Every actual counting attempt, in order; cached results add no entry. */
    countTokens?: CountTokensRecord[];
    /** One bounded compression after an assembled ride was counted above the soft budget. */
    lateCountRecovery?: {
        outcome: "compressed" | "forwarded" | "refused";
    };
    /** Searchable flag explaining a forward above the advisory compression budget. */
    overBudgetForward?: {
        reason: "exact-count-fits-window" | "estimate-fits-window" | "bytes-fallback-fits-window";
    };
    /**
     * Outcome of a tool-turn compaction attempt (a tool turn whose estimated
     * size reached the budget), or why none was made although one was due.
     * Absent on tool turns under the budget: they forward with no attempt.
     */
    routeRecovery?: {
        /**
         * Serialized non-system conversation bytes, measured once per attempt.
         * Absent when no attempt was made (kill switch, cooldown, in-flight,
         * backoff, awaiting-index).
         */
        conversationBytes?: number;
        outcome: "compressed" | "failed"
        /** The server returned the conversation uncompressed (index warming). */
         | "noop" | "unusable"
        /**
         * Compressed result carried no server `flattened_messages`
         * (pre-flatten server or malformed field). Forwarded the original.
         */
         | "no-flatten" | "no-gain" | "client-closed"
        /**
         * CCC_TOOL_ROUTE_RECOVERY=0: a route miss that got no size check and
         * no attempt.
         */
         | "disabled"
        /** A recent attempt returned null; the blocking wait was skipped. */
         | "cooldown"
        /** Another attempt for this lane is still in flight. */
         | "in-flight"
        /**
         * This lane's last attempt this human turn produced no prefix to ride
         * (no-op, no gain, failure, a forward that installed nothing, or a
         * result still over the window); the next one waits until the
         * conversation has grown by a twentieth of the budget, so a lane that
         * cannot compress does not pay a blocking call on every tool turn.
         */
         | "backoff"
        /**
         * This lane's last attempt found no finished tree for the conversation
         * (no-op, nothing indexed), so a compress call could only pass it
         * through again. None is made until that attempt's MemTree page
         * reports built (checked in the background, one fetch at a time).
         */
         | "awaiting-index"
        /**
         * The compressed result could not be serialized (e.g. V8 string-length
         * limit on a multi-megabyte body). Forwarded the original.
         */
         | "build-failed";
        /**
         * Main-thread compactions with a session: whether the result became the
         * session's stable prefix ("not-installed": the forward never completed,
         * or a newer prefix replaced the one this compaction started from).
         */
        prefix?: "installed" | "not-installed";
        /** A no-op that found no tree: the lane now waits for one ("awaiting-index"). */
        awaitingIndex?: boolean;
        /** Route candidate fate; only "compressed" outcomes carry it. */
        install?: "installed" | "stale" | "prompt-pending" | "no-session"
        /**
         * The recovered forward never reached protocol-complete and the
         * downstream client had NOT aborted. Typically an upstream 5xx/529
         * or a truncated upstream stream, but any non-2xx of the compressed
         * forward lands here — including a plain 4xx, which is deliberately
         * non-arming for the fuse — as does proxy-shutdown teardown of an
         * in-flight recovery. Lifts the lane's backoff so the identical-body
         * retry compresses again.
         */
         | "upstream-failed"
        /**
         * The upstream served the turn to protocol-complete but route
         * bookkeeping threw at an activation attempt (the protocol-complete
         * attempt, the delivered-settle retry, or both), so no route exists.
         * Releases the lane's reservation but keeps its backoff. In the common
         * sub-case the client got its complete answer — a fast-tool abort
         * after message_stop lands here, not in "client-aborted" — so no
         * identical-body retry is coming, and the throw is not
         * upstream-health evidence. Rarer closes land here too: a socket
         * that dies before the accepted message_stop bytes flush (which
         * DOES retry the identical body) and an upstream-owned error
         * arriving after the data chunk that carried message_stop. A retry
         * finds its lane backed off and forwards uncompressed until the
         * history grows past the retry size or the next human turn — a
         * bounded degradation accepted because the closes are
         * indistinguishable at settle time and lifting the backoff would
         * fund one blocking recompress per tool turn under a deterministic
         * activation throw.
         */
         | "activation-error"
        /**
         * The downstream client aborted mid-stream before protocol-complete.
         * Lifts the backoff exactly like upstream-failed (no route exists
         * and the client's identical-body retry is imminent) but is split
         * out so attempt-rate tripwires can tell client behavior from
         * upstream health.
         */
         | "client-aborted";
    };
    upstreamStatus?: number;
    /** The downstream client aborted before the response finished. */
    clientAborted?: true;
    /** Forward start → first response byte from Anthropic. */
    ttfbMs?: number;
    /** Forward start → first upstream content_block_delta (SSE only). */
    firstContentMs?: number;
    /** Request received → response fully sent to Claude Code. */
    totalMs?: number;
    /** Legacy schema field; live response fabrication is disabled. */
    preludeFired?: boolean;
    usage?: UsageRecord;
}
/** Why a turn compressed instead of riding its prefix (or passing through). */
export type RecompressReason = 
/** The prefix plus the turns after it reached the budget. */
"budget"
/** The messages the prefix covers changed: rewind, edit, fork, /clear. */
 | "prefix-mismatch"
/** `/memtree-compact [N]` asked for a compaction now. */
 | "manual"
/** The session's target or context window changed since the prefix was built. */
 | "target-change";
export interface CompactionRecord {
    /** "off" after `/memtree-compact off`; "explicit" for an N or CCC_COMPACT_TARGET. */
    mode: "auto" | "explicit" | "off";
    /** The whole-request budget the turn was measured against. */
    budgetTokens: number;
    /**
     * Where the budget came from: CCC_BUDGET_TOKENS ("override"), the
     * server's `model_budget_tokens` ("server"), or the model's context window
     * times FALLBACK_BUDGET_WINDOW_RATIO until the server reports one.
     */
    budgetSource: "override" | "server" | "window-ratio";
    /** What a compaction on this turn aims at (budget/2, or the explicit N). */
    targetTokens?: number;
    /** Sent as compression_threshold_tokens (servers that report a budget). */
    thresholdTokens?: number;
    /** Size estimate of what would be sent (prefix ride or full history). */
    estimatedTokens?: number;
    /** Bytes of the request underlying estimatedTokens, including a reused prefix. */
    estimatedBytes?: number;
    /**
     * "reported": Anthropic's input+cache_read+cache_creation for the previous
     * request of the same shape, plus bytes/4 for what was added since.
     * "bytes": bytes/4 of the whole body (no earlier usage to start from).
     */
    sizeSource?: "reported" | "bytes";
    /** Set when the turn compressed (or tried to) for one of these reasons. */
    reason?: RecompressReason;
    /** For "prefix-mismatch": which check failed. */
    prefixMiss?: "session" | "system" | "prefix";
    /**
     * A compaction was attempted but did not produce a new prefix (MemTree
     * down, no-op, unusable) and the turn rode the old prefix instead.
     */
    keptPrefix?: true;
}
/** One MemTree API call (blocking compress or background index). */
export interface MemtreeRecord {
    kind: "memtree";
    indexOnly: boolean;
    ms: number;
    ok: boolean;
    /** HTTP status; absent when the call died before a response (network/timeout). */
    status?: number;
    requestBytes: number;
    /** Model sent for server-side budget resolution (compression calls only). */
    model?: string;
    /**
     * Response diagnostics, present on successful calls that reported usage.
     * `indexedTokens` (cached_tokens) is the prompt coverage of the index and
     * drives the success notice: flat coverage across turns means MemTree
     * indexed nothing new. `memoryChars` moves independently of it because the
     * index is unfolded per question.
     */
    indexedTokens?: number;
    rawPromptTokens?: number;
    memoryChars?: number;
    /** The per-request MemTree page the server stamped on the response, if any. */
    memtreeUrl?: string;
    /** The completed index the turn was compressed against, if the server said. */
    memtreeIndex?: string;
    /** The server's model budget (`model_budget_tokens`), when it reported one. */
    modelBudgetTokens?: number;
}
/** A display-only notice was atomically claimed by one Claude Code hook. */
export interface NoticeRecord {
    kind: "notice";
    event: "claimed";
    via: "MessageDisplay" | "Stop";
}
export type RequestRecord = MessagesRecord | MemtreeRecord | NoticeRecord;
/** Structural logging seam retained for embedders and focused tests. */
export interface RequestLogSink {
    log(record: RequestRecord): void;
}
export declare class RequestLogger implements RequestLogSink {
    readonly path: string;
    private readonly pendingWrites;
    constructor(filePath?: string);
    /** Fire-and-forget append of one JSONL line. Never throws, never blocks. */
    log(record: RequestRecord): void;
    /**
     * Shutdown-only durability seam. Wait for already-scheduled appends without
     * making normal proxy logging synchronous; false means the bounded wait
     * expired. Callers should stop request producers before invoking this.
     */
    flush(timeoutMs?: number): Promise<boolean>;
}
/**
 * Merge token usage out of a parsed SSE event into a record. Anthropic sends
 * input/cache counts on message_start and the final output count (plus
 * occasionally refreshed input counts) on message_delta.
 */
export declare function mergeUsageFromSseEvent(data: any, rec: MessagesRecord): void;
/** Merge usage from a non-streaming /v1/messages JSON response body. */
export declare function mergeUsageFromJsonBody(body: Buffer, rec: MessagesRecord): void;
//# sourceMappingURL=reqlog.d.ts.map