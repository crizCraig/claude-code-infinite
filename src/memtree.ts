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
 * Work is deduped per messages hash, not per HTTP attempt, so Claude Code
 * retries cannot amplify into repeated compression/indexing calls.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { RequestLogSink } from "./reqlog.js";
import {
  stripCcSystemReminders,
  type Message,
} from "./turns.js";

export const CLIENT_NAME = "cc-infinite";
// Sent on every MemTree call so the server can detect/warn stale clients
// (plan: "API versioning").
export const CLIENT_VERSION: string = createRequire(import.meta.url)(
  "../package.json"
).version;

// Hard budget for the blocking user-turn compression call. The abort clock covers
// the ENTIRE fetch — uploading the full conversation (multi-MB on long sessions) plus
// server-side compression — so this is a circuit breaker for a hung server, not a
// latency target. Override via CCC_COMPRESS_TIMEOUT_MS (read below).
const DEFAULT_COMPRESS_TIMEOUT_MS = 15000;
/** Indexing runs off the response path; give it room. */
const INDEX_TIMEOUT_MS = 120_000;
const DEDUPE_CACHE_MAX = 64;

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
   * Optional explicit unfolded index for A/B grading. Older servers omit it;
   * callers fall back to the first non-system processed message, which is the
   * current server layout.
   */
  unfolded_memory?: string;
  usage?: unknown;
  /** Client-observed latency of the underlying HTTP call (survives retry dedupe). */
  clientLatencyMs?: number;
}

function usageRecord(result: CompressResult): Record<string, unknown> | null {
  return result.usage && typeof result.usage === "object"
    ? (result.usage as Record<string, unknown>)
    : null;
}

/**
 * Whether the server actually used indexed conversation history. A successful
 * context_memory response is not enough: while an index is still warming, the
 * endpoint deliberately returns the messages as-is with cached_tokens = 0.
 */
export function didMemtreeCompress(result: CompressResult): boolean {
  return (cachedPromptTokenCount(result) ?? 0) > 0;
}

/** Number of original prompt tokens covered by the index MemTree selected. */
export function cachedPromptTokenCount(
  result: CompressResult
): number | undefined {
  const details = usageRecord(result)?.prompt_tokens_details;
  if (!details || typeof details !== "object") return undefined;
  const cachedTokens = (details as Record<string, unknown>).cached_tokens;
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
export function rawPromptTokenCount(
  result: CompressResult
): number | undefined {
  const rawPromptTokens = usageRecord(result)?.raw_prompt_tokens;
  return typeof rawPromptTokens === "number" &&
    Number.isFinite(rawPromptTokens) &&
    rawPromptTokens > 0
    ? rawPromptTokens
    : undefined;
}

/**
 * Tokens after the indexed prefix. This is comparable across legacy signed
 * and normalized message shapes: unlike cached_tokens, it does not reward the
 * legacy shape merely for containing opaque signature bytes.
 */
export function unindexedPromptTokenCount(
  result: CompressResult
): number | undefined {
  const raw = rawPromptTokenCount(result);
  const cached = cachedPromptTokenCount(result);
  return raw === undefined || cached === undefined
    ? undefined
    : Math.max(0, raw - cached);
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
function contentChars(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) total += contentChars(part);
    return total;
  }
  if (typeof content !== "object") return String(content).length;
  const block = content as Record<string, unknown>;
  // Count what flattenToSingleUserMessage actually puts in front of the model:
  // thinking blocks contribute only their thinking text (the opaque base64
  // `signature` is dropped) and redacted_thinking blocks are skipped entirely,
  // so neither may count as retained conversation. Legacy-shaped results can
  // echo thinking blocks whose signatures alone would otherwise satisfy the
  // retained floor.
  if (block.type === "thinking") {
    return typeof block.thinking === "string" ? block.thinking.length : 0;
  }
  if (block.type === "redacted_thinking") return 0;
  if (typeof block.text === "string") return block.text.length;
  try {
    return JSON.stringify(block)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Conversation characters in `messages`, ignoring any system entry. */
function conversationChars(messages: Message[] | undefined): number {
  let chars = 0;
  for (const message of messages ?? []) {
    if (message.role === "system") continue;
    chars += contentChars(message.content);
  }
  return chars;
}

export interface CompressedHistoryCheck {
  /** Non-system conversation characters MemTree actually returned. */
  retainedChars: number;
  /** Characters in the turn that prompted this request (as sent). */
  currentTurnChars: number;
  /** Non-system characters of prior conversation we asked it to compress. */
  priorHistoryChars: number;
  /** False when the response carries no usable prior conversation. */
  usable: boolean;
}

/**
 * One rendered text piece of a content field. `joinable` marks plain text —
 * string content and `text` blocks — that reads as one contiguous passage
 * when consecutive, so adjacent joinable pieces may be coalesced when hunting
 * for echoes split across block boundaries. Thinking text and JSON-serialized
 * blocks are never joinable: they are distinct renderings, and anything
 * between two text pieces breaks their adjacency.
 */
interface TextSegment {
  text: string;
  joinable: boolean;
}

/**
 * The rendered text segments of a content field, mirroring contentChars:
 * plain strings, `text` blocks, thinking text (signatures dropped), no
 * redacted_thinking, and JSON serialization for anything else. Used to locate
 * verbatim echoes of the sent current turn inside a compressed result.
 */
function contentTextSegments(content: unknown, out: TextSegment[]): void {
  if (content == null) return;
  if (typeof content === "string") {
    if (content) out.push({ text: content, joinable: true });
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) contentTextSegments(part, out);
    return;
  }
  if (typeof content !== "object") {
    out.push({ text: String(content), joinable: true });
    return;
  }
  const block = content as Record<string, unknown>;
  if (block.type === "thinking") {
    if (typeof block.thinking === "string" && block.thinking) {
      out.push({ text: block.thinking, joinable: false });
    }
    return;
  }
  if (block.type === "redacted_thinking") return;
  if (typeof block.text === "string") {
    if (block.text) out.push({ text: block.text, joinable: true });
    return;
  }
  try {
    const json = JSON.stringify(block);
    if (json) out.push({ text: json, joinable: false });
  } catch {
    // unserializable block contributes nothing, matching contentChars
  }
}

/** The rendered text pieces of a content field, in order. */
function contentTextPieces(content: unknown, out: string[]): void {
  const segments: TextSegment[] = [];
  contentTextSegments(content, segments);
  for (const segment of segments) out.push(segment.text);
}

/**
 * The text pieces of one message's content, grouped into runs of ADJACENT
 * joinable pieces: consecutive plain-text pieces with nothing rendered
 * between them form one run, while thinking text and JSON-serialized blocks
 * each stand alone and break adjacency on both sides. A run's pieces
 * concatenate to the contiguous passage the model would read, which is where
 * an echo fragmented across text-block boundaries becomes visible again.
 */
function contentTextRuns(content: unknown): string[][] {
  const segments: TextSegment[] = [];
  contentTextSegments(content, segments);
  const runs: string[][] = [];
  let current: string[] | null = null;
  for (const segment of segments) {
    if (segment.joinable) {
      if (!current) {
        current = [];
        runs.push(current);
      }
      current.push(segment.text);
    } else {
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

/** A span [start, end) of a run text already charged as echo. */
interface EchoSpan {
  start: number;
  end: number;
}

/** Whether [start, end) intersects any charged span. */
function overlapsEchoSpan(
  spans: EchoSpan[],
  start: number,
  end: number
): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

/** The nearest charged-span start at or after pos: the forward-extension cap. */
function nextEchoSpanStart(
  spans: EchoSpan[],
  pos: number,
  fallback: number
): number {
  let cap = fallback;
  for (const s of spans) if (s.start >= pos && s.start < cap) cap = s.start;
  return cap;
}

/** The nearest charged-span end at or before pos: the backward-extension floor. */
function prevEchoSpanEnd(spans: EchoSpan[], pos: number): number {
  let floor = 0;
  for (const s of spans) if (s.end <= pos && s.end > floor) floor = s.end;
  return floor;
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
 * The scan catches whole, truncated, framed, and framed+truncated echoes; a
 * copy truncated at BOTH ends and framed (neither probe present) is the one
 * shape it concedes, traded for staying O(runText x pieces) with no regexes
 * over untrusted text. Run texts and turn pieces shorter than
 * ECHO_MIN_PIECE_CHARS never participate, and because every charged span
 * contains a full 32-char probe, no match shorter than the floor ever counts.
 */
function echoedCharsInRunText(
  runText: string,
  turnText: string,
  turnPieces: string[]
): number {
  if (runText.length < ECHO_MIN_PIECE_CHARS) return 0;
  if (turnText.includes(runText)) return runText.length;

  const charged: EchoSpan[] = [];
  let echoed = 0;
  for (const piece of turnPieces) {
    if (piece.length < ECHO_MIN_PIECE_CHARS) continue;

    // Head probe: a hit aligns runText[hit] with piece[0]; extend forward.
    const headProbe = piece.slice(0, ECHO_MIN_PIECE_CHARS);
    for (let from = 0; ; ) {
      const hit = runText.indexOf(headProbe, from);
      if (hit === -1) break;
      const probeEnd = hit + ECHO_MIN_PIECE_CHARS;
      if (overlapsEchoSpan(charged, hit, probeEnd)) {
        from = hit + 1;
        continue;
      }
      const cap = nextEchoSpanStart(charged, probeEnd, runText.length);
      let end = probeEnd;
      let p = ECHO_MIN_PIECE_CHARS;
      while (
        end < cap &&
        p < piece.length &&
        runText.charCodeAt(end) === piece.charCodeAt(p)
      ) {
        end += 1;
        p += 1;
      }
      echoed += end - hit;
      charged.push({ start: hit, end });
      from = end;
    }

    // Tail probe: a hit aligns runText[hit + 32] with the piece's end; extend
    // backward. Catches front-truncated copies, whose head never appears.
    const tailProbe = piece.slice(piece.length - ECHO_MIN_PIECE_CHARS);
    for (let from = 0; ; ) {
      const hit = runText.indexOf(tailProbe, from);
      if (hit === -1) break;
      const end = hit + ECHO_MIN_PIECE_CHARS;
      if (overlapsEchoSpan(charged, hit, end)) {
        from = hit + 1;
        continue;
      }
      const floor = prevEchoSpanEnd(charged, hit);
      let start = hit;
      let p = piece.length - ECHO_MIN_PIECE_CHARS;
      while (
        start > floor &&
        p > 0 &&
        runText.charCodeAt(start - 1) === piece.charCodeAt(p - 1)
      ) {
        start -= 1;
        p -= 1;
      }
      echoed += end - start;
      charged.push({ start, end });
      from = end;
    }
  }
  return echoed;
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
function echoedCurrentTurnChars(
  result: CompressResult,
  currentTurnContent: unknown
): number {
  const turnPieces: string[] = [];
  contentTextPieces(currentTurnContent, turnPieces);
  if (turnPieces.length === 0) return 0;
  const turnText = turnPieces.join("");

  let echoed = 0;
  for (const message of result.messages ?? []) {
    if (message.role === "system") continue;
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
export function checkCompressedHistory(
  result: CompressResult,
  sentMessages: Message[],
  minRetainedChars: number = MIN_RETAINED_HISTORY_CHARS
): CompressedHistoryCheck {
  const nonSystem = sentMessages.filter((m) => m.role !== "system");
  const currentTurnContent = nonSystem.length
    ? nonSystem[nonSystem.length - 1]!.content
    : undefined;
  const currentTurn = contentChars(currentTurnContent);
  const priorHistoryChars = Math.max(
    0,
    conversationChars(sentMessages) - currentTurn
  );
  const retainedChars = conversationChars(result.messages);
  const echoedChars = echoedCurrentTurnChars(result, currentTurnContent);
  // Nothing meaningful to lose: a short conversation legitimately compresses to
  // roughly itself, and passing it through would be pointless churn.
  const usable =
    priorHistoryChars < minRetainedChars ||
    retainedChars - echoedChars >= minRetainedChars;
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
export function normalizeMessagesForMemtree(messages: Message[]): Message[] {
  const normalized: Message[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      normalized.push(message);
      continue;
    }

    let changed = false;
    let removedReasoning = false;
    const content: unknown[] = [];
    for (const part of message.content) {
      if (!isReasoningBlock(part)) {
        content.push(part);
        continue;
      }
      changed = true;
      removedReasoning = true;
    }

    if (removedReasoning && content.length === 0) continue;
    normalized.push(changed ? { ...message, content } : message);
  }
  return normalized;
}

function isReasoningBlock(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ((value as Record<string, unknown>).type === "thinking" ||
      (value as Record<string, unknown>).type === "redacted_thinking")
  );
}

export class MemtreeClient {
  private baseUrl: string;
  private apiKey: string;
  private compressTimeoutMs: number;
  private debug: boolean;
  private reqlog: RequestLogSink | undefined;
  /** messages-hash → in-flight/settled compression promise (retry dedupe). */
  private compressCache = new Map<string, Promise<CompressResult | null>>();
  /** messages-hashes already submitted for background indexing. */
  private indexedHashes = new Set<string>();
  /** In-flight index-only calls, tracked so shutdown cannot outrun their logs. */
  private backgroundIndexes = new Map<Promise<void>, AbortController>();
  /** Once draining begins, no later request may create another log producer. */
  private backgroundClosing = false;
  /** FastAPI `detail` text from the most recent 402, or null while paid. */
  private unpaidDetail: string | null = null;

  /**
   * Non-null when the server last answered 402 (unpaid MemTree key): the
   * server's human-readable detail text. Set by both compression and
   * background-indexing calls; cleared by any subsequent success.
   */
  get paymentRequiredDetail(): string | null {
    return this.unpaidDetail;
  }

  /**
   * The blocking-compress abort budget. Exposed so the proxy's request log
   * can label a failed compress that consumed (roughly) the whole budget as a
   * timeout rather than a fast server error.
   */
  get compressBudgetMs(): number {
    return this.compressTimeoutMs;
  }

  constructor(opts: MemtreeOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.compressTimeoutMs =
      opts.compressTimeoutMs ??
      Number(process.env.CCC_COMPRESS_TIMEOUT_MS || DEFAULT_COMPRESS_TIMEOUT_MS);
    this.debug = opts.debug ?? false;
    this.reqlog = opts.reqlog;
  }

  static hashMessages(messages: Message[]): string {
    return createHash("sha256")
      .update(JSON.stringify(messages))
      .digest("hex");
  }

  /**
   * Blocking user-turn compression. Returns null on ANY failure (timeout,
   * network, 4xx/5xx including 402) — the caller must degrade to passthrough.
   * On 402 the failure is additionally recorded in paymentRequiredDetail so
   * the caller can distinguish "unpaid" from "outage".
   */
  compress(
    hash: string,
    messages: Message[],
    modelContextLimit: number,
    signal?: AbortSignal,
    meta?: CompressRequestMeta
  ): Promise<CompressResult | null> {
    const cached = this.compressCache.get(hash);
    if (cached) return cached;

    const promise = this.callContextMemory(messages, modelContextLimit, {
      timeoutMs: this.compressTimeoutMs,
      signal,
      model: meta?.model,
      tools: meta?.tools,
    }).catch((err) => {
      this.log(`compression failed: ${err?.message ?? err}`);
      // Don't cache failures — drop the entry so retries (e.g. Claude Code's
      // automatic retry of an identical request) hit the server again.
      if (this.compressCache.get(hash) === promise) {
        this.compressCache.delete(hash);
      }
      return null;
    });

    this.remember(hash, promise);
    return promise;
  }

  /**
   * Fire-and-forget background indexing for tool turns. Keeps the server index
   * fed during tool loops; adds zero latency to the response path.
   */
  indexInBackground(
    hash: string,
    messages: Message[],
    modelContextLimit: number
  ): void {
    if (this.backgroundClosing) return;
    if (this.indexedHashes.has(hash)) return;
    this.indexedHashes.add(hash);
    if (this.indexedHashes.size > DEDUPE_CACHE_MAX) {
      const first = this.indexedHashes.values().next().value;
      if (first !== undefined) this.indexedHashes.delete(first);
    }

    const stripped = stripCcSystemReminders(messages);
    const controller = new AbortController();
    const operation = this.callContextMemory(stripped, modelContextLimit, {
      timeoutMs: INDEX_TIMEOUT_MS,
      indexOnly: true,
      signal: controller.signal,
    })
      .then(
        () => undefined,
        (err) => {
          this.log(`background indexing failed (ignored): ${err?.message ?? err}`);
        }
      )
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
  async drainBackground(timeoutMs = 2_000): Promise<boolean> {
    this.backgroundClosing = true;
    if (this.backgroundIndexes.size === 0) return true;

    const boundedMs =
      Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : 2_000;
    const pending = [...this.backgroundIndexes.keys()];
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (completed) return true;

    for (const controller of this.backgroundIndexes.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.backgroundIndexes.keys()]);
    return false;
  }

  private remember(hash: string, promise: Promise<CompressResult | null>) {
    this.compressCache.set(hash, promise);
    if (this.compressCache.size > DEDUPE_CACHE_MAX) {
      const first = this.compressCache.keys().next().value;
      if (first !== undefined) this.compressCache.delete(first);
    }
  }

  private async callContextMemory(
    messages: Message[],
    modelContextLimit: number,
    opts: {
      timeoutMs: number;
      indexOnly?: boolean;
      signal?: AbortSignal;
      model?: string;
      tools?: unknown[];
    }
  ): Promise<CompressResult | null> {
    const body: Record<string, unknown> = {
      messages,
      model_context_limit: modelContextLimit,
    };
    // Server may ignore this until the index-only endpoint mode ships
    // (plan Phase 2.2); harmless extra field either way.
    if (opts.indexOnly) body.index_only = true;
    // Model (and tools, whose serialized size feeds the same budget) let the
    // server resolve a model-based memory budget instead of its static 50k
    // fallback. Only meaningful on compression calls: the server's index_only
    // path returns before budget resolution, so indexing calls skip both and
    // save the upload bytes (tools schemas run tens of KB per call).
    if (!opts.indexOnly) {
      if (opts.model) body.model = opts.model;
      if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
    }
    const payload = JSON.stringify(body);

    const started = Date.now();
    let status: number | undefined;
    let ok = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, opts.timeoutMs);
    timeout.unref();
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
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
        throw new Error(
          `context_memory ${response.status}: ${text.slice(0, 300)}`
        );
      }

      const json = (await response.json()) as CompressResult;
      if (!Array.isArray(json.messages) || json.messages.length === 0) {
        throw new Error("context_memory returned no messages");
      }
      const clientLatencyMs = Date.now() - started;
      this.unpaidDetail = null; // a success proves the key is paid (again)
      ok = true;
      this.log(
        `context_memory ok in ${clientLatencyMs}ms ` +
          `(${messages.length} → ${json.messages.length} messages` +
          `${opts.indexOnly ? ", index-only" : ""})`
      );
      return { ...json, clientLatencyMs };
    } finally {
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
      });
    }
  }

  private log(msg: string) {
    if (this.debug) console.error(`[ccc proxy] ${msg}`);
  }
}

/** 402 bodies are FastAPI JSON: {"detail": "<human-readable payment text>"}. */
function extract402Detail(bodyText: string): string {
  try {
    const detail = JSON.parse(bodyText)?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  } catch {
    // non-JSON 402 body — fall through to the generic text
  }
  return "Payment required";
}
