/**
 * Claude Code Infinite local proxy (plans/2026-06-09_PLAN_local_proxy_app.md,
 * refined by plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 *
 * Claude Code points ANTHROPIC_BASE_URL at this 127.0.0.1 server. We never
 * read, store, or refresh credentials: Claude Code keeps its native login and
 * sends its own OAuth bearer here, and we forward its headers and query string
 * verbatim to api.anthropic.com (the anthropic-beta flag list churns across CC
 * versions — never reconstruct it). Only the `messages` body is ever altered
 * (compression, plus defensive removal of legacy notice markers);
 * auth, identity, and routing are never touched.
 *
 * Turn classification for POST /v1/messages:
 * - Tool turn (last message isn't a real user input): background indexing,
 *   forward as-is — either riding its lane's memory route (routes live in a
 *   small map keyed by request identity: session + main/away/agent-id) or
 *   verbatim. A miss buys ONE best-effort blocking recompression per lane
 *   per epoch, any size (plans/2026-08-04_PLAN_tool_turn_route_recovery.md,
 *   plans/2026-08-08_PLAN_route_parity_simple.md); failure degrades to the
 *   verbatim forward. Every identity installs into its own lane — isolation
 *   is structural, not defended.
 * - First user turn (no earlier real user input): background indexing, forward
 *   as-is — nothing is indexed yet, so blocking would be a guaranteed no-op.
 * - Followup user turn: blocking compress + substitute. In CLI A/B mode, a
 *   compact request below the effective-context gate uses memory directly;
 *   above the gate, the proxy starts memory and full-history SSE legs, grades
 *   their semantic prefixes, commits the in-flight winner, and aborts the
 *   loser. A memory winner remains the prefix for that turn's tool loop.
 * - MemTree failure/timeout degrades to passthrough. A display-only success
 *   notice is queued only when the memory response is selected AND MemTree's
 *   index coverage grew since the last announcement (unchanged coverage means
 *   the turn was appended after an index that learned nothing new); degraded
 *   and unpaid states get their own notices.
 *
 * Every /v1/messages and count_tokens body is run through the legacy notice
 * strip pass before hashing/forwarding. Live notices use Claude Code hooks and
 * selected upstream response bytes pass through unchanged in the default
 * buffered mode. Explicit speculative mode performs documented SSE surgery.
 */

import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import type { Transform } from "node:stream";
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  abGateDecision,
  buildFusionGraderBody,
  extractUnfoldedMemory,
  GRADING_TRUNCATION_MARKER,
  parseFusionVerdictResponse,
  resolveAbRoutingOptions,
  winnerForVerdict,
  type AbGradeInput,
  type AbRoutingOptions,
  type AbWinner,
  type FusionVerdict,
  type ResolvedAbRoutingOptions,
} from "./ab-routing.js";
import {
  cachedPromptTokenCount,
  checkCompressedHistory,
  didMemtreeCompress,
  MemtreeClient,
  normalizeMessagesForMemtree,
  unindexedPromptTokenCount,
  type CompressResult,
} from "./memtree.js";
import {
  contextLimitForModel,
  flattenToSingleUserMessage,
  hasEarlierNonToolUserMessage,
  isAwaySummaryUserMessage,
  isLocalBashCommandTurn,
  isNonToolUserMessage,
  isToolResultUserMessage,
  lastNonSystemMessage,
  messagesWithSystem,
  modelForMemtree,
  stripSystemReminderText,
  userMessageText,
  type Message,
} from "./turns.js";
import {
  COMPRESSED_NOTICE,
  DEGRADED_NOTICE,
  FULL_HISTORY_OVERRIDE_NOTICE,
  PAYMENT_REQUIRED_NOTICE,
  RECOVERED_NOTICE,
  SseNoticeRewriter,
  sanitizeNoticeDetail,
  stripNoticeBlocks,
  stripNoticeSystem,
} from "./notices.js";
import {
  RECOVERY_BRIDGE_TEXT,
  SseEventForwarder,
  SseSpliceWriter,
  bridgeBlockEvents,
  contentBlockStopEvent,
} from "./splice.js";
import {
  NoticeDeliveryQueue,
  parseNoticeHookInput,
} from "./hooks.js";
import {
  approxTokensFromBytes,
  mergeUsageFromJsonBody,
  mergeUsageFromSseEvent,
  type MessagesRecord,
  type ComparisonDelivered,
  type ComparisonInterrupt,
  type ComparisonLegRecord,
  type GraderDiagnostic,
  type RequestLogSink,
  type TurnType,
  type UsageRecord,
} from "./reqlog.js";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const HOOK_BODY_LIMIT = 64 * 1024;
const NOTICE_SETTLE_WAIT_MS = 1_000;
const LEGACY_PROBE_UNINDEXED_TOKENS = 10_000;
const LEGACY_MIGRATION_SESSIONS_MAX = 64;
// After a recovery attempt returns null (MemTree down, 5xx, or a burned
// timeout budget), suppress the blocking attempt for this long. The followup
// path pays a failed compress at most once per HUMAN turn; the fuse sits on
// the tool loop and would otherwise pay it once per TOOL turn — and history
// grows every turn, so compress()'s hash dedup never absorbs the repeat.
// Long enough that a real outage costs one stall, short enough that a
// transient blip does not disable recovery for a working session.
const TOOL_RECOVERY_FAILURE_COOLDOWN_MS = 60_000;

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "content-length", // recomputed for buffered/modified bodies
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

// Speculative SSE delivery can splice a second response into the first, so
// upstream representation metadata is no longer valid for the bytes sent to
// the client. In particular, retaining content-length disables Node's
// chunked framing and can truncate the splice at the original leg's length.
const SKIP_TRANSFORMED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-range",
  "content-md5",
  "content-digest",
  "repr-digest",
  "digest",
  "etag",
  "trailer",
]);

export interface ProxyOptions {
  memtree: MemtreeClient;
  /**
   * Treat current native-1M Anthropic model ids as 1M without requiring the
   * legacy context-1m beta header. Defaults to true. Set false only when the
   * client deliberately disables native 1M context.
   */
  nativeOneMillionContext?: boolean;
  /**
   * Live with-memory vs full-history routing. Omit to retain the legacy
   * single-memory-leg path (useful to embedders/tests); the CLI enables it.
   */
  abRouting?: AbRoutingOptions;
  /**
   * Best-effort blocking recompression when a large main tool turn misses
   * its memory route (default true). This is a soft recovery fuse, not a
   * hard payload cap: MemTree failure still degrades to forwarding the
   * original body after the configured compress budget. The CLI maps
   * `CCC_TOOL_ROUTE_RECOVERY=0` to `false` as a temporary kill switch.
   */
  toolRouteRecovery?: boolean;
  debug?: boolean;
  /**
   * Always-on request/timing JSONL log (see reqlog.ts). Includes messages,
   * MemTree calls, and successful notice claims; omitted means no logging.
   */
  reqlog?: RequestLogSink;
  /** Test-only: forward to this origin instead of api.anthropic.com. */
  upstreamOrigin?: string;
  /** Test-only: dump each forwarded /v1/messages body to this directory. */
  captureDir?: string;
}

export interface RunningProxy {
  port: number;
  /** Random per-process endpoint used by the ephemeral Claude plugin. */
  hookUrl: string;
  close: () => void;
  /**
   * Stop accepting work and give active requests a bounded grace period.
   * On expiry, every accepted request and upstream is cancelled, then request
   * finalizers are awaited; false reports that forced cancellation was needed.
   */
  drain: (timeoutMs?: number) => Promise<boolean>;
}

interface Upstream {
  module: typeof http | typeof https;
  host: string;
  port: number;
}

/** Per-server mutable state (one server per ccc process). */
interface ProxyState {
  /** Set only when a hook actually claims the payment notice for display. */
  paymentNoticeShown: boolean;
  notices: NoticeDeliveryQueue;
  /** Armed only by a main-thread UserPromptSubmit hook. */
  mainPromptArmed: boolean;
  mainPromptId?: string;
  mainPromptText?: string;
  /**
   * True once the armed prompt's compressible main request has been fully
   * delivered downstream. The display arm is consumed before forwarding, but
   * Claude Code retries transient upstream failures (500/529) with the
   * identical body — recovery-turn classification must survive that retry, so
   * it corroborates with mainPromptText until delivery actually succeeds.
   */
  mainPromptDelivered: boolean;
  mainPromptGeneration: number;
  /** Matching Stop waits briefly for this response's final notice decision. */
  mainNoticeDelivery?: MainNoticeDelivery;
  /** Suppress producer-side state changes while agent API traffic is active. */
  activeSubagents: Set<string>;
  /** Resolved once at startup; absent means single-leg legacy behavior. */
  abRouting?: ResolvedAbRoutingOptions;
  /**
   * Memory winners carried through the current human turn's tool loops, one
   * lane per request identity (routeIdentity). LRU-bounded to
   * MEMORY_ROUTE_MAX_LANES; entries with a stale routeEpoch are dropped on
   * access, and every epoch bump clears the whole map — a new human turn ends
   * the previous turn's subagents too.
   */
  memoryRoutes: Map<string, MemoryRoute>;
  /**
   * Index coverage (MemTree `cached_tokens`) observed on the last compression
   * this session displayed a notice for. Only a turn whose coverage GREW
   * indexed newer messages; equal coverage means MemTree re-unfolded the same
   * index behind the current question and appended this turn verbatim, which
   * is not something to announce.
   *
   * Coverage, not the rendered memory text, is the signal: the server unfolds
   * the index per question (expanding the sections relevant to it), so the
   * memory message differs byte-wise on nearly every turn even when nothing
   * new was indexed.
   */
  lastNoticedIndexCoverage?: { sessionId?: string; indexedTokens: number };
  /**
   * Conversations whose stable normalized MemTree history has caught up with
   * the legacy shape. Scoped per session/conversation: the probe leg itself
   * warms a legacy index server-side, so a fresh post-upgrade conversation
   * can manufacture "legacy evidence" that proves nothing about a deep
   * pre-upgrade session /resume'd later in the same process. Insertion-order
   * bounded; evicting an entry merely re-opens that session's probe.
   */
  legacyMemtreeMigrationComplete: Set<string>;
  /** Monotonic guard against stale async routing decisions, hooks or no hooks. */
  mainRouteEpoch: number;
  /**
   * Orders async route decisions that share one epoch. The epoch guards
   * human-prompt lifecycle (UserPromptSubmit/Stop bump it); this generation is
   * reserved by every request that may asynchronously install or clear its
   * lane after an await — every followup, plus a route-owning tool-route
   * recovery. An install or post-await clear whose captured
   * generation is stale must do nothing, so an older completion can never
   * erase or overwrite a newer decision.
   */
  mainRouteDecisionGeneration: number;
  /**
   * Reservations taken from mainRouteDecisionGeneration that still block older
   * holders, keyed by route lane: in-flight decisions, plus committed ones (an
   * install or a clear keeps its reservation forever so a slower older
   * decision can never overwrite it). A decision that ends up mutating nothing
   * removes itself.
   *
   * Keyed per lane so ordering only applies where writers actually contend: a
   * subagent recovery's reservation must never mark a concurrent main
   * followup's install stale — they write different entries. Within one lane,
   * followups and recoveries all reserve so reverse-order async completions
   * cannot overwrite the newest decision.
   *
   * A set rather than "newest wins" on the counter alone, because releases can
   * arrive out of order: with reservations 6 and 7 live, 6 finishing first
   * cannot move a counter that reads 7, so its slot would leak and strand
   * every older holder permanently. Bounded by clearing it on each epoch bump,
   * where every surviving entry is already epoch-stale.
   */
  routeDecisionsLive: Map<string, Set<number>>;
  /**
   * Route lanes that have spent their one blocking recompression attempt this
   * epoch. Replaces the old 400KiB byte gate with the budget main already
   * lives by: the followup path pays exactly one blocking compress per human
   * turn, so every lane gets the same self-limiting deal. Cleared alongside
   * memoryRoutes on every epoch bump.
   */
  toolRecoveryAttemptedLanes: Set<string>;
  /**
   * Epoch-ms deadline until which tool-route miss recovery skips its blocking
   * attempt, set when an attempt returns null. Zero means no cooldown.
   */
  toolRecoveryCooldownUntil: number;
  /** Fired by drain after its grace period so every forwarding path can stop. */
  shutdownSignal: AbortSignal;
}

interface MainNoticeDelivery {
  promptGeneration: number;
  promptId?: string;
  pending: number;
  /** The selected memory response ended upstream, so first display may wait briefly. */
  firstDisplayCanWait: boolean;
  settled: Promise<void>;
  resolve: () => void;
}

function beginMainNoticeDelivery(
  state: ProxyState,
  promptGeneration: number,
  promptId: string | undefined
): MainNoticeDelivery {
  const current = state.mainNoticeDelivery;
  if (
    current &&
    current.promptGeneration === promptGeneration &&
    current.promptId === promptId
  ) {
    current.pending++;
    return current;
  }
  cancelMainNoticeDelivery(state);
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  const delivery: MainNoticeDelivery = {
    promptGeneration,
    promptId,
    pending: 1,
    firstDisplayCanWait: false,
    settled,
    resolve,
  };
  state.mainNoticeDelivery = delivery;
  return delivery;
}

function settleMainNoticeDelivery(
  state: ProxyState,
  delivery: MainNoticeDelivery
): void {
  if (delivery.pending > 0) delivery.pending--;
  if (delivery.pending !== 0) return;
  delivery.resolve();
  if (state.mainNoticeDelivery === delivery) {
    state.mainNoticeDelivery = undefined;
  }
}

function cancelMainNoticeDelivery(state: ProxyState): void {
  const delivery = state.mainNoticeDelivery;
  if (!delivery) return;
  state.mainNoticeDelivery = undefined;
  delivery.pending = 0;
  delivery.resolve();
}

async function waitForMainNoticeDelivery(
  state: ProxyState,
  promptId: string | undefined
): Promise<void> {
  const delivery = state.mainNoticeDelivery;
  if (
    !delivery ||
    (delivery.promptId !== undefined &&
      promptId !== undefined &&
      delivery.promptId !== promptId)
  ) {
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  let onShutdown: (() => void) | undefined;
  try {
    await Promise.race([
      delivery.settled,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, NOTICE_SETTLE_WAIT_MS);
      }),
      new Promise<void>((resolve) => {
        onShutdown = () => resolve();
        state.shutdownSignal.addEventListener("abort", onShutdown, {
          once: true,
        });
        if (state.shutdownSignal.aborted) onShutdown();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onShutdown) {
      state.shutdownSignal.removeEventListener("abort", onShutdown);
    }
  }
}

interface MemoryRoute {
  sessionId: string;
  originalSystemHash: string;
  originalPrefixHashes: string[];
  compressedMessages: Message[];
  compressedSystem: unknown;
  hasCompressedSystem: boolean;
  routeEpoch: number;
}

/**
 * Bound on concurrently held route lanes. A route entry is 0.4–4 MB of heap;
 * 8 is generous for one session's fan-out (main + away + a handful of live
 * subagents) and the cap is enforced by LRU eviction, not assumed.
 */
const MEMORY_ROUTE_MAX_LANES = 8;

type RouteLane = "main" | "away" | "agent";

/**
 * The agent id a request is attributed by, preferring its own id over its
 * parent's. Absence of both is the definition of main-thread attribution, so
 * hasAgentAttribution is this same extraction asked as a yes/no question.
 */
function agentAttributionId(
  req: http.IncomingMessage
): string | undefined {
  return (
    firstNonEmptyHeader(req, "x-claude-code-agent-id") ??
    firstNonEmptyHeader(req, "x-claude-code-parent-agent-id")
  );
}

/**
 * Collision-free identity of a memory-route lane: the label the reqlog reports
 * and the key every map is addressed by, classified once from the same headers
 * so the two can never disagree. The tuple tags reserved main/away lanes
 * separately from agent ids, so an agent literally named "main" or "away"
 * cannot alias either reserved lane; JSON array encoding also prevents
 * delimiter collisions between arbitrary session and agent headers.
 * Keying by identity is what makes lane isolation structural: a request can
 * only ever reach its own lane, so foreign-route defense is unnecessary rather
 * than implemented.
 */
function routeIdentity(
  req: http.IncomingMessage,
  isAwaySummary: boolean
): { lane: RouteLane; key: string } {
  const session = requestSessionId(req) ?? "";
  const agent = agentAttributionId(req);
  if (isAwaySummary) {
    return { lane: "away", key: JSON.stringify([session, "away"]) };
  }
  if (agent) {
    return { lane: "agent", key: JSON.stringify([session, "agent", agent]) };
  }
  return { lane: "main", key: JSON.stringify([session, "main"]) };
}

function firstNonEmptyHeader(
  req: http.IncomingMessage,
  name: string
): string | undefined {
  const value = req.headers[name];
  const text = Array.isArray(value)
    ? value.find((item) => item.trim() !== "")
    : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/**
 * Close the current route epoch and open the next one, returning the new
 * epoch. Everything keyed to the epoch just superseded goes with it: every
 * surviving reservation belongs to that closed epoch and can no longer hold
 * anything, and a new human turn ends the previous turn's subagents too, so
 * every lane's route and spent-recovery mark is dropped rather than
 * selectively pruned. Doing all of it here is what makes the sets' documented
 * bound ("cleared on each epoch bump") true at every bump site rather than
 * only at the followup one.
 */
function bumpRouteEpoch(state: ProxyState): number {
  const epoch = ++state.mainRouteEpoch;
  state.routeDecisionsLive.clear();
  state.memoryRoutes.clear();
  state.toolRecoveryAttemptedLanes.clear();
  return epoch;
}

/**
 * Lane lookup with the two map invariants applied on every access: an entry
 * whose epoch is stale is dropped (a new human turn ended the previous turn's
 * subagents too), and a hit is re-inserted to keep Map iteration order the
 * LRU order that eviction in setMemoryRoute relies on.
 */
function getMemoryRoute(
  state: ProxyState,
  key: string
): MemoryRoute | undefined {
  const route = state.memoryRoutes.get(key);
  if (!route) return undefined;
  if (route.routeEpoch !== state.mainRouteEpoch) {
    state.memoryRoutes.delete(key);
    return undefined;
  }
  state.memoryRoutes.delete(key);
  state.memoryRoutes.set(key, route);
  return route;
}

function setMemoryRoute(
  state: ProxyState,
  key: string,
  route: MemoryRoute
): void {
  state.memoryRoutes.delete(key);
  state.memoryRoutes.set(key, route);
  while (state.memoryRoutes.size > MEMORY_ROUTE_MAX_LANES) {
    const oldest = state.memoryRoutes.keys().next().value;
    if (oldest === undefined) break;
    state.memoryRoutes.delete(oldest);
  }
}

function resolveUpstream(opts: ProxyOptions): Upstream {
  const url = new URL(opts.upstreamOrigin ?? DEFAULT_UPSTREAM);
  const secure = url.protocol === "https:";
  return {
    module: secure ? https : http,
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
  };
}

function shouldProbeLegacyMemtree(
  result: CompressResult,
  sentMessages: Message[]
): boolean {
  if (!didMemtreeCompress(result)) return true;
  // An index that covers everything but returns nothing scores a perfect tail.
  // Probe on lost content too, or the emptiest answer ends the migration.
  if (!checkCompressedHistory(result, sentMessages).usable) return true;
  const unindexedTokens = unindexedPromptTokenCount(result);
  // A server that omits raw_prompt_tokens gives no tail evidence at all; the
  // absence of a measurement must not count as a caught-up index and end the
  // migration. Keep probing until the tail is actually measured small.
  if (unindexedTokens === undefined) return true;
  return unindexedTokens > LEGACY_PROBE_UNINDEXED_TOKENS;
}

/**
 * Migration state is scoped per conversation, not per process — and not per
 * session either: subagent requests carry the SAME session header as the main
 * thread, so agent attribution is folded into the key. Otherwise a subagent's
 * shallow legacy index losing its contest within a couple of turns would mark
 * the shared session complete and permanently skip the probe for the main
 * conversation's much deeper, never-contested legacy index. Without the
 * session header the key falls back to the conversation's own content hash.
 * (Client-side compaction changes that fallback key, which merely re-opens
 * probing — the safe direction.)
 */
function legacyMigrationKey(
  req: http.IncomingMessage,
  messages: Message[]
): string {
  const agentId = headerText(req.headers, "x-claude-code-agent-id").trim();
  // A request attributed only via x-claude-code-parent-agent-id is still not
  // the main thread (hasAgentAttribution accepts either header), and the
  // parent id would conflate sibling subagents; scope such requests by their
  // own conversation content instead of ever mapping them to "main".
  const agent = agentId
    ? `id:${agentId}`
    : hasAgentAttribution(req)
      ? `conv:${conversationContentKey(messages)}`
      : "main";
  const sessionId = requestSessionId(req);
  if (sessionId) return `session:${sessionId}:agent:${agent}`;
  return `conversation:${conversationContentKey(messages)}:agent:${agent}`;
}

/**
 * Content-derived conversation identity for migration keying. messages[0]
 * alone collides across conversations that open with identical user text
 * ("hi"), so fold in messages[1] — the first assistant reply — when present.
 * Blocking compression runs on followup user turns and on tool-route miss
 * recovery, both of which are past the opening exchange, so messages[1]
 * exists on every keyed turn and is stable once written; the key therefore
 * stays identical across every turn of one conversation. Conversations whose
 * first user AND first assistant messages both match still share a key —
 * nothing later in the transcript is stable across turns (a message-count
 * bucket would change every turn and break stability), so that residual
 * collision is accepted: its cost is bounded at one conversation skipping
 * probes it might still have wanted.
 */
function conversationContentKey(messages: Message[]): string {
  if (messages.length === 0) return "empty";
  const first = routeMessageHash(messages[0]);
  return messages.length > 1
    ? `${first}:${routeMessageHash(messages[1])}`
    : first;
}

function markLegacyMigrationComplete(state: ProxyState, key: string): void {
  // Insertion-order bounded. Evicting the oldest session re-opens its probe
  // (one redundant compress), never the reverse.
  state.legacyMemtreeMigrationComplete.delete(key);
  state.legacyMemtreeMigrationComplete.add(key);
  if (state.legacyMemtreeMigrationComplete.size > LEGACY_MIGRATION_SESSIONS_MAX) {
    const oldest = state.legacyMemtreeMigrationComplete.values().next().value;
    if (oldest !== undefined) {
      state.legacyMemtreeMigrationComplete.delete(oldest);
    }
  }
}

function isBetterLegacyMemtreeResult(
  canonical: CompressResult,
  canonicalMessages: Message[],
  legacy: CompressResult,
  legacyMessages: Message[]
): boolean {
  if (!didMemtreeCompress(legacy)) return false;
  if (!didMemtreeCompress(canonical)) return true;
  // Retained conversation dominates tail size: a candidate that kept the
  // conversation always beats one that dropped it, however well it indexed.
  const canonicalUsable = checkCompressedHistory(
    canonical,
    canonicalMessages
  ).usable;
  const legacyUsable = checkCompressedHistory(legacy, legacyMessages).usable;
  if (canonicalUsable !== legacyUsable) return legacyUsable;
  const canonicalTail = unindexedPromptTokenCount(canonical);
  const legacyTail = unindexedPromptTokenCount(legacy);
  return (
    canonicalTail !== undefined &&
    legacyTail !== undefined &&
    legacyTail < canonicalTail
  );
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const upstream = resolveUpstream(opts);
  const hookPath = `/_ccc/hooks/${randomBytes(24).toString("hex")}`;
  const activeRequests = new Set<Promise<void>>();
  const acceptedRequests = new Set<{
    req: http.IncomingMessage;
    res: http.ServerResponse;
  }>();
  const shutdownAbort = new AbortController();
  const state: ProxyState = {
    paymentNoticeShown: false,
    notices: new NoticeDeliveryQueue(),
    mainPromptArmed: false,
    mainPromptDelivered: true,
    mainPromptGeneration: 0,
    activeSubagents: new Set(),
    memoryRoutes: new Map(),
    abRouting: opts.abRouting
      ? resolveAbRoutingOptions(opts.abRouting)
      : undefined,
    legacyMemtreeMigrationComplete: new Set(),
    mainRouteEpoch: 0,
    mainRouteDecisionGeneration: 0,
    routeDecisionsLive: new Map(),
    toolRecoveryAttemptedLanes: new Set(),
    toolRecoveryCooldownUntil: 0,
    shutdownSignal: shutdownAbort.signal,
  };
  const server = http.createServer((req, res) => {
    const accepted = { req, res };
    acceptedRequests.add(accepted);
    const task = handleRequest(req, res, opts, upstream, state, hookPath).catch(
      (err) => {
        try {
          sendAnthropicError(res, `local proxy error: ${err?.message ?? err}`);
        } catch {
          // A failed error response must not strand shutdown bookkeeping.
        }
      }
    );
    activeRequests.add(task);
    void task.then(
      () => {
        activeRequests.delete(task);
        acceptedRequests.delete(accepted);
      },
      () => {
        activeRequests.delete(task);
        acceptedRequests.delete(accepted);
      }
    );
    if (shutdownAbort.signal.aborted) cancelAcceptedRequest(accepted);
  });
  // Long-running SSE responses must not be cut by idle timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let closePromise: Promise<void> | undefined;
  const beginClose = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = new Promise((done) => {
      if (!server.listening) {
        done();
        return;
      }
      server.close(() => done());
    });
    return closePromise;
  };
  const drain = async (timeoutMs = 5_000): Promise<boolean> => {
    const boundedMs =
      Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : 5_000;
    const quiesced = (async () => {
      // Once close completes, every accepted request has entered the tracked
      // set. Some handlers intentionally outlive their downstream response
      // while a speculative shadow grade finishes.
      await beginClose();
      while (activeRequests.size > 0) {
        await Promise.allSettled([...activeRequests]);
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      quiesced.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (completed) return true;

    // The grace period protects useful in-flight delivery and late shadow
    // verdicts. Once it expires, signal every forwarding path first so each can
    // classify the close as proxy-owned, then tear down any request that was
    // still reading/dispatching before it installed a path-specific listener.
    shutdownAbort.abort();
    for (const accepted of acceptedRequests) cancelAcceptedRequest(accepted);
    await quiesced;
    return false;
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        hookUrl: `http://127.0.0.1:${port}${hookPath}`,
        close: () => {
          void beginClose();
        },
        drain,
      });
    });
  });
}

/** Final safety net for handlers that have not reached an upstream path yet. */
function cancelAcceptedRequest(accepted: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
}): void {
  const { req, res } = accepted;
  if (!req.complete && !req.destroyed) {
    // A pass-through upload may not otherwise have an IncomingMessage error
    // listener; consume this proxy-owned teardown error after body readers see it.
    req.once("error", () => {});
    req.destroy(new Error("proxy shutdown"));
  }
  if (!res.destroyed && !res.writableEnded) res.destroy();
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream,
  state: ProxyState,
  hookPath: string
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (url.pathname === hookPath) {
    return handleNoticeHook(req, res, state, opts.reqlog);
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handleMessages(req, res, opts, upstream, state);
  }
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return handleCountTokens(req, res, opts, upstream, state);
  }
  return passThroughStreaming(req, res, upstream, state.shutdownSignal);
}

/** Serve only validated Claude hook POSTs on the randomized localhost path. */
async function handleNoticeHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ProxyState,
  reqlog: RequestLogSink | undefined
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > HOOK_BODY_LIMIT) {
    res.writeHead(413);
    res.end();
    req.resume();
    return;
  }

  const raw = await readBody(req);
  if (raw.length > HOOK_BODY_LIMIT) {
    res.writeHead(413);
    res.end();
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw.toString("utf-8"));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const parsed = parseNoticeHookInput(input);
  if (!parsed) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (parsed.hook_event_name === "UserPromptSubmit") {
    if (parsed.agent_id === undefined) {
      cancelMainNoticeDelivery(state);
      state.mainPromptArmed = true;
      state.mainPromptId = parsed.prompt_id;
      state.mainPromptText = parsed.prompt;
      state.mainPromptDelivered = false;
      state.mainPromptGeneration++;
      bumpRouteEpoch(state);
      state.notices.clearForUserRequest();
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (parsed.hook_event_name === "SubagentStart") {
    state.activeSubagents.add(parsed.agent_id);
    res.writeHead(204);
    res.end();
    return;
  }
  if (parsed.hook_event_name === "SubagentStop") {
    state.activeSubagents.delete(parsed.agent_id);
    res.writeHead(204);
    res.end();
    return;
  }

  const hookPromptGeneration = state.mainPromptGeneration;
  const displayWaitsForNotice =
    parsed.hook_event_name === "MessageDisplay" &&
    parsed.agent_id === undefined &&
    parsed.index === 0 &&
    state.mainNoticeDelivery?.firstDisplayCanWait === true &&
    (state.mainNoticeDelivery.promptId === undefined ||
      parsed.prompt_id === undefined ||
      state.mainNoticeDelivery.promptId === parsed.prompt_id);
  if (displayWaitsForNotice) {
    await waitForMainNoticeDelivery(state, parsed.prompt_id);
  }
  const stopMatchesMainPrompt =
    parsed.hook_event_name === "Stop" &&
    parsed.agent_id === undefined &&
    (state.mainPromptId === undefined ||
      parsed.prompt_id === undefined ||
      state.mainPromptId === parsed.prompt_id);
  if (stopMatchesMainPrompt) {
    await waitForMainNoticeDelivery(state, parsed.prompt_id);
  }
  // UserPromptSubmit can run while a display or Stop hook awaits the prior
  // response. Never let that old hook consume or clear the newer prompt's state.
  const stopStillMatches =
    stopMatchesMainPrompt &&
    state.mainPromptGeneration === hookPromptGeneration;
  const displayStillMatches =
    !displayWaitsForNotice ||
    state.mainPromptGeneration === hookPromptGeneration;
  const output =
    (parsed.hook_event_name === "Stop" && !stopStillMatches) ||
    !displayStillMatches
      ? null
      : state.notices.claim(parsed);
  if (stopStillMatches) {
    cancelMainNoticeDelivery(state);
    state.mainPromptArmed = false;
    state.mainPromptId = undefined;
    state.mainPromptText = undefined;
    state.mainPromptDelivered = true;
    // Invalidate a response that did not settle within the bounded hook wait.
    // Otherwise its late callback could enqueue a notice after Stop returned.
    state.mainPromptGeneration++;
    bumpRouteEpoch(state);
    // A normal main Stop means all child work for the turn has settled. Clear
    // stale lifecycle entries left by a missed SubagentStop hook.
    state.activeSubagents.clear();
  }
  if (!output) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (
    parsed.hook_event_name === "MessageDisplay" ||
    parsed.hook_event_name === "Stop"
  ) {
    try {
      reqlog?.log({
        kind: "notice",
        event: "claimed",
        via: parsed.hook_event_name,
      });
    } catch {
      // Custom/test loggers get RequestLogger's never-break-hook policy.
    }
  }
  const body = Buffer.from(JSON.stringify(output), "utf-8");
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Hook-prompt correlation: true only when the armed typed prompt appears as a
 * deliberate top-level text block of the user message — the whole block, or
 * its start/end (Claude Code may append/prepend ambient text around a merged
 * queued prompt). Matching runs on reminder-stripped block text so a
 * coincidental substring inside an appended <system-reminder> (or buried
 * mid-sentence in unrelated text) can never claim or consume the arm.
 */
function messageCarriesPromptText(
  message: Message | undefined | null,
  promptText: string
): boolean {
  const prompt = promptText.trim();
  if (!prompt) return false;
  if (!message || message.role !== "user") return false;
  const content = message.content;
  const parts: string[] =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.map((part: any) => {
            if (typeof part === "string") return part;
            return part?.type === "text" && typeof part.text === "string"
              ? part.text
              : "";
          })
        : [];
  return parts.some((part) => {
    const text = stripSystemReminderText(part);
    return (
      text === prompt || text.startsWith(prompt) || text.endsWith(prompt)
    );
  });
}

/** Buffer + inspect /v1/messages; classify the turn, strip notices, forward. */
async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream,
  state: ProxyState
): Promise<void> {
  const received = Date.now();
  const rawBody = await readBody(req);

  // One request-log record per /v1/messages, filled in as the request flows
  // through the forward path and written exactly once when the response is
  // done (success or failure) — always on, so a stalled turn leaves a trace.
  const rec: MessagesRecord = {
    kind: "messages",
    turnType: "unparseable",
    requestBytes: rawBody.length,
  };
  let noticeDelivery: MainNoticeDelivery | undefined;
  const settleNoticeDelivery = () => {
    if (!noticeDelivery) return;
    settleMainNoticeDelivery(state, noticeDelivery);
    noticeDelivery = undefined;
  };
  const logged = async (forward: Promise<unknown>): Promise<void> => {
    try {
      await forward;
    } finally {
      settleNoticeDelivery();
      // Speculative A/B stamps delivery-complete time itself: its forward
      // promise intentionally outlives delivery to also capture the shadow
      // grade, which must not inflate the delivery metric.
      if (rec.totalMs === undefined) rec.totalMs = Date.now() - received;
      opts.reqlog?.log(rec);
    }
  };

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody.toString("utf-8"));
    if (!Array.isArray(body.messages)) throw new Error("no messages array");
  } catch {
    // Not a shape we understand — forward verbatim rather than break the session.
    return logged(
      forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec)
    );
  }

  // Defensive legacy strip pass first: old marker-wrapped notices (including
  // one copied into an away-summary or top-level system prompt) must never
  // reach Anthropic or MemTree. Hook-delivered notices never enter this body.
  const stripped = stripNoticeBlocks(body.messages);
  const strippedSystem = stripNoticeSystem(body.system);
  let forwardBody = rawBody;
  if (stripped.stripped || strippedSystem.stripped) {
    body.messages = stripped.messages;
    if (strippedSystem.system === undefined) delete body.system;
    else body.system = strippedSystem.system;
    forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
    if (opts.debug) console.error("[ccc proxy] stripped legacy notice span(s) from request");
  }

  const messages: Message[] = body.messages;
  // CC 2.1.207 appends ambient role=system blocks after the typed prompt. Use
  // the last non-system conversation message for classification while keeping
  // every system block in the body sent to MemTree/Anthropic.
  const lastMsg = lastNonSystemMessage(messages);
  const isUserTurn = isNonToolUserMessage(lastMsg);
  const isToolResultTurn = isToolResultUserMessage(lastMsg);
  const isAwaySummary = isAwaySummaryUserMessage(lastMsg);
  const isLocalBashCommand = isLocalBashCommandTurn(messages);
  // CC 2.1.207 identifies agent API calls explicitly. Use that wire-level
  // attribution before lifecycle-hook state so an agent request cannot claim
  // or consume a main prompt arm even if SubagentStart ordering is delayed.
  const { lane: requestRouteLane, key: requestRouteKey } = routeIdentity(
    req,
    isAwaySummary
  );
  const isSubagentRequest = requestRouteLane === "agent";
  const isMainRequest = requestRouteLane === "main";
  rec.routeLane = requestRouteLane;
  // A typed prompt that recovers an interrupted tool loop (or was queued
  // mid-turn) arrives merged into the pending tool_result wrapper, so it fails
  // isNonToolUserMessage -- while its UserPromptSubmit hook has already cleared
  // the route expecting this request to rebuild it. Without this, that clear is
  // never followed by a rebuild and every later tool turn forwards the full
  // history (sticky passthrough until the next pure user turn). Corroborate
  // with the armed hook prompt, and only when no installed route survives to
  // ride -- an active route means the wrapper text matched by accident.
  //
  // The arm alone is not enough: it is consumed (for notice dedup) before the
  // forward, but Claude Code retries a transient upstream failure (500/529)
  // with the identical body. Until this prompt's compressible request has been
  // fully delivered (mainPromptDelivered), the prompt text stays valid for
  // classification so the retry recompresses instead of degrading to a plain
  // tool turn with full-history passthrough. Successful delivery closes that
  // window, so a stale prompt text cannot keep promoting later tool turns.
  //
  // "No installed route" needs one refinement. A route installed at
  // protocol-complete (message_stop accepted downstream) deliberately survives
  // a delivery promise that resolves false: Claude can consume message_stop,
  // abort the SSE response, and immediately send a fast tool request that must
  // still ride the compressed prefix. But delivered=false equally covers a
  // client socket that died before the flush, whose retry is the IDENTICAL
  // compressible body — indistinguishable from the fast-tool abort at delivery
  // time. The two separate here: a genuine tool turn extends the route's
  // prefix, while the identical-body retry cannot (empty suffix means
  // memoryRoutedToolBody would reject it into full-history passthrough — the
  // exact degradation the mainPromptDelivered window exists to prevent). So
  // only a route this request could actually ride vetoes recovery
  // classification.
  const rideableCandidate = getMemoryRoute(state, requestRouteKey);
  const routeRideableByThisRequest =
    rideableCandidate !== undefined &&
    messages.length > rideableCandidate.originalPrefixHashes.length;
  const isRecoveryPromptTurn =
    isToolResultTurn &&
    isMainRequest &&
    !routeRideableByThisRequest &&
    (state.mainPromptArmed || !state.mainPromptDelivered) &&
    !!state.mainPromptText &&
    messageCarriesPromptText(lastMsg, state.mainPromptText);
  const isCompressibleUserTurn = isUserTurn || isRecoveryPromptTurn;
  const isFollowupUserTurn =
    isCompressibleUserTurn && hasEarlierNonToolUserMessage(messages);
  let routeEpoch = state.mainRouteEpoch;
  let routeDecisionGeneration = state.mainRouteDecisionGeneration;
  // Whether this request's route decision is final: either it already made one
  // (a main followup makes its decision by clearing the previous epoch below,
  // even if its later compression loses the client) or it has since installed,
  // cleared, or handed back its reservation. Only a followup ever reserves,
  // and every path that reaches the reservation-aware helpers below has done
  // so, so this single flag covers both "reserved" and "committed".
  let routeDecisionSettled = isMainRequest;
  // Only a rebuilder may clear: a main followup enters the blocking
  // compression path below and installs a fresh route, so its clear is
  // clear-then-rebuild. A first-user-shaped request (including CC-internal
  // side calls that never fire UserPromptSubmit) takes the nonblocking path
  // and cannot rebuild what it clears — the 2026-08-04 incident was exactly
  // such a clear-without-rebuild hole stranding the next tool turn on a
  // 2.96MB full-history forward. memoryRoutedToolBody revalidates session,
  // epoch, system, and every prefix hash before any rewrite, so a retained
  // route can never graft onto an unrelated request; it can only match its
  // own conversation's extension or fail closed.
  if (isFollowupUserTurn) {
    if (isMainRequest) {
      // Clears every lane before this request reserves the main lane in the
      // new epoch.
      routeEpoch = bumpRouteEpoch(state);
    }
    // Every followup can install or clear its own lane after compression. Give
    // non-main lanes the same ordering guarantee main already had: a slower
    // older completion cannot overwrite a newer request on the same key.
    routeDecisionGeneration = ++state.mainRouteDecisionGeneration;
    reserveRouteDecision(state, requestRouteKey, routeDecisionGeneration);
  }
  const hookOwnedMainFollowup =
    isFollowupUserTurn &&
    !isAwaySummary &&
    !isSubagentRequest &&
    state.mainPromptArmed &&
    state.mainPromptText !== undefined &&
    messageCarriesPromptText(lastMsg, state.mainPromptText);
  // Local `!command` turns do not consistently emit UserPromptSubmit, and the
  // API history contains bash wrappers rather than the literal typed command.
  // Their strict main-thread replay shape can safely own its own notice.
  const localCommandMainFollowup =
    isFollowupUserTurn &&
    !isAwaySummary &&
    !isSubagentRequest &&
    isLocalBashCommand;
  const displayForThisTurn =
    (hookOwnedMainFollowup || localCommandMainFollowup) &&
    state.activeSubagents.size === 0;
  const noticePromptId = state.mainPromptId;
  const noticePromptGeneration = state.mainPromptGeneration;
  // Extended 1M context arrives as the `context-1m` beta header (Claude Code
  // strips the `[1m]` model suffix on the wire). Current native-1M models send
  // neither, so contextLimitForModel also needs the launcher's native setting.
  const modelContextLimit = contextLimitForModel(
    body.model,
    headerText(req.headers, "anthropic-beta"),
    opts.nativeOneMillionContext !== false
  );
  const rawMsgsForMemtree = messagesWithSystem(messages, body.system);
  const msgsForMemtree = normalizeMessagesForMemtree(rawMsgsForMemtree);
  const hash = MemtreeClient.hashMessages(msgsForMemtree);
  const legacyHash = MemtreeClient.hashMessages(rawMsgsForMemtree);

  // UserPromptSubmit clears/arms only a real main-thread human turn. Keep that
  // arm through CC's small first-user probe/retries; consume it only when the
  // actual followup request reaches the compression branch below. Hidden
  // away-summary requests neither produce notices nor mutate a concurrently
  // armed human turn.

  if (typeof body.model === "string") rec.model = body.model;
  rec.stream = body.stream === true;

  if (!isFollowupUserTurn) {
    // Tool turn or FIRST user turn: keep the index fed off the response path
    // and forward as-is — except a tool turn that misses its lane's memory
    // route, which gets one best-effort blocking recompression below (once
    // per lane per epoch).
    // On the first user turn nothing is indexed yet, so a blocking compress
    // would be a guaranteed no-op costing first-token latency
    // (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
    if (opts.debug && isUserTurn) {
      console.error("[ccc proxy] first user turn: index in background, forward verbatim");
    }
    let routedBody = forwardBody;
    let routedTool = false;
    let routeMiss: "missing" | "rejected" | undefined;
    if (isToolResultTurn) {
      // Every identity — main, subagent, away — consults its own lane. A
      // request can only ever name its own key, so the old foreign-owner
      // preservation and the subagent carve-out have nothing left to defend.
      // This is the lane lookup already done for rideableCandidate above:
      // same key, no await and no memoryRoutes mutation in between on this
      // path (the epoch clear is in the isFollowupUserTurn branch), so a
      // second getMemoryRoute would only redo its own LRU bookkeeping.
      const activeRoute = rideableCandidate;
      if (activeRoute) {
        const rewritten = memoryRoutedToolBody(
          body,
          messages,
          activeRoute,
          state.mainRouteEpoch,
          requestSessionId(req)
        );
        if (rewritten) {
          routedBody = rewritten;
          routedTool = true;
          if (opts.debug) {
            console.error("[ccc proxy] tool turn matched active memory route");
          }
        } else {
          // A mismatch means a different/resumed conversation shape, or two
          // requesters colliding on one lane (children sharing only a
          // parent-agent-id land on the same key; their prefix hashes
          // disagree and the loser lands here). A route stored under this key
          // always carries this requester's session id — installMemoryRoute
          // derives both from the same request — so this is by construction a
          // same-session divergence: evict, and let recovery rebuild it.
          routeMiss = "rejected";
          state.memoryRoutes.delete(requestRouteKey);
          if (opts.debug) {
            console.error("[ccc proxy] tool turn rejected active memory route");
          }
        }
      } else {
        routeMiss = "missing";
        if (opts.debug) {
          console.error("[ccc proxy] tool turn has no active memory route");
        }
      }
    }
    if (routeMiss !== undefined) rec.routeMiss = routeMiss;

    if (
      routeMiss !== undefined &&
      // Cheap shape check: without an earlier real user message no
      // server-side prefix can exist, so the miss is unrecoverable by
      // construction and not worth an attempt or a record.
      hasEarlierNonToolUserMessage(messages)
    ) {
      // No byte gate. The old 400KiB threshold answered "is this miss worth
      // a blocking round trip?" with a latency guess; the answer main
      // already lives by is a budget: at most ONE blocking recompress per
      // (lane, epoch), the same single blocking compress the followup path
      // pays per human turn. Self-limiting without a constant, and the
      // no-gain check in recovery still guarantees the payload never gets
      // worse than verbatim.
      if (opts.toolRouteRecovery === false) {
        // Under the kill switch no attempt ever runs and no lane is ever
        // marked spent, so every shape-eligible miss records "disabled" —
        // exactly the set of misses a switched-on proxy would have fed into
        // the budget below.
        rec.routeRecovery = { outcome: "disabled" };
      } else if (Date.now() < state.toolRecoveryCooldownUntil) {
        // A recent attempt burned the full compress budget and still
        // failed. Every tool turn appends a tool_result and rehashes, so
        // compress() dedup can never absorb the repeat: without this
        // cooldown a MemTree outage would add the whole blocking budget
        // to EVERY large tool turn for the rest of the session — dozens
        // per human turn, strictly worse than the verbatim path this
        // fuse promises never to be worse than. A cooldown skip does not
        // consume the lane's attempt.
        rec.routeRecovery = { outcome: "cooldown" };
      } else if (state.toolRecoveryAttemptedLanes.has(requestRouteKey)) {
        // This lane already spent its one blocking attempt this epoch;
        // the rest of its tool loop forwards verbatim (or rides, if the
        // attempt installed).
        rec.routeRecovery = { outcome: "spent" };
      } else {
        state.toolRecoveryAttemptedLanes.add(requestRouteKey);
        // Serialized non-system conversation bytes, for the record only —
        // computed here, once per lane per epoch, never on the misses that
        // skip the attempt: keeping the multi-megabyte stringify off every
        // other miss is what made deleting the byte gate affordable.
        const conversationBytes = Buffer.byteLength(
          JSON.stringify(messages.filter((m) => m.role !== "system")),
          "utf-8"
        );
        return logged(
          recoverToolRouteMiss({
            opts,
            state,
            req,
            res,
            upstream,
            body,
            messages,
            forwardBody,
            msgsForMemtree,
            rawMsgsForMemtree,
            hash,
            legacyHash,
            modelContextLimit,
            routeEpoch,
            rec,
            conversationBytes,
            routeKey: requestRouteKey,
            isMainRequest,
          })
        );
      }
    }

    recordTurn(
      rec,
      routedTool ? "tool-memory" : isUserTurn ? "first-user" : "tool",
      routedBody
    );
    opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit);
    capture(opts, routedTool ? "anthropic-request-memory-tool" : "anthropic-request", routedBody);
    return logged(
      forwardRaw(
        req,
        res,
        routedBody,
        opts,
        upstream,
        state.shutdownSignal,
        rec
      )
    );
  }

  // Close the recovery-retry window only once this compressible main turn's
  // response has been fully delivered downstream: a failed forward (500/529)
  // keeps state.mainPromptDelivered false so the client's identical-body retry
  // reclassifies as the same user/recovery turn above. Epoch-guarded so a late
  // completion can never mark a newer prompt's turn as delivered, and an
  // away-summary request (isMainRequest false) never closes the main window.
  const markMainPromptDelivered = () => {
    if (isMainRequest && state.mainRouteEpoch === routeEpoch) {
      state.mainPromptDelivered = true;
    }
  };

  // Post-await route mutations require BOTH guards current: a stale epoch
  // means a newer human turn owns the route lifecycle; a stale decision
  // generation means a newer async route owner (another followup, or a
  // route-owning tool recovery) has since reserved the decision. Either way
  // this completion lost — it must not erase or overwrite the winner's route.
  const routeDecisionCurrent = () =>
    state.mainRouteEpoch === routeEpoch &&
    routeDecisionHolds(state, requestRouteKey, routeDecisionGeneration);
  const commitRouteDecision = () => {
    routeDecisionSettled = true;
  };
  const releaseUncommittedRouteDecision = () => {
    if (routeDecisionSettled) return;
    releaseRouteDecision(state, requestRouteKey, routeDecisionGeneration);
    routeDecisionSettled = true;
  };

  // The complete request upload can outlive its downstream subscriber while
  // MemTree compression is in flight. Track that subscriber locally without
  // feeding its lifetime into MemtreeClient.compress(): compression promises
  // are hash-deduped and may still be serving another live retry.
  let downstreamClosedDuringCompression =
    res.destroyed && !res.writableFinished;
  const markDownstreamClosedDuringCompression = () => {
    if (!res.writableFinished) downstreamClosedDuringCompression = true;
  };
  res.once("close", markDownstreamClosedDuringCompression);

  // An active subagent can repeat/embed the human prompt in its own request;
  // producer suppression must also preserve the arm for the later main call.
  if (displayForThisTurn) state.mainPromptArmed = false;
  let compression: BlockingCompressionOutcome;
  try {
    compression = await runBlockingCompression({
      opts,
      state,
      req,
      body,
      messages,
      msgsForMemtree,
      rawMsgsForMemtree,
      hash,
      legacyHash,
      modelContextLimit,
      rec,
    });
  } catch (err) {
    releaseUncommittedRouteDecision();
    throw err;
  } finally {
    res.off("close", markDownstreamClosedDuringCompression);
  }
  const { result } = compression;
  noteMemtreeHealth(state, compression);

  if (
    downstreamClosedDuringCompression ||
    (res.destroyed && !res.writableFinished)
  ) {
    releaseUncommittedRouteDecision();
    recordTurn(rec, "followup-client-closed", Buffer.alloc(0));
    return logged(Promise.resolve());
  }
  // No await occurs between this check and the selected forwarder's call.
  // Each forwarder installs its own close listener synchronously, so this is
  // an event-loop-atomic handoff of downstream-close ownership.

  if (!result) {
    // MemTree down/slow/402: the user's own Anthropic call is never gated on
    // it. Degrade to passthrough and queue a display-only hook notice for a
    // visible turn. The hidden away-summary request deliberately stays quiet.
    // Unpaid key (402, from this compress OR an earlier background index) gets
    // a payment-specific notice instead of the generic degraded one, at most
    // once per proxy process after it has actually been delivered.
    recordTurn(rec, "followup-degraded", forwardBody);
    if (routeDecisionCurrent()) {
      state.memoryRoutes.delete(requestRouteKey);
      commitRouteDecision();
    } else {
      releaseUncommittedRouteDecision();
    }
    capture(opts, "anthropic-request", forwardBody);
    const paymentDetail = opts.memtree.paymentRequiredDetail;
    const mayQueueNotice =
      displayForThisTurn && state.mainPromptGeneration === noticePromptGeneration;
    if (mayQueueNotice && paymentDetail !== null && !state.paymentNoticeShown) {
      const detailFirstLine = sanitizeNoticeDetail(
        paymentDetail.split(/[\r\n]/, 1)[0]
      );
      state.notices.queueSuffix(
        detailFirstLine
          ? `${PAYMENT_REQUIRED_NOTICE}\n${detailFirstLine}`
          : PAYMENT_REQUIRED_NOTICE,
        () => {
          state.paymentNoticeShown = true;
        },
        noticePromptId
      );
    } else if (mayQueueNotice && paymentDetail === null) {
      state.notices.queueSuffix(DEGRADED_NOTICE, undefined, noticePromptId);
    }
    return logged(
      forwardRaw(
        req,
        res,
        forwardBody,
        opts,
        upstream,
        state.shutdownSignal,
        rec
      ).then((delivered) => {
        if (delivered) markMainPromptDelivered();
      })
    );
  }

  const actuallyCompressed = didMemtreeCompress(result);
  // The legacy probe may have swapped in a result compressed from the untouched
  // shape; measure retention against whatever we actually sent for the winner.
  const historyCheck = checkCompressedHistory(result, compression.winningInput);
  rec.history = {
    retainedChars: historyCheck.retainedChars,
    priorHistoryChars: historyCheck.priorHistoryChars,
    usable: historyCheck.usable,
  };
  if (!actuallyCompressed || !historyCheck.usable) {
    // Two distinct ways to get an unusable answer, one recovery.
    //
    // No cached/indexed tokens means the server is still warming an index and
    // returned the messages as-is. Preserve true passthrough semantics:
    // flattening that no-op response changes Anthropic's structured
    // conversation and made the first request disagree with the full-history
    // tool loop that followed it.
    //
    // A fully indexed response that carries no prior conversation is the more
    // dangerous case: it looks like a perfect compression by every usage-based
    // measure, so nothing downstream would notice that the model is about to be
    // asked to continue a conversation it can no longer see. Forwarding the
    // real history costs context but never silently amnesias the session.
    if (routeDecisionCurrent()) {
      state.memoryRoutes.delete(requestRouteKey);
      commitRouteDecision();
    } else {
      releaseUncommittedRouteDecision();
    }
    if (actuallyCompressed && opts.debug) {
      console.error(
        `[ccc proxy] memory response dropped the conversation ` +
          `(retained ${historyCheck.retainedChars} of ` +
          `${historyCheck.priorHistoryChars} prior chars); forwarding history`
      );
    }
    recordTurn(
      rec,
      actuallyCompressed ? "followup-empty-memory" : "followup-noop",
      forwardBody
    );
    capture(opts, "anthropic-request", forwardBody);
    return logged(
      forwardRaw(
        req,
        res,
        forwardBody,
        opts,
        upstream,
        state.shutdownSignal,
        rec
      ).then((delivered) => {
        if (delivered) markMainPromptDelivered();
      })
    );
  }

  // Invariant from the early return above: past this point the MemTree result
  // actually compressed (actuallyCompressed is true) and the retained history
  // is usable — every remaining path forwards the compressed body.
  let compressedBody: Record<string, any>;
  let compressedRaw: Buffer;
  try {
    ({ compressedBody, compressedRaw } = buildCompressedBody(body, result));
  } catch (err) {
    releaseUncommittedRouteDecision();
    throw err;
  }
  if (opts.debug) {
    console.error(
      `[ccc proxy] user turn compressed: ${forwardBody.length} → ` +
        `${compressedRaw.length} body bytes`
    );
  }
  const abRouting = state.abRouting;
  if (
    abRouting &&
    displayForThisTurn &&
    state.mainPromptGeneration === noticePromptGeneration
  ) {
    // A/B mode intentionally decides success only after complete downstream
    // delivery. Let a nearly simultaneous display or Stop wait briefly for
    // that decision instead of racing the late notice callback.
    noticeDelivery = beginMainNoticeDelivery(
      state,
      noticePromptGeneration,
      noticePromptId
    );
  }
  const canRouteAb =
    abRouting !== undefined &&
    body.stream === true &&
    isMainRequest;

  // Claude can consume message_stop, execute a fast local tool, and close the
  // SSE response before Node observes the downstream HTTP `finish` event.
  // Activate the route once the complete Anthropic response has been accepted
  // by the downstream response, so an immediate tool-result request cannot
  // race the later forwardRaw() delivery promise.
  let routeActivationAttempted = false;
  const activateMemoryRoute = () => {
    if (routeActivationAttempted) return;
    if (!routeDecisionCurrent()) {
      releaseUncommittedRouteDecision();
      routeActivationAttempted = true;
      return;
    }
    const installed = installMemoryRoute(
      state,
      requestRouteKey,
      req,
      body,
      messages,
      compressedBody,
      routeEpoch,
      routeDecisionGeneration
    );
    commitRouteDecision();
    // Leave this false if installMemoryRoute unexpectedly throws: the
    // delivery-complete fallback then gets one safe retry.
    routeActivationAttempted = true;
    if (opts.debug) {
      console.error(
        `[ccc proxy] memory route activation: ${
          installed ? "installed" : "unavailable"
        }`
      );
    }
  };

  if (canRouteAb) {
    // M1c gates on the whole A request. Until count_tokens is available here,
    // use its conservative fallback (encoded body bytes / 3 chars per token).
    const contextTokens = Math.ceil(compressedRaw.length / 3);
    const gate = abGateDecision(String(body.model ?? ""), contextTokens, abRouting);
    rec.comparison = {
      attempted: gate.compare,
      gateReason: gate.reason,
      approxContextTokens: gate.contextTokens,
      contextTokenEstimate: "body-bytes/3",
      effectiveContextTokens: gate.effectiveContextTokens,
      thresholdTokens: gate.thresholdTokens,
    };

    if (!gate.compare) {
      rec.comparison.winner = "memory";
      recordTurn(rec, "followup-compressed", compressedRaw);
      capture(opts, "anthropic-request-memory", compressedRaw);
      return logged(
        forwardRaw(
          req,
          res,
          compressedRaw,
          opts,
          upstream,
          state.shutdownSignal,
          rec,
          undefined,
          activateMemoryRoute
        ).then(
          (delivered) => {
            rec.comparison!.deliveryOk = delivered;
            if (delivered) markMainPromptDelivered();
            if (delivered && state.mainRouteEpoch === routeEpoch) {
              queueCompressionNotice({
                state,
                req,
                displayForThisTurn,
                noticePromptGeneration,
                noticePromptId,
                result,
              });
              activateMemoryRoute();
            } else if (routeDecisionCurrent() && !routeActivationAttempted) {
              state.memoryRoutes.delete(requestRouteKey);
              commitRouteDecision();
            } else if (!routeActivationAttempted) {
              releaseUncommittedRouteDecision();
            }
            // When activation already ran at protocol-complete, a
            // delivered=false settle keeps the route on purpose: it may be
            // the fast-tool abort (client consumed message_stop, closed the
            // SSE response, and its tool request must ride the prefix). If it
            // was instead a socket death before flush, the identical-body
            // retry cannot ride the route and reclassifies as the recovery
            // turn (routeRideableByThisRequest above), which bumps the epoch
            // and rebuilds the route.
          }
        )
      );
    }

    // Compared streams retain their stricter selected-delivery invariant:
    // onDeliveryComplete below owns route installation because the delivered
    // response may be memory, full history, or a splice of both.
    return logged(
      forwardComparedSse({
        req,
        res,
        opts,
        upstream,
        routing: abRouting,
        memoryBody: compressedRaw,
        fullBody: forwardBody,
        question: stripSystemReminderText(userMessageText(lastMsg)),
        unfoldedMemory:
          typeof result.unfolded_memory === "string"
            ? result.unfolded_memory
            : extractUnfoldedMemory(result.messages),
        model: String(body.model ?? ""),
        rec,
        receivedAt: received,
        shutdownSignal: state.shutdownSignal,
        onDecision: (winner, selectedAlreadyComplete) => {
          if (
            state.mainPromptGeneration !== noticePromptGeneration ||
            state.mainRouteEpoch !== routeEpoch
          ) {
            releaseUncommittedRouteDecision();
            return;
          }
          if (
            winner === "memory" &&
            selectedAlreadyComplete &&
            noticeDelivery &&
            state.mainNoticeDelivery === noticeDelivery
          ) {
            // The whole selected response ended upstream before any client
            // bytes. Its first MessageDisplay may make a bounded wait for the
            // downstream finish and then claim the completed-delivery notice.
            noticeDelivery.firstDisplayCanWait = true;
          }
          if (winner === "full" && routeDecisionCurrent()) {
            state.memoryRoutes.delete(requestRouteKey);
            commitRouteDecision();
            // The verdict judged memory WORSE than full context for this
            // turn. Recovery re-compressing the tool loop would override
            // that judgement with an ungraded compress, so the lane's
            // blocking budget is spent — the followup compress that fed the
            // comparison was this epoch's one attempt.
            state.toolRecoveryAttemptedLanes.add(requestRouteKey);
          }
        },
        onDeliveryComplete: (delivered, ok) => {
          // Route/notice bookkeeping is keyed off DELIVERED content, not the
          // verdict: a late B verdict after a clean memory delivery changes
          // priors, never the installed route.
          try {
            // Any fully delivered leg (memory, full, spliced, recovered)
            // completes this turn downstream, ending the recovery-retry window.
            if (ok) markMainPromptDelivered();
            if (!routeDecisionCurrent()) {
              releaseUncommittedRouteDecision();
              return;
            }
            if (delivered === "memory" && ok) {
              queueCompressionNotice({
                state,
                req,
                displayForThisTurn,
                noticePromptGeneration,
                noticePromptId,
                result,
              });
              installMemoryRoute(
                state,
                requestRouteKey,
                req,
                body,
                messages,
                compressedBody,
                routeEpoch,
                routeDecisionGeneration
              );
              commitRouteDecision();
              return;
            }
            state.memoryRoutes.delete(requestRouteKey);
            commitRouteDecision();
            if (delivered === "spliced") {
              // A B-verdict splice is the grader choosing full context over
              // memory mid-stream. Same authority as a full winner above:
              // the lane's blocking budget is spent, so the tool loop stays
              // full-context instead of recovery re-litigating the verdict.
              state.toolRecoveryAttemptedLanes.add(requestRouteKey);
            }
            const mayQueueNotice =
              ok &&
              displayForThisTurn &&
              state.mainPromptGeneration === noticePromptGeneration;
            if (mayQueueNotice && delivered === "spliced") {
              state.notices.queueSuffix(
                FULL_HISTORY_OVERRIDE_NOTICE,
                undefined,
                noticePromptId
              );
            } else if (mayQueueNotice && delivered === "recovered") {
              state.notices.queueSuffix(
                RECOVERED_NOTICE,
                undefined,
                noticePromptId
              );
            }
          } finally {
            // In speculative mode delivery completes while the shadow grade
            // is still running; release a waiting display/Stop hook now.
            settleNoticeDelivery();
          }
        },
      })
    );
  }

  if (routeDecisionCurrent()) {
    state.memoryRoutes.delete(requestRouteKey);
    commitRouteDecision();
  }
  // If a newer same-lane decision is live, keep this request's reservation
  // until its protocol-complete activation (or terminal forward failure).
  // The newer request may still end without mutating anything and hand
  // ownership back while this response is in flight. Releasing here would let
  // this request install later with no committed generation protecting that
  // route from an even older completion.
  recordTurn(rec, "followup-compressed", compressedRaw);
  capture(opts, "anthropic-request", compressedRaw);
  // Preserve the legacy embedder contract: without A/B enabled, a long live
  // stream may claim its display notice before message_stop. CLI A/B paths
  // above require complete delivery before queuing the same success notice.
  // (actuallyCompressed is guaranteed true past the early return above.)
  if (!abRouting) {
    queueCompressionNotice({
      state,
      req,
      displayForThisTurn,
      noticePromptGeneration,
      noticePromptId,
      result,
    });
  }
  return logged(
    forwardRaw(
      req,
      res,
      compressedRaw,
      opts,
      upstream,
      state.shutdownSignal,
      rec,
      undefined,
      activateMemoryRoute
    ).then(
      (delivered) => {
        // actuallyCompressed is guaranteed true past the early return above.
        // A route already installed at protocol-complete deliberately survives
        // delivered=false: that settle may be the fast-tool abort (client
        // consumed message_stop, closed the SSE response, and its immediate
        // tool request must ride the prefix). A socket death before flush
        // settles identically, but its identical-body retry cannot ride the
        // route and reclassifies as the recovery turn
        // (routeRideableByThisRequest above), bumping the epoch and
        // rebuilding the route.
        if (!delivered) {
          // Protocol-complete activation may already have installed the route
          // before a fast downstream close. Otherwise this forward made no
          // route decision, so return an uncommitted agent reservation.
          if (!routeActivationAttempted) releaseUncommittedRouteDecision();
          return;
        }
        markMainPromptDelivered();
        // The notice is the only part that stayed A/B-conditional here: the
        // legacy path already queued it above, before the stream started.
        if (abRouting) {
          queueCompressionNotice({
            state,
            req,
            displayForThisTurn,
            noticePromptGeneration,
            noticePromptId,
            result,
          });
        }
        // Route the rest of this human turn's tool loop — and the count_tokens
        // calls Claude Code sizes its context with — through the same compressed
        // prefix. Without this the tool loop re-sends the full history, so
        // count_tokens reports the uncompressed conversation and Claude Code
        // auto-compacts a context that memory had already shrunk.
        // Retain delivery completion as a defensive retry if protocol-time
        // route bookkeeping failed unexpectedly.
        activateMemoryRoute();
      }
    )
  );
}

function queueCompressionNotice(args: {
  state: ProxyState;
  req: http.IncomingMessage;
  displayForThisTurn: boolean;
  noticePromptGeneration: number;
  noticePromptId: string | undefined;
  result: CompressResult;
}): void {
  const {
    state,
    req,
    displayForThisTurn,
    noticePromptGeneration,
    noticePromptId,
    result,
  } = args;
  if (
    !displayForThisTurn ||
    state.mainPromptGeneration !== noticePromptGeneration
  ) {
    return;
  }
  // Announce only actual (re)indexing, measured as growth in how much of the
  // original prompt the index covers (`cached_tokens`). Unchanged coverage
  // means this turn rode the existing index with the new messages appended
  // after it — MemTree did no new indexing work worth reporting.
  //
  // Deliberately NOT keyed on the memory text: the server unfolds the index
  // against the current question, so its rendering (and length) changes on
  // nearly every turn regardless of indexing. Coverage is missing only on
  // servers old enough that `didMemtreeCompress` would have degraded this
  // turn already; announce rather than suppress on an unknown quantity.
  const indexedTokens = cachedPromptTokenCount(result);
  if (indexedTokens !== undefined) {
    const sessionId = requestSessionId(req);
    const last = state.lastNoticedIndexCoverage;
    // Record every observed coverage, announced or not, so a server-side
    // index rebuild that shrinks coverage re-announces once it grows past
    // its own new baseline rather than staying silent until it beats the old.
    state.lastNoticedIndexCoverage = { sessionId, indexedTokens };
    if (
      last &&
      last.sessionId === sessionId &&
      indexedTokens <= last.indexedTokens
    ) {
      return;
    }
  }
  state.notices.queuePrefix(COMPRESSED_NOTICE, undefined, noticePromptId);
}

/**
 * Record what a blocking operation just proved about MemTree's health: an
 * unopposed live failure arms the tool-recovery cooldown, any live success
 * clears it, and a cached-only result leaves the prior state untouched.
 *
 * Called from BOTH blocking paths and, critically, BEFORE either one checks
 * whether its client is still listening. A null says something about the
 * server, not about the downstream socket — and the full-budget stall that
 * produces a null is itself the likeliest reason a client gives up, so
 * learning only from attempts that outlived their client would blind the
 * cooldown to exactly the outage it exists to bound. Sharing it with the
 * followup path matters in both directions: an outage first seen on a human
 * turn must not cost another full stall on the next tool turn, and a
 * recovered MemTree must not stay locked out for the rest of the window.
 *
 * A live no-op, unusable, or non-shrinking answer still proves the server is
 * responsive and merely unhelpful for this history, and the next turn's
 * larger tail may well succeed — so those clear the outage fuse and keep
 * paying the fast, already-indexed round trip rather than locking recovery
 * out. The asymmetry trades a bounded repeat cost against never suppressing a
 * recovery a warming index is about to make possible.
 *
 * Both directions require evidence about MemTree's health RIGHT NOW; anything
 * weaker leaves the fuse untouched rather than guessing:
 *
 * - Every lane contributes the same shared evidence. A live success on either
 *   canonical or legacy-probe leg clears the cooldown, even if its sibling
 *   failed; when no live leg succeeds, a live failure arms it.
 * - Cache-served legs contribute no evidence. compress() memoizes successes by
 *   hash and returns them with zero server contact, so replaying an identical
 *   body cannot "prove" MemTree is up. Conversely, a live canonical failure
 *   rescued by a cached legacy answer still arms the fuse: the selected answer
 *   must not hide current outage evidence.
 * - A shutdown abort arms nothing. compress() maps abort to the same null as
 *   a server failure, but a draining proxy says nothing about MemTree; it
 *   would only misattribute the drain in the last records written.
 */
function noteMemtreeHealth(
  state: ProxyState,
  compression: BlockingCompressionOutcome
): void {
  if (compression.liveHealth === "failure") {
    if (state.shutdownSignal.aborted) return;
    state.toolRecoveryCooldownUntil =
      Date.now() + TOOL_RECOVERY_FAILURE_COOLDOWN_MS;
    return;
  }
  if (compression.liveHealth === "success") {
    state.toolRecoveryCooldownUntil = 0;
  }
}

/**
 * Whether the holder of `generation` still owns the route decision: true while
 * no STRICTLY NEWER reservation is live or committed. The holder's own
 * reservation never blocks itself, and a newer reservation that ended up
 * mutating nothing has already removed itself, handing ownership back rather
 * than stranding everyone older.
 */
function routeDecisionHolds(
  state: ProxyState,
  key: string,
  generation: number
): boolean {
  const live = state.routeDecisionsLive.get(key);
  if (!live) return true;
  for (const reserved of live) {
    if (reserved > generation) return false;
  }
  return true;
}

function reserveRouteDecision(
  state: ProxyState,
  key: string,
  generation: number
): void {
  let live = state.routeDecisionsLive.get(key);
  if (!live) {
    live = new Set();
    state.routeDecisionsLive.set(key, live);
  }
  live.add(generation);
}

function releaseRouteDecision(
  state: ProxyState,
  key: string,
  generation: number
): void {
  const live = state.routeDecisionsLive.get(key);
  if (!live) return;
  live.delete(generation);
  if (live.size === 0) state.routeDecisionsLive.delete(key);
}

function installMemoryRoute(
  state: ProxyState,
  key: string,
  req: http.IncomingMessage,
  originalBody: Record<string, any>,
  originalMessages: Message[],
  compressedBody: Record<string, any>,
  routeEpoch: number,
  decisionGeneration: number
): boolean {
  // Epoch guards the human-prompt lifecycle; the decision generation orders
  // async installs that share one epoch (two recoveries, or a recovery vs an
  // in-flight followup). A stale completion must not overwrite a newer
  // decision's route — and must not clear it either, hence the early return
  // before the sessionless-clear below.
  if (
    state.mainRouteEpoch !== routeEpoch ||
    !routeDecisionHolds(state, key, decisionGeneration)
  ) {
    return false;
  }
  const sessionId = requestSessionId(req);
  if (!sessionId || !Array.isArray(compressedBody.messages)) {
    state.memoryRoutes.delete(key);
    return false;
  }
  setMemoryRoute(state, key, {
    sessionId,
    originalSystemHash: routeValueHash(
      normalizeRouteSystem(originalBody.system)
    ),
    // Include trailing ambient role=system blocks: MemTree consolidated them
    // into compressedBody.system, so treating them as suffix would duplicate
    // those instructions on every tool request.
    originalPrefixHashes: originalMessages.map(routeMessageHash),
    compressedMessages: cloneJson(compressedBody.messages),
    compressedSystem: cloneJson(compressedBody.system),
    hasCompressedSystem: Object.prototype.hasOwnProperty.call(
      compressedBody,
      "system"
    ),
    routeEpoch,
  });
  return true;
}

function memoryRoutedToolBody(
  body: Record<string, any>,
  messages: Message[],
  route: MemoryRoute,
  routeEpoch: number,
  sessionId: string | undefined
): Buffer | null {
  // Model is deliberately not route identity: Claude Code switches models
  // mid-loop (overload fallback, /model, /fast), and the compressed prefix is
  // plain message content valid for any model. Session + prefix hashes pin the
  // conversation; requiring model equality dropped the whole tool loop to
  // full-history passthrough on every mid-turn switch.
  if (
    !sessionId ||
    route.sessionId !== sessionId ||
    route.routeEpoch !== routeEpoch ||
    routeValueHash(normalizeRouteSystem(body.system)) !==
      route.originalSystemHash
  ) {
    return null;
  }
  const prefixLength = route.originalPrefixHashes.length;
  if (messages.length <= prefixLength) return null;
  for (let i = 0; i < prefixLength; i++) {
    if (routeMessageHash(messages[i]) !== route.originalPrefixHashes[i]) {
      return null;
    }
  }
  const suffix = messages.slice(prefixLength);
  if (!validToolRouteSuffix(suffix)) return null;
  const routed: Record<string, any> = {
    ...body,
    messages: [...cloneJson(route.compressedMessages), ...suffix],
  };
  if (route.hasCompressedSystem) {
    routed.system = currentRouteSystem(route.compressedSystem, body.system);
  } else {
    delete routed.system;
  }
  return Buffer.from(JSON.stringify(routed), "utf-8");
}

/** Ignore cache-control churn when matching Claude's next tool-loop request. */
function routeMessageHash(message: Message): string {
  return routeValueHash(normalizeRouteMessage(message));
}

function routeValueHash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        present: value !== undefined,
        value: stableRouteValue(value),
      })
    )
    .digest("hex");
}

function normalizeRouteMessage(message: Message): Message {
  const normalized = cloneJson(message);
  normalized.content = normalizeRouteContent(normalized.content);
  return normalized;
}

/** Canonicalize semantically identical Anthropic content representations. */
function normalizeRouteContent(content: unknown): unknown {
  const blocks =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
  return withoutContentBlockCacheControl(normalizeReminderContent(blocks));
}

/**
 * Claude Code changes request-attribution fields such as `cch` and
 * `cc_prev_req` during a tool loop. That synthetic top-level system block is
 * not conversation identity. Ignore exactly one standalone billing block
 * there, while keeping header-like text in messages fully identity-bearing.
 */
function normalizeRouteSystem(system: unknown): unknown {
  const normalized = normalizeRouteContent(system);
  const headers = routeBillingHeaders(normalized);
  if (headers.length !== 1) return normalized;
  return replaceSingleRouteBillingHeader(
    normalized,
    ROUTE_BILLING_HEADER_PLACEHOLDER
  );
}

function normalizeReminderContent(content: unknown): unknown {
  if (typeof content === "string") return normalizeRouteText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part === "string") return normalizeRouteText(part);
    if (!part || typeof part !== "object") return part;
    const copy = { ...(part as Record<string, unknown>) };
    if (copy.type === "text" && typeof copy.text === "string") {
      copy.text = normalizeRouteText(copy.text);
    } else if (copy.type === "tool_result") {
      copy.content = normalizeReminderContent(copy.content);
    }
    return copy;
  });
}

const ROUTE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const ROUTE_BILLING_HEADER_PLACEHOLDER =
  "x-anthropic-billing-header: <dynamic>";

function normalizeRouteText(text: string): string {
  return stripSystemReminderText(text);
}

/** Preserve Claude's current per-request billing metadata after prefix grafting. */
function currentRouteSystem(
  compressedSystem: unknown,
  currentSystem: unknown
): unknown {
  const currentHeaders = routeBillingHeaders(currentSystem);
  const compressedHeaders = routeBillingHeaders(compressedSystem);
  if (currentHeaders.length === 1 && compressedHeaders.length === 1) {
    return replaceSingleRouteBillingHeader(
      cloneJson(compressedSystem),
      currentHeaders[0]
    );
  }
  // The one-synthetic-header invariant broke (Claude reordered the header
  // fields, or the compressed system carries duplicate header-like blocks).
  // Never replay the FIRST request's stale cch/cc_prev_req attribution for
  // every tool call in the turn: drop the recognizable billing headers from
  // the routed system instead. Missing attribution is safer than wrong
  // attribution.
  const stripped = withoutRouteBillingHeaders(cloneJson(compressedSystem));
  // JSON.stringify omits undefined-valued keys, so an all-header system is
  // sent with no `system` field rather than an empty block list.
  return Array.isArray(stripped) && stripped.length === 0
    ? undefined
    : stripped;
}

function routeBillingHeaders(value: unknown): string[] {
  if (typeof value === "string") {
    return isRouteBillingHeader(value) ? [value] : [];
  }
  if (!Array.isArray(value)) return [];
  const headers: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (isRouteBillingHeader(item)) headers.push(item);
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "text"
    ) {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && isRouteBillingHeader(text)) {
        headers.push(text);
      }
    }
  }
  return headers;
}

function isRouteBillingHeader(text: string): boolean {
  if (
    /[\r\n]/.test(text) ||
    !text.startsWith(ROUTE_BILLING_HEADER_PREFIX)
  ) {
    return false;
  }
  const fields = text.slice(ROUTE_BILLING_HEADER_PREFIX.length).trim();
  return (
    /^cc_version=[^;]+;/.test(fields) &&
    /(?:^|;\s*)cc_entrypoint=[^;]+;/.test(fields)
  );
}

function replaceSingleRouteBillingHeader(
  value: unknown,
  replacement: string
): unknown {
  if (typeof value === "string") {
    return isRouteBillingHeader(value) ? replacement : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") {
        return isRouteBillingHeader(item) ? replacement : item;
      }
      if (
        !item ||
        typeof item !== "object" ||
        (item as Record<string, unknown>).type !== "text"
      ) {
        return item;
      }
      const block = item as Record<string, unknown>;
      return typeof block.text === "string" &&
        isRouteBillingHeader(block.text)
        ? { ...block, text: replacement }
        : item;
    });
  }
  return value;
}

/** Remove every recognizable synthetic billing-header block from a system value. */
function withoutRouteBillingHeaders(value: unknown): unknown {
  if (typeof value === "string") {
    return isRouteBillingHeader(value) ? undefined : value;
  }
  if (!Array.isArray(value)) return value;
  return value.filter((item) => {
    if (typeof item === "string") return !isRouteBillingHeader(item);
    if (
      !item ||
      typeof item !== "object" ||
      (item as Record<string, unknown>).type !== "text"
    ) {
      return true;
    }
    const text = (item as Record<string, unknown>).text;
    return !(typeof text === "string" && isRouteBillingHeader(text));
  });
}

/** Ignore only Anthropic content-block cache metadata, never user/tool data. */
function withoutContentBlockCacheControl(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((part) => withoutContentBlockCacheControl(part));
  }
  if (!content || typeof content !== "object") return content;
  const { cache_control: _cacheControl, ...block } = content as Record<
    string,
    unknown
  >;
  return block;
}

function stableRouteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRouteValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stableRouteValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function validToolRouteSuffix(messages: Message[]): boolean {
  if (!messages.length || messages.some(isNonToolUserMessage)) return false;
  const toolUses = new Set<string>();
  const toolResults: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_use" && typeof part.id === "string") {
        toolUses.add(part.id);
      } else if (
        part.type === "tool_result" &&
        typeof part.tool_use_id === "string"
      ) {
        toolResults.push(part.tool_use_id);
      }
    }
  }
  return (
    toolUses.size > 0 &&
    toolResults.length > 0 &&
    toolResults.every((id) => toolUses.has(id))
  );
}

function requestSessionId(req: http.IncomingMessage): string | undefined {
  const value = req.headers["x-claude-code-session-id"];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function hasAgentAttribution(req: http.IncomingMessage): boolean {
  return agentAttributionId(req) !== undefined;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

interface BlockingCompressionOutcome {
  result: CompressResult | null;
  usedLegacyFallback: boolean;
  /**
   * The exact input shape the winning result must be validated against:
   * the raw pre-normalization messages when the legacy probe won, the
   * canonical normalized messages otherwise.
   */
  winningInput: Message[];
  /** Current server-health evidence contributed by this blocking operation. */
  liveHealth: "success" | "failure" | "none";
}

/**
 * The complete blocking-compression selection pipeline, shared by the main
 * followup path and tool-route miss recovery: canonical + legacy probe legs,
 * conversation-scoped migration bookkeeping, legacy fallback selection, and
 * the `compress` telemetry record. Callers own downstream-close tracking
 * (compression promises are hash-deduped and may serve another live retry, so
 * a per-request disconnect signal must never feed compress()) and all
 * decisions about the returned result: both
 * `didMemtreeCompress(result)` and
 * `checkCompressedHistory(result, winningInput).usable` must hold before the
 * result may be forwarded or become a route.
 */
async function runBlockingCompression(args: {
  opts: ProxyOptions;
  state: ProxyState;
  req: http.IncomingMessage;
  body: Record<string, any>;
  messages: Message[];
  msgsForMemtree: Message[];
  rawMsgsForMemtree: Message[];
  hash: string;
  legacyHash: string;
  modelContextLimit: number;
  rec: MessagesRecord;
}): Promise<BlockingCompressionOutcome> {
  const {
    opts,
    state,
    req,
    body,
    messages,
    msgsForMemtree,
    rawMsgsForMemtree,
    hash,
    legacyHash,
    modelContextLimit,
    rec,
  } = args;
  const compressStarted = Date.now();
  let result: CompressResult | null;
  let usedLegacyFallback = false;
  let canonicalCompressFailed = false;
  // Wall time of the canonical leg alone. timedOut must be computed from
  // this, not the Promise.all wall time: a fast canonical failure (e.g. a
  // 200ms 5xx) awaited alongside a slow legacy probe is not a timeout.
  let canonicalCompressMs = 0;
  const compressMeta = {
    // Model + tools drive the server's model-based memory budget
    // (e.g. 500k whole-request target for Fable / Opus 4.8). Omitting
    // them silently downgrades to the server's static 50k fallback.
    // `[1m]` is re-attached when the session is 1M-context so the
    // server's budget telemetry names the variant it actually served.
    model: modelForMemtree(
      typeof body.model === "string" ? body.model : undefined,
      modelContextLimit
    ),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
  };
  // The first request after this normalization ships may not match an
  // existing signature-keyed index. The canonical call starts the stable
  // replacement index. Until it catches up, compare one lookup with the
  // untouched shape so a shallow canonical hit cannot hide a much deeper
  // same-model legacy index. Both legs run concurrently — the probe's
  // inputs never depend on the canonical result, only the decision below
  // does — so an active migration pays one compress budget, not two, per
  // turn. compress() maps every failure to a resolved null (it never
  // rejects), so neither leg can surface an unhandled rejection.
  const migrationKey = legacyMigrationKey(req, messages);
  const probeLegacy =
    legacyHash !== hash &&
    !state.legacyMemtreeMigrationComplete.has(migrationKey);
  // Sampled BEFORE the legs run, while it still describes this call: after
  // the await both hashes are in the cache regardless of who put them there.
  const canonicalCached = opts.memtree.hasCachedCompress(hash);
  const legacyCached = probeLegacy && opts.memtree.hasCachedCompress(legacyHash);
  const [canonicalResult, legacyResult] = await Promise.all([
    // compress() never rejects, so this .then always runs and records the
    // canonical leg's own duration for the timedOut heuristic below.
    opts.memtree
      .compress(
        hash,
        msgsForMemtree,
        modelContextLimit,
        state.shutdownSignal,
        compressMeta
      )
      .then((value) => {
        canonicalCompressMs = Date.now() - compressStarted;
        return value;
      }),
    probeLegacy
      ? opts.memtree.compress(
          legacyHash,
          rawMsgsForMemtree,
          modelContextLimit,
          state.shutdownSignal,
          compressMeta
        )
      : null,
  ]);
  result = canonicalResult;
  canonicalCompressFailed = canonicalResult === null;
  if (
    canonicalResult === null &&
    legacyResult &&
    didMemtreeCompress(legacyResult) &&
    checkCompressedHistory(legacyResult, rawMsgsForMemtree).usable
  ) {
    // The canonical leg failed (server error/timeout — compress maps every
    // failure to null) while the concurrent probe returned a compressed,
    // usable answer that is already paid for. Forward it instead of
    // degrading to passthrough. The migration flag is untouched: a failed
    // canonical leg is not a contest.
    result = legacyResult;
    usedLegacyFallback = true;
    if (opts.debug) {
      console.error(
        "[ccc proxy] canonical compress failed; using legacy probe result"
      );
    }
  } else if (
    canonicalResult &&
    legacyResult &&
    didMemtreeCompress(legacyResult)
  ) {
    // Ending the migration is scoped to this conversation's key, and still
    // requires legacy evidence: the probe leg was consulted this turn and
    // answered from a real (compressed) legacy index. Even so, the probe
    // itself warms a legacy index server-side, so evidence from one
    // conversation says nothing about any other — a pre-upgrade session
    // /resume'd later in this run keeps its own probe armed regardless of
    // how many fresh conversations have caught up.
    if (!shouldProbeLegacyMemtree(canonicalResult, msgsForMemtree)) {
      // Compressed, usable, and a small measured unindexed tail
      // (shouldProbe returns true for every weaker outcome): the canonical
      // index has caught up against a real legacy index, so the
      // concurrently fetched legacy result is deliberately ignored and this
      // conversation's later turns skip the probe entirely.
      markLegacyMigrationComplete(state, migrationKey);
    } else if (
      isBetterLegacyMemtreeResult(
        canonicalResult,
        msgsForMemtree,
        legacyResult,
        rawMsgsForMemtree
      )
    ) {
      result = legacyResult;
      usedLegacyFallback = true;
    } else if (
      didMemtreeCompress(canonicalResult) &&
      checkCompressedHistory(canonicalResult, msgsForMemtree).usable &&
      unindexedPromptTokenCount(canonicalResult) !== undefined &&
      unindexedPromptTokenCount(legacyResult) !== undefined
    ) {
      // Ending the migration also needs a real contest on the canonical
      // side: a compressed, usable canonical answer that beat the legacy
      // index it was probed against, with BOTH tails actually measured.
      // An unusable empty-memory canonical answer must not end it, and
      // neither may a "win" isBetterLegacyMemtreeResult awarded only
      // because raw_prompt_tokens was absent from both responses — an
      // unmeasured contest is no contest.
      markLegacyMigrationComplete(state, migrationKey);
    }
  }
  // Overall wall time of the blocking compress step (both concurrent legs) —
  // what reqlog documents for compress.ms.
  const compressMs = Date.now() - compressStarted;
  const hadLiveSuccess =
    (!canonicalCached && canonicalResult !== null) ||
    (probeLegacy && !legacyCached && legacyResult !== null);
  const hadLiveFailure =
    (!canonicalCached && canonicalResult === null) ||
    (probeLegacy && !legacyCached && legacyResult === null);
  rec.compress = {
    ms: compressMs,
    ok: result !== null,
    // Budget-consumed heuristic on the CANONICAL leg: the client maps every
    // failure to null, so a canonical null whose OWN leg took (roughly) the
    // whole abort budget was almost certainly the AbortSignal timeout, not a
    // fast server error. Timed per-leg rather than from the Promise.all wall
    // time so a slow legacy probe cannot make a fast canonical failure look
    // like a timeout, and computed from the canonical outcome rather than
    // the post-swap result so a legacy-probe rescue (ok stays true) still
    // records that the canonical leg burned the full budget.
    timedOut:
      canonicalCompressFailed &&
      canonicalCompressMs >= opts.memtree.compressBudgetMs,
    ...(usedLegacyFallback ? { legacyFallback: true } : {}),
  };
  return {
    result,
    usedLegacyFallback,
    winningInput: usedLegacyFallback ? rawMsgsForMemtree : msgsForMemtree,
    // A live success is stronger evidence than a simultaneous live failure:
    // the service answered this proxy now. Cached-only operations leave the
    // existing fuse state untouched.
    liveHealth: hadLiveSuccess
      ? "success"
      : hadLiveFailure
        ? "failure"
        : "none",
  };
}

/**
 * Shared final request shape for a validated compression result: lift any
 * returned system message to `body.system`, flatten the rest to the single
 * user message Anthropic receives. Route candidates must be created from this
 * `compressedBody` — never from raw `result.messages` — so tool-turn rewrites
 * extend exactly the bytes that were sent.
 */
function buildCompressedBody(
  body: Record<string, any>,
  result: CompressResult
): { compressedBody: Record<string, any>; compressedRaw: Buffer } {
  const processed = result.messages;
  const systemMsg = processed.find((m) => m.role === "system");
  const compressedBody: Record<string, any> = {
    ...body,
    messages: flattenToSingleUserMessage(processed),
  };
  if (systemMsg?.content != null) {
    compressedBody.system = systemMsg.content;
  }
  return {
    compressedBody,
    compressedRaw: Buffer.from(JSON.stringify(compressedBody), "utf-8"),
  };
}

/**
 * Best-effort recovery for a large main tool turn whose memory route missed
 * (missing slot or same-session rejection): one blocking recompression
 * attempt, sharing the followup path's complete selection pipeline. This is
 * a soft fuse — any failure, no-op, unusable, or non-shrinking result
 * degrades to forwarding the original body, never worse than the verbatim
 * path it replaces. A validated smaller result forwards exactly one
 * compressed Anthropic leg (never A/B — launching a full-history leg would
 * defeat the recovery), claims no human-turn state (no notice, no prompt
 * arm/delivery mutation), and installs a self-healing route at
 * protocol-complete so the rest of the tool loop rides locally again.
 */
async function recoverToolRouteMiss(args: {
  opts: ProxyOptions;
  state: ProxyState;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  upstream: Upstream;
  body: Record<string, any>;
  messages: Message[];
  forwardBody: Buffer;
  msgsForMemtree: Message[];
  rawMsgsForMemtree: Message[];
  hash: string;
  legacyHash: string;
  modelContextLimit: number;
  routeEpoch: number;
  rec: MessagesRecord;
  conversationBytes: number;
  routeKey: string;
  isMainRequest: boolean;
}): Promise<void> {
  const {
    opts,
    state,
    req,
    res,
    upstream,
    body,
    messages,
    forwardBody,
    msgsForMemtree,
    rawMsgsForMemtree,
    hash,
    legacyHash,
    modelContextLimit,
    routeEpoch,
    rec,
    conversationBytes,
    routeKey,
    isMainRequest,
  } = args;

  const sessionId = requestSessionId(req);
  // A pending MAIN prompt arm/retry window means a typed prompt may arrive
  // merged into a tool_result wrapper: recovery-turn classification uses
  // route absence as a rideability signal, so an intermediate main wrapper
  // must not install a route that vetoes the real merged-prompt request.
  // Captured ONCE here: the attempt stays transform-only even if the window
  // happens to close before its response settles.
  // The ARM alone, deliberately not the followup path's full
  // `mainPromptArmed || !mainPromptDelivered` window. `mainPromptDelivered`
  // means "the response stream flushed", which is strictly stronger than
  // "the client got the message": the fast-tool abort documented below at the
  // A/B settle — Claude consumes message_stop, drops the SSE, and fires its
  // tool request — is a normal success that leaves the flag false for the
  // REST of the agent turn (only Stop resets it). Keying recovery off that
  // window meant one such abort plus one later route rejection made every
  // subsequent large tool turn transform-only: a full blocking compress per
  // tool turn, no route ever installed, and no cooldown to bound it because
  // every attempt succeeded — the exact per-tool-turn cost this fuse exists
  // to prevent. Hookless embedders, where nothing ever sets the flag, were
  // stranded the same way from the first request.
  //
  // Dropping that half is safe because the merged-prompt hazard it guarded
  // cannot coexist with a main tool-result turn. Being here at all proves a
  // main response reached the client and produced a tool_use; the only
  // undelivered prompt that could still arrive merged into a tool_result
  // wrapper is one whose request has not been classified yet, and that is
  // precisely what the arm marks. An unflushed retry (5xx) is likewise
  // unreachable: its client holds no new tool_use to send meanwhile, so no
  // recovery can install a route that would veto the retry's
  // recovery-prompt classification.
  // The armed prompt belongs only to the main lane. An attributed agent's
  // route cannot veto main's merged-prompt classification, so suppressing the
  // agent install here would merely strand its tool loop after spending the
  // lane's one recovery attempt.
  const promptWindowPending = isMainRequest && state.mainPromptArmed;
  // Every identity owns its own lane now, so the only transform-only reasons
  // left are local to this request: no session id to safely match a later
  // ride against, or the merged-prompt window above. The foreign-owner and
  // subagent carve-outs are gone because the hazard they defended against is
  // structurally unreachable — a request's key can only name its own lane.
  const routeOwning = sessionId !== undefined && !promptWindowPending;
  // Only a route-owning recovery reserves the decision generation. A
  // transform-only attempt must not advance it — and, reciprocally, its late
  // completion can never install over (or clear) a route someone else
  // installed after this miss began, because it never activates at all.
  const decisionGeneration = routeOwning
    ? ++state.mainRouteDecisionGeneration
    : state.mainRouteDecisionGeneration;
  if (routeOwning) reserveRouteDecision(state, routeKey, decisionGeneration);
  // A reservation that ends up installing nothing must be RETURNED. It was
  // taken before the outcome was known, and while held it marks stale every
  // concurrent install and post-await clear that captured the previous
  // generation. Failing to release it means a failed/no-op/no-gain/
  // client-closed recovery silently suppresses a concurrent followup's
  // install, leaving the conversation with no route at all. Dropping our own
  // entry is unconditional and order-independent: it never moves anyone
  // else's reservation, so releasing before or after a newer sibling makes no
  // difference to who holds the decision.
  const releaseOwnReservation = () => {
    if (routeOwning) releaseRouteDecision(state, routeKey, decisionGeneration);
  };

  // Same downstream-close tracking as the followup path: compression
  // promises are hash-deduped and may serve another live retry, so the
  // subscriber's lifetime is tracked locally, never fed into compress().
  let downstreamClosedDuringCompression =
    res.destroyed && !res.writableFinished;
  const markDownstreamClosed = () => {
    if (!res.writableFinished) downstreamClosedDuringCompression = true;
  };
  res.once("close", markDownstreamClosed);
  let compression: BlockingCompressionOutcome;
  try {
    compression = await runBlockingCompression({
      opts,
      state,
      req,
      body,
      messages,
      msgsForMemtree,
      rawMsgsForMemtree,
      hash,
      legacyHash,
      modelContextLimit,
      rec,
    });
  } catch (err) {
    // Nothing in the pipeline is expected to throw (compress() maps every
    // failure to null), but a reservation held by a dead attempt suppresses
    // every concurrent install for the rest of the epoch — the same hole the
    // release exists to close. Hand it back before the error propagates.
    releaseOwnReservation();
    throw err;
  } finally {
    res.off("close", markDownstreamClosed);
  }
  const { result } = compression;
  // Every lane writes the shared cooldown now: with subagents on the same
  // recovery path, a subagent's compress failure is the same evidence about
  // MemTree's health as main's, and its successes clear the cooldown too.
  noteMemtreeHealth(state, compression);

  if (
    downstreamClosedDuringCompression ||
    (res.destroyed && !res.writableFinished)
  ) {
    // The MemTree work keeps its cache/index value, but a dead client gets
    // no Anthropic request and no route.
    rec.routeRecovery = { conversationBytes, outcome: "client-closed" };
    releaseOwnReservation();
    recordTurn(rec, "tool", Buffer.alloc(0));
    return;
  }

  const forwardOriginal = () => {
    capture(opts, "anthropic-request", forwardBody);
    return forwardRaw(
      req,
      res,
      forwardBody,
      opts,
      upstream,
      state.shutdownSignal,
      rec
    ).then(() => undefined);
  };

  if (!result) {
    rec.routeRecovery = { conversationBytes, outcome: "failed" };
    releaseOwnReservation();
    recordTurn(rec, "tool", forwardBody);
    // An ordinary server/network failure or timeout retains the background
    // submission: its longer independent budget can still warm the index for
    // a later turn. An unpaid key (402, possibly set by this very compress)
    // or a shutting-down proxy gets no retry.
    if (
      !state.shutdownSignal.aborted &&
      opts.memtree.paymentRequiredDetail === null
    ) {
      opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit);
    }
    return forwardOriginal();
  }

  // Any non-null response already submitted this history to the server; an
  // extra indexInBackground for the same request would be a duplicate.
  const actuallyCompressed = didMemtreeCompress(result);
  const historyCheck = checkCompressedHistory(result, compression.winningInput);
  rec.history = {
    retainedChars: historyCheck.retainedChars,
    priorHistoryChars: historyCheck.priorHistoryChars,
    usable: historyCheck.usable,
  };
  if (!actuallyCompressed || !historyCheck.usable) {
    // Index-warming no-op (flattening it would change structured history for
    // nothing) or an indexed answer that dropped the conversation (amnesia —
    // fatal for a route). Both preserve the original body.
    rec.routeRecovery = {
      conversationBytes,
      outcome: actuallyCompressed ? "unusable" : "noop",
    };
    releaseOwnReservation();
    recordTurn(rec, "tool", forwardBody);
    return forwardOriginal();
  }

  // Serializing the compressed body is the one synchronous step here that can
  // realistically throw: these are the multi-megabyte payloads that court
  // V8's string-length ceiling, which is exactly why this fuse exists. A
  // throw would otherwise escape as a proxy 500 AND strand the reservation,
  // turning a recoverable tool turn into a failed one. Degrade instead — the
  // original body is still forwardable.
  let built: { compressedBody: Record<string, any>; compressedRaw: Buffer };
  try {
    built = buildCompressedBody(body, result);
  } catch (err) {
    rec.routeRecovery = { conversationBytes, outcome: "build-failed" };
    releaseOwnReservation();
    recordTurn(rec, "tool", forwardBody);
    if (opts.debug) {
      console.error(
        `[ccc proxy] recovered body build failed: ${
          (err as Error)?.message ?? err
        }`
      );
    }
    return forwardOriginal();
  }
  const { compressedBody, compressedRaw } = built;
  if (compressedRaw.length >= forwardBody.length) {
    // The final transformed body is the proof of payload recovery; a result
    // with no byte gain is not worth a route built on it.
    rec.routeRecovery = { conversationBytes, outcome: "no-gain" };
    releaseOwnReservation();
    recordTurn(rec, "tool", forwardBody);
    return forwardOriginal();
  }

  rec.routeRecovery = { conversationBytes, outcome: "compressed" };
  let activationAttempted = false;
  let installFate: "installed" | "stale" | undefined;
  const activateRecoveredRoute = () => {
    if (activationAttempted) return;
    if (!routeOwning) {
      activationAttempted = true;
      return;
    }
    // No staleness pre-check: installMemoryRoute applies the identical epoch
    // and decision-generation guard as its first act, before its sessionless
    // clear, and a false return classifies as "stale" below.
    const installed = installMemoryRoute(
      state,
      routeKey,
      req,
      body,
      messages,
      compressedBody,
      routeEpoch,
      decisionGeneration
    );
    // Leave this false if installMemoryRoute unexpectedly throws: the
    // delivery-complete fallback then gets one safe retry.
    activationAttempted = true;
    installFate = installed ? "installed" : "stale";
    if (opts.debug) {
      console.error(
        `[ccc proxy] recovered memory route activation: ${
          installed ? "installed" : "unavailable"
        }`
      );
    }
  };

  if (opts.debug) {
    console.error(
      `[ccc proxy] tool-route miss recovered: ${forwardBody.length} → ` +
        `${compressedRaw.length} body bytes`
    );
  }
  recordTurn(rec, "tool-recompressed", compressedRaw);
  // Tagged as a TOOL memory leg, not a followup one: capture-based tooling
  // must be able to tell a recovered tool request from a normal compressed
  // human turn without cross-referencing reqlog.
  capture(opts, "anthropic-request-memory-tool", compressedRaw);
  const delivered = await forwardRaw(
    req,
    res,
    compressedRaw,
    opts,
    upstream,
    state.shutdownSignal,
    rec,
    undefined,
    // Protocol-complete (accepted SSE message_stop or a complete 2xx JSON
    // response) is the real activation point, exactly as on the followup
    // path, so a fast tool request right after message_stop can ride.
    activateRecoveredRoute
  );
  // Defensive delivery-complete fallback, mirroring the followup path. A
  // candidate already activated at message_stop deliberately survives a
  // delivered=false settle (fast-tool abort); an upstream 500/529 or an
  // incomplete response never reached protocol-complete and never installs.
  if (delivered) activateRecoveredRoute();
  rec.routeRecovery.install = !routeOwning
    ? sessionId === undefined
      ? "no-session"
      : "prompt-pending"
    : installFate ?? "upstream-failed";
  // A reservation that lost its race (stale) or never reached
  // protocol-complete (upstream 5xx, truncated stream) installed nothing, so
  // it must stop suppressing whoever is still trying to install.
  if (rec.routeRecovery.install !== "installed") releaseOwnReservation();
}

/** Stamp the classified turn type and forwarded-size fields on the record. */
function recordTurn(
  rec: MessagesRecord,
  turnType: MessagesRecord["turnType"],
  forwardBody: Buffer
): void {
  rec.turnType = turnType;
  rec.forwardedBytes = forwardBody.length;
  rec.approxInputTokens = approxTokensFromBytes(forwardBody.length);
}

function headerText(
  headers: http.IncomingHttpHeaders,
  name: string
): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

/**
 * count_tokens: strip notices and mirror an active memory route during its
 * tool loop. The response itself remains byte-transparent.
 */
async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream,
  state: ProxyState
): Promise<void> {
  const rawBody = await readBody(req);
  let forwardBody = rawBody;
  try {
    const body = JSON.parse(rawBody.toString("utf-8"));
    if (Array.isArray(body.messages)) {
      const stripped = stripNoticeBlocks(body.messages);
      const strippedSystem = stripNoticeSystem(body.system);
      if (stripped.stripped || strippedSystem.stripped) {
        body.messages = stripped.messages;
        if (strippedSystem.system === undefined) delete body.system;
        else body.system = strippedSystem.system;
        forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
      }
      const lastMsg = lastNonSystemMessage(body.messages);
      // A tool_result tail is never an away-summary probe, so the lane key
      // only distinguishes main vs agent identity here.
      const countRoute = isToolResultUserMessage(lastMsg)
        ? getMemoryRoute(state, routeIdentity(req, false).key)
        : undefined;
      if (countRoute) {
        const routed = memoryRoutedToolBody(
          body,
          body.messages,
          countRoute,
          state.mainRouteEpoch,
          requestSessionId(req)
        );
        if (routed) forwardBody = routed;
      }
    }
  } catch {
    // Unknown shape: forward verbatim.
  }
  return forwardRaw(
    req,
    res,
    forwardBody,
    opts,
    upstream,
    state.shutdownSignal,
    undefined
  ).then(() => undefined);
}

interface ComparedSseArgs {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  opts: ProxyOptions;
  upstream: Upstream;
  routing: ResolvedAbRoutingOptions;
  memoryBody: Buffer;
  fullBody: Buffer;
  question: string;
  unfoldedMemory: string;
  model: string;
  rec: MessagesRecord;
  /** Request-received timestamp so delivery-complete can stamp rec.totalMs. */
  receivedAt: number;
  /** Proxy-wide forced-shutdown signal, observed by both comparison modes. */
  shutdownSignal: AbortSignal;
  /** Buffered mode only; speculative mode reports through onDeliveryComplete. */
  onDecision: (winner: AbWinner, selectedAlreadyComplete: boolean) => void;
  onDeliveryComplete: (delivered: ComparisonDelivered, ok: boolean) => void;
}

/**
 * Live memory-vs-full comparison. Buffered mode is the default and holds both
 * prefixes until the grader selects a leg. Explicit speculative mode commits
 * the memory leg from its first byte and treats a B verdict as an in-stream
 * interruption.
 */
async function forwardComparedSse(args: ComparedSseArgs): Promise<void> {
  if (args.routing.speculative) return forwardSpeculativeSse(args);
  return forwardBufferedComparedSse(args);
}

/** Buffer two live SSE legs, grade their semantic prefixes, then commit one. */
async function forwardBufferedComparedSse(args: ComparedSseArgs): Promise<void> {
  const {
    req,
    res,
    opts,
    upstream,
    routing,
    memoryBody,
    fullBody,
    question,
    unfoldedMemory,
    model,
    rec,
    shutdownSignal,
    onDecision,
    onDeliveryComplete,
  } = args;
  const comparison = rec.comparison!;
  comparison.prefixChars = routing.prefixChars;
  const memoryRecord: ComparisonLegRecord = { requestBytes: memoryBody.length };
  const fullRecord: ComparisonLegRecord = { requestBytes: fullBody.length };
  comparison.memoryLeg = memoryRecord;
  comparison.fullLeg = fullRecord;
  rec.turnType = "followup-ab-pending";

  capture(opts, "anthropic-request-memory", memoryBody);
  capture(opts, "anthropic-request-full", fullBody);

  const memoryLeg = new BufferedUpstreamLeg({
    name: "memory",
    req,
    body: memoryBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: memoryRecord,
  });
  const fullLeg = new BufferedUpstreamLeg({
    name: "full",
    req,
    body: fullBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: fullRecord,
  });
  const decisionAbort = new AbortController();
  let clientClosed = false;
  let shutdownCancelled = false;
  const abortAll = () => {
    if (!res.writableFinished && !shutdownCancelled) {
      clientClosed = true;
      comparison.clientAborted = true;
    }
    decisionAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
  };
  res.once("close", abortAll);
  const cancelForShutdown = () => {
    if (shutdownCancelled || res.writableFinished) return;
    shutdownCancelled = true;
    comparison.fallbackReason ??= "shutdown-cancelled";
    comparison.delivered ??= "none";
    comparison.deliveryOk = false;
    rec.turnType = "followup-ab-failed";
    decisionAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    // Proxy shutdown is not a downstream/client abort. Remove that classifier
    // before the shared request registry tears down the response socket.
    res.off("close", abortAll);
    if (!res.destroyed && !res.writableEnded) res.destroy();
  };
  shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
  if (shutdownSignal.aborted) cancelForShutdown();

  try {
    if (shutdownCancelled) return;
    memoryLeg.start();
    fullLeg.start();

    const prefixStarted = Date.now();
    const prefixesReady = await waitForBothPrefixes(
      memoryLeg,
      fullLeg,
      routing.prefixTimeoutMs,
      decisionAbort.signal
    );
    comparison.prefixWaitMs = Date.now() - prefixStarted;
    if (clientClosed || res.destroyed) return;

    let winner: AbWinner = "memory";
    let verdict: FusionVerdict | undefined;
    let fallbackReason: string | undefined;
    const memoryHealthy = memoryLeg.isHealthy();
    const fullHealthy = fullLeg.isHealthy();

    if (!prefixesReady) {
      const memoryReady = memoryLeg.isPrefixReadyAndHealthy();
      const fullReady = fullLeg.isPrefixReadyAndHealthy();
      if (fullReady && !memoryReady) {
        winner = "full";
        fallbackReason = "memory-prefix-timeout";
      } else if (memoryReady) {
        fallbackReason = "full-prefix-timeout";
      } else if (
        !memoryHealthy &&
        (fullHealthy || (memoryLeg.hasFailed() && !fullLeg.hasFailed()))
      ) {
        winner = "full";
        fallbackReason = "memory-leg-failed-before-prefix";
      } else {
        // The prefix timer is not an upstream timeout. Extended thinking can
        // legitimately exceed it without producing gradable answer text, so
        // stop comparing and continue the preferred in-flight memory request.
        fallbackReason = "prefix-timeout-default-memory";
      }
    } else if (!memoryHealthy && fullHealthy) {
      winner = "full";
      fallbackReason = "memory-leg-failed";
    } else if (memoryHealthy && !fullHealthy) {
      fallbackReason = "full-leg-failed";
    } else if (!memoryHealthy && !fullHealthy) {
      fallbackReason = "both-legs-failed";
    } else {
      const gradeStarted = Date.now();
      const graderModel = routing.graderModelFor(model);
      const graderDiagnostic: GraderDiagnostic = {
        model: routing.grader ? "injected" : graderModel,
        ok: false,
      };
      comparison.grader = graderDiagnostic;
      const gradeOutcome = await gradeComparedPrefixes({
        req,
        upstream,
        routing,
        input: {
          question,
          unfoldedMemory,
          memoryResponse: memoryLeg.semanticForGrading(),
          fullResponse: fullLeg.semanticForGrading(),
          model,
          signal: decisionAbort.signal,
        },
        overflow: Promise.race([
          memoryLeg.bufferOverflow,
          fullLeg.bufferOverflow,
        ]),
        parentSignal: decisionAbort.signal,
        diagnostic: graderDiagnostic,
        graderModel,
      });
      comparison.gradeMs = Date.now() - gradeStarted;
      if (gradeOutcome.verdict) {
        graderDiagnostic.ok = true;
        verdict = gradeOutcome.verdict;
        winner = winnerForVerdict(verdict.verdict);
      } else {
        fallbackReason = gradeOutcome.reason ?? "grader-failed";
        graderDiagnostic.error ??= fallbackReason;
      }
    }

    if (clientClosed || res.destroyed) return;
    // A leg can fail while the grader is running. Never commit a failed selected
    // arm when its peer is still healthy.
    const memoryFailed = memoryLeg.hasFailed();
    const fullFailed = fullLeg.hasFailed();
    if (winner === "memory" && memoryFailed && !fullFailed) {
      winner = "full";
      fallbackReason = "memory-leg-failed-after-grade";
    } else if (winner === "full" && fullFailed && !memoryFailed) {
      winner = "memory";
      fallbackReason = "full-leg-failed-after-grade";
    } else if (memoryFailed && fullFailed) {
      fallbackReason = "both-legs-failed";
    }
    let selected = winner === "memory" ? memoryLeg : fullLeg;
    let discarded = winner === "memory" ? fullLeg : memoryLeg;
    if (!selected.hasHealthyFallbackEvidence()) {
      // A prefix timeout can fire while one arm has only bare 2xx headers (or
      // both calls are still pending). Keep both alive until one produces a
      // healthy semantic prefix, a complete short response, or valid SSE work
      // (including extended thinking); headers alone do not justify destroying
      // the only fallback.
      const responsive = await firstHealthyFallbackEvidence(
        selected,
        discarded,
        decisionAbort.signal
      );
      if (!responsive || clientClosed || res.destroyed) return;
      if (responsive !== selected) {
        const previousWinner = winner;
        winner = winner === "memory" ? "full" : "memory";
        fallbackReason = selected.hasFailed()
          ? `${previousWinner}-leg-failed-before-commit`
          : `${previousWinner}-no-progress-before-commit`;
        selected = responsive;
        discarded = winner === "memory" ? fullLeg : memoryLeg;
      }
    }
    comparison.verdict = verdict?.verdict;
    comparison.winner = winner;
    comparison.fallbackReason = fallbackReason;
    comparison.loserAborted = discarded.abort();
    recordTurn(
      rec,
      winner === "memory" ? "followup-ab-memory" : "followup-ab-full",
      winner === "memory" ? memoryBody : fullBody
    );
    if (selected.hasFailed()) rec.turnType = "followup-ab-failed";
    copyWinnerObservation(rec, selected.record);
    let decisionNotified = false;
    const notifyDecision = () => {
      if (decisionNotified || !selected.isHealthy()) return;
      decisionNotified = true;
      try {
        onDecision(winner, selected.completedSuccessfully());
      } catch {
        // UI/route bookkeeping can never prevent delivery of the chosen response.
      }
    };
    notifyDecision();
    if (opts.debug) {
      console.error(
        `[ccc proxy] A/B routed ${winner}` +
          `${verdict ? ` (verdict ${verdict.verdict})` : ""}` +
          `${fallbackReason ? ` (${fallbackReason})` : ""}`
      );
    }

    decisionAbort.abort();
    const delivered = await selected.commitTo(res, notifyDecision);
    if (shutdownCancelled) return;
    copyWinnerObservation(rec, selected.record);
    comparison.delivered = winner;
    comparison.deliveryOk = delivered;
    if (!delivered) rec.turnType = "followup-ab-failed";
    try {
      onDeliveryComplete(winner, delivered);
    } catch {
      // Route bookkeeping is best-effort and never changes delivered bytes.
    }
  } finally {
    decisionAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    res.off("close", abortAll);
    shutdownSignal.removeEventListener("abort", cancelForShutdown);
  }
}

/**
 * Speculative A/B delivery (plans/2026-07-17_PLAN_speculative_ab_streaming.md):
 * commit the memory leg (A) to the client from its first sign of stream
 * progress through an event-aligned forwarder; grade both semantic prefixes
 * OFF the delivery path; and if the shadow verdict is B while the interrupt
 * window is still open, splice the full leg (B) into A's message envelope —
 * closing A's open block, emitting a model-visible bridge text block, and
 * replaying B's content with renumbered indices. A short answer that finishes
 * before B can be graded simply stands, and the late verdict is logged for
 * effective-context priors.
 */
async function forwardSpeculativeSse(args: ComparedSseArgs): Promise<void> {
  const {
    req,
    res,
    opts,
    upstream,
    routing,
    memoryBody,
    fullBody,
    question,
    unfoldedMemory,
    model,
    rec,
    receivedAt,
    shutdownSignal,
    onDeliveryComplete,
  } = args;
  const comparison = rec.comparison!;
  comparison.prefixChars = routing.prefixChars;
  comparison.speculative = true;
  comparison.interrupt = "none";
  const memoryRecord: ComparisonLegRecord = { requestBytes: memoryBody.length };
  const fullRecord: ComparisonLegRecord = { requestBytes: fullBody.length };
  comparison.memoryLeg = memoryRecord;
  comparison.fullLeg = fullRecord;
  rec.turnType = "followup-ab-pending";

  capture(opts, "anthropic-request-memory", memoryBody);
  capture(opts, "anthropic-request-full", fullBody);

  const started = Date.now();
  const memoryLeg = new BufferedUpstreamLeg({
    name: "memory",
    req,
    body: memoryBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: memoryRecord,
  });
  const fullLeg = new BufferedUpstreamLeg({
    name: "full",
    req,
    body: fullBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: fullRecord,
  });

  // Unlike buffered mode, this controller cancels GRADING only — delivery is
  // already committed. A client abort still tears down everything.
  const graderAbort = new AbortController();
  let clientClosed = false;

  // ---- interrupt-window state machine -------------------------------------
  let committedLeg: AbWinner | null = null;
  let forwarder: SseEventForwarder | null = null;
  let spliceStarted = false;
  let pendingDeferredSplice = false;
  let recoveryStarted = false;
  let shadowSettled = false;
  let deliverySettled = false;
  let shutdownCancelled = false;
  let resolveDelivery!: () => void;
  const deliveryDone = new Promise<void>((r) => (resolveDelivery = r));

  const currentDeliveredKind = (): ComparisonDelivered => {
    if (spliceStarted) {
      return comparison.interrupt === "recovered" ? "recovered" : "spliced";
    }
    if (committedLeg === "full") return "full";
    if (committedLeg === "memory") return "memory";
    return "none";
  };

  const finishDelivery = (delivered: ComparisonDelivered, ok: boolean): void => {
    if (deliverySettled) return;
    deliverySettled = true;
    comparison.delivered = delivered;
    comparison.deliveryOk = ok;
    const turnType: TurnType = !ok
      ? "followup-ab-failed"
      : delivered === "memory"
        ? "followup-ab-memory"
        : delivered === "full"
          ? "followup-ab-full"
          : delivered === "spliced"
            ? "followup-ab-spliced"
            : delivered === "recovered"
              ? "followup-ab-recovered"
              : "followup-ab-failed";
    recordTurn(
      rec,
      turnType,
      delivered === "memory" || delivered === "none" ? memoryBody : fullBody
    );
    copyWinnerObservation(
      rec,
      delivered === "memory" || delivered === "none"
        ? memoryRecord
        : fullRecord
    );
    rec.totalMs = Date.now() - receivedAt;
    if (opts.debug) {
      console.error(
        `[ccc proxy] A/B speculative delivered ${delivered}` +
          ` (ok=${ok}, interrupt=${comparison.interrupt})`
      );
    }
    try {
      onDeliveryComplete(delivered, ok);
    } catch {
      // Route/notice bookkeeping can never affect delivered bytes.
    }
    resolveDelivery();
  };

  const abortAll = () => {
    // res "close" also follows a NORMAL finish; the shadow grade deliberately
    // outlives delivery (late verdicts feed effective-context priors), so
    // only an abnormal close tears everything down.
    if (res.writableFinished || shutdownCancelled) return;
    if (!deliverySettled) {
      clientClosed = true;
      comparison.clientAborted = true;
    }
    graderAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    finishDelivery(currentDeliveredKind(), false);
  };
  res.once("close", abortAll);

  const cancelForShutdown = (): void => {
    if (shutdownCancelled) return;
    shutdownCancelled = true;
    comparison.fallbackReason ??= deliverySettled
      ? "shutdown-shadow-cancelled"
      : "shutdown-delivery-cancelled";
    graderAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    if (!deliverySettled) {
      // This is proxy-owned cancellation, not a client abort. Detach the
      // close classifier before terminating any still-open downstream body.
      res.off("close", abortAll);
      if (!res.destroyed) res.destroy();
      finishDelivery(currentDeliveredKind(), false);
    }
  };
  shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
  if (shutdownSignal.aborted) cancelForShutdown();

  const writeToClient = (bytes: string): boolean => {
    if (res.destroyed || res.writableEnded) return true;
    return res.write(bytes);
  };

  /**
   * Abort B only after it is no longer needed by either consumer: the shadow
   * grade has settled and A has reached a clean downstream finish. Until that
   * point B remains A's mid-stream recovery candidate, even when the verdict
   * already selected A/tie or grading failed.
   */
  const releaseFullLeg = () => {
    if (
      shadowSettled &&
      deliverySettled &&
      comparison.delivered === "memory" &&
      comparison.deliveryOk === true &&
      committedLeg === "memory" &&
      !spliceStarted &&
      !pendingDeferredSplice &&
      !recoveryStarted
    ) {
      comparison.loserAborted = fullLeg.abort();
    }
  };

  const markFullLegNotSse = (): void => {
    comparison.interrupt = "blocked-full-not-sse";
    comparison.fallbackReason = "full-leg-not-sse";
  };

  /** Replay B into A's open envelope after the bridge block. */
  const replayFullLeg = (
    startIndex: number,
    kind: "spliced" | "recovered"
  ): void => {
    // Defense in depth: a JSON message can be healthy for whole-response
    // failover and grading, but the SSE splice writer cannot embed it in A's
    // already-open event envelope.
    if (!fullLeg.isSseResponse()) {
      markFullLegNotSse();
      failDelivery();
      return;
    }
    const writer = new SseSpliceWriter({ startIndex });
    fullLeg.streamTo({
      write: (chunk) => writeToClient(writer.push(chunk)),
      end: () => {
        writer.flush();
        const ok = fullLeg.completedSuccessfully();
        if (ok) {
          if (!res.destroyed && !res.writableEnded) res.end();
        } else if (!res.destroyed) {
          res.destroy();
        }
        void waitForResponseFinishOrClose(res).then((flushed) =>
          finishDelivery(kind, flushed && ok)
        );
      },
      drain: (resume) => res.once("drain", resume),
    });
  };

  const performSplice = (interrupt: ComparisonInterrupt): void => {
    if (spliceStarted || !forwarder || clientClosed) return;
    // Check before stopping A or fabricating a bridge. A B verdict with a
    // non-SSE B is safely blocked; recovery has no valid continuation and
    // must fail the delivery without emitting misleading bridge-only output.
    if (!fullLeg.isSseResponse()) {
      pendingDeferredSplice = false;
      markFullLegNotSse();
      if (interrupt === "recovered") failDelivery();
      return;
    }
    spliceStarted = true;
    pendingDeferredSplice = false;
    comparison.interrupt = interrupt;
    comparison.spliceAtChars = forwarder.textChars;
    const openBlock = forwarder.openBlock;
    const bridgeIndex = forwarder.maxIndex + 1;
    forwarder.stop();
    comparison.loserAborted = memoryLeg.abort() || undefined;
    if (opts.debug) {
      console.error(`[ccc proxy] A/B splice (${interrupt}) at block ${bridgeIndex}`);
    }
    let head = "";
    if (openBlock) head += contentBlockStopEvent(openBlock.index);
    head += bridgeBlockEvents(
      bridgeIndex,
      interrupt === "recovered" ? RECOVERY_BRIDGE_TEXT : routing.bridgeText
    );
    const beginReplay = () => {
      if (clientClosed || res.destroyed || res.writableEnded) return;
      replayFullLeg(
        bridgeIndex + 1,
        interrupt === "recovered" ? "recovered" : "spliced"
      );
    };
    // write(false) accepted the whole fabricated head, but B must remain
    // private until that head drains or its replay can overtake backpressure.
    if (writeToClient(head)) beginReplay();
    else res.once("drain", beginReplay);
  };

  /** Apply a B verdict against the interrupt-window table. */
  const attemptInterrupt = () => {
    if (
      clientClosed ||
      spliceStarted ||
      pendingDeferredSplice ||
      committedLeg !== "memory" ||
      !forwarder
    ) {
      return;
    }
    if (deliverySettled || forwarder.sawMessageDelta) {
      comparison.interrupt = "late-verdict";
      comparison.verdictLate = true;
      return;
    }
    const disposition = forwarder.interruptDisposition();
    if (disposition === "blocked") {
      // Any structured/non-text block can carry state that must not be cut in
      // half or mixed with B. Keep the established diagnostic for log readers.
      comparison.interrupt = "blocked-tool-use";
      return;
    }
    if (disposition === "defer") {
      // A partial thinking block lacks its signature_delta; truncating it
      // would poison replay. Wait for the block to close, then re-check.
      pendingDeferredSplice = true;
      return;
    }
    performSplice("spliced");
  };

  /** Deferred-splice re-check on the exact event boundary that closed a block. */
  const onForwardedEvent = (fwd: SseEventForwarder): void => {
    if (!pendingDeferredSplice || spliceStarted) return;
    const disposition = fwd.interruptDisposition();
    if (disposition === "blocked") {
      pendingDeferredSplice = false;
      comparison.interrupt = "blocked-tool-use";
      releaseFullLeg();
      return;
    }
    if (fwd.sawMessageDelta) {
      pendingDeferredSplice = false;
      comparison.interrupt = "late-verdict";
      comparison.verdictLate = true;
      releaseFullLeg();
      return;
    }
    if (disposition === "splice") performSplice("deferred-then-spliced");
  };

  /** A died or emitted a terminal error: healthy B can recover a safe prefix. */
  const recoverFromFullLeg = async (): Promise<void> => {
    if (recoveryStarted || spliceStarted || clientClosed || deliverySettled) {
      return;
    }
    recoveryStarted = true;
    if (
      !forwarder ||
      forwarder.sawMessageDelta ||
      forwarder.interruptDisposition() !== "splice"
    ) {
      // Structured content, unfinished signed thinking, or the closing
      // envelope is already on the wire. A synthetic stop would corrupt the
      // message, so terminate this delivery instead of splicing.
      failDelivery();
      return;
    }
    pendingDeferredSplice = false;
    await fullLeg.waitForFallbackEvidence();
    if (clientClosed || spliceStarted || deliverySettled) return;
    if (fullLeg.hasHealthyFallbackEvidence()) {
      performSplice("recovered");
    } else {
      failDelivery();
    }
  };

  const failDelivery = (): void => {
    if (!res.destroyed) res.destroy();
    finishDelivery(committedLeg === "memory" ? "memory" : "none", false);
  };

  /** A's upstream stream ended — cleanly or not. */
  const onMemoryStreamEnd = (): void => {
    if (spliceStarted || clientClosed || deliverySettled) return;
    if (forwarder?.sawMessageStop) {
      // The full message is on the wire; a late upstream hiccup is irrelevant.
      if (!res.destroyed && !res.writableEnded) res.end();
      void waitForResponseFinishOrClose(res).then((flushed) => {
        finishDelivery("memory", flushed);
        releaseFullLeg();
      });
      return;
    }
    void recoverFromFullLeg();
  };

  const commitMemory = async (): Promise<void> => {
    committedLeg = "memory";
    if (!memoryLeg.isSseResponse()) {
      // Degenerate upstream (JSON body on a stream request): raw passthrough.
      const ok = await memoryLeg.commitTo(res);
      finishDelivery("memory", ok);
      releaseFullLeg();
      return;
    }
    comparison.clientTtfbMs = Date.now() - started;
    memoryLeg.sendHeadTo(res);
    forwarder = new SseEventForwarder({
      write: writeToClient,
      afterEvent: onForwardedEvent,
      onTerminalError: () => void recoverFromFullLeg(),
    });
    const drainForwarder = (resume: () => void): void => {
      const resumeAfterClientDrain = (): void => {
        // A raw upstream chunk is not fully consumed until every parsed frame
        // it owned has crossed its own ServerResponse drain seam.
        if (!forwarder || forwarder.resumeAfterDrain()) resume();
        else res.once("drain", resumeAfterClientDrain);
      };
      res.once("drain", resumeAfterClientDrain);
    };
    memoryLeg.streamTo({
      write: (chunk) => forwarder!.push(chunk),
      end: onMemoryStreamEnd,
      drain: drainForwarder,
    });
    // If the shadow grade already finished (with no B verdict to apply), the
    // deferred release of B lands now that A owns the delivery.
    if (shadowSettled) releaseFullLeg();
    await deliveryDone;
  };

  const deliverWholeFullLeg = async (fallbackReason: string): Promise<void> => {
    committedLeg = "full";
    comparison.fallbackReason ??= fallbackReason;
    comparison.loserAborted = memoryLeg.abort();
    comparison.clientTtfbMs = Date.now() - started;
    const ok = await fullLeg.commitTo(res);
    finishDelivery("full", ok);
  };

  const deliverBothFailed = async (): Promise<void> => {
    fullLeg.abort();
    comparison.fallbackReason ??= "both-legs-failed";
    // Surface the memory leg's actual error response (or a synthetic 502).
    await memoryLeg.commitTo(res);
    finishDelivery("none", false);
  };

  /**
   * Pre-commit phase: the client is committed to A at its first sign of
   * stream progress; until then A can still be swapped for a whole-B
   * failover. A silent A past the prefix window yields to a producing B.
   */
  const waitForCommitChoice = async (): Promise<
    | { kind: "memory" }
    | { kind: "full"; reason: string }
    | { kind: "error" }
    | { kind: "closed" }
  > => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        memoryLeg.waitForFallbackEvidence(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, routing.prefixTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (clientClosed) return { kind: "closed" };
    if (memoryLeg.hasHealthyFallbackEvidence()) return { kind: "memory" };
    if (memoryLeg.isFallbackEvidenceSettled()) {
      // A failed (or ended empty) before any client-visible progress: today's
      // full failover, minus the wait.
      await fullLeg.waitForFallbackEvidence();
      if (clientClosed) return { kind: "closed" };
      return fullLeg.hasHealthyFallbackEvidence()
        ? { kind: "full", reason: "memory-leg-failed-before-prefix" }
        : { kind: "error" };
    }
    if (fullLeg.hasHealthyFallbackEvidence()) {
      return { kind: "full", reason: "memory-no-progress-before-commit" };
    }
    const responsive = await firstHealthyFallbackEvidence(
      memoryLeg,
      fullLeg,
      graderAbort.signal
    );
    if (!responsive || clientClosed) return { kind: "closed" };
    if (responsive === memoryLeg && memoryLeg.hasHealthyFallbackEvidence()) {
      return { kind: "memory" };
    }
    if (responsive === fullLeg && fullLeg.hasHealthyFallbackEvidence()) {
      return { kind: "full", reason: "memory-no-progress-before-commit" };
    }
    return { kind: "error" };
  };

  // ---- shadow grading ------------------------------------------------------
  const shadowGrade = async (): Promise<FusionVerdict | undefined> => {
    const prefixStarted = Date.now();
    const prefixesReady = await waitForBothPrefixes(
      memoryLeg,
      fullLeg,
      routing.prefixTimeoutMs,
      graderAbort.signal
    );
    comparison.prefixWaitMs = Date.now() - prefixStarted;
    if (clientClosed) return undefined;

    let verdict: FusionVerdict | undefined;
    let fallbackReason: string | undefined;
    const memoryHealthy = memoryLeg.isHealthy();
    const fullHealthy = fullLeg.isHealthy();
    if (!prefixesReady) {
      const memoryReady = memoryLeg.isPrefixReadyAndHealthy();
      const fullReady = fullLeg.isPrefixReadyAndHealthy();
      if (fullReady && !memoryReady) {
        fallbackReason = "memory-prefix-timeout";
      } else if (memoryReady) {
        fallbackReason = "full-prefix-timeout";
      } else if (
        !memoryHealthy &&
        (fullHealthy || (memoryLeg.hasFailed() && !fullLeg.hasFailed()))
      ) {
        fallbackReason = "memory-leg-failed-before-prefix";
      } else {
        fallbackReason = "prefix-timeout-default-memory";
      }
    } else if (!memoryHealthy && fullHealthy) {
      fallbackReason = "memory-leg-failed";
    } else if (memoryHealthy && !fullHealthy) {
      fallbackReason = "full-leg-failed";
    } else if (!memoryHealthy && !fullHealthy) {
      fallbackReason = "both-legs-failed";
    } else {
      const gradeStarted = Date.now();
      const graderModel = routing.graderModelFor(model);
      let attempt = 0;
      while (true) {
        const graderDiagnostic: GraderDiagnostic = {
          model: routing.grader ? "injected" : graderModel,
          ok: false,
        };
        comparison.grader = graderDiagnostic;
        const gradeOutcome = await gradeComparedPrefixes({
          req,
          upstream,
          routing,
          input: {
            question,
            unfoldedMemory,
            memoryResponse: memoryLeg.semanticForGrading(),
            fullResponse: fullLeg.semanticForGrading(),
            model,
            signal: graderAbort.signal,
          },
          overflow: Promise.race([
            memoryLeg.bufferOverflow,
            fullLeg.bufferOverflow,
          ]),
          parentSignal: graderAbort.signal,
          diagnostic: graderDiagnostic,
          graderModel,
        });
        if (gradeOutcome.verdict) {
          graderDiagnostic.ok = true;
          verdict = gradeOutcome.verdict;
          fallbackReason = undefined;
          break;
        }
        fallbackReason = gradeOutcome.reason ?? "grader-failed";
        graderDiagnostic.error ??= fallbackReason;
        // Off the delivery path, a 429 (both legs just saturated the org
        // limit) or network blip earns one retry with jittered backoff.
        const retryable =
          attempt === 0 &&
          fallbackReason === "grader-failed" &&
          (graderDiagnostic.status === undefined ||
            graderDiagnostic.status === 429) &&
          !graderAbort.signal.aborted;
        if (!retryable) break;
        attempt += 1;
        comparison.graderRetries = attempt;
        const backoff =
          routing.graderRetryMinDelayMs +
          Math.random() *
            (routing.graderRetryMaxDelayMs - routing.graderRetryMinDelayMs);
        if (!(await abortableDelay(backoff, graderAbort.signal))) break;
      }
      comparison.gradeMs = Date.now() - gradeStarted;
    }
    comparison.verdict = verdict?.verdict;
    comparison.fallbackReason ??= fallbackReason;
    if (opts.debug) {
      console.error(
        `[ccc proxy] A/B shadow grade ` +
          `${verdict ? `verdict ${verdict.verdict}` : `no verdict`}` +
          `${fallbackReason ? ` (${fallbackReason})` : ""}`
      );
    }
    return verdict;
  };

  try {
    if (!shutdownCancelled) {
      memoryLeg.start();
      fullLeg.start();
    }

    const deliveryTask = (async () => {
      const choice = await waitForCommitChoice();
      if (choice.kind === "closed" || shutdownCancelled) return;
      if (choice.kind === "memory") await commitMemory();
      else if (choice.kind === "full") await deliverWholeFullLeg(choice.reason);
      else await deliverBothFailed();
    })();

    const shadowTask = (async () => {
      const verdict = await shadowGrade();
      shadowSettled = true;
      if (verdict && winnerForVerdict(verdict.verdict) === "full") {
        attemptInterrupt();
      }
      // B has served its grading purpose, but remains A's recovery candidate
      // until A itself has completed cleanly.
      releaseFullLeg();
      return verdict;
    })();

    const [, verdict] = await Promise.all([deliveryTask, shadowTask]);
    comparison.winner =
      verdict !== undefined
        ? winnerForVerdict(verdict.verdict)
        : comparison.delivered === "full"
          ? "full"
          : "memory";
    // The deferred-splice window can outlive the shadow task; wait for the
    // delivery to settle before tearing the legs down.
    await deliveryDone;
  } finally {
    graderAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    res.off("close", abortAll);
    shutdownSignal.removeEventListener("abort", cancelForShutdown);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForBothPrefixes(
  memoryLeg: BufferedUpstreamLeg,
  fullLeg: BufferedUpstreamLeg,
  timeoutMs: number,
  signal: AbortSignal
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([memoryLeg.prefixReady, fullLeg.prefixReady]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        signal.addEventListener("abort", () => resolve(false), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function firstHealthyFallbackEvidence(
  preferred: BufferedUpstreamLeg,
  alternate: BufferedUpstreamLeg,
  signal: AbortSignal
): Promise<BufferedUpstreamLeg | null> {
  const candidates = [preferred, alternate];
  while (!signal.aborted) {
    for (const candidate of candidates) {
      if (candidate.hasHealthyFallbackEvidence()) {
        return candidate;
      }
    }
    const pending = candidates.filter(
      (candidate) => !candidate.isFallbackEvidenceSettled()
    );
    if (pending.length === 0) return preferred;
    const settled = await waitForLegFallbackEvidence(pending, signal);
    if (!settled) return null;
  }
  return null;
}

function waitForLegFallbackEvidence(
  legs: BufferedUpstreamLeg[],
  signal: AbortSignal
): Promise<BufferedUpstreamLeg | null> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (leg: BufferedUpstreamLeg | null) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      resolve(leg);
    };
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(null);
      return;
    }
    for (const leg of legs) {
      void leg.waitForFallbackEvidence().then(() => finish(leg));
    }
  });
}

async function gradeComparedPrefixes(args: {
  req: http.IncomingMessage;
  upstream: Upstream;
  routing: ResolvedAbRoutingOptions;
  input: AbGradeInput;
  overflow: Promise<void>;
  parentSignal: AbortSignal;
  diagnostic: GraderDiagnostic;
  graderModel: string;
}): Promise<{ verdict?: FusionVerdict; reason?: string }> {
  const {
    req,
    upstream,
    routing,
    input,
    overflow,
    parentSignal,
    diagnostic,
    graderModel,
  } = args;
  const controller = new AbortController();
  let settleStop!: (kind: "timeout" | "aborted") => void;
  const stopPromise = new Promise<
    { kind: "timeout" } | { kind: "aborted" }
  >((resolve) => {
    settleStop = (kind) =>
      resolve(kind === "timeout" ? { kind: "timeout" } : { kind: "aborted" });
  });
  const abort = () => {
    controller.abort();
    settleStop("aborted");
  };
  parentSignal.addEventListener("abort", abort, { once: true });
  // AbortSignal listeners are not replayed when they are attached after the
  // signal has already fired. Close that race before scheduling any grader
  // work so a cancelled client can never launch another billed request.
  if (parentSignal.aborted) abort();
  const timer = setTimeout(() => {
    controller.abort();
    settleStop("timeout");
  }, routing.graderTimeoutMs);
  const gradePromise = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw new Error("grader aborted");
      }
      return routing.grader
        ? routing.grader({ ...input, signal: controller.signal })
        : gradeWithIncomingAnthropicAuth({
            req,
            upstream,
            routing,
            input: { ...input, signal: controller.signal },
            diagnostic,
            graderModel,
          });
    })
    .then((value) => ({ kind: "verdict" as const, value }))
    .catch((error) => ({ kind: "error" as const, error }));
  const overflowPromise = overflow.then(() => ({ kind: "overflow" as const }));
  try {
    const outcome = await Promise.race([
      gradePromise,
      overflowPromise,
      stopPromise,
    ]);
    if (outcome.kind === "timeout") return { reason: "grader-timeout" };
    if (outcome.kind === "aborted") return { reason: "grader-aborted" };
    if (outcome.kind === "overflow") {
      controller.abort();
      return { reason: "buffer-limit" };
    }
    if (outcome.kind === "error") {
      diagnostic.error = String(outcome.error?.message ?? outcome.error);
      return {
        reason: controller.signal.aborted ? "grader-timeout" : "grader-failed",
      };
    }
    const validated = validateInjectedVerdict(outcome.value);
    return validated ? { verdict: validated } : { reason: "grader-malformed" };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

function validateInjectedVerdict(value: FusionVerdict): FusionVerdict | null {
  // Reuse the same runtime parser shape without relying on TypeScript-only
  // trust for injected/custom graders.
  return parseFusionVerdictResponse({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
}

async function gradeWithIncomingAnthropicAuth(args: {
  req: http.IncomingMessage;
  upstream: Upstream;
  routing: ResolvedAbRoutingOptions;
  input: AbGradeInput;
  diagnostic: GraderDiagnostic;
  graderModel: string;
}): Promise<FusionVerdict> {
  const { req, upstream, routing, input, diagnostic, graderModel } = args;
  if (input.signal.aborted) throw new Error("grader aborted");
  const body = Buffer.from(
    JSON.stringify(
      buildFusionGraderBody(
        {
          question: input.question,
          unfoldedMemory: input.unfoldedMemory,
          memoryResponse: input.memoryResponse,
          fullResponse: input.fullResponse,
          model: input.model,
        },
        graderModel,
        routing.prefixChars,
        routing.graderMemoryChars
      )
    ),
    "utf-8"
  );
  // Recorded before the request goes out so 429s/timeouts still log how big
  // the attempt was; memoryChars isolates the prompt's only unbounded section.
  diagnostic.requestBytes = body.length;
  diagnostic.memoryChars = input.unfoldedMemory.length;
  const headers = forwardableRequestHeaders(req);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  headers.accept = "application/json";
  headers["accept-encoding"] = "identity";

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, verdict?: FusionVerdict) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (verdict) resolve(verdict);
      else reject(new Error("grader returned no verdict"));
    };
    const graderReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: "POST",
        path: req.url,
        headers,
      },
      (graderRes) => {
        diagnostic.status = graderRes.statusCode ?? 502;
        const chunks: Buffer[] = [];
        let bytes = 0;
        graderRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            graderReq.destroy(new Error("grader response exceeded 4 MiB"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        graderRes.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if ((graderRes.statusCode ?? 500) < 200 || (graderRes.statusCode ?? 500) >= 300) {
            finish(
              new Error(
                `grader ${graderRes.statusCode ?? 500}: ${raw.slice(0, 300)}`
              )
            );
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            diagnostic.usage = usageFromResponse(parsed?.usage);
            const verdict = parseFusionVerdictResponse(parsed);
            finish(
              verdict ? undefined : new Error("grader returned malformed output"),
              verdict ?? undefined
            );
          } catch {
            finish(new Error("grader returned invalid JSON"));
          }
        });
        graderRes.on("error", (error) => finish(error));
      }
    );
    const abort = () => graderReq.destroy(new Error("grader aborted"));
    input.signal.addEventListener("abort", abort, { once: true });
    graderReq.on("error", (error) => finish(error));
    // The signal can fire after the entry check but before its listener is
    // installed. Re-check after both abort and error handlers are ready.
    if (input.signal.aborted) {
      abort();
      return;
    }
    graderReq.end(body);
  });
}

function copyWinnerObservation(
  rec: MessagesRecord,
  winner: ComparisonLegRecord
): void {
  rec.upstreamStatus = winner.upstreamStatus;
  rec.ttfbMs = winner.ttfbMs;
  rec.firstContentMs = winner.firstContentMs;
  rec.usage = winner.usage ? { ...winner.usage } : undefined;
}

function usageFromResponse(value: unknown): UsageRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: UsageRecord = {};
  for (const field of [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
  ] as const) {
    const tokenCount = (value as Record<string, unknown>)[field];
    if (typeof tokenCount === "number" && Number.isFinite(tokenCount)) {
      out[field] = tokenCount;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

interface BufferedUpstreamLegOptions {
  name: AbWinner;
  req: http.IncomingMessage;
  body: Buffer;
  upstream: Upstream;
  prefixChars: number;
  maxBufferedBytes: number;
  record: ComparisonLegRecord;
}

/**
 * Speculative-mode chunk consumer. Unlike commitTo's raw piping, a sink lets
 * the orchestrator transform/track bytes (event-aligned forwarding, splice
 * renumbering) and decide itself how the client response ends.
 */
interface UpstreamLegSink {
  /** Forward one raw chunk; false requests an upstream pause until drain. */
  write(chunk: Buffer): boolean;
  /** Upstream ended — cleanly or not; inspect the leg to tell which. */
  end(): void;
  /** Register a one-shot resume callback for backpressure release. */
  drain(resume: () => void): void;
}

/**
 * Ordered hand-off from a leg's private buffer to its selected downstream
 * sink. Writable.write(false) still accepts the current chunk, but no later
 * chunk may be submitted until drain. Keeping that distinction here avoids
 * replaying up to maxBufferedBytes into ServerResponse's own memory buffer.
 *
 * Exported from this internal module solely so the drain state machine can be
 * tested without depending on operating-system socket buffer sizes.
 */
export class DrainAwareChunkQueue {
  private readonly queue: Buffer[];
  private started = false;
  private flushing = false;
  private waitingForDrain = false;
  private ending = false;
  private ended = false;

  constructor(
    bufferedChunks: Buffer[],
    private readonly sink: UpstreamLegSink,
    private readonly onWritable: () => void
  ) {
    this.queue = bufferedChunks;
  }

  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.flush();
  }

  /** Write live data, retaining it behind any replay already in progress. */
  write(chunk: Buffer): boolean {
    if (this.ending || this.ended) return true;
    if (
      !this.started ||
      this.flushing ||
      this.waitingForDrain ||
      this.queue.length > 0
    ) {
      this.queue.push(chunk);
      return false;
    }
    const writable = this.sink.write(chunk);
    if (!writable) this.waitForDrain();
    return writable;
  }

  /** End only after every accepted/retained chunk has crossed a drain seam. */
  finish(): void {
    if (this.ending || this.ended) return;
    this.ending = true;
    this.flush();
  }

  /** Abandon a deselected/client-aborted leg without firing its sink end. */
  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue.length = 0;
  }

  private flush(): void {
    if (
      !this.started ||
      this.flushing ||
      this.waitingForDrain ||
      this.ended
    ) {
      return;
    }
    this.flushing = true;
    let consumed = 0;
    while (consumed < this.queue.length) {
      const writable = this.sink.write(this.queue[consumed]);
      consumed++;
      if (!writable) {
        this.queue.splice(0, consumed);
        this.flushing = false;
        this.waitForDrain();
        return;
      }
    }
    if (consumed > 0) this.queue.splice(0, consumed);
    this.flushing = false;
    if (this.ending) {
      this.ended = true;
      this.sink.end();
    } else {
      this.onWritable();
    }
  }

  private waitForDrain(): void {
    if (this.waitingForDrain || this.ended) return;
    this.waitingForDrain = true;
    this.sink.drain(() => {
      if (this.ended) return;
      this.waitingForDrain = false;
      this.flush();
    });
  }
}

/** One in-flight completion whose raw bytes stay private until selected. */
class BufferedUpstreamLeg {
  readonly record: ComparisonLegRecord;
  readonly prefixReady: Promise<void>;
  readonly bufferOverflow: Promise<void>;

  private readonly name: AbWinner;
  private readonly incomingReq: http.IncomingMessage;
  private readonly body: Buffer;
  private readonly upstream: Upstream;
  private readonly prefixChars: number;
  private readonly maxBufferedBytes: number;
  private readonly startedAt = Date.now();
  private readonly observerRecord: MessagesRecord;
  private readonly chunks: Buffer[] = [];
  private readonly toolBlocks = new Map<number, { name: string; json: string }>();
  private semantic = "";
  private semanticComplete = false;
  private sawStreamProgress = false;
  private totalBufferedBytes = 0;
  private upstreamReq?: http.ClientRequest;
  private upstreamRes?: http.IncomingMessage;
  private clientRes?: http.ServerResponse;
  private sinkQueue?: DrainAwareChunkQueue;
  private sseObserver?: SseNoticeRewriter;
  private expectsSse = false;
  private sawMessageStop = false;
  private validJsonResponse = false;
  private ended = false;
  private completedNormally = false;
  private aborted = false;
  private prefixSettled = false;
  private fallbackEvidenceSettled = false;
  private overflowSettled = false;
  private responseSettled = false;
  private doneSettled = false;
  private resolvePrefix!: () => void;
  private resolveFallbackEvidence!: () => void;
  private resolveOverflow!: () => void;
  private resolveResponse!: () => void;
  private resolveDone!: () => void;
  private readonly responseReady: Promise<void>;
  private readonly fallbackEvidenceReady: Promise<void>;
  private readonly done: Promise<void>;

  constructor(options: BufferedUpstreamLegOptions) {
    this.name = options.name;
    this.incomingReq = options.req;
    this.body = options.body;
    this.upstream = options.upstream;
    this.prefixChars = options.prefixChars;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.record = options.record;
    this.observerRecord = {
      kind: "messages",
      turnType: "unparseable",
      requestBytes: options.body.length,
    };
    this.prefixReady = new Promise((resolve) => (this.resolvePrefix = resolve));
    this.fallbackEvidenceReady = new Promise(
      (resolve) => (this.resolveFallbackEvidence = resolve)
    );
    this.bufferOverflow = new Promise(
      (resolve) => (this.resolveOverflow = resolve)
    );
    this.responseReady = new Promise(
      (resolve) => (this.resolveResponse = resolve)
    );
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  start(): void {
    const headers = forwardableRequestHeaders(this.incomingReq);
    headers["content-length"] = String(this.body.length);
    // A/B needs an incrementally inspectable copy. The winner's bytes remain
    // exact; we merely ask Anthropic not to encode this response.
    headers["accept-encoding"] = "identity";
    this.upstreamReq = this.upstream.module.request(
      {
        host: this.upstream.host,
        port: this.upstream.port,
        method: this.incomingReq.method,
        path: this.incomingReq.url,
        headers,
      },
      (response) => this.handleResponse(response)
    );
    this.upstreamReq.on("error", (error) => this.fail(error));
    this.upstreamReq.end(this.body);
  }

  isHealthy(): boolean {
    const status = this.record.upstreamStatus;
    return (
      !this.aborted &&
      !this.record.error &&
      typeof status === "number" &&
      status >= 200 &&
      status < 300
    );
  }

  completedSuccessfully(): boolean {
    return this.ended && this.completedNormally && this.isHealthy();
  }

  isPrefixReadyAndHealthy(): boolean {
    return this.prefixSettled && this.isHealthy();
  }

  waitForResponse(): Promise<void> {
    return this.responseReady;
  }

  isSseResponse(): boolean {
    return this.expectsSse;
  }

  /** Mirror this leg's upstream status line and headers onto the client. */
  sendHeadTo(res: http.ServerResponse): void {
    if (res.headersSent || !this.upstreamRes) return;
    res.writeHead(
      this.upstreamRes.statusCode ?? 502,
      forwardableResponseHeaders(
        this.upstreamRes,
        SKIP_TRANSFORMED_RESPONSE_HEADERS
      )
    );
  }

  /**
   * Speculative delivery: flush already-buffered chunks into the sink, then
   * hand it every future chunk as it arrives. The passive SSE observer keeps
   * running, so grading/usage extraction are unaffected.
   */
  streamTo(sink: UpstreamLegSink): void {
    if (this.sinkQueue) throw new Error(`${this.name} leg already has a sink`);
    // Freeze live delivery before replay starts so a newly-arriving data event
    // cannot overtake chunks accumulated during prefix grading.
    this.upstreamRes?.pause();
    const queue = new DrainAwareChunkQueue(
      this.chunks.splice(0),
      sink,
      () => {
        // Also undoes a buffer-overflow pause once the private replay is empty.
        if (!this.aborted && !this.ended) this.upstreamRes?.resume();
      }
    );
    this.sinkQueue = queue;
    if (this.ended) queue.finish();
    queue.start();
  }

  hasFailed(): boolean {
    const status = this.record.upstreamStatus;
    return (
      this.record.error !== undefined ||
      (typeof status === "number" && (status < 200 || status >= 300))
    );
  }

  hasHealthyFallbackEvidence(): boolean {
    return (
      this.isHealthy() && (this.prefixSettled || this.sawStreamProgress)
    );
  }

  isFallbackEvidenceSettled(): boolean {
    return this.fallbackEvidenceSettled;
  }

  waitForFallbackEvidence(): Promise<void> {
    return this.fallbackEvidenceReady;
  }

  semanticForGrading(): string {
    if (this.semantic.length > this.prefixChars) {
      return (
        this.semantic.slice(0, this.prefixChars) + GRADING_TRUNCATION_MARKER
      );
    }
    if (
      this.semantic.length === this.prefixChars &&
      !this.semanticComplete
    ) {
      return this.semantic + GRADING_TRUNCATION_MARKER;
    }
    return this.semantic;
  }

  abort(): boolean {
    if (this.aborted || this.ended) return false;
    this.aborted = true;
    this.sinkQueue?.cancel();
    this.upstreamRes?.destroy();
    this.upstreamReq?.destroy();
    this.settlePrefix();
    this.settleResponse();
    this.settleDone();
    return true;
  }

  async commitTo(
    res: http.ServerResponse,
    onResponseReady?: () => void
  ): Promise<boolean> {
    await this.responseReady;
    onResponseReady?.();
    if (!this.upstreamRes) {
      sendAnthropicError(
        res,
        `${this.name} comparison leg failed: ${this.record.error ?? "no response"}`
      );
      return false;
    }
    this.upstreamRes.pause();
    if (!res.headersSent) {
      res.writeHead(
        this.upstreamRes.statusCode ?? 502,
        forwardableResponseHeaders(this.upstreamRes)
      );
    }
    for (const chunk of this.chunks.splice(0)) {
      if (res.destroyed || res.writableEnded) {
        this.abort();
        return false;
      }
      if (!res.write(chunk) && !(await waitForDrainOrClose(res))) {
        this.abort();
        return false;
      }
    }
    this.clientRes = res;
    if (this.ended) {
      if (!res.destroyed && !res.writableEnded) res.end();
      const flushed = await waitForResponseFinishOrClose(res);
      return flushed && this.completedNormally && this.isHealthy();
    }
    this.upstreamRes.resume();
    await this.done;
    const flushed = await waitForResponseFinishOrClose(res);
    return (
      flushed &&
      this.completedNormally &&
      this.isHealthy() &&
      !this.aborted
    );
  }

  private handleResponse(response: http.IncomingMessage): void {
    this.upstreamRes = response;
    this.record.upstreamStatus = response.statusCode ?? 502;
    const contentType = String(response.headers["content-type"] ?? "");
    if (contentType.includes("text/event-stream")) {
      this.expectsSse = true;
      this.sseObserver = new SseNoticeRewriter({
        onEvent: (event) => this.observeEvent(event),
      });
    }
    this.settleResponse();
    if (!this.isHealthy()) this.settlePrefix();
    response.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    response.on("end", () => this.finish());
    response.on("aborted", () =>
      this.fail(new Error("upstream response aborted"))
    );
    response.on("error", (error) => this.fail(error));
  }

  private handleChunk(chunk: Buffer): void {
    if (this.aborted) return;
    if (this.record.ttfbMs === undefined) {
      this.record.ttfbMs = Date.now() - this.startedAt;
    }
    if (this.sinkQueue) {
      if (!this.sinkQueue.write(chunk)) this.upstreamRes?.pause();
    } else if (this.clientRes) {
      if (!this.clientRes.write(chunk)) {
        this.upstreamRes?.pause();
        this.clientRes.once("drain", () => this.upstreamRes?.resume());
      }
    } else {
      this.chunks.push(Buffer.from(chunk));
      this.totalBufferedBytes += chunk.length;
      if (
        this.totalBufferedBytes > this.maxBufferedBytes &&
        !this.overflowSettled
      ) {
        this.overflowSettled = true;
        this.upstreamRes?.pause();
        this.resolveOverflow();
      }
    }
    if (this.sseObserver) this.sseObserver.push(chunk);
  }

  private observeEvent(event: any): void {
    mergeUsageFromSseEvent(event, this.observerRecord);
    if (
      event?.type === "content_block_start" ||
      event?.type === "content_block_delta" ||
      event?.type === "content_block_stop" ||
      event?.type === "message_delta" ||
      event?.type === "message_stop"
    ) {
      this.sawStreamProgress = true;
      this.settleFallbackEvidence();
    }
    if (
      this.record.firstContentMs === undefined &&
      event?.type === "content_block_delta"
    ) {
      this.record.firstContentMs = Date.now() - this.startedAt;
    }
    if (event?.type === "content_block_start" && typeof event.index === "number") {
      const block = event.content_block;
      if (block?.type === "text" && typeof block.text === "string") {
        if (this.semantic) this.appendSemantic("\n");
        this.appendSemantic(block.text);
      } else if (block?.type === "tool_use") {
        this.toolBlocks.set(event.index, {
          name: typeof block.name === "string" ? block.name : "unknown",
          json: "",
        });
      }
    } else if (event?.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.appendSemantic(delta.text);
      } else if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        typeof event.index === "number"
      ) {
        const tool = this.toolBlocks.get(event.index);
        // Tool JSON only feeds the graded semantic prefix (via the
        // content_block_stop append below, which itself truncates), so stop
        // accumulating once it can no longer reach the grading window.
        if (
          tool &&
          this.semantic.length + tool.json.length <= this.prefixChars
        ) {
          tool.json += delta.partial_json;
        }
      }
    } else if (
      event?.type === "content_block_stop" &&
      typeof event.index === "number"
    ) {
      const tool = this.toolBlocks.get(event.index);
      if (tool) {
        this.appendSemantic(
          `${this.semantic ? "\n" : ""}[Tool call: ${tool.name}(${tool.json || "{}"})]`
        );
        this.toolBlocks.delete(event.index);
      }
    } else if (event?.type === "message_stop") {
      this.sawMessageStop = true;
      this.semanticComplete = true;
      this.settlePrefix();
    }
    if (this.observerRecord.usage) {
      this.record.usage = { ...this.observerRecord.usage };
    }
  }

  private appendSemantic(text: string): void {
    // Grading only ever reads the first prefixChars characters. Keep one
    // extra character so semanticForGrading() can still detect truncation,
    // and drop the rest so long responses are not buffered a second time.
    const capacity = this.prefixChars + 1 - this.semantic.length;
    if (capacity > 0) {
      this.semantic +=
        text.length > capacity ? text.slice(0, capacity) : text;
    }
    if (this.semantic.length >= this.prefixChars) this.settlePrefix();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.record.ended = true;
    if (this.sseObserver) this.sseObserver.flush();
    if (!this.sseObserver && this.chunks.length) {
      this.observeJsonBody(Buffer.concat(this.chunks));
    }
    this.completedNormally = this.expectsSse
      ? this.sawMessageStop
      : this.validJsonResponse;
    this.semanticComplete = this.completedNormally;
    if (
      !this.completedNormally &&
      this.record.error === undefined &&
      typeof this.record.upstreamStatus === "number" &&
      this.record.upstreamStatus >= 200 &&
      this.record.upstreamStatus < 300
    ) {
      this.record.error = this.expectsSse
        ? "upstream SSE ended before message_stop"
        : "upstream returned an incomplete message response";
    }
    this.settlePrefix();
    if (this.clientRes && !this.clientRes.destroyed && !this.clientRes.writableEnded) {
      this.clientRes.end();
    }
    this.sinkQueue?.finish();
    this.settleDone();
  }

  private observeJsonBody(body: Buffer): void {
    try {
      const parsed = JSON.parse(body.toString("utf-8"));
      mergeUsageFromJsonBody(body, this.observerRecord);
      this.record.usage = this.observerRecord.usage
        ? { ...this.observerRecord.usage }
        : undefined;
      if (parsed?.type !== "message" || !Array.isArray(parsed.content)) return;
      this.validJsonResponse = true;
      for (const block of parsed.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          this.appendSemantic(block.text);
        } else if (block?.type === "tool_use") {
          this.appendSemantic(
            `${this.semantic ? "\n" : ""}[Tool call: ${String(block.name)}(` +
              `${JSON.stringify(block.input ?? {})})]`
          );
        }
      }
    } catch {
      // Error/non-JSON bodies remain forwardable; they simply are not gradable.
    }
  }

  private fail(error: Error): void {
    if (this.aborted || this.ended) return;
    this.record.error = error.message;
    this.ended = true;
    this.settleResponse();
    this.settlePrefix();
    if (this.clientRes) this.clientRes.destroy(error);
    // A sink-attached leg leaves the client response to the orchestrator,
    // which may recover the turn from the peer leg instead of destroying it.
    this.sinkQueue?.finish();
    this.settleDone();
  }

  private settlePrefix(): void {
    if (this.prefixSettled) return;
    this.prefixSettled = true;
    this.resolvePrefix();
    this.settleFallbackEvidence();
  }

  private settleFallbackEvidence(): void {
    if (this.fallbackEvidenceSettled) return;
    this.fallbackEvidenceSettled = true;
    this.resolveFallbackEvidence();
  }

  private settleResponse(): void {
    if (this.responseSettled) return;
    this.responseSettled = true;
    this.resolveResponse();
  }

  private settleDone(): void {
    if (this.doneSettled) return;
    this.doneSettled = true;
    this.resolveDone();
  }
}

function waitForDrainOrClose(res: http.ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

function waitForResponseFinishOrClose(
  res: http.ServerResponse
): Promise<boolean> {
  if (res.writableFinished) return Promise.resolve(true);
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("finish", onFinish);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    const onFinish = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once("finish", onFinish);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

/**
 * Forward a buffered request and pipe the response back byte-for-byte. A
 * passive observer parses copies of SSE/JSON chunks for request logging and
 * completion validation; its output is discarded and can never change the
 * client response.
 */
function forwardRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream,
  shutdownSignal: AbortSignal,
  rec?: MessagesRecord,
  onJsonResponse?: (body: Buffer) => void,
  onProtocolComplete?: () => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    headers["content-length"] = String(bodyBuffer.length);
    // The passive observer must be able to decode its copy to verify complete
    // delivery (message_stop for SSE, complete JSON otherwise). Constrain the
    // negotiated coding to what the observation decoders support — same idea
    // as the A/B comparison legs forcing identity — so an upstream choice
    // like zstd cannot mark a byte-perfectly delivered response as failed.
    // The bytes written to the client stay exact.
    headers["accept-encoding"] = observableAcceptEncoding(
      headers["accept-encoding"]
    );
    const forwardStarted = Date.now();
    let settled = false;
    let upstreamCompleted = false;
    let responseFinished = false;
    let protocolComplete = false;
    let successfulStatus = false;
    let clientAborted = false;
    let shutdownCancelled = false;
    let protocolCompleteNotified = false;
    let upstreamReq: http.ClientRequest | undefined;
    let activeUpstreamRes: http.IncomingMessage | undefined;

    const notifyProtocolComplete = () => {
      if (
        protocolCompleteNotified ||
        !successfulStatus ||
        onProtocolComplete === undefined
      ) {
        return;
      }
      protocolCompleteNotified = true;
      try {
        onProtocolComplete();
      } catch {
        // Route/observer bookkeeping can never affect byte delivery.
      }
    };
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      res.off("finish", onResponseFinish);
      res.off("close", onResponseClose);
      shutdownSignal.removeEventListener("abort", cancelForShutdown);
      resolve(ok);
    };
    const maybeSettle = () => {
      if (upstreamCompleted && responseFinished) {
        settle(successfulStatus && protocolComplete && !clientAborted);
      }
    };
    const onResponseFinish = () => {
      responseFinished = true;
      maybeSettle();
    };
    const onResponseClose = () => {
      if (res.writableFinished || shutdownCancelled) return;
      clientAborted = true;
      activeUpstreamRes?.destroy();
      upstreamReq?.destroy();
      settle(false);
    };
    const completeUpstream = (complete: boolean) => {
      upstreamCompleted = true;
      protocolComplete = complete;
      if (complete && !res.destroyed) notifyProtocolComplete();
      if (res.destroyed && !res.writableFinished) {
        settle(false);
        return;
      }
      maybeSettle();
    };
    const cancelForShutdown = () => {
      if (settled || shutdownCancelled) return;
      shutdownCancelled = true;
      // Teardown is proxy-owned. Detach the ordinary client-close classifier
      // before destroying either side of the pipe.
      res.off("close", onResponseClose);
      activeUpstreamRes?.destroy();
      upstreamReq?.destroy();
      if (!res.destroyed && !res.writableEnded) res.destroy();
      settle(false);
    };
    res.once("finish", onResponseFinish);
    res.once("close", onResponseClose);
    shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
    if (shutdownSignal.aborted) {
      cancelForShutdown();
      return;
    }

    upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url, // path + query string verbatim (?beta=true etc.)
        headers,
      },
      (upstreamRes) => {
        activeUpstreamRes = upstreamRes;
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const isSse = contentType.includes("text/event-stream");
        const contentEncoding = String(
          upstreamRes.headers["content-encoding"] ?? "identity"
        ).trim().toLowerCase();
        const compressed =
          contentEncoding !== "" && contentEncoding !== "identity";
        let sawFirstByte = false;
        let sawMessageStop = false;
        let observerFailed = false;
        const observeSseEvent = (data: any) => {
          if (rec) {
            mergeUsageFromSseEvent(data, rec);
            if (
              rec.firstContentMs === undefined &&
              data?.type === "content_block_delta"
            ) {
              rec.firstContentMs = Date.now() - forwardStarted;
            }
          }
          if (data?.type === "message_stop") {
            sawMessageStop = true;
          }
        };
        const sseObserver = isSse
          ? new SseNoticeRewriter({
              onEvent: observeSseEvent,
            })
          : null;
        const incrementalDecoder = sseObserver && compressed
          ? createObservationDecoder(contentEncoding)
          : null;
        const observedChunks: Buffer[] | null =
          onJsonResponse !== undefined ||
          !isSse ||
          (compressed && !incrementalDecoder)
            ? []
            : null;
        const observeRawChunk = (chunk: Buffer) => {
          if (rec && !sawFirstByte) {
            sawFirstByte = true;
            rec.ttfbMs = Date.now() - forwardStarted;
          }
          if (sseObserver && !compressed) sseObserver.push(chunk);
          if (observedChunks) observedChunks.push(Buffer.from(chunk));
        };
        if (rec) {
          rec.upstreamStatus = upstreamRes.statusCode ?? 502;
        }
        successfulStatus =
          typeof upstreamRes.statusCode === "number" &&
          upstreamRes.statusCode >= 200 &&
          upstreamRes.statusCode < 300;
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          forwardableResponseHeaders(upstreamRes)
        );

        if (incrementalDecoder && sseObserver) {
          // Gate each encoded SSE chunk on locally decoding its copy. This
          // guarantees message_start usage is recorded before the identical
          // gzip/Brotli/deflate bytes can trigger Claude's MessageDisplay hook.
          // Only the original bytes are written to the client.
          let decoderFailed = false;
          let pendingForward: (() => void) | null = null;
          let pendingFinish: (() => void) | null = null;
          incrementalDecoder.on("data", (chunk: Buffer) => {
            if (!decoderFailed) sseObserver.push(chunk);
          });
          incrementalDecoder.on("error", () => {
            decoderFailed = true;
            observerFailed = true;
            const forward = pendingForward;
            pendingForward = null;
            forward?.();
            const finish = pendingFinish;
            pendingFinish = null;
            finish?.();
          });
          res.once("close", () => incrementalDecoder.destroy());

          const forwardEncoded = (chunk: Buffer): boolean => {
            if (res.destroyed || res.writableEnded) {
              upstreamRes.destroy();
              return false;
            }
            if (res.write(chunk)) upstreamRes.resume();
            else res.once("drain", () => upstreamRes.resume());
            return true;
          };

          upstreamRes.on("data", (chunk: Buffer) => {
            upstreamRes.pause();
            observeRawChunk(chunk);
            if (decoderFailed) {
              forwardEncoded(chunk);
              return;
            }
            let forwarded = false;
            let accepted = false;
            const forwardOnce = (): boolean => {
              if (forwarded) return accepted;
              forwarded = true;
              accepted = forwardEncoded(chunk);
              return accepted;
            };
            pendingForward = forwardOnce;
            try {
              incrementalDecoder.write(chunk, (err) => {
                if (err) {
                  decoderFailed = true;
                  observerFailed = true;
                }
                if (pendingForward === forwardOnce) pendingForward = null;
                const chunkAccepted = forwardOnce();
                if (
                  chunkAccepted &&
                  !decoderFailed &&
                  sawMessageStop
                ) {
                  notifyProtocolComplete();
                }
              });
            } catch {
              decoderFailed = true;
              observerFailed = true;
              if (pendingForward === forwardOnce) pendingForward = null;
              forwardOnce();
            }
          });
          upstreamRes.on("end", () => {
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              pendingFinish = null;
              sseObserver.flush();
              if (observedChunks && onJsonResponse) {
                const observed = decodeForObservation(
                  Buffer.concat(observedChunks),
                  contentEncoding
                );
                if (observed) {
                  try {
                    onJsonResponse(observed);
                  } catch {
                    // Passive observation must never affect proxying.
                  }
                }
              }
              if (!res.destroyed && !res.writableEnded) res.end();
              completeUpstream(!observerFailed && sawMessageStop);
            };
            if (decoderFailed) {
              finish();
              return;
            }
            try {
              pendingFinish = finish;
              incrementalDecoder.end(finish);
            } catch {
              finish();
            }
          });
          upstreamRes.on("error", () => {
            incrementalDecoder.destroy();
            res.destroy();
            settle(false);
          });
          upstreamRes.on("aborted", () => {
            incrementalDecoder.destroy();
            res.destroy();
            settle(false);
          });
          return;
        }

        upstreamRes.on("data", observeRawChunk);
        upstreamRes.pipe(res);
        if (isSse && !compressed) {
          // Registered after pipe(), so this runs only after the raw chunk
          // containing the complete message_stop frame has been accepted by
          // ServerResponse. The callback still runs synchronously before a
          // client can issue the resulting tool request.
          upstreamRes.on("data", () => {
            if (sawMessageStop && !observerFailed && !res.destroyed) {
              notifyProtocolComplete();
            }
          });
        }
        upstreamRes.on("end", () => {
          let observed: Buffer | null = null;
          if (observedChunks) {
            observed = decodeForObservation(
              Buffer.concat(observedChunks),
              contentEncoding
            );
            if (observed && onJsonResponse) {
              try {
                onJsonResponse(observed);
              } catch {
                // Passive observation must never affect the proxied response.
              }
            }
            if (rec && observed && !isSse) {
              mergeUsageFromJsonBody(observed, rec);
            }
          }
          if (isSse) {
            if (compressed && !incrementalDecoder) {
              if (observed) sseObserver?.push(observed);
              else observerFailed = true;
            }
            sseObserver?.flush();
            completeUpstream(!observerFailed && sawMessageStop);
          } else {
            completeUpstream(
              observed !== null && isCompleteJsonResponse(req.url, observed)
            );
          }
        });
        upstreamRes.on("error", () => {
          res.destroy();
          settle(false);
        });
        upstreamRes.on("aborted", () => {
          res.destroy();
          settle(false);
        });
      }
    );

    upstreamReq.on("error", (err) => {
      if (!shutdownCancelled) {
        sendAnthropicError(res, `upstream connection failed: ${err.message}`);
      }
      settle(false);
    });

    upstreamReq.end(bodyBuffer);
  });
}

function isCompleteJsonResponse(
  requestUrl: string | undefined,
  body: Buffer
): boolean {
  try {
    const parsed = JSON.parse(body.toString("utf-8"));
    const pathname = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
    if (pathname.endsWith("/count_tokens")) {
      return (
        typeof parsed?.input_tokens === "number" &&
        Number.isFinite(parsed.input_tokens) &&
        parsed.input_tokens >= 0
      );
    }
    return parsed?.type === "message" && Array.isArray(parsed.content);
  } catch {
    return false;
  }
}

/** Transparent streaming passthrough for everything else. */
function passThroughStreaming(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
  shutdownSignal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    // The body is piped unmodified here, so keep the client's original
    // content-length (SKIP_REQUEST_HEADERS strips it for the buffered paths,
    // which recompute it); dropping it would silently convert the request to
    // chunked transfer-encoding.
    if (req.headers["content-length"] !== undefined) {
      headers["content-length"] = req.headers["content-length"];
    }
    let settled = false;
    let shutdownCancelled = false;
    let incomingUploadEnded = req.readableEnded;
    let upstreamUploadFinished = false;
    let upstreamResponseEnded = false;
    let downstreamFinished = res.writableFinished;
    let pendingErrorResponse = false;
    let upstreamReq: http.ClientRequest | undefined;
    let activeUpstreamRes: http.IncomingMessage | undefined;

    const settle = () => {
      if (settled) return;
      settled = true;
      shutdownSignal.removeEventListener("abort", cancelForShutdown);
      resolve();
    };

    /** Clean completion owns all four independently asynchronous seams. */
    const settleIfComplete = () => {
      if (
        incomingUploadEnded &&
        upstreamUploadFinished &&
        upstreamResponseEnded &&
        downstreamFinished
      ) {
        settle();
      }
    };

    /** Every abnormal exit tears down the whole duplex exchange exactly once. */
    const tearDown = () => {
      if (settled) return;
      // An early upstream response can mark ClientRequest/IncomingMessage as
      // destroyed while their keep-alive socket still awaits the rest of the
      // upload. Capture both transports before stream teardown and close them
      // explicitly so server.close() cannot inherit a half-owned connection.
      const downstreamSocket = req.socket;
      const upstreamSocket = activeUpstreamRes?.socket ?? upstreamReq?.socket;
      activeUpstreamRes?.unpipe(res);
      if (upstreamReq) req.unpipe(upstreamReq);
      // Mark settled before destroy(): close/error events can fire reentrantly.
      settle();
      if (!req.destroyed) req.destroy();
      if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy();
      if (activeUpstreamRes && !activeUpstreamRes.destroyed) {
        activeUpstreamRes.destroy();
      }
      if (!res.destroyed) res.destroy();
      if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
      if (!downstreamSocket.destroyed) downstreamSocket.destroy();
    };

    const onIncomingEnd = () => {
      incomingUploadEnded = true;
      settleIfComplete();
    };
    const onIncomingClose = () => {
      if (settled) return;
      if (req.complete) {
        incomingUploadEnded = true;
        settleIfComplete();
      } else {
        tearDown();
      }
    };
    const onDownstreamFinish = () => {
      downstreamFinished = true;
      if (pendingErrorResponse) tearDown();
      else settleIfComplete();
    };
    const onResponseClose = () => {
      if (settled) return;
      if (res.writableFinished) {
        downstreamFinished = true;
        if (pendingErrorResponse) tearDown();
        else settleIfComplete();
      } else {
        tearDown();
      }
    };
    const cancelForShutdown = () => {
      if (settled || shutdownCancelled) return;
      shutdownCancelled = true;
      tearDown();
    };

    req.once("end", onIncomingEnd);
    req.once("aborted", tearDown);
    req.once("error", tearDown);
    req.once("close", onIncomingClose);
    res.once("finish", onDownstreamFinish);
    res.once("error", tearDown);
    res.once("close", onResponseClose);
    shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
    if (shutdownSignal.aborted) {
      cancelForShutdown();
      return;
    }

    upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        if (settled) {
          upstreamRes.destroy();
          return;
        }
        activeUpstreamRes = upstreamRes;
        const onUpstreamResponseEnd = () => {
          upstreamResponseEnded = true;
          settleIfComplete();
        };
        const onUpstreamResponseClose = () => {
          if (!settled && !upstreamResponseEnded) tearDown();
        };
        upstreamRes.once("end", onUpstreamResponseEnd);
        upstreamRes.once("error", tearDown);
        upstreamRes.once("aborted", tearDown);
        upstreamRes.once("close", onUpstreamResponseClose);
        try {
          res.writeHead(
            upstreamRes.statusCode ?? 502,
            forwardableResponseHeaders(upstreamRes)
          );
        } catch {
          tearDown();
          return;
        }
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.once("finish", () => {
      upstreamUploadFinished = true;
      settleIfComplete();
    });
    upstreamReq.once("close", () => {
      if (!settled && !upstreamUploadFinished && !pendingErrorResponse) {
        tearDown();
      }
    });
    upstreamReq.on("error", (err) => {
      if (settled) return;
      if (shutdownCancelled || res.headersSent || res.destroyed) {
        tearDown();
        return;
      }
      // Preserve the existing Anthropic-shaped 502 when no upstream bytes
      // were committed. Ownership remains until that response flushes, then
      // the still-open incoming upload/socket is torn down as one exchange.
      pendingErrorResponse = true;
      if (upstreamReq) req.unpipe(upstreamReq);
      activeUpstreamRes?.unpipe(res);
      sendAnthropicError(res, `upstream connection failed: ${err.message}`);
      if (res.writableFinished) onDownstreamFinish();
    });
    try {
      req.pipe(upstreamReq);
    } catch {
      tearDown();
    }
  });
}

function forwardableRequestHeaders(
  req: http.IncomingMessage
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function forwardableResponseHeaders(
  upstreamRes: http.IncomingMessage,
  additionalSkippedHeaders?: ReadonlySet<string>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    const lowerKey = key.toLowerCase();
    if (
      SKIP_RESPONSE_HEADERS.has(lowerKey) ||
      additionalSkippedHeaders?.has(lowerKey)
    ) {
      continue;
    }
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Well-formed Anthropic-shaped error body so Claude Code fails fast, not weird. */
function sendAnthropicError(res: http.ServerResponse, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify({
    type: "error",
    error: { type: "api_error", message },
  });
  res.writeHead(502, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

let captureCounter = 0;

/** Test-only diagnostics: dump forwarded bodies for smoke-test inspection. */
function capture(opts: ProxyOptions, kind: string, body: Buffer): void {
  const dir = opts.captureDir;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${String(++captureCounter).padStart(4, "0")}-${kind}.json`;
    writeFileSync(join(dir, name), body);
  } catch {
    // diagnostics only — never break the proxy path
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return readAll(req);
}

const OBSERVABLE_ENCODINGS = new Set(["gzip", "br", "deflate", "identity"]);

/**
 * Restrict a client Accept-Encoding value to codings the passive observer can
 * decode (see createObservationDecoder/decodeForObservation). Client tokens
 * are kept verbatim (q-values included) so negotiation semantics survive —
 * except q=0 tokens, which the client explicitly refuses and so cannot count
 * as an acceptable coding; an absent header means "anything", so advertise
 * the full supported set, and if nothing supported and acceptable remains
 * fall back to identity, which every client accepts.
 */
const REFUSED_Q_ZERO = /;\s*q\s*=\s*0(?:\.0{0,3})?\s*(?:;|$)/i;

function observableAcceptEncoding(clientValue: string | undefined): string {
  if (clientValue === undefined) return "gzip, br, deflate";
  const kept = clientValue
    .split(",")
    .map((token) => token.trim())
    .filter(
      (token) =>
        OBSERVABLE_ENCODINGS.has(token.split(";", 1)[0].trim().toLowerCase()) &&
        !REFUSED_Q_ZERO.test(token)
    );
  return kept.length > 0 ? kept.join(", ") : "identity";
}

/** Incremental decoder used only to observe a copy of encoded SSE bytes. */
function createObservationDecoder(encoding: string): Transform | null {
  if (encoding === "gzip") return createGunzip();
  if (encoding === "br") return createBrotliDecompress();
  if (encoding === "deflate") return createInflate();
  return null;
}

/** Decode a response copy for diagnostics without ever touching forwarded bytes. */
function decodeForObservation(body: Buffer, encoding: string): Buffer | null {
  try {
    if (!encoding || encoding === "identity") return body;
    if (encoding === "gzip") return gunzipSync(body);
    if (encoding === "br") return brotliDecompressSync(body);
    if (encoding === "deflate") return inflateSync(body);
  } catch {
    // Diagnostics only. Unknown/corrupt encodings do not affect proxying.
  }
  return null;
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
