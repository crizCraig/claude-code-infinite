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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { stripCcSystemReminders, } from "./turns.js";
export const CLIENT_NAME = "cc-infinite";
// Sent on every MemTree call so the server can detect/warn stale clients
// (plan: "API versioning").
export const CLIENT_VERSION = createRequire(import.meta.url)("../package.json").version;
// Hard budget for the blocking user-turn compression call. The abort clock covers
// the ENTIRE fetch — uploading the full conversation (multi-MB on long sessions) plus
// server-side compression — so this is a circuit breaker for a hung server, not a
// latency target. Override via CCC_COMPRESS_TIMEOUT_MS (read below).
const DEFAULT_COMPRESS_TIMEOUT_MS = 15000;
/** Indexing runs off the response path; give it room. */
const INDEX_TIMEOUT_MS = 120_000;
const DEDUPE_CACHE_MAX = 64;
/**
 * The server-flattened single user message of a compressed result, or null
 * when the server did not provide a valid one (a pre-flatten server, or a
 * malformed field). The flatten format lives server-side ONLY — the client
 * must never re-derive or post-process it — so a null here means the result
 * cannot be forwarded in compressed form and the caller degrades to the
 * original history. Returns a fresh single-message array so callers may
 * embed it in a request body without sharing structure with the result.
 */
export function serverFlattenedMessages(result) {
    const flattened = result.flattened_messages;
    if (!Array.isArray(flattened) || flattened.length !== 1)
        return null;
    const only = flattened[0];
    if (!only || typeof only !== "object" || only.role !== "user")
        return null;
    if (typeof only.content !== "string" || only.content.length === 0) {
        return null;
    }
    return [{ role: "user", content: only.content }];
}
function usageRecord(result) {
    return result.usage && typeof result.usage === "object"
        ? result.usage
        : null;
}
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
export function didMemtreeCompress(result) {
    if (typeof result.compressed === "boolean")
        return result.compressed;
    return (cachedPromptTokenCount(result) ?? 0) > 0;
}
/** Number of original prompt tokens covered by the index MemTree selected. */
export function cachedPromptTokenCount(result) {
    const details = usageRecord(result)?.prompt_tokens_details;
    if (!details || typeof details !== "object")
        return undefined;
    const cachedTokens = details.cached_tokens;
    return typeof cachedTokens === "number" &&
        Number.isFinite(cachedTokens) &&
        cachedTokens >= 0
        ? cachedTokens
        : undefined;
}
/**
 * MemTree's informational estimate of the original, pre-consolidation prompt.
 * Newer servers include images as visual-token estimates and deliberately keep
 * this value separate from billable Context Memory usage.
 */
export function rawPromptTokenCount(result) {
    const rawPromptTokens = usageRecord(result)?.raw_prompt_tokens;
    return typeof rawPromptTokens === "number" &&
        Number.isFinite(rawPromptTokens) &&
        rawPromptTokens > 0
        ? rawPromptTokens
        : undefined;
}
/**
 * Minimum conversation content, beyond any verbatim echo of the current turn,
 * that a compressed response must carry before we will send it to Anthropic in
 * place of the real history.
 *
 * Sized well below any useful memory (the server's own semantic floor is 15k
 * chars) and well above an empty answer, so this fires only on genuine context
 * loss and never on a legitimately aggressive compression.
 */
export const MIN_RETAINED_HISTORY_CHARS = 2_000;
/** Characters of text/JSON content in an Anthropic content field. */
function contentChars(content) {
    if (content == null)
        return 0;
    if (typeof content === "string")
        return content.length;
    if (Array.isArray(content)) {
        let total = 0;
        for (const part of content)
            total += contentChars(part);
        return total;
    }
    if (typeof content !== "object")
        return String(content).length;
    const block = content;
    // Count what the server flatten actually puts in front of the model:
    // thinking blocks contribute only their thinking text (the opaque base64
    // `signature` is dropped) and redacted_thinking blocks are skipped entirely,
    // so neither may count as retained conversation: an echoed thinking block's
    // signature alone must not satisfy the retained floor.
    if (block.type === "thinking") {
        return typeof block.thinking === "string" ? block.thinking.length : 0;
    }
    if (block.type === "redacted_thinking")
        return 0;
    if (typeof block.text === "string")
        return block.text.length;
    try {
        return JSON.stringify(block)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
/** Conversation characters in `messages`, ignoring any system entry. */
function conversationChars(messages) {
    let chars = 0;
    for (const message of messages ?? []) {
        if (message.role === "system")
            continue;
        chars += contentChars(message.content);
    }
    return chars;
}
/**
 * The rendered text segments of a content field, mirroring contentChars:
 * plain strings, `text` blocks, thinking text (signatures dropped), no
 * redacted_thinking, and JSON serialization for anything else. Used to locate
 * verbatim echoes of the sent current turn inside a compressed result.
 */
function contentTextSegments(content, out) {
    if (content == null)
        return;
    if (typeof content === "string") {
        if (content)
            out.push({ text: content, joinable: true });
        return;
    }
    if (Array.isArray(content)) {
        for (const part of content)
            contentTextSegments(part, out);
        return;
    }
    if (typeof content !== "object") {
        out.push({ text: String(content), joinable: true });
        return;
    }
    const block = content;
    if (block.type === "thinking") {
        if (typeof block.thinking === "string" && block.thinking) {
            out.push({ text: block.thinking, joinable: false });
        }
        return;
    }
    if (block.type === "redacted_thinking")
        return;
    if (typeof block.text === "string") {
        if (block.text)
            out.push({ text: block.text, joinable: true });
        return;
    }
    try {
        const json = JSON.stringify(block);
        if (json)
            out.push({ text: json, joinable: false });
    }
    catch {
        // unserializable block contributes nothing, matching contentChars
    }
}
/** The rendered text pieces of a content field, in order. */
function contentTextPieces(content, out) {
    const segments = [];
    contentTextSegments(content, segments);
    for (const segment of segments)
        out.push(segment.text);
}
/**
 * The text pieces of one message's content, grouped into runs of ADJACENT
 * joinable pieces: consecutive plain-text pieces with nothing rendered
 * between them form one run, while thinking text and JSON-serialized blocks
 * each stand alone and break adjacency on both sides. A run's pieces
 * concatenate to the contiguous passage the model would read, which is where
 * an echo fragmented across text-block boundaries becomes visible again.
 */
function contentTextRuns(content) {
    const segments = [];
    contentTextSegments(content, segments);
    const runs = [];
    let current = null;
    for (const segment of segments) {
        if (segment.joinable) {
            if (!current) {
                current = [];
                runs.push(current);
            }
            current.push(segment.text);
        }
        else {
            current = null;
            runs.push([segment.text]);
        }
    }
    return runs;
}
/**
 * Below this length a match between result text and the current turn is
 * treated as coincidence, not echo. Small fragments legitimately recur in both
 * directions — the current turn quoting a prior message back, memory quoting a
 * phrase the turn repeats — and counting them as echo would sink genuine
 * retained history on overlap-heavy turns. Sized well below the shortest
 * echo worth catching (an empty-memory replay of a >= ~2k-char turn) and above
 * incidental shared phrases. Also the length of the head/tail probes in the
 * echo scan, which is what enforces the floor there: a probe IS a 32-char
 * verbatim match, so nothing shorter can ever be charged.
 */
const ECHO_MIN_PIECE_CHARS = 32;
/**
 * Index of the first charged span with start >= pos. The charged list is kept
 * sorted by start and its spans are disjoint, so starts and ends are both
 * strictly increasing and one binary search answers every interval question
 * in O(log spans) — a probe-dense run text (repeated characters produce a hit
 * at nearly every offset) used to linear-scan the growing list per hit, which
 * made the whole scan quadratic in the run length.
 */
function echoSpanLowerBound(spans, pos) {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].start < pos)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
/** Whether [start, end) intersects any charged span. O(log spans). */
function overlapsEchoSpan(spans, start, end) {
    const i = echoSpanLowerBound(spans, start);
    if (i < spans.length && spans[i].start < end)
        return true;
    return i > 0 && spans[i - 1].end > start;
}
/** Record [start, end) as charged, keeping the list sorted by start. */
function chargeEchoSpan(spans, start, end) {
    spans.splice(echoSpanLowerBound(spans, start), 0, { start, end });
}
/**
 * Echoed characters within one run text (the coalesced passage of adjacent
 * plain-text pieces the model would read). Two mechanisms, both anchored to
 * the sent current turn:
 *
 * - Whole-text containment: a run text that is itself a verbatim slice of the
 *   turn — whole, truncated at either end, or cut from the middle — is echo
 *   in full. Nothing the probe scan could find exceeds that, so it returns
 *   directly.
 * - Probe-and-extend masking scan: for every framed or truncated copy, a
 *   32-char probe from each END of each turn piece (head and tail) is
 *   searched for in the run text; every hit is extended greedily through the
 *   piece in the anchored direction (forward from a head hit, backward from a
 *   tail hit), the extended span is charged and masked so no later probe can
 *   re-charge it, and scanning continues past the span. Matches are therefore
 *   non-overlapping, each verbatim copy is charged once, and DISTINCT copies
 *   — the turn embedded twice in one blob, or reassembled from fragments next
 *   to a second truncated block — are each charged.
 *
 * Pieces are scanned LONGEST FIRST: when one turn piece is a verbatim
 * substring of a larger one, the larger piece's copy in the run must be
 * charged whole before the substring's probes can pre-mask its interior — a
 * substring is never longer than its superset, so descending length order
 * guarantees it. Interior masks that still arise (shared content between
 * pieces neither of which contains the other) do not truncate a legitimate
 * extension either: when the piece keeps matching across an already-charged
 * span at the aligned offset, the extension steps both cursors past the span
 * without re-charging it and continues on the far side. Both rules exist
 * because an interior mask used to cap head extension and floor tail
 * extension, leaving the region BETWEEN two interior masks uncharged — an
 * under-count, which is the failure direction this scan must never take.
 * Skips are attempted only after a segment that charged NEW characters, so a
 * chain of adjacent masks with nothing new between them ends the extension —
 * still strictly more coverage than not skipping at all — instead of
 * re-walking charged territory on every probe hit of a probe-dense run.
 *
 * The scan catches whole, truncated, framed, and framed+truncated echoes. Two
 * shapes it concedes: a copy truncated at BOTH ends and framed (neither probe
 * present), and a copy whose head probe lands inside territory an earlier
 * piece's extension already charged while its tail is truncated out of the
 * run (the overlap check rejects every hit). Both require remixed,
 * mask-geometry-aligned echoes never observed from real servers; the trade
 * buys a cheap scan with no regexes over untrusted
 * text: O(runText x pieces) for the substring searches, plus O(log spans)
 * per probe hit for the mask bookkeeping (the charged list is kept sorted by
 * start and binary-searched; see echoSpanLowerBound), plus extension work
 * bounded by the characters actually matched. Run texts and turn pieces
 * shorter than ECHO_MIN_PIECE_CHARS never participate, and because every
 * charged span contains a full 32-char probe, no match shorter than the
 * floor ever counts.
 */
function echoedCharsInRunText(runText, turnText, turnPieces) {
    if (runText.length < ECHO_MIN_PIECE_CHARS)
        return 0;
    if (turnText.includes(runText))
        return runText.length;
    const charged = [];
    let echoed = 0;
    // Longest pieces first, so a piece that is a substring of another can never
    // pre-mask the interior of its superset's copy (see the function comment).
    // Sort is stable, so equal-length pieces keep their original order.
    const pieces = turnPieces
        .filter((piece) => piece.length >= ECHO_MIN_PIECE_CHARS)
        .sort((a, b) => b.length - a.length);
    for (const piece of pieces) {
        // Head probe: a hit aligns runText[hit] with piece[0]; extend forward.
        // An already-charged span the piece still matches at the aligned offset
        // is stepped over without re-charging, so an interior mask cannot leave
        // the rest of a legitimate extension uncharged.
        const headProbe = piece.slice(0, ECHO_MIN_PIECE_CHARS);
        for (let from = 0;;) {
            const hit = runText.indexOf(headProbe, from);
            if (hit === -1)
                break;
            if (overlapsEchoSpan(charged, hit, hit + ECHO_MIN_PIECE_CHARS)) {
                from = hit + 1;
                continue;
            }
            let end = hit + ECHO_MIN_PIECE_CHARS;
            let p = ECHO_MIN_PIECE_CHARS;
            let segStart = hit;
            const segments = [];
            for (;;) {
                const next = echoSpanLowerBound(charged, end);
                const cap = next < charged.length ? charged[next].start : runText.length;
                while (end < cap &&
                    p < piece.length &&
                    runText.charCodeAt(end) === piece.charCodeAt(p)) {
                    end += 1;
                    p += 1;
                }
                const progressed = end > segStart;
                if (progressed)
                    segments.push({ start: segStart, end });
                if (end !== cap || next >= charged.length)
                    break;
                // Reached an interior mask. If the piece keeps matching across the
                // whole masked span, step both cursors past it (it is already
                // charged); otherwise the extension genuinely ends here. A skip is
                // attempted only when this segment charged NEW characters (the probe
                // guarantees that for the first one): a fruitless skip would mean the
                // extension is re-walking already-charged territory, which later
                // probes cover anyway, and unbounded re-walking of the charged
                // prefix is what would make probe-dense (repeated-character) runs
                // quadratic again.
                if (!progressed)
                    break;
                const span = charged[next];
                const len = span.end - span.start;
                if (p + len > piece.length)
                    break;
                let matches = true;
                for (let k = 0; k < len; k += 1) {
                    if (runText.charCodeAt(span.start + k) !== piece.charCodeAt(p + k)) {
                        matches = false;
                        break;
                    }
                }
                if (!matches)
                    break;
                end = span.end;
                p += len;
                segStart = end;
            }
            for (const s of segments) {
                echoed += s.end - s.start;
                chargeEchoSpan(charged, s.start, s.end);
            }
            from = end;
        }
        // Tail probe: a hit aligns runText[hit + 32] with the piece's end; extend
        // backward, stepping over aligned already-charged spans the same way.
        // Catches front-truncated copies, whose head never appears.
        const tailProbe = piece.slice(piece.length - ECHO_MIN_PIECE_CHARS);
        for (let from = 0;;) {
            const hit = runText.indexOf(tailProbe, from);
            if (hit === -1)
                break;
            const end = hit + ECHO_MIN_PIECE_CHARS;
            if (overlapsEchoSpan(charged, hit, end)) {
                from = hit + 1;
                continue;
            }
            let start = hit;
            let p = piece.length - ECHO_MIN_PIECE_CHARS;
            let segEnd = end;
            const segments = [];
            for (;;) {
                const prev = echoSpanLowerBound(charged, start) - 1;
                const floor = prev >= 0 ? charged[prev].end : 0;
                while (start > floor &&
                    p > 0 &&
                    runText.charCodeAt(start - 1) === piece.charCodeAt(p - 1)) {
                    start -= 1;
                    p -= 1;
                }
                const progressed = segEnd > start;
                if (progressed)
                    segments.push({ start, end: segEnd });
                if (start !== floor || prev < 0)
                    break;
                // Same fruitless-skip guard as the forward direction, mirrored.
                if (!progressed)
                    break;
                const span = charged[prev];
                const len = span.end - span.start;
                if (p - len < 0)
                    break;
                let matches = true;
                for (let k = 0; k < len; k += 1) {
                    if (runText.charCodeAt(span.start + k) !== piece.charCodeAt(p - len + k)) {
                        matches = false;
                        break;
                    }
                }
                if (!matches)
                    break;
                start = span.start;
                p -= len;
                segEnd = start;
            }
            for (const s of segments) {
                echoed += s.end - s.start;
                chargeEchoSpan(charged, s.start, s.end);
            }
            from = end;
        }
    }
    return echoed;
}
/** Append text nested inside tool_result blocks as rendered by a flattened response. */
function appendRenderedToolResultTextPieces(content, pieces) {
    if (!Array.isArray(content))
        return;
    for (const part of content) {
        if (!part || typeof part !== "object" || Array.isArray(part))
            continue;
        const block = part;
        if (block.type === "tool_result") {
            contentTextPieces(block.content, pieces);
        }
    }
}
/**
 * Characters of the result body that are a VERBATIM echo of the sent current
 * turn. Each message's text is scored per RUN of adjacent plain-text pieces
 * (contentTextRuns), coalesced into the contiguous passage the model would
 * read, with one probe-and-extend masking scan per run
 * (echoedCharsInRunText). Coalescing means an echo fragmented across
 * consecutive text blocks — sub-floor slivers that individually dodge the
 * length gate but concatenate back into the turn — is scored as the passage
 * it reassembles into, and the probes find a copy wherever it sits inside
 * the run: whole, truncated at either end, framed by non-turn text, or both.
 *
 * EVERY verbatim copy counts — a result that embeds the turn twice inside
 * one memory blob, or once in the memory block AND again as a replayed tail,
 * or reassembled from fragments beside a second truncated block, is charged
 * for every copy, so the total may exceed the turn's own length. Masking
 * within a run keeps the charges non-overlapping, so a single copy is never
 * charged twice, and a double echo can never net out to a single turn's
 * worth of "retained" text and pass the empty-memory gate. Over-subtraction
 * fails safe: a verbatim copy of current-turn content is by definition not
 * prior conversation.
 *
 * Run texts and turn pieces shorter than ECHO_MIN_PIECE_CHARS never count,
 * and no charged match is shorter than that floor: tiny fragments shared
 * between the turn and the result (quoted-back prior messages, repeated
 * pastes) are genuine retained history, not echo — and because quoted
 * fragments in genuine memory are separated by surrounding prose, coalescing
 * their run does not turn them into echo either. Content the server rewrote
 * — e.g. a summary of a huge pasted log — deliberately does not count as
 * echo: rewriting is compression work, and its output is retained context,
 * not a replay of the input.
 */
function echoedCurrentTurnChars(messages, currentTurnContent) {
    const turnPieces = [];
    contentTextPieces(currentTurnContent, turnPieces);
    if (turnPieces.length === 0)
        return 0;
    const turnText = turnPieces.join("");
    appendRenderedToolResultTextPieces(currentTurnContent, turnPieces);
    let echoed = 0;
    for (const message of messages ?? []) {
        if (message.role === "system")
            continue;
        for (const run of contentTextRuns(message.content)) {
            echoed += echoedCharsInRunText(run.join(""), turnText, turnPieces);
        }
    }
    return echoed;
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
export function checkCompressedHistory(result, sentMessages, minRetainedChars = MIN_RETAINED_HISTORY_CHARS) {
    const nonSystem = sentMessages.filter((m) => m.role !== "system");
    const currentTurnContent = nonSystem.length
        ? nonSystem[nonSystem.length - 1].content
        : undefined;
    const currentTurn = contentChars(currentTurnContent);
    const priorHistoryChars = Math.max(0, conversationChars(sentMessages) - currentTurn);
    const flattened = serverFlattenedMessages(result);
    const measuredMessages = flattened ?? result.messages;
    const retainedChars = conversationChars(measuredMessages);
    const echoedChars = echoedCurrentTurnChars(measuredMessages, currentTurnContent);
    // Require the original structured check too: rendering can reformat current
    // tool/text blocks enough to hide a verbatim echo in the flattened text.
    const structuredHistoryChars = flattened
        ? conversationChars(result.messages) -
            echoedCurrentTurnChars(result.messages, currentTurnContent)
        : retainedChars - echoedChars;
    // Nothing meaningful to lose: a short conversation legitimately compresses to
    // roughly itself, and passing it through would be pointless churn.
    const usable = priorHistoryChars < minRetainedChars ||
        (structuredHistoryChars >= minRetainedChars &&
            retainedChars - echoedChars >= minRetainedChars);
    return { retainedChars, currentTurnChars: currentTurn, priorHistoryChars, usable };
}
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
export function normalizeMessagesForMemtree(messages) {
    const normalized = [];
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            normalized.push(message);
            continue;
        }
        let removedReasoning = false;
        const content = [];
        for (const part of message.content) {
            if (!isReasoningBlock(part)) {
                content.push(part);
                continue;
            }
            removedReasoning = true;
        }
        if (removedReasoning && content.length === 0)
            continue;
        normalized.push(removedReasoning ? { ...message, content } : message);
    }
    return normalized;
}
function isReasoningBlock(value) {
    return (!!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value.type === "thinking" ||
            value.type === "redacted_thinking"));
}
function transmittedModel(model) {
    return typeof model === "string" && model.length > 0 ? model : undefined;
}
function transmittedTools(tools) {
    return Array.isArray(tools) && tools.length > 0 ? tools : undefined;
}
export class MemtreeClient {
    baseUrl;
    apiKey;
    compressTimeoutMs;
    debug;
    reqlog;
    /** Complete compression request key → in-flight/settled promise (retry dedupe). */
    compressCache = new Map();
    /** Message hashes already submitted for background indexing. */
    indexedHashes = new Set();
    /** In-flight index-only calls, tracked so shutdown cannot outrun their logs. */
    backgroundIndexes = new Map();
    /** Once draining begins, no later request may create another log producer. */
    backgroundClosing = false;
    /** FastAPI `detail` text from the most recent 402, or null while paid. */
    unpaidDetail = null;
    /** Complete compression request key → whether its latest failure arms fuse. */
    compressFailureArming = new Map();
    /**
     * Non-null when the server last answered 402 (unpaid MemTree key): the
     * server's human-readable detail text. Set by both compression and
     * background-indexing calls; cleared by any subsequent success.
     */
    get paymentRequiredDetail() {
        return this.unpaidDetail;
    }
    /**
     * The blocking-compress abort budget. Exposed so the proxy's request log
     * can label a failed compress that consumed (roughly) the whole budget as a
     * timeout rather than a fast server error.
     */
    get compressBudgetMs() {
        return this.compressTimeoutMs;
    }
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/$/, "");
        this.apiKey = opts.apiKey;
        this.compressTimeoutMs =
            opts.compressTimeoutMs ??
                Number(process.env.CCC_COMPRESS_TIMEOUT_MS || DEFAULT_COMPRESS_TIMEOUT_MS);
        this.debug = opts.debug ?? false;
        this.reqlog = opts.reqlog;
    }
    static hashMessages(messages) {
        return createHash("sha256")
            .update(JSON.stringify(messages))
            .digest("hex");
    }
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
    hasCachedCompress(hash, modelContextLimit, meta) {
        return this.compressCache.has(this.compressKey(hash, modelContextLimit, meta));
    }
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
    lastCompressFailureArming(hash, modelContextLimit, meta) {
        return (this.compressFailureArming.get(this.compressKey(hash, modelContextLimit, meta)) ?? true);
    }
    /**
     * Blocking user-turn compression. Returns null on ANY failure (timeout,
     * network, 4xx/5xx including 402) — the caller must degrade to passthrough.
     * On 402 the failure is additionally recorded in paymentRequiredDetail so
     * the caller can distinguish "unpaid" from "outage".
     */
    compress(hash, messages, modelContextLimit, signal, meta) {
        const cacheKey = this.compressKey(hash, modelContextLimit, meta);
        const cached = this.compressCache.get(cacheKey);
        if (cached)
            return cached;
        const promise = this.callContextMemory(messages, modelContextLimit, {
            timeoutMs: this.compressTimeoutMs,
            signal,
            model: meta?.model,
            tools: meta?.tools,
        }).catch((err) => {
            this.log(`compression failed: ${err?.message ?? err}`);
            // `status` is absent when the call never got a response (network
            // error/timeout) — the arming default covers it.
            const status = err?.status;
            // Delete-before-set so a re-failure moves to the back of the FIFO;
            // Map.set on an existing key keeps its old insertion position, which
            // would leave a fresh classification first in eviction order — under
            // churn it could be evicted before the failing leg samples it and the
            // sample would default to arming.
            this.compressFailureArming.delete(cacheKey);
            this.compressFailureArming.set(cacheKey, status === undefined || status >= 500 || status === 402);
            if (this.compressFailureArming.size > DEDUPE_CACHE_MAX) {
                const first = this.compressFailureArming.keys().next().value;
                if (first !== undefined)
                    this.compressFailureArming.delete(first);
            }
            // Don't cache failures — drop the entry so retries (e.g. Claude Code's
            // automatic retry of an identical request) hit the server again.
            if (this.compressCache.get(cacheKey) === promise) {
                this.compressCache.delete(cacheKey);
            }
            return null;
        });
        this.remember(cacheKey, promise);
        return promise;
    }
    /**
     * Fire-and-forget background indexing for tool and first-user turns. Keeps
     * the server index fed during tool loops; adds zero latency to the response
     * path. A tool turn whose route-miss recovery got any non-null compress()
     * response skips this: that call already submitted the same history. A
     * recovery that returned null skips it too when the client has already
     * disconnected, or on shutdown/402 — only an ordinary failure with a live
     * client keeps the longer-budget background retry.
     */
    indexInBackground(hash, messages, modelContextLimit) {
        if (this.backgroundClosing)
            return;
        if (this.indexedHashes.has(hash))
            return;
        this.indexedHashes.add(hash);
        if (this.indexedHashes.size > DEDUPE_CACHE_MAX) {
            const first = this.indexedHashes.values().next().value;
            if (first !== undefined)
                this.indexedHashes.delete(first);
        }
        const stripped = stripCcSystemReminders(messages);
        const controller = new AbortController();
        const operation = this.callContextMemory(stripped, modelContextLimit, {
            timeoutMs: INDEX_TIMEOUT_MS,
            indexOnly: true,
            signal: controller.signal,
        })
            .then(() => undefined, (err) => {
            this.log(`background indexing failed (ignored): ${err?.message ?? err}`);
        })
            .finally(() => {
            this.backgroundIndexes.delete(operation);
        });
        this.backgroundIndexes.set(operation, controller);
        void operation;
    }
    /**
     * Stop accepting background indexes and wait boundedly for those already in
     * flight. Calls still running after the grace period are aborted, and this
     * method does not return until their final request-log records are produced.
     * The boolean is true for a graceful drain and false when abort was needed.
     */
    async drainBackground(timeoutMs = 2_000) {
        this.backgroundClosing = true;
        if (this.backgroundIndexes.size === 0)
            return true;
        const boundedMs = Number.isFinite(timeoutMs) && timeoutMs >= 0
            ? Math.floor(timeoutMs)
            : 2_000;
        const pending = [...this.backgroundIndexes.keys()];
        let timer;
        const completed = await Promise.race([
            Promise.allSettled(pending).then(() => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), boundedMs);
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        if (completed)
            return true;
        for (const controller of this.backgroundIndexes.values()) {
            controller.abort();
        }
        await Promise.allSettled([...this.backgroundIndexes.keys()]);
        return false;
    }
    compressKey(hash, modelContextLimit, meta) {
        const model = transmittedModel(meta?.model);
        const tools = transmittedTools(meta?.tools);
        const toolsJson = tools === undefined ? "" : JSON.stringify(tools);
        const toolsHash = createHash("sha256").update(toolsJson).digest("hex");
        return createHash("sha256")
            .update(JSON.stringify([hash, model ?? null, modelContextLimit, toolsHash]))
            .digest("hex");
    }
    remember(cacheKey, promise) {
        this.compressCache.set(cacheKey, promise);
        if (this.compressCache.size > DEDUPE_CACHE_MAX) {
            const first = this.compressCache.keys().next().value;
            if (first !== undefined)
                this.compressCache.delete(first);
        }
    }
    async callContextMemory(messages, modelContextLimit, opts) {
        const body = {
            messages,
            model_context_limit: modelContextLimit,
        };
        // Server may ignore this until the index-only endpoint mode ships
        // (plan Phase 2.2); harmless extra field either way.
        if (opts.indexOnly)
            body.index_only = true;
        // Model (and tools, whose serialized size feeds the same budget) let the
        // server resolve a model-based memory budget instead of its static 50k
        // fallback. Only meaningful on compression calls: the server's index_only
        // path returns before budget resolution, so indexing calls skip both and
        // save the upload bytes (tools schemas run tens of KB per call).
        if (!opts.indexOnly) {
            const model = transmittedModel(opts.model);
            const tools = transmittedTools(opts.tools);
            if (model !== undefined)
                body.model = model;
            if (tools !== undefined)
                body.tools = tools;
            // Ask the server for its canonical single-user-message flatten of the
            // compressed result. The flatten format (closed transcript container,
            // per-human-turn headers, live-tail framing, header escaping) lives
            // server-side only; the client forwards `flattened_messages` verbatim
            // and never re-derives it. Pre-flatten servers ignore the field and
            // omit `flattened_messages`, which degrades to passthrough upstream.
            body.flatten = true;
        }
        const payload = JSON.stringify(body);
        const started = Date.now();
        let status;
        let ok = false;
        let diagnostics = {};
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timeout = setTimeout(abort, opts.timeoutMs);
        timeout.unref();
        opts.signal?.addEventListener("abort", abort, { once: true });
        if (opts.signal?.aborted)
            abort();
        try {
            const response = await fetch(`${this.baseUrl}/v1/context_memory`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.apiKey}`,
                    "content-type": "application/json",
                    "x-client": CLIENT_NAME,
                    "x-client-version": CLIENT_VERSION,
                },
                body: payload,
                signal: controller.signal,
            });
            status = response.status;
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                if (response.status === 402) {
                    this.unpaidDetail = extract402Detail(text);
                }
                // The status rides on the error so compress() can classify the
                // failure for the fuse without parsing message text.
                throw Object.assign(new Error(`context_memory ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
            }
            const json = (await response.json());
            // An index-only ack is `{ messages: [], usage: {...zeros}, index_only:
            // true }` by contract: the server skips compression and returns no
            // messages. Only a compress call needs a non-empty conversation back.
            if (!opts.indexOnly &&
                (!Array.isArray(json.messages) || json.messages.length === 0)) {
                throw new Error("context_memory returned no messages");
            }
            const clientLatencyMs = Date.now() - started;
            this.unpaidDetail = null; // a success proves the key is paid (again)
            ok = true;
            diagnostics = {
                indexedTokens: cachedPromptTokenCount(json),
                rawPromptTokens: rawPromptTokenCount(json),
                // Explicit field when the server sends one, else the first non-system
                // processed message — the current server's memory layout.
                memoryChars: typeof json.unfolded_memory === "string"
                    ? json.unfolded_memory.length
                    : contentChars(json.messages.find((message) => message?.role !== "system")
                        ?.content),
            };
            this.log(`context_memory ok in ${clientLatencyMs}ms ` +
                `(${messages.length} → ${json.messages.length} messages` +
                `${opts.indexOnly ? ", index-only" : ""})`);
            return { ...json, clientLatencyMs };
        }
        finally {
            clearTimeout(timeout);
            opts.signal?.removeEventListener("abort", abort);
            // One JSONL line per MemTree call, success or failure; `status` stays
            // absent when the call never got a response (network error/timeout).
            this.reqlog?.log({
                kind: "memtree",
                indexOnly: opts.indexOnly === true,
                ms: Date.now() - started,
                ok,
                status,
                requestBytes: Buffer.byteLength(payload),
                // Present only when the request carried a model for server-side
                // budget resolution — the client-visible half of the server's
                // "/v1/context_memory budget" log line.
                ...(opts.model && !opts.indexOnly ? { model: opts.model } : {}),
                ...diagnostics,
            });
        }
    }
    log(msg) {
        if (this.debug)
            console.error(`[ccc proxy] ${msg}`);
    }
}
/** 402 bodies are FastAPI JSON: {"detail": "<human-readable payment text>"}. */
function extract402Detail(bodyText) {
    try {
        const detail = JSON.parse(bodyText)?.detail;
        if (typeof detail === "string" && detail.trim())
            return detail.trim();
    }
    catch {
        // non-JSON 402 body — fall through to the generic text
    }
    return "Payment required";
}
//# sourceMappingURL=memtree.js.map