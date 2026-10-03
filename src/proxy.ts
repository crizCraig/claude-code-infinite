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
 *   forward as-is — riding its lane's memory route (routes live in a small
 *   map keyed by request identity: session + main/away/agent-id), on the main
 *   thread the session's stable prefix, or verbatim — while the estimated
 *   size is under the budget, with no compress call. At the budget it
 *   compresses once to the target (planToolCompaction), the same rule human
 *   turns follow; on the main thread the result becomes the stable prefix
 *   later tool and human turns ride. Failure degrades to the old ride or the
 *   verbatim forward. Every identity installs into its own lane — isolation
 *   is structural, not defended.
 * - First user turn (no earlier real user input): background indexing, forward
 *   as-is — nothing is indexed yet, so blocking would be a guaranteed no-op.
 * - Followup user turn: blocking compress + substitute. The compressed body
 *   remains the prefix for that turn's tool loop. On the main thread a
 *   compaction also becomes the session's stable prefix (planEdgeCompaction):
 *   later human turns ride it byte for byte, with no compress call, until
 *   prefix + newer turns reach the budget or the covered messages change.
 * - MemTree failure/timeout degrades to passthrough. A display-only success
 *   notice is queued only when the memory response is selected AND MemTree's
 *   index coverage grew since the last announcement (unchanged coverage means
 *   the turn was appended after an index that learned nothing new); degraded
 *   and unpaid states get their own notices.
 *
 * Every /v1/messages and count_tokens body is run through the legacy notice
 * strip pass before hashing/forwarding. Live notices use Claude Code hooks and
 * upstream response bytes pass through to the client unchanged.
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
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  cachedPromptTokenCount,
  checkCompressedHistory,
  didMemtreeCompress,
  MemtreeClient,
  modelBudgetTokens,
  normalizeMessagesForMemtree,
  serverFlattenedMessages,
  type CompressResult,
  rawPromptTokenCount,
} from "./memtree.js";
import {
  contextLimitForModel,
  hasEarlierNonToolUserMessage,
  isAwaySummaryUserMessage,
  isLocalBashCommandTurn,
  isNonToolUserMessage,
  isToolResultUserMessage,
  lastNonSystemMessage,
  messagesWithSystem,
  modelForMemtree,
  stripSystemReminderText,
  type Message,
} from "./turns.js";
import {
  COMPRESSED_NOTICE,
  compressedTotalsText,
  DEGRADED_NOTICE,
  NOT_COMPRESSED_NOTE,
  recapLinkText,
  PAYMENT_REQUIRED_NOTICE,
  SseNoticeRewriter,
  sanitizeNoticeDetail,
  stripNoticeBlocks,
  stripNoticeSystem,
} from "./notices.js";
import {
  NoticeDeliveryQueue,
  MEMTREE_COMPACT_COMMAND,
  MEMTREE_HELP_COMMAND,
  TRAILER_LABEL,
  LINK_LABEL,
  linkLines,
  isMemtreeViewCommand,
  sessionCommandArgs,
  parseNoticeHookInput,
  type SessionStartHookInput,
} from "./hooks.js";
import type { MemtreeLinkPlacement } from "./cli-args.js";
import { MEMTREE_LINKS_MAX_SESSIONS, type MemtreeLinkStore } from "./memtree-links.js";
import {
  describeClaudeCodeRequest,
  inspectMonitorTranscript,
  isClaudeCodeSideRequest,
  memtreeClientMeta,
  sessionTag,
  type ClaudeCodeRequestInfo,
} from "./cc-request.js";
import type { MessageTimes, TranscriptUsageSource } from "./transcript-usage.js";
import type { ProjectMeta } from "./project-meta.js";
import {
  approxTokensFromBytes,
  mergeUsageFromJsonBody,
  mergeUsageFromSseEvent,
  type CompactionRecord,
  type MessagesRecord,
  type RecompressReason,
  type RequestLogSink,
  type TurnType,
  type UsageRecord,
} from "./reqlog.js";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const HOOK_BODY_LIMIT = 64 * 1024;
// After a recovery attempt returns null (MemTree down, 5xx, or a burned
// timeout budget), suppress the blocking attempt for this long, across every
// lane. A lane's own growth backoff alone would let each over-budget tool turn
// pay the failed call again once its history grew past the retry size, and
// every other lane would pay it too — history grows every turn, so
// compress()'s complete-request dedup never absorbs the repeat.
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

export interface ProxyOptions {
  memtree: MemtreeClient;
  /**
   * Treat current native-1M Anthropic model ids as 1M without requiring the
   * legacy context-1m beta header. Defaults to true. Set false only when the
   * client deliberately disables native 1M context.
   */
  nativeOneMillionContext?: boolean;
  /**
   * Tool-turn compaction (default true): a tool turn on any lane whose
   * estimated size reaches the budget compresses once to the target, like a
   * main human turn (planToolCompaction); on the main thread the result is
   * the session's stable prefix. A soft fuse, not a hard payload cap: MemTree
   * failure degrades to the old prefix or the original body. `false` (the
   * CLI's `CCC_TOOL_ROUTE_RECOVERY=0`) is a pure-passthrough switch for tool
   * turns: no size check and no compress call; they ride their lane's route
   * when one exists and otherwise go out whole.
   */
  toolRouteRecovery?: boolean;
  /**
   * Handle only Claude Code's own requests. ccc launches Claude Code with
   * ANTHROPIC_BASE_URL pointing here, and every program Claude Code runs
   * inherits it (scripts, test suites, SDK apps, a benchmark's judge calls).
   * Claude Code's API client always sends `X-Claude-Code-Session-Id`; a
   * request without it is another program's and is forwarded to Anthropic
   * byte for byte: no MemTree compress or index, no route state, logged as
   * `turnType: "foreign"`. The CLI turns this on; embedders and tests that
   * send bare requests keep the old behaviour by default.
   */
  claudeCodeOnly?: boolean;
  /**
   * Compaction target (tokens) for every session that has not run
   * `/memtree-compact`: `CCC_COMPACT_TARGET`. For benchmarks and headless
   * runs, where the hook-driven command is unavailable. It sets what each
   * compaction aims at (instead of half the budget); it does not trigger
   * one — that is still the budget. `/memtree-compact off` still turns
   * compaction off for one session. null (`CCC_COMPACT_TARGET=off`) starts
   * every session in the `/memtree-compact off` state, for headless runs that
   * cannot type the command; `/memtree-compact [N]` still turns it back on.
   */
  defaultCompactTarget?: number | null;
  /**
   * Test-only whole-request budget (tokens) for every session:
   * `CCC_BUDGET_TOKENS`. Replaces the server-reported model budget (and the
   * context-window fallback) so a cheap session crosses it in a few turns.
   */
  budgetTokensOverride?: number;
  /** Test-only overrides for the first-tree probe (5s) and total wait (60s). */
  awaitedIndexProbeTimeoutMs?: number;
  awaitedIndexWaitTimeoutMs?: number;
  debug?: boolean;
  /**
   * Always-on request/timing JSONL log (see reqlog.ts). Includes messages,
   * MemTree calls, and successful notice claims; omitted means no logging.
   */
  reqlog?: RequestLogSink;
  /**
   * Where the MemTree page link is shown (default "turn"):
   * - "turn": `• MemTree · <url>` once at the end of a user turn (Stop), and
   *   only when the index behind the link changed since it was last shown.
   * - "message": `• MemTree · <url>` under every finished assistant message,
   *   Stop as the fallback for a turn that rendered none; the first message
   *   after a newly finished index came into use is green, later ones dim.
   * - "stop": the same trailer, on Stop only, once per turn.
   * - "success": only under the `✓ MemTree · conversation optimized` line.
   * In "turn" (the default) and "success", the success line carries the
   * current page link on its own line below it; in "turn" the end-of-turn
   * trailer then skips a link that line already showed.
   * - "off": no link anywhere (the page still reaches the request log).
   * The CLI maps `CCC_MEMTREE_LINK` onto this.
   */
  memtreeLinkPlacement?: MemtreeLinkPlacement;
  /**
   * Where the newest page per session is persisted so a resumed session can
   * show its link (SessionStart hook). Omitted means no persistence (tests);
   * the CLI passes the default store under ~/.claude-code-infinite.
   */
  memtreeLinkStore?: MemtreeLinkStore;
  /**
   * Per-response token usage (thinking share on the MemTree page), read from
   * Claude Code's transcript. Omitted means none is sent (tests); the CLI
   * passes the reader for ~/.claude/projects.
   */
  transcriptUsage?: TranscriptUsageSource;
  /**
   * The session's project (project-meta.ts: directory name, `owner/repo`,
   * branch, commit), added to every MemTree call's `x-client-meta` so the
   * user can find sessions by project. Omitted means none is sent.
   */
  projectMeta?: ProjectMeta;
  /** Test-only: forward to this origin instead of api.anthropic.com. */
  upstreamOrigin?: string;
  /** Test-only: dump each forwarded /v1/messages body to this directory. */
  captureDir?: string;
  /**
   * Test-only fault-injection seam: invoked inside installMemoryRoute after
   * its guards pass, immediately before the route is stored. Throwing here
   * simulates route bookkeeping failing (the cloneJson/JSON.stringify
   * calls), which no natural input can trigger — every install input has
   * already survived JSON.parse. Exists solely so the "activation-error"
   * install fate (label precedence over clientAborted, release keeping the
   * lane's backoff) is pinnable by tests. Undefined in production.
   */
  routeInstallFault?: () => void;
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

/**
 * A MemTree page the server stamped on a main-conversation compress, with
 * the completed index that turn was compressed against. The page shows that
 * index until the request's own tree is built, so it is safe to link at once.
 */
interface MemtreePage {
  sessionId?: string;
  url: string;
  /** `X-Polychat-Memtree-Index`: what the link is news about. */
  index: string;
  /**
   * Whether the call behind the page actually compressed. False means the
   * conversation fit the model's budget and went out whole; the trailer says
   * so, since the link alone reads as "MemTree rewrote this turn".
   */
  compressed: boolean;
  seq: number;
}

/** Per-server mutable state (one server per ccc process). */
interface ProxyState {
  /** Set only when a hook actually claims the payment notice for display. */
  paymentNoticeShown: boolean;
  notices: NoticeDeliveryQueue;
  /** Armed only by a main-thread UserPromptSubmit hook. */
  mainPromptArmed: boolean;
  /**
   * True from a UserPromptSubmit bump until the boundary's own main request
   * consumes it: a followup bump reads it to skip the second wipe, and a
   * first-user-shaped main request (new conversation — no followup bump will
   * come) clears it without bumping. A matching Stop also clears. The
   * single-wipe decision keys off THIS flag, not off mainPromptArmed: the
   * arm can outlive its boundary (a followup with active subagents never
   * consumes it, and a missed Stop never clears it), and trusting it would
   * let a later hookless boundary inherit the previous human turn's lane
   * compaction marks (backoff, awaiting-index).
   */
  recoveryBudgetWipedForBoundary: boolean;
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
  /**
   * True from an armed main UserPromptSubmit until its matching Stop. A main
   * UserPromptSubmit while this is set is a prompt typed mid-turn: Claude Code
   * fires the hook at once but delivers the text inside a <system-reminder>
   * beside the next tool_result, so no request ever owns it as a turn.
   */
  mainTurnActive: boolean;
  /**
   * Prompts whose UserPromptSubmit arrived mid-turn, held instead of armed.
   * Each is armed only if a main request uniquely carries it as a plain user turn
   * (Claude Code skips Stop on an interrupt, so a real next prompt can look
   * mid-turn here). Arming at the hook cleared the route the running tool
   * loop rides, and nothing rebuilt it (2026-10-02 overflow).
   */
  deferredMainPrompts: { id?: string; text?: string }[];
  deferredMainPromptsOverflowed: boolean;
  /** Hooks cannot prove a new owner yet: retain the route and refuse unsafe passthrough. */
  mainRouteOwnershipUncertain: boolean;
  /** Suppress producer-side state changes while agent API traffic is active. */
  activeSubagents: Set<string>;
  /**
   * Memory winners carried through the current human turn's tool loops, one
   * lane per request identity (routeIdentity). LRU-bounded to
   * MEMORY_ROUTE_MAX_LANES; entries with a stale routeEpoch are dropped on
   * access, and every epoch bump clears the whole map — a new human turn ends
   * the previous turn's subagents too.
   */
  memoryRoutes: Map<string, MemoryRoute>;
  /**
   * The main lane's most recently installed route, kept across epoch bumps
   * (Stop and UserPromptSubmit clear memoryRoutes). Read only by forks of the
   * main conversation, the away recap, which Claude Code sends after Stop:
   * they extend the same history, so they can send the exact compressed
   * prefix the main thread last sent and hit Anthropic's prompt cache.
   * Never read by tool turns, which keep their epoch-scoped lane routes.
   */
  lastMainRoute?: MemoryRoute;
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
   * The newest MemTree page per session, linked from the success
   * line once per new served index. `seq` orders calls by submission so a
   * slow older call that settles after a newer one cannot roll the link back
   * to a staler tree.
   */
  memtreePages: Map<string, MemtreePage>;
  /** Submission counter behind the pages' `seq`. */
  memtreeCallSeq: number;
  memtreeLinkStore?: MemtreeLinkStore;
  memtreeLinkPlacement: MemtreeLinkPlacement;
  /**
   * `/memtree-compact` targets by Claude Code session: every compression for
   * that session asks the server for this whole-request size instead of the
   * model-based budget, so it stays compressed while it would still fit.
   */
  /**
   * Per-session `/memtree-compact` target; null means explicitly off, and
   * undefined the automatic target (half the budget) even when
   * `CCC_COMPACT_TARGET=off` made off the default.
   */
  compactTargets: Map<string, number | null | undefined>;
  /** `CCC_COMPACT_TARGET=off`: sessions start with compaction off. */
  defaultCompactOff: boolean;
  /**
   * Sessions that ran `/memtree-compact [N]` and have not compacted since:
   * their next main human turn compresses whatever its size (reason
   * "manual").
   */
  compactNow: Set<string>;
  /**
   * Each session's stable compressed prefix (edge compaction): the bytes of
   * its last compaction, reused unchanged on every later main-thread request
   * — human turns included — until prefix + newer turns reach the budget
   * again or the messages it covers change. Unlike memoryRoutes it survives
   * turn boundaries, which is what makes it a prompt-cache read on every
   * human turn after the one that compacted. LRU-bounded.
   */
  stablePrefixes: Map<string, StablePrefix>;
  /**
   * Model budgets the server reported (`model_budget_tokens`), keyed by
   * model and context window (serverBudgetKey).
   */
  serverBudgets: Map<string, number>;
  /**
   * True once any compress response carried `model_budget_tokens`: the
   * server understands `compression_threshold_tokens`, so it can make the
   * over-budget decision itself. Until then the proxy decides from its own
   * size estimate.
   */
  serverReportsBudget: boolean;
  /**
   * Per session: Anthropic's reported size of the last main-thread request
   * forwarded whole (no prefix), with its body bytes, to estimate the next
   * one while the session is still passing through.
   */
  passthroughSizes: Map<string, SizeSample>;
  /**
   * The same, per route lane, for lanes other than the main thread's
   * (subagents): the anchor of their tool turns' budget check.
   */
  laneSizes: Map<string, SizeSample>;
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
   * Each lane's latest tool-turn compaction attempt this epoch: the capacity
   * it targeted, whether it is still in flight (a concurrent attempt in the
   * lane waits: "in-flight"), and, when it produced no prefix, the size the
   * lane must grow to before it tries again ("backoff"), or that it waits
   * for its tree to be built ("awaiting-index"). Tool turns compress whenever
   * their estimate reaches the budget (planToolCompaction); these marks only
   * pace retries after an attempt that produced nothing. A route over a
   * strictly smaller capacity lifts them. Cleared alongside memoryRoutes on every epoch bump —
   * except the followup-path bump of a prompt the hook already armed, which
   * keeps it so one turn boundary lifts a backoff once, not twice (see
   * bumpRouteEpoch).
   */
  toolRecoveryAttemptedLanes: Map<string, ToolRecoveryAttempt>;
  /**
   * Epoch-ms deadline until which tool-route miss recovery skips its blocking
   * attempt, set when an attempt returns null. Zero means no cooldown.
   */
  toolRecoveryCooldownUntil: number;
  /** Fired by drain after its grace period so every forwarding path can stop. */
  shutdownSignal: AbortSignal;
  /** Test-only fault-injection seam; see ProxyOptions.routeInstallFault. */
  routeInstallFault?: () => void;
}

interface MemoryRoute {
  sessionId: string;
  originalSystemHash: string;
  originalPrefixHashes: string[];
  compressedMessages: Message[];
  compressedSystem: unknown;
  hasCompressedSystem: boolean;
  routeEpoch: number;
  /**
   * The stable prefix this route's compressed messages start with, when the
   * route came from a main-thread compaction or prefix ride. Tool turns that
   * ride the route report their Anthropic usage to it (lastSize).
   */
  stablePrefix?: StablePrefix;
  /**
   * Newest reported size of a tool turn sent on this route, for a route with
   * no stable prefix (subagent lanes; sessions with compaction off). The
   * tool-turn budget check (planToolCompaction) starts from it.
   */
  lastSize?: SizeSample;
}

/** A request size Anthropic reported, and the bytes of the body it was for. */
interface SizeSample {
  /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens. */
  tokens: number;
  forwardedBytes: number;
}

/**
 * A session's stable compressed prefix (see ProxyState.stablePrefixes). The
 * route fields mean what they mean on MemoryRoute: the hashes of the original
 * messages the prefix stands for, and the compressed bytes sent instead.
 */
interface StablePrefix {
  sessionId: string;
  originalSystemHash: string;
  originalPrefixHashes: string[];
  compressedMessages: Message[];
  compressedSystem: unknown;
  hasCompressedSystem: boolean;
  /** The compaction target this prefix was built with. */
  targetTokens: number;
  /** Whether that target was explicit (N / CCC_COMPACT_TARGET) or budget/2. */
  explicitTarget: boolean;
  /** Context window of the request that built it; a change recompresses. */
  modelContextLimit: number;
  /** Newest reported size of a request sent on this prefix. */
  lastSize?: SizeSample;
}

/** A compaction's request to store its result as the session's stable prefix. */
interface StablePrefixInstall {
  targetTokens: number;
  explicitTarget: boolean;
  modelContextLimit: number;
  /**
   * Tool-turn compactions only: the session prefix this one replaces (null:
   * none). The install is skipped if the session's prefix changed while the
   * compress call was in flight, so an older completion never overwrites a
   * newer prefix. Undefined (human turns): install unconditionally.
   */
  replaces?: StablePrefix | null;
  /** Set by installMemoryRoute / storeStablePrefix to the prefix it stored. */
  installed?: StablePrefix;
}

/**
 * Budget fallback until the server reports `model_budget_tokens`: this share
 * of the model's context window (800k of Opus 5.5's 1M, matching the server's
 * large-context threshold).
 */
export const FALLBACK_BUDGET_WINDOW_RATIO = 0.8;
/**
 * An explicit target is capped at this share of the budget: a compaction to
 * the budget itself would be over budget again on the next turn and
 * recompress on every turn.
 */
const MAX_EXPLICIT_TARGET_BUDGET_RATIO = 0.9;
/** The server rejects smaller compression targets and thresholds. */
const SERVER_MIN_TARGET_TOKENS = 10_000;
/** Sessions whose stable prefix / passthrough size is kept (LRU). */
const STABLE_PREFIX_MAX_SESSIONS = 16;

interface ToolRecoveryAttempt {
  modelContextLimit: number;
  inFlight: boolean;
  /**
   * Set when the attempt produced no prefix (failure, no-op, no gain, ...):
   * the lane's next attempt this human turn waits until the estimate reaches
   * this size, so a lane that cannot compress does not pay a blocking call on
   * every tool turn (routeRecovery outcome "backoff").
   */
  retryAtTokens?: number;
  /**
   * Set when the attempt's reply showed no finished tree for the conversation
   * (a no-op with no indexed tokens). Until then a compress call cannot shrink
   * anything: the server keeps every unindexed message verbatim. The lane
   * makes no compress call (routeRecovery outcome "awaiting-index") and
   * instead checks, in the background and one at a time, whether that
   * reply's MemTree page has finished building. A window overflow still
   * attempts.
   */
  awaitingIndex?: { pageId: string; checking: boolean; deadline: number };
}

/**
 * Background check of whether a lane's awaited tree exists: its page answers
 * 200 once built (202 while building). Any other answer stops the wait, so a
 * page that never resolves falls back to the growth backoff instead of
 * blocking compaction for good.
 */
function checkAwaitedIndex(
  opts: ProxyOptions,
  attempt: ToolRecoveryAttempt,
  shutdownSignal: AbortSignal
): void {
  const waiting = attempt.awaitingIndex;
  if (!waiting || waiting.checking || shutdownSignal.aborted) return;
  waiting.checking = true;
  // Bound both the individual body read and repeated 202 responses. A page
  // that never completes must eventually return the lane to growth backoff.
  const timeoutMs = Math.max(1, Math.min(
    opts.awaitedIndexProbeTimeoutMs ?? 5_000,
    waiting.deadline - Date.now()
  ));
  const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(timeoutMs)]);
  opts.memtree
    .fetchMemTree(`/usage/memtree/${waiting.pageId}.json`, "application/json", signal)
    .then((page) => {
      if (page.status === 202 && Date.now() < waiting.deadline) return;
      if (attempt.awaitingIndex === waiting) attempt.awaitingIndex = undefined;
      // A finished tree is exactly what the backoff was waiting for.
      if (page.status === 200) attempt.retryAtTokens = undefined;
    })
    .catch(() => {
      if (attempt.awaitingIndex === waiting) attempt.awaitingIndex = undefined;
    })
    .finally(() => {
      waiting.checking = false;
    });
}

/** Growth (share of the budget) a lane waits for after an attempt that failed. */
const TOOL_COMPACTION_RETRY_BUDGET_RATIO = 0.05;

/**
 * Bound on concurrently held route lanes. A route entry is 0.4–4 MB of heap,
 * so 32 lanes is honestly ~128 MB worst case — accepted so a wide agent
 * fan-out (main + away + dozens of live subagents) cannot LRU-evict main's
 * route mid-turn; the cap is enforced by LRU eviction, not assumed.
 */
const MEMORY_ROUTE_MAX_LANES = 32;
const DEFERRED_MAIN_PROMPT_LIMIT = 32;

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
 * every lane's route and tool-compaction attempt mark (in-flight, backoff,
 * awaiting-index) is dropped rather than selectively pruned. Doing all of it here is what makes the sets' documented
 * bound ("cleared on each epoch bump") true at every bump site rather than
 * only at the followup one.
 *
 * keepRecoveryBudget skips only the attempt-mark wipe, for the followup
 * bump of a prompt whose UserPromptSubmit bump already wiped it: one turn
 * boundary otherwise wipes twice milliseconds apart, lifting a backoff a
 * lane earned in between. Hookless embedders (no UserPromptSubmit ever
 * fires) must never pass true — their followup bump is their only
 * per-human-turn reset, without which a lane's backoff or awaiting-index
 * mark would carry into the next human turn.
 */
/**
 * A main human turn begins: arm the prompt for this boundary's request and
 * clear the previous turn's routes.
 */
function armMainPrompt(
  state: ProxyState,
  promptId: string | undefined,
  prompt: string | undefined
): void {
  state.mainPromptArmed = true;
  state.mainPromptId = promptId;
  state.mainPromptText = prompt;
  state.mainPromptDelivered = false;
  state.mainPromptGeneration++;
  state.mainTurnActive = true;
  state.mainRouteOwnershipUncertain = false;
  bumpRouteEpoch(state);
  state.recoveryBudgetWipedForBoundary = true;
  state.notices.clearForUserRequest();
}

/** Arms a mid-turn-deferred prompt once a plain user turn proves it a new turn. */
function armDeferredPromptIfCarried(
  state: ProxyState,
  lastMsg: Message | undefined
): void {
  if (state.deferredMainPromptsOverflowed) return;
  const matches = state.deferredMainPrompts.filter(
    (prompt) => prompt.text !== undefined && messageCarriesPromptText(lastMsg, prompt.text)
  );
  // Identical or overlapping queued text cannot establish which hook owns the
  // request. Keep both prompts and the existing route until ownership is proven.
  if (matches.length !== 1) return;
  const deferred = matches[0];
  state.deferredMainPrompts.splice(state.deferredMainPrompts.indexOf(deferred), 1);
  armMainPrompt(state, deferred.id, deferred.text);
}

function routeOwnershipIsUncertain(state: ProxyState): boolean {
  return state.mainRouteOwnershipUncertain || state.deferredMainPrompts.length > 0;
}

/** Capture prompt identities before asynchronous work; consult ownership at send time. */
function toolForwardingGuard(
  state: ProxyState,
  res: http.ServerResponse,
  isMainRequest: boolean,
  lastMsg: Message | undefined
): { allow: (compressed: boolean) => boolean; settle: (delivered: boolean) => void } {
  const deliveredTexts = isMainRequest ? deliveredUserTexts(lastMsg) : new Set<string>();
  const carried = state.deferredMainPrompts.filter((prompt) => {
    const text = normalizeDeliveryText(prompt.text ?? "");
    // One successful delivery consumes at most one queued identity for each
    // exact normalized text, even when the request repeats that text block.
    return !!text && deliveredTexts.delete(text);
  });
  return {
    allow: (compressed) => {
      if (!isMainRequest || compressed || !routeOwnershipIsUncertain(state)) return true;
      sendAnthropicError(res, "MemTree route ownership is uncertain; retry after the current turn settles");
      return false;
    },
    settle: (delivered) => {
      if (delivered) state.deferredMainPrompts = state.deferredMainPrompts.filter(
        (prompt) => !carried.includes(prompt)
      );
    },
  };
}

/** Only exact top-level user blocks, never tool output or reminders, prove delivery. */
function deliveredUserTexts(message: Message | undefined): Set<string> {
  if (message?.role !== "user") return new Set();
  const content = message.content;
  const blocks = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.flatMap((part: any) =>
      typeof part === "string" ? [part]
        : part?.type === "text" && typeof part.text === "string" ? [part.text] : [])
    : [];
  return new Set(blocks.map(normalizeDeliveryText).filter(Boolean));
}

function normalizeDeliveryText(text: string): string {
  return stripSystemReminderText(text).replace(/\s+/g, " ").trim();
}

function bumpRouteEpoch(
  state: ProxyState,
  keepRecoveryBudget = false
): number {
  const epoch = ++state.mainRouteEpoch;
  state.routeDecisionsLive.clear();
  state.memoryRoutes.clear();
  if (!keepRecoveryBudget) state.toolRecoveryAttemptedLanes.clear();
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
    recoveryBudgetWipedForBoundary: false,
    mainPromptDelivered: true,
    mainPromptGeneration: 0,
    mainTurnActive: false,
    deferredMainPrompts: [],
    deferredMainPromptsOverflowed: false,
    mainRouteOwnershipUncertain: false,
    activeSubagents: new Set(),
    memoryRoutes: new Map(),
    mainRouteEpoch: 0,
    mainRouteDecisionGeneration: 0,
    routeDecisionsLive: new Map(),
    toolRecoveryAttemptedLanes: new Map(),
    toolRecoveryCooldownUntil: 0,
    shutdownSignal: shutdownAbort.signal,
    routeInstallFault: opts.routeInstallFault,
    memtreePages: new Map(),
    memtreeCallSeq: 0,
    memtreeLinkStore: opts.memtreeLinkStore,
    memtreeLinkPlacement: opts.memtreeLinkPlacement ?? "turn",
    compactTargets: new Map(),
    defaultCompactOff: opts.defaultCompactTarget === null,
    compactNow: new Set(),
    stablePrefixes: new Map(),
    serverBudgets: new Map(),
    serverReportsBudget: false,
    passthroughSizes: new Map(),
    laneSizes: new Map(),
  };
  installMemtreeLink(state, state.memtreeLinkPlacement);
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
      // set.
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

    // The grace period protects useful in-flight delivery. Once it
    // expires, signal every forwarding path first so each can
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

  if (
    req.method === "GET" &&
    (url.pathname === MEMTREE_CURRENT_PATH || url.pathname === `${MEMTREE_CURRENT_PATH}.json`)
  ) {
    return handleMemTreeCurrent(req, res, opts, state, url);
  }
  const finderPath = req.method === "GET" ? MEMTREE_FINDER_RELAY.get(url.pathname) : undefined;
  if (finderPath) {
    return handleMemTreeFinder(req, res, opts, finderPath, url);
  }
  if (req.method === "GET" && url.pathname.startsWith(MEMTREE_PASSTHROUGH_PREFIX)) {
    return handleMemTreePassthrough(req, res, opts, url);
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handleMessages(req, res, opts, upstream, state);
  }
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return handleCountTokens(req, res, opts, upstream, state);
  }
  return passThroughStreaming(req, res, upstream, state.shutdownSignal);
}

/** Loopback prefix for reading the user's own MemTree pages through this proxy. */
const MEMTREE_PASSTHROUGH_PREFIX = "/memtree/";
/**
 * `<request id>`, `<request id>.json`, `<request id>/session.json` (the
 * page's session pane), `<request id>/search` (the server's term search over
 * that tree, `?q=&limit=`), or `sessions/<Claude Code session id>.json` (every
 * page from one session, newest first); nothing that could walk the upstream
 * path. The id is the request UUID or the server's short form of it (leading
 * hex, as in the `/m/<id>` links it hands out) — the server accepts both.
 */
const MEMTREE_PASSTHROUGH_TARGET_RE =
  /^(?:[A-Za-z0-9-]+(\.json|\/session\.json|\/search)?|sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json)$/;

/**
 * `GET /memtree/<id>[.json][?share=…]` on the loopback: read the user's own
 * MemTree page with their key. Claude Code's child env already carries this
 * server as ANTHROPIC_BASE_URL, so an agent inside a ccc session needs no key
 * handling — the polychat page's 401 body points here first. The upstream
 * response is relayed as-is (status, content type, body); the key never
 * leaves this process.
 */
async function handleMemTreePassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  url: URL
): Promise<void> {
  const target = url.pathname.slice(MEMTREE_PASSTHROUGH_PREFIX.length);
  if (!MEMTREE_PASSTHROUGH_TARGET_RE.test(target)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Not Found" }));
    return;
  }
  try {
    const upstream = await opts.memtree.fetchMemTree(
      `/usage/memtree/${target}${url.search}`,
      req.headers.accept ?? "application/json"
    );
    res.writeHead(upstream.status, { "content-type": upstream.contentType });
    res.end(upstream.body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `MemTree fetch failed: ${String(err)}` }));
  }
}

/**
 * Loopback routes for finding things across the user's own sessions, relayed
 * to the server's owner-only endpoints with the user's key (which never
 * leaves this process): `GET /memtree/sessions?…` lists sessions, `GET
 * /memtree/search?…` searches their trees. Exact paths only; the query string
 * goes on unchanged (the URL parser has already split off any path or
 * fragment). Matched before the page relay, whose id pattern would otherwise
 * take them for page ids.
 *
 * The project meta goes along in `x-client-meta`, and the caller's Claude
 * Code session id when it sends one, so a charged (vector) search's usage row
 * says where it came from.
 */
const MEMTREE_FINDER_RELAY = new Map<string, string>([
  [`${MEMTREE_PASSTHROUGH_PREFIX}sessions`, "/v1/memtree/sessions"],
  [`${MEMTREE_PASSTHROUGH_PREFIX}search`, "/v1/memtree/search"],
]);
const SESSION_ID_HEADER_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

async function handleMemTreeFinder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstreamPath: string,
  url: URL
): Promise<void> {
  const headers: Record<string, string> = {};
  const meta = memtreeClientMeta({ project: opts.projectMeta });
  if (Object.keys(meta).length) headers["x-client-meta"] = JSON.stringify(meta);
  const sessionId = firstNonEmptyHeader(req, "x-claude-code-session-id");
  if (sessionId && SESSION_ID_HEADER_VALUE.test(sessionId)) {
    headers["x-claude-code-session-id"] = sessionId;
  }
  try {
    const upstream = await opts.memtree.fetchMemTree(
      `${upstreamPath}${url.search}`,
      req.headers.accept ?? "application/json",
      undefined,
      headers
    );
    res.writeHead(upstream.status, { "content-type": upstream.contentType });
    res.end(upstream.body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `MemTree fetch failed: ${String(err)}` }));
  }
}

/**
 * `GET /memtree/current[.json][?session=<Claude Code session id>]`: the page
 * the session's newest main request was served from — what the `memtree` MCP server
 * reads (memtree-mcp.ts). Bare `current` answers the pointer
 * `{id, url, index, session_id, compressed}` without an upstream call, so the
 * MCP server can keep its cached tree until the page changes; `current.json`
 * relays the page JSON itself, like `/memtree/<id>.json`.
 *
 * Every pointer is scoped to the caller's exact session id. Missing session
 * ids never fall back to another conversation served by the same proxy.
 */
async function handleMemTreeCurrent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  state: ProxyState,
  url: URL
): Promise<void> {
  const sessionId = url.searchParams.get("session") || undefined;
  const page = currentMemtreePage(state, sessionId);
  const id = page ? memtreePageId(page.url) : undefined;
  if (!page || !id) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "No MemTree page for this session yet" }));
    return;
  }
  if (!url.pathname.endsWith(".json")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        url: page.url,
        index: page.index,
        session_id: page.sessionId ?? null,
        compressed: page.compressed,
      })
    );
    return;
  }
  try {
    const upstream = await opts.memtree.fetchMemTree(
      `/usage/memtree/${id}.json`,
      req.headers.accept ?? "application/json"
    );
    res.writeHead(upstream.status, {
      "content-type": upstream.contentType,
      "x-memtree-page": page.url,
    });
    res.end(upstream.body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `MemTree fetch failed: ${String(err)}` }));
  }
}

const MEMTREE_CURRENT_PATH = `${MEMTREE_PASSTHROUGH_PREFIX}current`;

function currentMemtreePage(
  state: ProxyState,
  sessionId: string | undefined
): { url: string; index: string; compressed: boolean; sessionId?: string } | undefined {
  if (!sessionId) return undefined;
  const latest = state.memtreePages.get(sessionId);
  if (latest) return latest;
  const stored = state.memtreeLinkStore?.get(sessionId);
  return stored ? { ...stored, sessionId } : undefined;
}

/** The page id in a server-stamped link (`…/m/<id>` or `…/usage/memtree/<id>`). */
export function memtreePageId(pageUrl: string): string | undefined {
  try {
    const match = /\/(?:m|usage\/memtree)\/([A-Za-z0-9-]+?)(?:\.json)?$/.exec(new URL(pageUrl).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
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

  if (parsed.hook_event_name === "SessionStart") {
    const line = resumeLinkLine(state, parsed);
    if (!line) {
      res.writeHead(204);
      res.end();
      return;
    }
    const body = Buffer.from(JSON.stringify({ systemMessage: line }), "utf-8");
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }
  if (parsed.hook_event_name === "UserPromptSubmit") {
    // `/memtree-view`: answered here and blocked, so no model turn runs and
    // the prompt never enters the conversation. Not a human turn either, so
    // none of the turn state below is touched.
    const commandReply =
      parsed.agent_id === undefined
        ? sessionCommandReply(state, parsed.session_id, parsed.prompt)
        : undefined;
    if (commandReply !== undefined) {
      const body = Buffer.from(
        JSON.stringify({
          decision: "block",
          reason: commandReply,
          // Claude Code otherwise repeats "Original prompt: /ccc:memtree-view"
          // under the answer. Older releases ignore the flag.
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            suppressOriginalPrompt: true,
          },
        }),
        "utf-8"
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (parsed.agent_id === undefined) {
      if (state.mainTurnActive || state.deferredMainPrompts.length > 0 ||
          state.mainRouteOwnershipUncertain) {
        // Preserve the oldest unconsumed owners. Overflow loses the ability to
        // prove newer owners, never permission to forward their whole history.
        if (state.deferredMainPrompts.length < DEFERRED_MAIN_PROMPT_LIMIT) {
          state.deferredMainPrompts.push({ id: parsed.prompt_id, text: parsed.prompt });
        } else {
          state.deferredMainPromptsOverflowed = true;
        }
        state.mainRouteOwnershipUncertain = true;
      } else {
        armMainPrompt(state, parsed.prompt_id, parsed.prompt);
      }
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

  const stopMatchesMainPrompt =
    parsed.hook_event_name === "Stop" &&
    parsed.agent_id === undefined &&
    (state.mainPromptId === undefined ||
      parsed.prompt_id === undefined ||
      state.mainPromptId === parsed.prompt_id ||
      state.deferredMainPrompts.some((prompt) => prompt.id === parsed.prompt_id));
  const output =
    parsed.hook_event_name === "Stop" && !stopMatchesMainPrompt
      ? null
      : state.notices.claim(parsed);
  if (stopMatchesMainPrompt) {
    const ownsTurn = parsed.prompt_id !== undefined && parsed.prompt_id === state.mainPromptId;
    state.mainRouteOwnershipUncertain ||= !ownsTurn || state.deferredMainPrompts.length > 0;
    state.mainTurnActive = false;
    state.mainPromptArmed = false;
    state.mainPromptId = undefined;
    state.mainPromptText = undefined;
    state.mainPromptDelivered = true;
    // Invalidate a response still in flight at Stop. Otherwise its late
    // delivery callback could enqueue a notice after Stop returned.
    state.mainPromptGeneration++;
    if (!state.mainRouteOwnershipUncertain) bumpRouteEpoch(state);
    // The boundary this flag described is over; a followup arriving before
    // the next UserPromptSubmit is a new hookless boundary and must wipe.
    state.recoveryBudgetWipedForBoundary = false;
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
  const logged = async (forward: Promise<unknown>): Promise<void> => {
    try {
      await forward;
    } finally {
      if (rec.totalMs === undefined) rec.totalMs = Date.now() - received;
      opts.reqlog?.log(rec);
    }
  };

  if (opts.claudeCodeOnly && requestSessionId(req) === undefined) {
    rec.turnType = "foreign";
    rec.forwardedBytes = rawBody.length;
    const agent = firstNonEmptyHeader(req, "user-agent");
    if (agent) rec.userAgent = agent.slice(0, 80);
    return logged(
      forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec)
    );
  }

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
  // Neither a prompt nor a tool result: a background task notification
  // arrives as a trailing role=system block after the assistant's last reply,
  // so the last conversation message is that reply. It carries the whole
  // history like any turn and must live by the budget like a tool turn; it
  // once fell through every branch and forwarded the uncompacted 4.4MB
  // history (Prompt is too long, 2026-09-30).
  const isContinuationTurn = lastMsg !== undefined && !isUserTurn && !isToolResultTurn;

  // Claude Code's security monitor re-sends the whole session as one
  // `<transcript>` message after most actions. Before this check it looked
  // like a main-thread followup: it bumped the route epoch (wiping the main
  // tool loop's compressed route mid-turn, forcing a blocking recompress),
  // cost a MemTree passthrough, and started a from-scratch index of a
  // conversation that already has one. It must touch none of that state, so
  // it is handled here, before anything below mutates it. Anthropic already
  // caches its append-only transcript well, so it goes out verbatim.
  let clientInfo: ClaudeCodeRequestInfo | undefined;
  try {
    clientInfo = describeClaudeCodeRequest(body);
    if (clientInfo.suspectedSideRequest) {
      clientInfo.sessionTag = sessionTag(requestSessionId(req));
    }
  } catch {
    // logging only; never affects the request
  }
  // The header rule alone is not enough: Claude Code releases before
  // cc_turn_origin existed send main-thread requests with no turn origin, so
  // the monitor's <transcript> block must also be recognised. A candidate
  // whose transcript does not match keeps the ordinary handling (the
  // pre-existing behaviour) and records why, so a format change in Claude
  // Code shows up in requests.jsonl instead of silently misrouting.
  let sideRequest = false;
  if (clientInfo && isClaudeCodeSideRequest(clientInfo)) {
    try {
      rec.transcript = inspectMonitorTranscript(body);
      sideRequest = rec.transcript.ok;
      if (!rec.transcript.ok) {
        console.error(
          `[ccc proxy] possible side request, transcript format not recognised ` +
            `(${rec.transcript.reason}${rec.transcript.badLine ? ` at line ${rec.transcript.badLine}` : ""}); ` +
            `handled as an ordinary request. Claude Code may have changed the monitor format.`
        );
      }
    } catch {
      // never let the format check affect the request
    }
  }
  if (sideRequest && clientInfo) {
    if (typeof body.model === "string") rec.model = body.model;
    rec.stream = body.stream === true;
    rec.client = clientInfo;
    recordTurn(rec, "side-request", forwardBody);
    capture(opts, "anthropic-request-side", forwardBody);
    return logged(
      forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, rec)
    );
  }

  if (isAwaySummary && state.memtreeLinkPlacement !== "off") {
    const sessionId = requestSessionId(req);
    recapLinkAppenders.set(req, (streamedTextChars) => {
      const latest = currentMemtreePage(state, sessionId);
      if (!latest || (sessionId !== undefined && latest.sessionId !== undefined && latest.sessionId !== sessionId)) {
        return undefined;
      }
      return recapLinkText(
        latest.url,
        streamedTextChars,
        latest.compressed ? undefined : NOT_COMPRESSED_NOTE
      );
    });
  }
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
  if (isMainRequest && !isAwaySummary && isUserTurn) {
    armDeferredPromptIfCarried(state, lastMsg);
  }
  // Stored by the server on the usage row (client_meta): which Claude Code,
  // lane, agent and model produced this request.
  const clientMeta = memtreeClientMeta({
    info: clientInfo,
    lane: requestRouteLane,
    agentId: firstNonEmptyHeader(req, "x-claude-code-agent-id"),
    parentAgentId: firstNonEmptyHeader(req, "x-claude-code-parent-agent-id"),
    model: body.model,
    project: opts.projectMeta,
  }) as Record<string, string>;
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
  const routeOwnershipUncertain = routeOwnershipIsUncertain(state);
  const toolForwarding = toolForwardingGuard(
    state, res, isMainRequest && (isToolResultTurn || isContinuationTurn), lastMsg
  );
  const pendingPromptOwnershipUnknown = state.deferredMainPrompts.length > 0 &&
    (!state.mainPromptText || !messageCarriesPromptText(lastMsg, state.mainPromptText));
  if (isFollowupUserTurn && isMainRequest &&
      (state.mainRouteOwnershipUncertain || pendingPromptOwnershipUnknown)) {
    sendAnthropicError(res, "MemTree route ownership is uncertain; retry after the current turn settles");
    return;
  }
  if (isFollowupUserTurn) {
    if (isMainRequest) {
      // Clears every lane before this request reserves the main lane in the
      // new epoch. If this boundary's UserPromptSubmit bump already wiped the
      // lanes' attempt marks milliseconds ago, keep any backoff set since.
      // Consume-once: the flag (not the arm, which can outlive its boundary)
      // is what proves the wipe was THIS boundary's, and a hookless followup
      // (flag never set) must still clear, being its embedder's only
      // per-human-turn reset.
      routeEpoch = bumpRouteEpoch(state, state.recoveryBudgetWipedForBoundary);
      state.recoveryBudgetWipedForBoundary = false;
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

  // UserPromptSubmit clears/arms only a real main-thread human turn. Keep that
  // arm through CC's small first-user probe/retries; consume it only when the
  // actual followup request reaches the compression branch below. Hidden
  // away-summary requests neither produce notices nor mutate a concurrently
  // armed human turn.

  if (typeof body.model === "string") rec.model = body.model;
  rec.stream = body.stream === true;
  // Observation only: which requests carry Claude Code's turn origin.
  if (clientInfo) rec.client = clientInfo;

  if (!isFollowupUserTurn) {
    // Tool turn or FIRST user turn: keep the index fed off the response path
    // and forward as-is (on the lane's memory route or the session's stable
    // prefix when one applies) — except a tool turn whose estimated size
    // reached the budget, which compresses once to the target below
    // (planToolCompaction), exactly like a main human turn.
    // On the first user turn nothing is indexed yet, so a blocking compress
    // would be a guaranteed no-op costing first-token latency
    // (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
    if (opts.debug && isUserTurn) {
      console.error("[ccc proxy] first user turn: index in background, forward verbatim");
    }
    // A first-user-shaped main request is its boundary's only main arrival —
    // no followup bump will ever come to consume the UserPromptSubmit flag.
    // Consume it here, or a later hookless followup would read THIS
    // boundary's "already wiped" and skip its own turn's reset, carrying
    // lane backoffs across a human-turn boundary.
    //
    // Only the armed prompt itself consumes (same prompt-text correlation as
    // hookOwnedMainFollowup): CC-internal side calls can arrive first-user
    // shaped on the main key without being the armed prompt, and letting one
    // of those consume would leave the real followup bumping with keep=false
    // — a second wipe in the same boundary, lifting backoffs set moments
    // earlier. That is the exact double-wipe keepRecoveryBudget closes.
    //
    // Two residual gaps are accepted (cycle-5 review), both bounded to one
    // boundary and both degrading toward verbatim forwards:
    // - A transformed prompt (slash-command expansion, hook-wrapped text)
    //   fails the correlation and never consumes; a later hookless followup
    //   then keeps last boundary's lane backoffs for one turn. Stop's epoch
    //   bump converges it. Clearing on ANY first-user arrival
    //   would re-open the double-wipe above — don't.
    // - A side call that echoes the typed prompt verbatim passes the
    //   correlation and consumes, re-admitting the double-wipe for that
    //   narrow window. Text correlation cannot distinguish it; cost is at
    //   most one extra blocking compress per lane, which then backs off.
    // - (cycle-6 review) The rideability veto below is length-only: a
    //   straggler recovery can install an old-history route on the main lane
    //   after the prompt-boundary bump, and a merged-prompt wrapper longer
    //   than that stale prefix is vetoed out of recovery classification. If
    //   its ride then hash-mismatches, it rejects into tool recovery with
    //   the prompt window still pending and the arm never consumed on that
    //   path, so the rest of the turn's main tool compactions are
    //   transform-only (no route; the stable prefix still installs and later
    //   tool turns ride it as tool-prefix). Same envelope as the two gaps
    //   above: one boundary, bounded degradation, converged by Stop's epoch
    //   bump. In the common
    //   sub-case the hashes match and the wrapper simply rides with the
    //   prompt in the suffix, which is correct.
    if (
      isMainRequest &&
      isUserTurn &&
      state.mainPromptText !== undefined &&
      messageCarriesPromptText(lastMsg, state.mainPromptText)
    ) {
      state.recoveryBudgetWipedForBoundary = false;
    }
    let routedBody = forwardBody;
    let routedTool = false;
    let routeMiss: "missing" | "rejected" | "replay" | "superseded" | undefined;
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
        const overContextWindow = rewritten !== null &&
          routedBodyExceedsContext(body, rewritten, modelContextLimit);
        if (rewritten && !overContextWindow) {
          routedBody = rewritten;
          routedTool = true;
          if (opts.debug) {
            console.error("[ccc proxy] tool turn matched active memory route");
          }
        } else if (
          isRouteInstallReplay(
            body,
            messages,
            activeRoute,
            state.mainRouteEpoch,
            requestSessionId(req)
          )
        ) {
          // An exact replay of the request that installed this route: the
          // client's socket died before the response flushed and it retried
          // the identical body. Not a divergence — forward verbatim but KEEP
          // the route, so the next real tool turn (whose suffix extends the
          // prefix) still rides. Deleting here would spend a rebuild on a
          // route that was never wrong.
          routeMiss = "replay";
          if (opts.debug) {
            console.error(
              "[ccc proxy] tool turn replayed the route-installing request"
            );
          }
        } else {
          // A mismatch means a different/resumed conversation shape, or two
          // requesters colliding on one lane (children sharing only a
          // parent-agent-id land on the same key; their prefix hashes
          // disagree and the loser lands here). A route stored under this key
          // always carries this requester's session id — installMemoryRoute
          // derives both from the same request — so this is by construction a
          // same-session divergence: evict, and let recovery rebuild it.
          // A matching route that outgrew the request's resolved window must
          // also rebuild; a smaller window lifts the lane's backoff.
          routeMiss = "rejected";
          if (!isMainRequest || !routeOwnershipUncertain) {
            state.memoryRoutes.delete(requestRouteKey);
          }
          if (overContextWindow) {
            regrantSmallerWindowRecovery(state, requestRouteKey, modelContextLimit);
          }
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
    const toolSessionId = requestSessionId(req);
    // A main-thread route built on an older stable prefix than the session's
    // current one: a tool-turn compaction replaced the prefix without owning
    // the route (a typed prompt was pending, see recoverToolRouteMiss). The
    // route would carry the old, over-budget prefix; ride the current one.
    if (
      routedTool &&
      isMainRequest &&
      toolSessionId !== undefined &&
      rideableCandidate?.stablePrefix !== state.stablePrefixes.get(toolSessionId)
    ) {
      routedTool = false;
      routedBody = forwardBody;
      routeMiss = "superseded";
      if (!routeOwnershipUncertain) state.memoryRoutes.delete(requestRouteKey);
    }
    if (routeMiss !== undefined) rec.routeMiss = routeMiss;
    if (isContinuationTurn) rec.continuation = true;

    // Cheap shape check: without an earlier real user message there is
    // nothing MemTree could compress, so no attempt is worth making.
    const canCompress = hasEarlierNonToolUserMessage(messages);
    let toolRide: ToolRide | undefined = routedTool
      ? {
          raw: routedBody,
          turnType: "tool-memory",
          sizeHolder: rideableCandidate!.stablePrefix ?? rideableCandidate!,
        }
      : undefined;
    let toolNeedsOriginal = false;
    if (opts.toolRouteRecovery === false) {
      // Kill switch: no size check and no compress call on any tool turn.
      // A route still rides; a miss forwards whole and records "disabled".
      if ((routeMiss === "missing" || routeMiss === "rejected") && canCompress) {
        rec.routeRecovery = { outcome: "disabled" };
      }
    } else if ((isToolResultTurn || isContinuationTurn) && routeMiss !== "replay") {
      // Every lane's tool turn lives by the budget, like a main human turn:
      // under it, forward (on the lane's route or the session's stable
      // prefix, else whole) with no compress call; at it, compress once to
      // the target (planToolCompaction). A "replay" is a client retry of the
      // request that installed the route, forwarded verbatim.
      const plan = planToolCompaction({
        opts,
        state,
        body,
        messages,
        sessionId: toolSessionId,
        routeKey: requestRouteKey,
        isMainRequest,
        modelContextLimit,
        forwardBody,
        rec,
        ride: toolRide,
        canCompress,
      });
      if (plan.kind === "ride") toolRide = plan.ride;
      if (plan.kind === "pass" && plan.original) {
        toolRide = undefined;
        toolNeedsOriginal = true;
      }
      if (plan.kind === "compress") {
        // Clear the caller's old ride before any in-flight/backoff/cooldown
        // exit. An over-window prefix cannot remain the implicit fallback.
        toolRide = plan.fallback;
        toolNeedsOriginal = plan.overWindow;
        const prior = state.toolRecoveryAttemptedLanes.get(requestRouteKey);
        if (prior?.awaitingIndex && Date.now() >= prior.awaitingIndex.deadline) {
          prior.awaitingIndex = undefined;
        }
        if (prior?.inFlight) {
          // A concurrent request of this lane is already compressing.
          rec.routeRecovery = { outcome: "in-flight" };
        } else if (prior?.awaitingIndex && !plan.overWindow) {
          // The last attempt found no tree for this conversation, so a
          // compress call could only pass everything through again. Forward
          // now; the page check lets the next tool turn try once it exists.
          rec.routeRecovery = { outcome: "awaiting-index" };
          checkAwaitedIndex(opts, prior, state.shutdownSignal);
        } else if (
          prior?.retryAtTokens !== undefined &&
          plan.estimateTokens < prior.retryAtTokens
        ) {
          // This lane's last attempt this human turn produced nothing; wait
          // for growth instead of paying a blocking call on every tool turn.
          rec.routeRecovery = { outcome: "backoff" };
        } else if (Date.now() < state.toolRecoveryCooldownUntil) {
          // A recent attempt burned the full compress budget and still
          // failed. Every tool turn appends a tool_result and rehashes, so
          // compress() dedup can never absorb the repeat: without this
          // cooldown a MemTree outage would add the whole blocking budget to
          // every tool turn over the budget. A cooldown skip does not start
          // the lane's backoff.
          rec.routeRecovery = { outcome: "cooldown" };
        } else {
          const recoveryAttempt: ToolRecoveryAttempt = { modelContextLimit, inFlight: true };
          state.toolRecoveryAttemptedLanes.set(requestRouteKey, recoveryAttempt);
          // Serialized non-system conversation bytes, for the record only —
          // computed only when an attempt is made.
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
              forwardBody: plan.overWindow ? rawBody : forwardBody,
              originalBody: rawBody,
              msgsForMemtree,
              hash,
              modelContextLimit,
              routeEpoch,
              rec,
              conversationBytes,
              routeKey: requestRouteKey,
              isMainRequest,
              recoveryAttempt,
              toolForwarding,
              clientMeta,
              compaction: { target: plan.target, threshold: plan.threshold },
              ...(plan.replaces !== undefined
                ? {
                    stable: {
                      targetTokens: plan.targetTokens,
                      explicitTarget: plan.explicitTarget,
                      modelContextLimit,
                      replaces: plan.replaces,
                    },
                  }
                : {}),
              ...(plan.fallback ? { fallback: plan.fallback } : {}),
              retryAtTokens:
                plan.estimateTokens +
                Math.floor(plan.budgetTokens * TOOL_COMPACTION_RETRY_BUDGET_RATIO),
            }).finally(() => {
              recoveryAttempt.inFlight = false;
            })
          );
        }
        // No attempt: send the old ride when there is one, else the whole
        // history.
        if (plan.fallback) {
          toolRide = plan.fallback;
          rec.compaction!.keptPrefix = true;
        }
      }
    }

    if (!toolForwarding.allow(!!toolRide)) return;
    const sendBody = toolRide?.raw ?? (toolNeedsOriginal ? rawBody : forwardBody);
    recordTurn(
      rec,
      toolRide ? toolRide.turnType : isUserTurn ? "first-user" : "tool",
      sendBody
    );
    // A replay matched the stored route's prefix hashes, which are
    // normalization-tolerant — attribution/cache-control churn can make its
    // bytes (and even its MemTree hash) differ from the installer's, so the
    // indexedHashes dedupe would NOT absorb this resubmit. The skip is still
    // sound: a live route proves the installer's compress() submitted this
    // history in this process, so re-indexing buys nothing.
    if (routeMiss !== "replay") {
      opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, toolSessionId, clientMeta, transcriptTimesFor(opts, toolSessionId, agentAttributionId(req)));
    }
    capture(opts, toolRide ? "anthropic-request-memory-tool" : "anthropic-request", sendBody);
    // The size Anthropic reports is the next budget check's anchor: a ride
    // reports to its prefix (or route), a whole request to the session's (or
    // lane's) passthrough size.
    return logged(
      forwardRaw(
        req,
        res,
        sendBody,
        opts,
        upstream,
        state.shutdownSignal,
        rec
      ).then((delivered) => {
        toolForwarding.settle(delivered);
        if (toolRide) noteRideSize(toolRide.sizeHolder, rec, sendBody.length);
        else {
          noteWholeRequestSize(state, isMainRequest, toolSessionId, requestRouteKey, rec, sendBody.length);
        }
      })
    );
  }

  // The away recap is a fork of the main conversation: its history is the
  // main thread's plus one question. Ride the main thread's last compressed
  // prefix instead of compressing separately, so the request stays under the
  // window, hits the prompt cache the main thread warmed, and costs no
  // MemTree call. Any mismatch falls through to the recap's own compression.
  if (isAwaySummary) {
    const fork = forkRoutedBody(
      body,
      messages,
      state.lastMainRoute,
      requestSessionId(req),
      modelContextLimit
    );
    if ("body" in fork) {
      releaseRouteDecision(state, requestRouteKey, routeDecisionGeneration);
      recordTurn(rec, "fork-memory", fork.body);
      capture(opts, "anthropic-request-memory-fork", fork.body);
      return logged(
        forwardRaw(req, res, fork.body, opts, upstream, state.shutdownSignal, rec)
      );
    }
    rec.forkMiss = fork.miss;
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
  // Terminal non-riding outcome: if this request still owns the decision,
  // clearing the lane IS its decision; otherwise yield to the newer owner.
  const clearLaneOrYield = () => {
    if (routeDecisionCurrent()) {
      state.memoryRoutes.delete(requestRouteKey);
      commitRouteDecision();
    } else {
      releaseUncommittedRouteDecision();
    }
  };

  const sessionId = requestSessionId(req);
  // Stable-prefix (edge) compaction: the main thread's human turns only. The
  // recap rides the main route above; subagents keep per-turn compression.
  const edge =
    isMainRequest && sessionId !== undefined
      ? planEdgeCompaction({
          opts,
          state,
          body,
          messages,
          sessionId,
          modelContextLimit,
          forwardBody,
          rec,
        })
      : undefined;

  // Capture the prefix whose fate this request owns before any async work.
  // A tool compaction can replace it without advancing the human epoch.
  const prefixAtDecision = sessionId === undefined
    ? undefined
    : state.stablePrefixes.get(sessionId);

  // An active subagent can repeat/embed the human prompt in its own request;
  // producer suppression must also preserve the arm for the later main call.
  if (displayForThisTurn) state.mainPromptArmed = false;

  /**
   * Forward a compressed body — a fresh compaction, or a ride on the stable
   * prefix — and make it the route for the rest of this human turn's tool
   * loop (and, for a compaction, the session's new stable prefix).
   */
  const forwardCompressed = (
    compressedBody: Record<string, any>,
    compressedRaw: Buffer,
    turnType: "followup-compressed" | "followup-prefix",
    stable: StablePrefixInstall | { ride: StablePrefix } | undefined,
    result: CompressResult | undefined
  ): Promise<void> => {
    if (opts.debug) {
      console.error(
        `[ccc proxy] user turn ${turnType}: ${forwardBody.length} → ` +
          `${compressedRaw.length} body bytes`
      );
    }
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
      // Away lane: commit the decision but store nothing. Nothing can ever
      // read an away route — tool turns and count_tokens can never classify as
      // away — so storing it would only mislead and burn heap. All the
      // reservation bookkeeping above and around this stays exactly as for any
      // lane: it is what stops a stale slow away duplicate from stepping on a
      // newer one.
      if (requestRouteLane === "away") {
        commitRouteDecision();
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
        routeDecisionGeneration,
        stable
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
    recordTurn(rec, turnType, compressedRaw);
    capture(
      opts,
      turnType === "followup-prefix" ? "anthropic-request-memory-prefix" : "anthropic-request",
      compressedRaw
    );
    // Queue the success notice before the stream starts: a long live stream may
    // claim its display notice before message_stop. A prefix ride made no
    // compress call, so there is nothing new to announce.
    if (result) {
      queueCompressionNotice({
        state,
        req,
        displayForThisTurn,
        noticePromptGeneration,
        noticePromptId,
        result,
        rec,
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
        // Wrapped like the recovery twin's protocol-complete callback — not
        // for behavior (forwardRaw's notify catch swallows a throw either
        // way, and routeActivationAttempted stays false so the
        // delivered-settle retry below still gets its one safe attempt) but
        // for observability: a bare throw here otherwise leaves zero trace,
        // unlike the recovery path's "activation-error" install fate.
        () => {
          try {
            activateMemoryRoute();
          } catch (err) {
            if (opts.debug) {
              console.error(
                `[ccc proxy] followup route activation threw at protocol-complete: ${err}`
              );
            }
          }
        }
      ).then(
        (delivered) => {
          // The size Anthropic reported for this request is where the next
          // human turn's budget check starts.
          const sizePrefix = stable
            ? "ride" in stable
              ? stable.ride
              : stable.installed
            : undefined;
          if (sizePrefix) notePrefixSize(sizePrefix, rec, compressedRaw.length);
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
          // Route the rest of this human turn's tool loop — and the count_tokens
          // calls Claude Code sizes its context with — through the same compressed
          // prefix. Without this the tool loop re-sends the full history, so
          // count_tokens reports the uncompressed conversation and Claude Code
          // auto-compacts a context that memory had already shrunk.
          // Retain delivery completion as a defensive retry if protocol-time
          // route bookkeeping failed unexpectedly. Guarded like the recovery
          // twin: a repeat throw here would reject inside this settle callback
          // and strand the uncommitted reservation, so release it instead.
          try {
            activateMemoryRoute();
          } catch (err) {
            if (!routeActivationAttempted) releaseUncommittedRouteDecision();
            if (opts.debug) {
              console.error(
                `[ccc proxy] followup route activation retry threw: ${err}`
              );
            }
          }
        }
      )
    );
  };

  if (edge?.kind === "ride") {
    // The stable prefix still covers this conversation and prefix + newer
    // turns fit the budget: the same prefix bytes as the last request, so
    // Anthropic reads them from cache, and no compress call. MemTree still
    // gets the history to index.
    opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, sessionId, clientMeta, transcriptTimesFor(opts, sessionId, agentAttributionId(req)));
    return forwardCompressed(
      edge.routed.body,
      edge.routed.raw,
      "followup-prefix",
      { ride: edge.prefix },
      undefined
    );
  }

  /**
   * A compaction that produced no new prefix: send this turn on the old one
   * instead of the whole history when it is still valid. Undefined when there
   * is none, or when the server passed a `/memtree-compact` request through
   * (the conversation is under the asked-for target: send it whole).
   */
  const rideOldPrefix = (passedThrough: boolean): Promise<void> | undefined => {
    if (edge?.kind !== "compress" || !edge.fallback) return undefined;
    if (passedThrough && edge.reason === "manual") return undefined;
    rec.compaction!.keptPrefix = true;
    return forwardCompressed(
      edge.fallback.routed.body,
      edge.fallback.routed.raw,
      "followup-prefix",
      { ride: edge.fallback.prefix },
      undefined
    );
  };
  /** A main request about to go out whole: size it and drop any stale prefix. */
  const sendingWhole = () => {
    if (
      edge?.kind === "compress" &&
      sessionId !== undefined &&
      routeDecisionCurrent() &&
      state.stablePrefixes.get(sessionId) === prefixAtDecision
    ) {
      state.stablePrefixes.delete(sessionId);
    }
  };
  const noteWholeSize = () => {
    if (isMainRequest) notePassthroughSize(state, sessionId, rec, forwardBody.length);
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

  // The hidden away-summary request compresses too, but its page is not the
  // conversation the user is looking at.
  const linkSeq =
    isMainRequest && !isAwaySummary ? nextMemtreeCallSeq(state) : undefined;
  let compression: BlockingCompressionOutcome;
  try {
    compression = await runBlockingCompression({
      opts,
      state,
      body,
      msgsForMemtree,
      hash,
      modelContextLimit,
      rec,
      sessionId,
      agentId: agentAttributionId(req),
      clientMeta,
      ...(edge?.kind === "compress"
        ? { compaction: { target: edge.target, threshold: edge.threshold } }
        : edge?.kind === "off"
          ? { compaction: {} }
          : {}),
    });
  } catch {
    releaseUncommittedRouteDecision();
    recordTurn(rec, "followup-degraded", rawBody);
    capture(opts, "anthropic-request", rawBody);
    return logged(
      forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec)
        .then((delivered) => {
          if (isMainRequest) notePassthroughSize(state, sessionId, rec, rawBody.length);
          if (delivered) markMainPromptDelivered();
        })
    );
  } finally {
    res.off("close", markDownstreamClosedDuringCompression);
  }
  const { result } = compression;
  noteMemtreeHealth(state, compression);
  if (linkSeq !== undefined) {
    noteMemtreePage(state, linkSeq, sessionId, result);
  }
  // Any answer settles a `/memtree-compact`: a compressed one became the
  // prefix, a passthrough means there was nothing to compact. A failure keeps
  // it pending for the next turn.
  if (result && sessionId !== undefined) state.compactNow.delete(sessionId);

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
    const kept = rideOldPrefix(false);
    if (kept) return kept;
    // MemTree down/slow/402: the user's own Anthropic call is never gated on
    // it. Degrade to passthrough and queue a display-only hook notice for a
    // visible turn. The hidden away-summary request deliberately stays quiet.
    // Unpaid key (402, from this compress OR an earlier background index) gets
    // a payment-specific notice instead of the generic degraded one, at most
    // once per proxy process after it has actually been delivered.
    recordTurn(rec, "followup-degraded", forwardBody);
    clearLaneOrYield();
    sendingWhole();
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
        noteWholeSize();
        if (delivered) markMainPromptDelivered();
      })
    );
  }

  const actuallyCompressed = didMemtreeCompress(result);
  const historyCheck = checkCompressedHistory(result, msgsForMemtree);
  rec.history = {
    retainedChars: historyCheck.retainedChars,
    priorHistoryChars: historyCheck.priorHistoryChars,
    usable: historyCheck.usable,
  };
  if (!actuallyCompressed || !historyCheck.usable) {
    const kept = rideOldPrefix(!actuallyCompressed);
    if (kept) return kept;
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
    clearLaneOrYield();
    sendingWhole();
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
        noteWholeSize();
        if (delivered) markMainPromptDelivered();
      })
    );
  }

  // Invariant from the early return above: past this point the MemTree result
  // actually compressed (actuallyCompressed is true) and the retained history
  // is usable — every remaining path forwards the compressed body.
  let built: {
    compressedBody: Record<string, any>;
    compressedRaw: Buffer;
  } | null;
  try {
    built = buildCompressedBody(body, result);
  } catch (err) {
    releaseUncommittedRouteDecision();
    throw err;
  }
  if (built === null) {
    const kept = rideOldPrefix(false);
    if (kept) return kept;
    // The server compressed but returned no usable `flattened_messages`
    // (pre-flatten server, or a malformed field). The flatten format lives
    // server-side only — the client deliberately has no local fallback, that
    // drift is what caused the append/adherence regressions — so forward the
    // real history instead, exactly like the unusable branch above.
    clearLaneOrYield();
    sendingWhole();
    if (opts.debug) {
      console.error(
        "[ccc proxy] compressed result carried no server flatten; " +
          "forwarding history"
      );
    }
    recordTurn(rec, "followup-no-flatten", forwardBody);
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
        noteWholeSize();
        if (delivered) markMainPromptDelivered();
      })
    );
  }
  // A compaction: this result becomes the session's stable prefix once the
  // response completes. The server may also have compressed on its own
  // (over its budget with no threshold from us): that is a budget compaction.
  let stable: StablePrefixInstall | undefined;
  if (edge?.kind === "compress") {
    const compaction = rec.compaction!;
    compaction.reason ??= compaction.prefixMiss ? "prefix-mismatch" : "budget";
    stable = {
      targetTokens: edge.targetTokens,
      explicitTarget: edge.explicitTarget,
      modelContextLimit,
    };
  }
  return forwardCompressed(
    built.compressedBody,
    built.compressedRaw,
    "followup-compressed",
    stable,
    result
  );
}

function queueCompressionNotice(args: {
  state: ProxyState;
  req: http.IncomingMessage;
  displayForThisTurn: boolean;
  noticePromptGeneration: number;
  noticePromptId: string | undefined;
  result: CompressResult;
  /** This turn's record: its compaction estimate and, once the response
   * arrives, Anthropic's usage for the compressed request. */
  rec?: MessagesRecord;
}): void {
  const {
    state,
    req,
    displayForThisTurn,
    noticePromptGeneration,
    noticePromptId,
    result,
    rec,
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
  //
  // A newly ready MemTree page also earns the line: the link rides only the
  // success line (never its own message), so a finished index is announced
  // on the next compressed turn even when coverage stayed flat.
  const indexedTokens = cachedPromptTokenCount(result);
  const sessionId = requestSessionId(req);
  if (indexedTokens !== undefined) {
    const last = state.lastNoticedIndexCoverage;
    // Record every observed coverage, announced or not, so a server-side
    // index rebuild that shrinks coverage re-announces once it grows past
    // its own new baseline rather than staying silent until it beats the old.
    state.lastNoticedIndexCoverage = { sessionId, indexedTokens };
    if (
      last &&
      last.sessionId === sessionId &&
      indexedTokens <= last.indexedTokens &&
      !state.notices.linkPending(sessionId)
    ) {
      return;
    }
  }
  state.notices.queuePrefix(
    () => compressedTotalsText(...compressionTotals(rec, result)),
    undefined,
    noticePromptId
  );
}

/**
 * Before and after sizes for the success line, read when the line is shown.
 * Before: the estimated request that would otherwise have been sent (the
 * old prefix plus suffix on recompaction), else the server's raw_prompt_tokens
 * for the original history. After: Anthropic's reported compressed input once
 * usage arrives, else "before" scaled using the bytes of that same estimate.
 */
function compressionTotals(
  rec: MessagesRecord | undefined,
  result: CompressResult
): [number | undefined, number | undefined] {
  const original = rec?.compaction?.estimatedTokens ?? rawPromptTokenCount(result);
  if (!rec) return [original, undefined];
  const reported = reportedInputTokens(rec);
  if (reported !== undefined) return [original, reported];
  const fwd = rec.forwardedBytes;
  const basisBytes = rec.compaction?.estimatedTokens !== undefined
    ? rec.compaction.estimatedBytes
    : rec.requestBytes;
  if (original === undefined || !fwd || !basisBytes) return [original, undefined];
  return [original, Math.round((original * fwd) / basisBytes)];
}

/**
 * The link on the success line: the newest page for the hook's session,
 * exactly as the server stamped it, keyed by the index it was compressed
 * against so it is announced once per newly finished index. The server hands
 * out its short spelling (`/m/<leading hex of the request id>`), which is
 * permanent — it outlives this proxy — and fits a terminal line.
 */
function installMemtreeLink(
  state: ProxyState,
  placement: MemtreeLinkPlacement
): void {
  const resolve = (sessionId: string | undefined) => {
    const latest = currentMemtreePage(state, sessionId);
    if (!latest) return undefined;
    return {
      key: latest.index,
      link: latest.url,
      ...(latest.compressed ? {} : { note: NOT_COMPRESSED_NOTE }),
    };
  };
  switch (placement) {
    case "success":
      state.notices.setLink(resolve);
      break;
    case "turn":
      // The success line carries the current page on the line below it; the
      // end-of-turn trailer then skips a link that line already showed.
      state.notices.setLink(resolve);
      state.notices.setTrailer(resolve, placement);
      break;
    case "message":
    case "stop":
      // These trailers show on every message or every Stop; no second copy.
      state.notices.setTrailer(resolve, placement);
      break;
    case "off":
      break;
  }
}

/**
 * The link line for a resumed main session: its newest page, from memory when
 * this proxy served it (an in-app `/resume` back to an earlier conversation),
 * else from the on-disk store (a new `ccc --resume` process). Adopts it as the
 * session's current page so trailers continue from it, at a sequence number
 * any later call beats.
 */
function resumeLinkLine(
  state: ProxyState,
  input: SessionStartHookInput
): string | undefined {
  if (input.agent_id !== undefined || input.source === "compact") return undefined;
  if (state.memtreeLinkPlacement === "off") return undefined;
  const sessionId = input.session_id;
  const inMemory = state.memtreePages.get(sessionId);
  const page =
    inMemory && inMemory.sessionId === sessionId
      ? inMemory
      : state.memtreeLinkStore?.get(sessionId);
  if (!page) return undefined;
  if (page !== inMemory) {
    rememberMemtreePage(state, sessionId, {
      sessionId,
      url: page.url,
      index: page.index,
      compressed: page.compressed,
      seq: state.memtreeCallSeq,
    });
  }
  return state.notices.resumeLine({
    key: page.index,
    link: page.url,
    ...(page.compressed ? {} : { note: NOT_COMPRESSED_NOTE }),
  }, sessionId);
}

export const MEMTREE_COMPACT_MIN_TOKENS = 20_000;

/** The reply to a ccc slash command, or undefined for an ordinary prompt. */
function sessionCommandReply(
  state: ProxyState,
  sessionId: string,
  prompt: string
): string | undefined {
  if (sessionCommandArgs(prompt, MEMTREE_HELP_COMMAND) !== undefined) {
    return [
      "• /memtree-view · show this session's MemTree page link",
      `• /memtree-compact [tokens | off] · compact this session on your next message (default half the budget, at least ${MEMTREE_COMPACT_MIN_TOKENS / 1000}k)`,
    ].join("\n");
  }
  if (isMemtreeViewCommand(prompt)) return memtreeViewLine(state, sessionId);
  const args = sessionCommandArgs(prompt, MEMTREE_COMPACT_COMMAND);
  if (args === undefined) return undefined;
  const keep =
    "then that compressed history is reused unchanged until the conversation reaches the budget again. /memtree-compact off to stop.";
  if (/^off$/i.test(args)) {
    state.compactTargets.set(sessionId, null);
    state.compactNow.delete(sessionId);
    state.stablePrefixes.delete(sessionId);
    return `${TRAILER_LABEL} compaction off: the conversation is sent whole, and MemTree compresses only when it outgrows the model's budget.`;
  }
  if (args === "") {
    // Back to the automatic target (half the budget, or CCC_COMPACT_TARGET).
    // Under CCC_COMPACT_TARGET=off the default is off, so pin the automatic
    // target for this session instead of falling back to that default.
    if (state.defaultCompactOff) state.compactTargets.set(sessionId, undefined);
    else state.compactTargets.delete(sessionId);
    state.compactNow.add(sessionId);
    return `${TRAILER_LABEL} compacting: your next message is sent compressed to about half the budget, ${keep}`;
  }
  const target = parseTokenCount(args);
  if (target === undefined || target < MEMTREE_COMPACT_MIN_TOKENS) {
    return `${TRAILER_LABEL} usage: /memtree-compact [tokens, e.g. 400k, at least ${MEMTREE_COMPACT_MIN_TOKENS / 1000}k | off]`;
  }
  state.compactTargets.set(sessionId, target);
  state.compactNow.add(sessionId);
  return `${TRAILER_LABEL} compacting: your next message is sent compressed to about ${Math.round(target / 1000)}k tokens, ${keep}`;
}

/** "50k", "50000", "1.5m" → tokens; undefined when not a positive count. */
export function parseTokenCount(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim());
  if (!match) return undefined;
  const scale = { k: 1_000, m: 1_000_000 }[match[2]?.toLowerCase() as "k" | "m"] ?? 1;
  const value = Math.round(Number(match[1]) * scale);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The `/memtree-view` answer: this session's newest page, or why there is none. */
function memtreeViewLine(state: ProxyState, sessionId: string): string {
  const inMemory = state.memtreePages.get(sessionId);
  const page =
    inMemory && (inMemory.sessionId === undefined || inMemory.sessionId === sessionId)
      ? inMemory
      : state.memtreeLinkStore?.get(sessionId);
  if (!page) {
    return `${TRAILER_LABEL} no page yet: this session has not been indexed. The link appears once it has.`;
  }
  return linkLines(LINK_LABEL, page.url, page.compressed ? undefined : NOT_COMPRESSED_NOTE);
}

function nextMemtreeCallSeq(state: ProxyState): number {
  return ++state.memtreeCallSeq;
}

/**
 * Adopt a compress response's MemTree page as the conversation's newest,
 * unless a call submitted later already reported one. Only a response that
 * names the index it was compressed against counts: that index is complete,
 * so the page shows a tree right away, and its identity is what makes the
 * link worth announcing. A response without it (pre-view server, failed or
 * uncompressed call) changes nothing.
 */
function noteMemtreePage(
  state: ProxyState,
  seq: number,
  sessionId: string | undefined,
  result: CompressResult | null
): void {
  const url = result?.memtreeUrl;
  const index = result?.memtreeIndex;
  if (!sessionId || !url || !index) return;
  const latest = state.memtreePages.get(sessionId);
  if (latest && latest.seq >= seq) return;
  const compressed = didMemtreeCompress(result!);
  rememberMemtreePage(state, sessionId, { sessionId, url, index, compressed, seq });
  if (sessionId) state.memtreeLinkStore?.put(sessionId, { url, index, compressed });
}

/** Bound optional page state independently of how many sessions use the proxy. */
function rememberMemtreePage(state: ProxyState, sessionId: string, page: MemtreePage): void {
  state.memtreePages.delete(sessionId);
  state.memtreePages.set(sessionId, page);
  while (state.memtreePages.size > MEMTREE_LINKS_MAX_SESSIONS) {
    state.memtreePages.delete(state.memtreePages.keys().next().value!);
  }
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
 * - Every lane contributes the same shared evidence. A live success clears
 *   the cooldown; a live failure arms it.
 * - Cache-served calls contribute no evidence. compress() memoizes successes
 *   by hash and returns them with zero server contact, so replaying an
 *   identical body cannot "prove" MemTree is up.
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
  decisionGeneration: number,
  /**
   * Main-thread human turns only: the stable prefix these compressed messages
   * start with. `register` stores it as the session's prefix (a compaction);
   * a prefix ride passes the prefix it rode, already stored.
   */
  stable?: StablePrefixInstall | { ride: StablePrefix }
): MemoryRoute | undefined {
  // Epoch guards the human-prompt lifecycle; the decision generation orders
  // async installs that share one epoch (two recoveries, or a recovery vs an
  // in-flight followup). A stale completion must not overwrite a newer
  // decision's route — and must not clear it either, hence the early return
  // before the sessionless-clear below.
  if (
    state.mainRouteEpoch !== routeEpoch ||
    !routeDecisionHolds(state, key, decisionGeneration)
  ) {
    return undefined;
  }
  const sessionId = requestSessionId(req);
  if (!sessionId || !Array.isArray(compressedBody.messages)) {
    state.memoryRoutes.delete(key);
    return undefined;
  }
  // Test-only fault-injection seam (undefined in production): placed after
  // every guard and before the store, exactly where the route object's
  // cloneJson/hash construction could throw, so tests can reach the
  // "activation-error" settle label. See ProxyOptions.routeInstallFault.
  state.routeInstallFault?.();
  const route: MemoryRoute = {
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
  };
  if (stable && "ride" in stable) {
    route.stablePrefix = stable.ride;
  } else if (stable) {
    // The route's own fields are the prefix: the hashes of every message this
    // request carried, and the compressed bytes sent for them. Later requests
    // reuse these bytes unchanged, so the prefix stays a cache read.
    route.stablePrefix = storeStablePrefix(state, sessionId, originalMessages, route, stable);
  }
  setMemoryRoute(state, key, route);
  if (key === JSON.stringify([sessionId, "main"])) state.lastMainRoute = route;
  return route;
}

/**
 * Store a compaction's compressed bytes as the session's stable prefix. For a
 * tool-turn compaction (`replaces` set) only while the session's prefix is
 * still the one the compaction replaced; undefined when skipped.
 */
function storeStablePrefix(
  state: ProxyState,
  sessionId: string,
  originalMessages: Message[],
  compressed: Pick<
    StablePrefix,
    "originalSystemHash" | "compressedMessages" | "compressedSystem" | "hasCompressedSystem"
  >,
  stable: StablePrefixInstall
): StablePrefix | undefined {
  if (
    stable.replaces !== undefined &&
    (state.stablePrefixes.get(sessionId) ?? null) !== stable.replaces
  ) {
    return undefined;
  }
  const prefix: StablePrefix = {
    sessionId,
    originalSystemHash: compressed.originalSystemHash,
    originalPrefixHashes: originalMessages.map(stablePrefixMessageHash),
    compressedMessages: compressed.compressedMessages,
    compressedSystem: compressed.compressedSystem,
    hasCompressedSystem: compressed.hasCompressedSystem,
    targetTokens: stable.targetTokens,
    explicitTarget: stable.explicitTarget,
    modelContextLimit: stable.modelContextLimit,
  };
  stable.installed = prefix;
  boundedSet(state.stablePrefixes, sessionId, prefix);
  state.compactNow.delete(sessionId);
  return prefix;
}

type ForkMiss = NonNullable<MessagesRecord["forkMiss"]>;

/**
 * A fork of the main conversation (the away recap) sent on the main thread's
 * last compressed prefix: that prefix, then the fork's own messages after it.
 * Only session, system and every prefix message are checked; unlike a tool
 * turn, the suffix may end in a plain user message (the fork's question).
 */
function forkRoutedBody(
  body: Record<string, any>,
  messages: Message[],
  route: MemoryRoute | undefined,
  sessionId: string | undefined,
  modelContextLimit: number
): { body: Buffer } | { miss: ForkMiss } {
  if (!route) return { miss: "no-route" };
  const miss = prefixMismatch(body, messages, route, sessionId);
  if (miss) return { miss };
  const routed = prefixRoutedBody(body, messages, route);
  if (!routed) return { miss: "prefix" };
  const buffer = routed.raw;
  if (routedBodyExceedsContext(body, buffer, modelContextLimit)) return { miss: "too-large" };
  return { body: buffer };
}

/** The compressed-prefix fields a route and a stable prefix share. */
type PrefixLike = Pick<
  MemoryRoute,
  | "sessionId"
  | "originalSystemHash"
  | "originalPrefixHashes"
  | "compressedMessages"
  | "compressedSystem"
  | "hasCompressedSystem"
>;

/**
 * Why `messages` cannot continue from `prefix`, or null when they can: same
 * session, same system prompt, every message the prefix covers unchanged, and
 * at least one message after them. The suffix may be anything, human turns
 * included.
 */
function prefixMismatch(
  body: Record<string, any>,
  messages: Message[],
  prefix: PrefixLike,
  sessionId: string | undefined,
  hashMessage: (message: Message) => string = routeMessageHash
): "session" | "system" | "prefix" | null {
  if (!sessionId || prefix.sessionId !== sessionId) return "session";
  if (routeValueHash(normalizeRouteSystem(body.system)) !== prefix.originalSystemHash) {
    return "system";
  }
  const prefixLength = prefix.originalPrefixHashes.length;
  if (messages.length <= prefixLength) return "prefix";
  for (let i = 0; i < prefixLength; i++) {
    if (hashMessage(messages[i]) !== prefix.originalPrefixHashes[i]) {
      return "prefix";
    }
  }
  return null;
}

/**
 * Message identity for a stable prefix: routeMessageHash without assistant
 * thinking blocks. A stable prefix spans human turns, and Claude Code does not
 * reliably replay earlier turns' thinking (model switch, resume); those blocks
 * are never sent on the prefix anyway (the compressed bytes stand in for them),
 * so they must not decide whether it still matches.
 */
function stablePrefixMessageHash(message: Message): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return routeMessageHash(message);
  }
  return routeMessageHash({
    ...message,
    content: message.content.filter(
      (part: any) => part?.type !== "thinking" && part?.type !== "redacted_thinking"
    ),
  });
}

/**
 * The request sent on a compressed prefix: the prefix's compressed messages
 * (a JSON round trip of the stored bytes, so byte-identical every time), then
 * the messages after the part it covers, verbatim, with Claude Code's current
 * billing header grafted into the compressed system and the cache breakpoints
 * capped at Anthropic's limit (the prefix's own marker always kept).
 */
function prefixRoutedBody(
  body: Record<string, any>,
  messages: Message[],
  prefix: PrefixLike
): { body: Record<string, any>; raw: Buffer } | null {
  const routed: Record<string, any> = {
    ...body,
    messages: [
      ...cloneJson(prefix.compressedMessages),
      ...messages.slice(prefix.originalPrefixHashes.length),
    ],
  };
  if (prefix.hasCompressedSystem) {
    routed.system = currentRouteSystem(prefix.compressedSystem, body.system);
  } else {
    delete routed.system;
  }
  capCacheBreakpoints(routed, prefix.compressedMessages.length);
  if (!validCacheTtlOrder(routed)) return null;
  return { body: routed, raw: Buffer.from(JSON.stringify(routed), "utf-8") };
}

/** Whole-request budget and where it came from. */
interface Budget {
  tokens: number;
  source: "override" | "server" | "window-ratio";
}

function serverBudgetKey(model: unknown, modelContextLimit: number): string {
  return JSON.stringify([typeof model === "string" ? model : "", modelContextLimit]);
}

/**
 * The session's whole-request budget: CCC_BUDGET_TOKENS when set (tests),
 * else the model budget the server last reported for this model and window,
 * else the window times FALLBACK_BUDGET_WINDOW_RATIO (servers that predate
 * `model_budget_tokens`, and the first request before any response).
 */
function resolveBudget(
  opts: ProxyOptions,
  state: ProxyState,
  model: unknown,
  modelContextLimit: number
): Budget {
  if (opts.budgetTokensOverride !== undefined) {
    return { tokens: opts.budgetTokensOverride, source: "override" };
  }
  const reported = state.serverBudgets.get(serverBudgetKey(model, modelContextLimit));
  if (reported !== undefined) return { tokens: reported, source: "server" };
  return {
    tokens: Math.floor(modelContextLimit * FALLBACK_BUDGET_WINDOW_RATIO),
    source: "window-ratio",
  };
}

/** Remember the model budget a compress response reported. */
function noteServerBudget(
  state: ProxyState,
  model: unknown,
  modelContextLimit: number,
  result: CompressResult | null
): void {
  const tokens = result ? modelBudgetTokens(result) : undefined;
  if (tokens === undefined) return;
  state.serverReportsBudget = true;
  boundedSet(state.serverBudgets, serverBudgetKey(model, modelContextLimit), tokens);
}

type CompactionMode =
  | { mode: "off" }
  | { mode: "auto" }
  | { mode: "explicit"; tokens: number };

/** `/memtree-compact` for this session, else CCC_COMPACT_TARGET, else automatic. */
function compactionMode(
  opts: ProxyOptions,
  state: ProxyState,
  sessionId: string | undefined
): CompactionMode {
  const configured =
    sessionId !== undefined && state.compactTargets.has(sessionId)
      ? state.compactTargets.get(sessionId)
      : opts.defaultCompactTarget;
  if (configured === null) return { mode: "off" };
  if (configured === undefined) return { mode: "auto" };
  return { mode: "explicit", tokens: configured };
}

/** What a compaction aims at: the explicit N (capped under the budget), else budget/2. */
function compactionTarget(mode: CompactionMode, budgetTokens: number): number {
  const target =
    mode.mode === "explicit"
      ? Math.min(mode.tokens, Math.floor(budgetTokens * MAX_EXPLICIT_TARGET_BUDGET_RATIO))
      : Math.floor(budgetTokens / 2);
  return Math.max(SERVER_MIN_TARGET_TOKENS, target);
}

/**
 * Target and threshold for compress calls other than a main-thread human turn
 * or a tool turn (subagent and recap followups). They never build a
 * stable prefix, so they only need to stay under the budget: a server that
 * understands the threshold gets both, an older one gets neither and uses its
 * own model budget. Never a bare target, which would force a compression on
 * every call.
 */
function laneCompaction(
  opts: ProxyOptions,
  state: ProxyState,
  sessionId: string | undefined,
  model: unknown,
  modelContextLimit: number
): { target?: number; threshold?: number } {
  const mode = compactionMode(opts, state, sessionId);
  if (mode.mode === "off" || !state.serverReportsBudget) return {};
  const budget = resolveBudget(opts, state, model, modelContextLimit);
  return {
    target: compactionTarget(mode, budget.tokens),
    threshold: Math.max(SERVER_MIN_TARGET_TOKENS, budget.tokens),
  };
}

/** Calibrated input must leave room for the requested output as well. */
function calibratedSizeExceedsWindow(
  record: CompactionRecord,
  body: Record<string, any>,
  modelContextLimit: number
): boolean {
  const outputTokens = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
    ? Math.max(0, body.max_tokens) : 0;
  return record.sizeSource === "reported" &&
    (record.estimatedTokens ?? 0) + outputTokens > modelContextLimit;
}

function calibratedSizeExceedsLimits(
  record: CompactionRecord,
  body: Record<string, any>,
  modelContextLimit: number
): boolean {
  return (record.sizeSource === "reported" &&
    (record.estimatedTokens ?? 0) >= record.budgetTokens) ||
    calibratedSizeExceedsWindow(record, body, modelContextLimit);
}

/** Only calibrated usage may force an estimate-driven compaction. */
function budgetCompaction(
  state: ProxyState,
  record: CompactionRecord,
  target: number,
  body: Record<string, any>,
  modelContextLimit: number
): { target?: number; threshold?: number } {
  if (calibratedSizeExceedsLimits(record, body, modelContextLimit)) return { target };
  // Older servers may ignore a threshold, so do not send a forcing target
  // until support is known. They can still compact against their own budget.
  if (!state.serverReportsBudget) return {};
  const threshold = Math.max(SERVER_MIN_TARGET_TOKENS, record.budgetTokens);
  record.thresholdTokens = threshold;
  return { target, threshold };
}

/** Anthropic's whole input size for a request: uncached + cache read + cache write. */
function reportedInputTokens(rec: MessagesRecord): number | undefined {
  const usage = rec.usage;
  if (!usage || typeof usage.input_tokens !== "number") return undefined;
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Size of a body about to be sent, scaled from the reported size of an earlier
 * request of the same shape by that request's own bytes-per-token ratio.
 * Compressed memory is denser than bytes/4 (about 2.65 bytes per token on a
 * 2026-09-29 Opus session), so a plain bytes/4 fallback undercounted a body
 * that had shrunk slightly since the sample (1.25 KB less: 284k estimated vs
 * 429k reported), which would delay recompression past the budget. Growth
 * uses the denser of the sample's ratio and bytes/4, so the estimate errs
 * high. bytes/4 only when there is no sample.
 */
function estimateRequestTokens(
  sample: SizeSample | undefined,
  bytes: number
): { tokens: number; source: "reported" | "bytes" } {
  if (sample && sample.tokens > 0 && sample.forwardedBytes > 0) {
    const bytesPerToken = sample.forwardedBytes / sample.tokens;
    if (bytes <= sample.forwardedBytes) {
      return { tokens: Math.round(bytes / bytesPerToken), source: "reported" };
    }
    const added = bytes - sample.forwardedBytes;
    return {
      tokens: sample.tokens + Math.max(
        approxTokensFromBytes(added),
        Math.round(added / bytesPerToken)
      ),
      source: "reported",
    };
  }
  return { tokens: approxTokensFromBytes(bytes), source: "bytes" };
}

/** Something a request's reported size is recorded on: a stable prefix or a route. */
type SizeHolder = { lastSize?: SizeSample };

/** Keep the newest (largest-body) reported size of a request on this prefix. */
function notePrefixSize(prefix: SizeHolder, rec: MessagesRecord, bytes: number): void {
  const tokens = reportedInputTokens(rec);
  if (tokens === undefined) return;
  if (prefix.lastSize && bytes < prefix.lastSize.forwardedBytes) return;
  prefix.lastSize = { tokens, forwardedBytes: bytes };
}

/** Record the reported size of a main-thread request forwarded whole. */
function notePassthroughSize(
  state: ProxyState,
  sessionId: string | undefined,
  rec: MessagesRecord,
  bytes: number
): void {
  const tokens = reportedInputTokens(rec);
  if (sessionId === undefined || tokens === undefined) return;
  boundedSet(state.passthroughSizes, sessionId, { tokens, forwardedBytes: bytes });
}

/** Size of a tool turn sent on a ride, recorded on its prefix or route. */
const noteRideSize = notePrefixSize;

/**
 * Record the reported size of a request forwarded whole: the session's
 * passthrough size on the main thread, else its lane's.
 */
function noteWholeRequestSize(
  state: ProxyState,
  isMainRequest: boolean,
  sessionId: string | undefined,
  routeKey: string,
  rec: MessagesRecord,
  bytes: number
): void {
  if (isMainRequest && sessionId !== undefined) {
    notePassthroughSize(state, sessionId, rec, bytes);
    return;
  }
  const tokens = reportedInputTokens(rec);
  if (tokens === undefined) return;
  boundedSet(state.laneSizes, routeKey, { tokens, forwardedBytes: bytes }, MEMORY_ROUTE_MAX_LANES);
}

function boundedSet<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  limit = STABLE_PREFIX_MAX_SESSIONS
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** What a main-thread human turn does about compaction (planEdgeCompaction). */
type EdgePlan =
  /** `/memtree-compact off`: the pre-edge behaviour, no stable prefix. */
  | { kind: "off" }
  /** Send on the stored prefix; no compress call. */
  | { kind: "ride"; prefix: StablePrefix; routed: { body: Record<string, any>; raw: Buffer } }
  /**
   * Make a compress call. `target`/`threshold` go to the server as
   * compression_target_tokens / compression_threshold_tokens (either may be
   * absent). A compressed result becomes the new stable prefix. `fallback`
   * is the old prefix's ride, used when the compaction yields nothing usable.
   */
  | {
      kind: "compress";
      target?: number;
      threshold?: number;
      targetTokens: number;
      explicitTarget: boolean;
      reason?: RecompressReason;
      fallback?: { prefix: StablePrefix; routed: { body: Record<string, any>; raw: Buffer } };
    };

/**
 * Stable-prefix (edge) compaction for a main-thread human turn:
 *
 * - With a stored prefix that still matches the conversation and a size
 *   (prefix + newer turns) under the budget: ride it, no compress call.
 * - Otherwise compress: forced to the target when the prefix outgrew the
 *   budget, the window/target changed, or `/memtree-compact` asked; while the
 *   session is still passing through, let the server decide against the
 *   budget (threshold), or — on a server that predates the threshold — force
 *   only once the proxy's own estimate reaches the budget.
 *
 * Fills rec.compaction with the budget, estimate and reason.
 */
function planEdgeCompaction(args: {
  opts: ProxyOptions;
  state: ProxyState;
  body: Record<string, any>;
  messages: Message[];
  sessionId: string;
  modelContextLimit: number;
  forwardBody: Buffer;
  rec: MessagesRecord;
}): EdgePlan {
  const { opts, state, body, messages, sessionId, modelContextLimit, forwardBody, rec } =
    args;
  const mode = compactionMode(opts, state, sessionId);
  const budget = resolveBudget(opts, state, body.model, modelContextLimit);
  const compaction: CompactionRecord = {
    mode: mode.mode,
    budgetTokens: budget.tokens,
    budgetSource: budget.source,
  };
  rec.compaction = compaction;
  if (mode.mode === "off") {
    state.stablePrefixes.delete(sessionId);
    state.compactNow.delete(sessionId);
    return { kind: "off" };
  }
  const targetTokens = compactionTarget(mode, budget.tokens);
  const explicitTarget = mode.mode === "explicit";
  compaction.targetTokens = targetTokens;
  const forced = (
    reason: RecompressReason,
    fallback?: Extract<EdgePlan, { kind: "compress" }>["fallback"]
  ): EdgePlan => {
    compaction.reason = reason;
    return {
      kind: "compress",
      ...(reason === "budget"
        ? budgetCompaction(state, compaction, targetTokens, body, modelContextLimit)
        : { target: targetTokens }),
      targetTokens,
      explicitTarget,
      reason,
      ...(fallback ? { fallback } : {}),
    };
  };

  let prefix = state.stablePrefixes.get(sessionId);
  if (prefix) {
    const miss = prefixMismatch(body, messages, prefix, sessionId, stablePrefixMessageHash);
    if (miss) {
      // Rewind, edit, fork, /clear, or a changed system prompt: the prefix no
      // longer stands for this conversation. Start over from passthrough.
      state.stablePrefixes.delete(sessionId);
      compaction.prefixMiss = miss;
      prefix = undefined;
    }
  }
  if (prefix) {
    boundedSet(state.stablePrefixes, sessionId, prefix);
    const routed = prefixRoutedBody(body, messages, prefix);
    if (!routed) {
      // Cache TTLs are not conversation identity, but a stored 5m prefix
      // cannot precede a new 1h suffix. Rebuild without an invalid fallback;
      // never rewrite the prefix's bytes or the user's marker TTLs.
      state.stablePrefixes.delete(sessionId);
      return forced("prefix-mismatch");
    }
    const size = estimateRequestTokens(prefix.lastSize, routed.raw.length);
    compaction.estimatedTokens = size.tokens;
    compaction.estimatedBytes = routed.raw.length;
    compaction.sizeSource = size.source;
    const overWindow = routedBodyExceedsContext(body, routed.raw, modelContextLimit) ||
      calibratedSizeExceedsWindow(compaction, body, modelContextLimit);
    const fallback = overWindow ? undefined : { prefix, routed };
    if (state.compactNow.has(sessionId)) return forced("manual", fallback);
    if (
      prefix.modelContextLimit !== modelContextLimit ||
      (explicitTarget && prefix.targetTokens !== targetTokens)
    ) {
      return forced("target-change", fallback);
    }
    if (size.tokens >= budget.tokens || overWindow) return forced("budget", fallback);
    return { kind: "ride", prefix, routed };
  }

  if (state.compactNow.has(sessionId)) return forced("manual");
  const size = estimateRequestTokens(
    state.passthroughSizes.get(sessionId),
    forwardBody.length
  );
  compaction.estimatedTokens = size.tokens;
  compaction.estimatedBytes = forwardBody.length;
  compaction.sizeSource = size.source;
  if (calibratedSizeExceedsLimits(compaction, body, modelContextLimit)) {
    return forced(compaction.prefixMiss ? "prefix-mismatch" : "budget");
  }
  if (state.serverReportsBudget) {
    // The server measures the request and compresses only past the budget.
    const threshold = Math.max(SERVER_MIN_TARGET_TOKENS, budget.tokens);
    compaction.thresholdTokens = threshold;
    return { kind: "compress", target: targetTokens, threshold, targetTokens, explicitTarget };
  }
  // Without calibrated usage or threshold support, let the server decide
  // against its own model budget rather than forcing from transport bytes.
  return { kind: "compress", targetTokens, explicitTarget };
}

/** A tool turn sent on a compressed prefix instead of its whole history. */
interface ToolRide {
  raw: Buffer;
  /** "tool-memory": the lane's route; "tool-prefix": the session's stable prefix. */
  turnType: "tool-memory" | "tool-prefix";
  /** Where this request's reported size is recorded. */
  sizeHolder: SizeHolder;
}

/** What a tool turn does about compaction (planToolCompaction). */
type ToolPlan =
  /** Compaction off for the session: ride the route if any, else whole; no compress call. */
  | { kind: "off" }
  /** Under the budget on a route or the stable prefix: send it, no compress call. */
  | { kind: "ride"; ride: ToolRide }
  /** Under the budget with nothing to ride: forward whole, no compress call. */
  | { kind: "pass"; original?: boolean }
  /**
   * At the budget (or past the context window): ask for compression once.
   * Only a calibrated estimate forces `target`; otherwise the server decides. `fallback` is the ride sent if that fails. `replaces` (main
   * thread with a session) makes the result the session's stable prefix,
   * replacing that one (null: none).
   */
  | {
      kind: "compress";
      target?: number;
      threshold?: number;
      targetTokens: number;
      explicitTarget: boolean;
      estimateTokens: number;
      budgetTokens: number;
      /** The request would not fit the model's window as sent. */
      overWindow: boolean;
      fallback?: ToolRide;
      replaces?: StablePrefix | null;
    };

/**
 * Stable-prefix compaction for a tool turn, on every lane: the rule human
 * turns follow (planEdgeCompaction), minus the server-side threshold call —
 * a tool turn under the budget makes no compress call at all.
 *
 * - The ride: the lane's route (`ride`, already matched), else on the main
 *   thread the session's stable prefix when it still covers this history.
 * - Its size: estimateRequestTokens anchored on the size Anthropic reported
 *   for the previous request of the same shape (the ride's prefix or route,
 *   else the session's / lane's whole-request size), bytes/4 without one.
 * - Under the budget (and within the window): ride, or forward whole.
 * - At the budget: compress, forcing the target only with calibrated usage; on the
 *   main thread the result becomes the stable prefix later tool AND human
 *   turns ride.
 *
 * Fills rec.compaction.
 */
function planToolCompaction(args: {
  opts: ProxyOptions;
  state: ProxyState;
  body: Record<string, any>;
  messages: Message[];
  sessionId: string | undefined;
  routeKey: string;
  isMainRequest: boolean;
  modelContextLimit: number;
  forwardBody: Buffer;
  rec: MessagesRecord;
  ride: ToolRide | undefined;
  canCompress: boolean;
}): ToolPlan {
  const { opts, state, body, messages, sessionId, modelContextLimit, forwardBody, rec } =
    args;
  const mode = compactionMode(opts, state, sessionId);
  const budget = resolveBudget(opts, state, body.model, modelContextLimit);
  const compaction: CompactionRecord = {
    mode: mode.mode,
    budgetTokens: budget.tokens,
    budgetSource: budget.source,
  };
  rec.compaction = compaction;
  if (mode.mode === "off") return { kind: "off" };
  const targetTokens = compactionTarget(mode, budget.tokens);
  compaction.targetTokens = targetTokens;

  const stableLane = args.isMainRequest && sessionId !== undefined;
  const current = stableLane ? state.stablePrefixes.get(sessionId) : undefined;
  let ride = args.ride;
  let overWindow = false;
  if (!ride && current && !prefixMismatch(body, messages, current, sessionId, stablePrefixMessageHash)) {
    const routed = prefixRoutedBody(body, messages, current);
    if (routed) {
      if (routedBodyExceedsContext(body, routed.raw, modelContextLimit)) overWindow = true;
      else ride = { raw: routed.raw, turnType: "tool-prefix", sizeHolder: current };
    }
  }
  if (!ride) {
    overWindow ||= routedBodyExceedsContext(body, forwardBody, modelContextLimit);
  }
  const sample = ride
    ? ride.sizeHolder.lastSize
    : stableLane
      ? state.passthroughSizes.get(sessionId!)
      : state.laneSizes.get(args.routeKey);
  const size = estimateRequestTokens(sample, (ride?.raw ?? forwardBody).length);
  compaction.estimatedTokens = size.tokens;
  compaction.estimatedBytes = (ride?.raw ?? forwardBody).length;
  compaction.sizeSource = size.source;
  overWindow ||= calibratedSizeExceedsWindow(compaction, body, modelContextLimit);
  if (!args.canCompress) {
    if (overWindow) return { kind: "pass", original: true };
    return ride ? { kind: "ride", ride } : { kind: "pass" };
  }
  if (size.tokens < budget.tokens && !overWindow) {
    return ride ? { kind: "ride", ride } : { kind: "pass" };
  }
  compaction.reason = "budget";
  return {
    kind: "compress",
    ...budgetCompaction(state, compaction, targetTokens, body, modelContextLimit),
    targetTokens,
    explicitTarget: mode.mode === "explicit",
    estimateTokens: size.tokens,
    budgetTokens: budget.tokens,
    overWindow,
    ...(ride && !overWindow ? { fallback: ride } : {}),
    ...(stableLane ? { replaces: current ?? null } : {}),
  };
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
  capCacheBreakpoints(routed, route.compressedMessages.length);
  if (!validCacheTtlOrder(routed)) return null;
  return Buffer.from(JSON.stringify(routed), "utf-8");
}

/** Size the assembled input (including system/tools) and reserve output room. */
function routedBodyExceedsContext(
  body: Record<string, any>,
  routedBody: Buffer,
  modelContextLimit: number
): boolean {
  const outputTokens = typeof body.max_tokens === "number" &&
    Number.isFinite(body.max_tokens) ? Math.max(0, body.max_tokens) : 0;
  // This is the existing local byte estimate, not a tokenizer or a hard cap.
  // Recovery remains best-effort and never calls the provider to count tokens.
  return approxTokensFromBytes(routedBody.length) + outputTokens > modelContextLimit;
}

function regrantSmallerWindowRecovery(
  state: ProxyState,
  key: string,
  modelContextLimit: number
): void {
  const previous = state.toolRecoveryAttemptedLanes.get(key);
  if (previous && !previous.inFlight && modelContextLimit < previous.modelContextLimit) {
    // The route has already been evicted. Dropping the attempt mark lifts its
    // backoff/awaiting-index, and an outage cooldown can defer the new
    // attempt without losing it; the next actual attempt records the smaller
    // capacity before it awaits anything.
    state.toolRecoveryAttemptedLanes.delete(key);
  }
}

/**
 * Whether a tool-turn body is an exact replay of the request that installed
 * the route: identical message count and every identity input
 * memoryRoutedToolBody validates — session, epoch, system hash, and each
 * prefix message hash. Claude Code retries a request whose socket died before
 * the response flushed with the IDENTICAL body; that retry cannot ride (its
 * suffix is empty) but it is a client retry, not a divergence. Anything else
 * — any differing hash, or a body shorter than the prefix — is a genuine
 * mismatch and keeps reject-and-rebuild semantics.
 */
function isRouteInstallReplay(
  body: Record<string, any>,
  messages: Message[],
  route: MemoryRoute,
  routeEpoch: number,
  sessionId: string | undefined
): boolean {
  if (
    !sessionId ||
    route.sessionId !== sessionId ||
    route.routeEpoch !== routeEpoch ||
    routeValueHash(normalizeRouteSystem(body.system)) !==
      route.originalSystemHash ||
    messages.length !== route.originalPrefixHashes.length
  ) {
    return false;
  }
  for (let i = 0; i < messages.length; i++) {
    if (routeMessageHash(messages[i]) !== route.originalPrefixHashes[i]) {
      return false;
    }
  }
  return true;
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

/** Anthropic's limit on cache_control breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Claude Code marks its own blocks with cache_control, but the server's
 * flatten turns the compressed conversation into one plain-string user
 * message, so a compressed request carried no breakpoint at all: Anthropic
 * billed every compressed first request in full and cached nothing
 * (requests.jsonl, 2026-09-26: followup-compressed 51.8M uncached input,
 * 0.06M cache write; tool-recompressed 133.5M uncached, 0 either way).
 * Marking the flattened message caches system + tools + compressed history,
 * and every tool turn that rides the route reads it back.
 */
function withFlattenCacheBreakpoint(
  body: Record<string, any>,
  ttl: string | undefined
): Message[] {
  const messages: Message[] = body.messages;
  if (messages.length !== 1) return messages;
  const only = messages[0];
  const text = typeof only.content === "string" ? only.content : undefined;
  if (text === undefined) return messages;
  const cacheControl: Record<string, string> = { type: "ephemeral" };
  if (ttl !== undefined) cacheControl.ttl = ttl;
  return [{ ...only, content: [{ type: "text", text, cache_control: cacheControl }] }];
}

/**
 * Match the last existing marker in Anthropic's tools/system/messages order.
 * For a valid request it is the shortest TTL, so a new final marker cannot
 * put 1h after a retained 5m marker. Preserve omitted TTLs (default 5m).
 */
function cacheTtlOf(body: Record<string, any>): string | undefined {
  let last: string | undefined;
  forEachCacheControl(body, (cc) => { last = cc.ttl; });
  return last;
}

/** A transformed request must not place a 1h breakpoint after a 5m one. */
function validCacheTtlOrder(body: Record<string, any>): boolean {
  let sawShort = false;
  let valid = true;
  forEachCacheControl(body, (cc) => {
    if (cc.ttl === "1h") {
      if (sawShort) valid = false;
    } else {
      sawShort = true;
    }
  });
  return valid;
}

function countCacheBreakpoints(body: Record<string, any>): number {
  let n = 0;
  forEachCacheControl(body, () => n++);
  return n;
}

function forEachCacheControl(
  body: Record<string, any>,
  visit: (cc: Record<string, any>) => void
): void {
  const blocks = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (item && typeof item === "object" && (item as any).cache_control) {
        visit((item as any).cache_control);
      }
    }
  };
  // Anthropic prompt order matters for mixed cache TTLs.
  blocks(body.tools);
  blocks(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) blocks(m?.content);
  }
}

/**
 * Keep a request within Anthropic's breakpoint limit after the compressed
 * prefix (which carries one) is joined to Claude Code's own suffix. Drops
 * the earliest suffix breakpoints first, never the compressed prefix's or
 * the request's last one, so both the big prefix and the growing tail stay
 * cached.
 */
function capCacheBreakpoints(body: Record<string, any>, _prefixLength?: number): void {
  // Protected: the compressed prefix's own marker (always on messages[0], the
  // flattened memory) and the newest marker. Everything else goes, oldest
  // first: message markers after the prefix (a reused prefix route carries
  // earlier turns' messages, with Claude Code's markers still on them), then
  // system and tool markers, which the prefix marker's cache entry covers
  // anyway because it comes after them. Anthropic rejects more than 4.
  let excess = countCacheBreakpoints(body) - MAX_CACHE_BREAKPOINTS;
  if (excess <= 0) return;
  const last = Array.isArray(body.messages) ? lastCacheBreakpoint(body.messages) : undefined;
  if (Array.isArray(body.messages)) {
    for (let i = 1; i < body.messages.length && excess > 0; i++) {
      const content = body.messages[i]?.content;
      if (!Array.isArray(content)) continue;
      body.messages[i] = {
        ...body.messages[i],
        content: content.map((part: any, j: number) => {
          if (excess <= 0 || !part?.cache_control || (i === last?.[0] && j === last?.[1])) return part;
          excess--;
          const { cache_control: _dropped, ...rest } = part;
          return rest;
        }),
      };
    }
  }
  for (const key of ["system", "tools"] as const) {
    if (excess <= 0 || !Array.isArray(body[key])) continue;
    body[key] = body[key].map((part: any) => {
      if (excess <= 0 || !part || typeof part !== "object" || !part.cache_control) return part;
      excess--;
      const { cache_control: _dropped, ...rest } = part;
      return rest;
    });
  }
}

function lastCacheBreakpoint(messages: Message[]): [number, number] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if ((content[j] as any)?.cache_control) return [i, j];
    }
  }
  return undefined;
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
  /** Current server-health evidence contributed by this blocking operation. */
  liveHealth: "success" | "failure" | "none";
}

/**
 * The blocking-compression step, shared by the main followup path and
 * tool-route miss recovery: the compress call plus the `compress` telemetry
 * record. Callers own downstream-close tracking (compression promises are
 * hash-deduped and may serve another live retry, so a per-request disconnect
 * signal must never feed compress()) and all decisions about the returned
 * result: both `didMemtreeCompress(result)` and
 * `checkCompressedHistory(result, msgsForMemtree).usable` must hold before
 * the result may be forwarded or become a route.
 */
async function runBlockingCompression(args: {
  opts: ProxyOptions;
  state: ProxyState;
  body: Record<string, any>;
  msgsForMemtree: Message[];
  hash: string;
  modelContextLimit: number;
  rec: MessagesRecord;
  sessionId: string | undefined;
  /** The subagent this request belongs to: its transcript has the usage and times. */
  agentId?: string;
  clientMeta?: Record<string, string>;
  /**
   * compression_target_tokens / compression_threshold_tokens for this call.
   * Omitted: laneCompaction's (never a bare forcing target).
   */
  compaction?: { target?: number; threshold?: number };
}): Promise<BlockingCompressionOutcome> {
  const { opts, state, body, msgsForMemtree, hash, modelContextLimit, rec } =
    args;
  const compaction =
    args.compaction ??
    laneCompaction(opts, state, args.sessionId, body.model, modelContextLimit);
  const messageUsage =
    args.sessionId !== undefined && opts.transcriptUsage
      ? opts.transcriptUsage.usageFor(args.sessionId, msgsForMemtree, args.agentId)
      : undefined;
  const messageTimes = transcriptTimesFor(opts, args.sessionId, args.agentId)?.(msgsForMemtree);
  const compressStarted = Date.now();
  const compressMeta = {
    // Model + tools drive the server's model-based memory budget
    // (e.g. 800k whole-request target for Fable / Opus 5). Omitting
    // them silently downgrades to the server's static 50k fallback.
    // `[1m]` is re-attached when the session is 1M-context so the
    // server's budget telemetry names the variant it actually served.
    model: modelForMemtree(
      typeof body.model === "string" ? body.model : undefined,
      modelContextLimit
    ),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    ...(compaction.target !== undefined
      ? { compressionTargetTokens: compaction.target }
      : {}),
    ...(compaction.threshold !== undefined
      ? { compressionThresholdTokens: compaction.threshold }
      : {}),
    ...(messageUsage && Object.keys(messageUsage).length ? { messageUsage } : {}),
    ...(messageTimes && Object.keys(messageTimes).length ? { messageTimes } : {}),
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.clientMeta ? { clientMeta: args.clientMeta } : {}),
  };
  // Sampled BEFORE the call, while it still describes this call: after the
  // await the hash is in the cache regardless of who put it there.
  const cached = opts.memtree.hasCachedCompress(
    hash,
    modelContextLimit,
    compressMeta
  );
  // compress() maps every failure to a resolved null (it never rejects).
  const result = await opts.memtree.compress(
    hash,
    msgsForMemtree,
    modelContextLimit,
    state.shutdownSignal,
    compressMeta
  );
  const compressMs = Date.now() - compressStarted;
  noteServerBudget(state, body.model, modelContextLimit, result);
  // Sampled at this call's settle, before a concurrent same-request failure of
  // another class can overwrite the complete-key entry.
  const failureArming =
    result === null &&
    opts.memtree.lastCompressFailureArming(hash, modelContextLimit, compressMeta);
  const hadLiveSuccess = !cached && result !== null;
  // Only arming-class live failures (network error, timeout, 5xx, 402) are
  // fuse evidence. A responsive server's other 4xx failed THIS call but says
  // nothing about MemTree's health, so it contributes neither failure nor
  // success — the fuse is untouched.
  const hadLiveFailure = !cached && result === null && failureArming;
  rec.compress = {
    ms: compressMs,
    ok: result !== null,
    // Budget-consumed heuristic: the client maps every failure to null, so a
    // null that took (roughly) the whole abort budget was almost certainly
    // the AbortSignal timeout, not a fast server error.
    timedOut: result === null && compressMs >= opts.memtree.compressBudgetMs,
  };
  return {
    result,
    // Cached-only operations leave the existing fuse state untouched.
    liveHealth: hadLiveSuccess
      ? "success"
      : hadLiveFailure
        ? "failure"
        : "none",
  };
}

/**
 * Shared final request shape for a validated compression result: lift any
 * returned system message to `body.system`, and forward the SERVER's flatten
 * of the compressed conversation as the single user message Anthropic
 * receives. The flatten format (closed transcript container, per-human-turn
 * headers, live-tail framing, header escaping) lives server-side only; the
 * client forwards `flattened_messages` verbatim and never re-derives it.
 * Returns null when the server provided no usable flatten (a pre-flatten
 * server, or a malformed field) — callers degrade to forwarding the original
 * history. Route candidates must be created from this `compressedBody` —
 * never from raw `result.messages` — so tool-turn rewrites extend exactly
 * the bytes that were sent.
 */
function buildCompressedBody(
  body: Record<string, any>,
  result: CompressResult
): { compressedBody: Record<string, any>; compressedRaw: Buffer } | null {
  const flattened = serverFlattenedMessages(result);
  if (flattened === null) return null;
  const systemMsg = result.messages.find((m) => m.role === "system");
  const compressedBody: Record<string, any> = {
    ...body,
    messages: flattened,
  };
  if (systemMsg?.content != null) {
    compressedBody.system = systemMsg.content;
  }
  compressedBody.messages = withFlattenCacheBreakpoint(compressedBody, cacheTtlOf(body));
  // Reserve a slot for the prefix even when all four original markers were
  // on retained tools/system blocks. Only this transformed body is capped.
  capCacheBreakpoints(compressedBody, compressedBody.messages.length);
  if (!validCacheTtlOrder(compressedBody)) return null;
  return {
    compressedBody,
    compressedRaw: Buffer.from(JSON.stringify(compressedBody), "utf-8"),
  };
}

/**
 * A tool turn's compaction (planToolCompaction said its estimated size
 * reached the budget): one blocking compression forced to the target,
 * sharing the followup path's complete selection pipeline. This is a soft
 * fuse — any failure, no-op, unusable, or non-shrinking result degrades to
 * the body the turn would otherwise have sent (`fallback`: the old route or
 * prefix ride, recorded as keptPrefix; else the whole history). A validated
 * smaller result forwards exactly one compressed Anthropic leg, claims no
 * human-turn state (no notice, no prompt arm/delivery mutation), and at
 * protocol-complete installs the lane's route and, on the main thread, the
 * session's new stable prefix (`stable`), so later tool and human turns ride
 * it with no compress call. An attempt that produced no prefix sets the
 * lane's backoff (`retryAtTokens`).
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
  /** Original upload, preserved byte for byte on unexpected compression errors. */
  originalBody: Buffer;
  msgsForMemtree: Message[];
  hash: string;
  modelContextLimit: number;
  routeEpoch: number;
  rec: MessagesRecord;
  conversationBytes: number;
  routeKey: string;
  isMainRequest: boolean;
  recoveryAttempt: ToolRecoveryAttempt;
  toolForwarding: ReturnType<typeof toolForwardingGuard>;
  clientMeta?: Record<string, string>;
  /** compression_target_tokens / threshold for the compress call. */
  compaction?: { target?: number; threshold?: number };
  /** Main thread with a session: store the result as the stable prefix. */
  stable?: StablePrefixInstall;
  /** Sent instead of the whole history when the attempt produces nothing. */
  fallback?: ToolRide;
  /** The lane's backoff size, set when the attempt produces no prefix. */
  retryAtTokens?: number;
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
    hash,
    modelContextLimit,
    routeEpoch,
    rec,
    conversationBytes,
    routeKey,
    isMainRequest,
    recoveryAttempt,
    toolForwarding,
    stable,
    fallback,
  } = args;
  const backOff = () => {
    if (args.retryAtTokens !== undefined) recoveryAttempt.retryAtTokens = args.retryAtTokens;
  };

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
  // "the client got the message": the fast-tool abort documented at the
  // forwardRaw settle in handleMessages — Claude consumes message_stop,
  // drops the SSE, and fires its
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
  // agent install here would merely leave its tool loop routeless (agents
  // have no stable prefix), compressing again on every over-budget turn.
  const promptWindowPending = isMainRequest && state.mainPromptArmed;
  // Every identity owns its own lane. Missing session identity, a pending
  // prompt window, or uncertain main-prompt ownership makes this transform-only. The foreign-owner and
  // subagent carve-outs are gone because the hazard they defended against is
  // structurally unreachable — a request's key can only name its own lane.
  const routeOwning = sessionId !== undefined && !promptWindowPending &&
    !(isMainRequest && routeOwnershipIsUncertain(state));
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
  const linkSeq = isMainRequest ? nextMemtreeCallSeq(state) : undefined;
  let compression: BlockingCompressionOutcome;
  try {
    compression = await runBlockingCompression({
      opts,
      state,
      body,
      msgsForMemtree,
      hash,
      modelContextLimit,
      rec,
      sessionId: requestSessionId(req),
      agentId: agentAttributionId(req),
      clientMeta: args.clientMeta,
      ...(args.compaction ? { compaction: args.compaction } : {}),
    });
  } catch {
    // Preserve the reservation and ownership safeguards even on pipeline exceptions.
    backOff();
    releaseOwnReservation();
    rec.routeRecovery = { conversationBytes, outcome: "failed" };
    if (!toolForwarding.allow(false)) return;
    recordTurn(rec, "tool", args.originalBody);
    capture(opts, "anthropic-request", args.originalBody);
    return forwardRaw(req, res, args.originalBody, opts, upstream, state.shutdownSignal, rec)
      .then((delivered) => {
        toolForwarding.settle(delivered);
        noteWholeRequestSize(state, isMainRequest, sessionId, routeKey, rec, args.originalBody.length);
      });
  } finally {
    res.off("close", markDownstreamClosed);
  }
  const { result } = compression;
  // Every lane writes the shared cooldown now: with subagents on the same
  // recovery path, a subagent's compress failure is the same evidence about
  // MemTree's health as main's, and its successes clear the cooldown too.
  noteMemtreeHealth(state, compression);
  if (linkSeq !== undefined) {
    noteMemtreePage(state, linkSeq, requestSessionId(req), result);
  }

  if (
    downstreamClosedDuringCompression ||
    (res.destroyed && !res.writableFinished)
  ) {
    // The MemTree work keeps its cache/index value, but a dead client gets
    // no Anthropic request and no route.
    rec.routeRecovery = { conversationBytes, outcome: "client-closed" };
    releaseOwnReservation();
    // Same hazard class as the post-forward fates "upstream-failed" /
    // "client-aborted": no route was installed and the client's identical
    // retry is imminent, so no backoff is set and the attempt mark is
    // dropped; the retry compresses again, a compress-cache hit (client
    // closes are deliberately never fed into compress()). Epoch-guarded so a
    // late settle cannot touch a later human turn's lane.
    if (state.mainRouteEpoch === routeEpoch) {
      state.toolRecoveryAttemptedLanes.delete(routeKey);
    }
    recordTurn(rec, "tool", Buffer.alloc(0));
    return;
  }

  /**
   * The attempt produced nothing: send what the turn would have sent without
   * it — the old ride (kept prefix) or the whole history — and back off.
   */
  const forwardOriginal = () => {
    backOff();
    if (!toolForwarding.allow(!!fallback)) return Promise.resolve();
    if (fallback) {
      if (rec.compaction) rec.compaction.keptPrefix = true;
      recordTurn(rec, fallback.turnType, fallback.raw);
      capture(opts, "anthropic-request-memory-tool", fallback.raw);
      return forwardRaw(
        req,
        res,
        fallback.raw,
        opts,
        upstream,
        state.shutdownSignal,
        rec
      ).then((delivered) => {
        toolForwarding.settle(delivered);
        noteRideSize(fallback.sizeHolder, rec, fallback.raw.length);
      });
    }
    recordTurn(rec, "tool", forwardBody);
    capture(opts, "anthropic-request", forwardBody);
    return forwardRaw(
      req,
      res,
      forwardBody,
      opts,
      upstream,
      state.shutdownSignal,
      rec
    ).then((delivered) => {
      toolForwarding.settle(delivered);
      noteWholeRequestSize(state, isMainRequest, sessionId, routeKey, rec, forwardBody.length);
    });
  };

  if (!result) {
    rec.routeRecovery = { conversationBytes, outcome: "failed" };
    releaseOwnReservation();
    // An ordinary server/network failure or timeout retains the background
    // submission: its longer independent budget can still warm the index for
    // a later turn. An unpaid key (402, possibly set by this very compress)
    // or a shutting-down proxy gets no retry.
    if (
      !state.shutdownSignal.aborted &&
      opts.memtree.paymentRequiredDetail === null
    ) {
      opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, requestSessionId(req), args.clientMeta, transcriptTimesFor(opts, requestSessionId(req), agentAttributionId(req)));
    }
    return forwardOriginal();
  }

  // Any non-null response already submitted this history to the server; an
  // extra indexInBackground for the same request would be a duplicate.
  const actuallyCompressed = didMemtreeCompress(result);
  const historyCheck = checkCompressedHistory(result, msgsForMemtree);
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
    // No tree yet (nothing indexed): wait for it to be built rather than
    // retrying on growth, which on a fast-growing loop is every tool turn.
    const pageId = result.memtreeUrl ? memtreePageId(result.memtreeUrl) : undefined;
    if (!actuallyCompressed && !(cachedPromptTokenCount(result) ?? 0) && pageId) {
      recoveryAttempt.awaitingIndex = {
        pageId,
        checking: false,
        deadline: Date.now() + (opts.awaitedIndexWaitTimeoutMs ?? 60_000),
      };
      rec.routeRecovery.awaitingIndex = true;
    }
    releaseOwnReservation();
    return forwardOriginal();
  }

  // Serializing the compressed body is the one synchronous step here that can
  // realistically throw: these are the multi-megabyte payloads that court
  // V8's string-length ceiling, which is exactly why this fuse exists. A
  // throw would otherwise escape as a proxy 500 AND strand the reservation,
  // turning a recoverable tool turn into a failed one. Degrade instead — the
  // original body is still forwardable.
  let built: {
    compressedBody: Record<string, any>;
    compressedRaw: Buffer;
  } | null;
  try {
    built = buildCompressedBody(body, result);
  } catch (err) {
    rec.routeRecovery = { conversationBytes, outcome: "build-failed" };
    releaseOwnReservation();
    if (opts.debug) {
      console.error(
        `[ccc proxy] recovered body build failed: ${
          (err as Error)?.message ?? err
        }`
      );
    }
    return forwardOriginal();
  }
  if (built === null) {
    // The server compressed but returned no usable `flattened_messages`
    // (pre-flatten server, or a malformed field). The client never re-derives
    // the flatten locally — that drifted from the server's canonical format
    // once already — so degrade to the original body, same envelope as every
    // other non-forwardable recovery outcome.
    rec.routeRecovery = { conversationBytes, outcome: "no-flatten" };
    releaseOwnReservation();
    if (opts.debug) {
      console.error(
        "[ccc proxy] recovered result carried no server flatten; " +
          "forwarding original body"
      );
    }
    return forwardOriginal();
  }
  const { compressedBody, compressedRaw } = built;
  if (compressedRaw.length >= (fallback?.raw ?? forwardBody).length) {
    // The final transformed body is the proof of payload recovery; a result
    // with no byte gain over what the turn would send anyway is not worth a
    // route built on it.
    rec.routeRecovery = { conversationBytes, outcome: "no-gain" };
    releaseOwnReservation();
    return forwardOriginal();
  }

  rec.routeRecovery = { conversationBytes, outcome: "compressed" };
  let activationAttempted = false;
  let ownershipDeferred = false;
  let installFate: "installed" | "stale" | undefined;
  let installedRoute: MemoryRoute | undefined;
  const activateRecoveredRoute = () => {
    if (activationAttempted) return;
    if (isMainRequest && routeOwnershipIsUncertain(state)) {
      ownershipDeferred = true;
      releaseOwnReservation();
      activationAttempted = true;
      return;
    }
    if (!routeOwning) {
      // No route (a typed prompt is pending, or no session to match a later
      // ride against), but on the main thread the result still becomes the
      // session's stable prefix: nothing classifies against it, and later
      // tool turns ride it directly ("tool-prefix").
      if (stable && sessionId !== undefined) {
        storeStablePrefix(
          state,
          sessionId,
          messages,
          {
            originalSystemHash: routeValueHash(normalizeRouteSystem(body.system)),
            compressedMessages: cloneJson(compressedBody.messages),
            compressedSystem: cloneJson(compressedBody.system),
            hasCompressedSystem: Object.prototype.hasOwnProperty.call(compressedBody, "system"),
          },
          stable
        );
      }
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
      decisionGeneration,
      stable
    );
    // Leave this false if installMemoryRoute unexpectedly throws: the
    // delivery-complete fallback then gets one safe retry.
    activationAttempted = true;
    installedRoute = installed;
    installFate = installed ? "installed" : "stale";
    // A tool continuation can arrive after message_stop while this HTTP
    // stream is still draining. Its route is already complete, so a smaller
    // window may buy recovery now. Mutate only this attempt's object: a late
    // transport settle must not release a newer attempt in the same lane.
    if (installed) recoveryAttempt.inFlight = false;
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
  // Set when either activation attempt throws. Protocol-complete firing
  // means the upstream served the complete turn and the proxy accepted the
  // message_stop bytes into the response — not that the client received
  // them. A throw there must NOT fall through to "client-aborted" or
  // "upstream-failed" at settle: in the common sub-case (fast-tool abort)
  // the client consumed its answer and no identical-body retry is coming.
  // The close is not always client-owned — an upstream socket error after
  // the data chunk carrying message_stop lands here too — and a socket
  // that dies before the queued bytes flush DOES retry the identical body.
  // Those rarer closes keep the lane's backoff — an accepted, bounded
  // degradation (the retry forwards uncompressed until the history grows
  // past the retry size or the next human turn clears it), because the
  // closes are indistinguishable at settle time and lifting the backoff
  // would fund one blocking recompress per tool turn under a deterministic
  // activation throw.
  let activationThrew = false;
  if (!toolForwarding.allow(true)) {
    releaseOwnReservation();
    return;
  }
  const delivered = await forwardRaw(
    req,
    res,
    compressedRaw,
    opts,
    upstream,
    state.shutdownSignal,
    rec,
    // Protocol-complete (accepted SSE message_stop or a complete 2xx JSON
    // response) is the real activation point, exactly as on the followup
    // path, so a fast tool request right after message_stop can ride.
    () => {
      try {
        activateRecoveredRoute();
      } catch {
        // forwardRaw's own guard would swallow this anyway; catching here
        // records that a route was earned but its bookkeeping threw, which
        // the settle label below must be able to tell apart from a
        // mid-stream abort or an upstream failure.
        activationThrew = true;
      }
    }
  );
  toolForwarding.settle(delivered);
  // Defensive delivery-complete fallback, mirroring the followup path. A
  // candidate already activated at message_stop deliberately survives a
  // delivered=false settle (fast-tool abort); an upstream 500/529 or an
  // incomplete response never reached protocol-complete and never installs.
  // Swallow a repeat throw: if it escaped here, the settle logic below
  // would be skipped and the lane's reservation stranded for the rest of
  // the epoch. With no install fate the fallback below still labels
  // ("activation-error" for this corner) and releases; the backoff stays,
  // since the delivered client will not retry.
  if (delivered) {
    try {
      activateRecoveredRoute();
    } catch {
      // Fate/release handled by the settle logic below. Remember the throw:
      // this is a fully delivered response with no route, which must not be
      // labeled (or have its backoff lifted) as an upstream failure.
      activationThrew = true;
    }
  }
  rec.routeRecovery.install = ownershipDeferred ? "prompt-pending" : !routeOwning
    ? sessionId === undefined
      ? "no-session"
      : "prompt-pending"
    : // No install fate normally means protocol-complete never fired —
      // split by who owned the close: a client mid-stream abort is not
      // evidence about upstream health, and the attempt-rate tripwire needs
      // to count the two separately. The one exception is a turn the
      // upstream served to protocol-complete whose route bookkeeping threw
      // at an activation attempt (the protocol-complete attempt, the
      // delivered retry, or both): label it distinctly so it neither
      // pollutes the upstream-failure metric nor lifts the backoff. In
      // the common sub-case the client got its answer (a fast-tool abort
      // consumed message_stop first) and no identical-body retry is coming;
      // the rarer closes — a pre-flush socket death (which does retry, into
      // the lane's backoff) or an upstream-owned error after the accepted
      // message_stop chunk — land here too. See the activationThrew comment
      // above for why that trade-off is deliberate.
      installFate ??
      (activationThrew
        ? "activation-error"
        : rec.clientAborted
          ? "client-aborted"
          : "upstream-failed");
  if (stable) rec.routeRecovery.prefix = stable.installed ? "installed" : "not-installed";
  // The compacted request's reported size anchors the next budget check.
  const sizeHolder: SizeHolder | undefined = stable?.installed ?? installedRoute;
  if (sizeHolder) notePrefixSize(sizeHolder, rec, compressedRaw.length);
  // Nothing to ride next turn, or a result that still does not fit the
  // window (the next turn would reject it and compress again): wait for
  // growth before the lane tries again.
  if (!sizeHolder || routedBodyExceedsContext(body, compressedRaw, modelContextLimit)) backOff();
  // A reservation that lost its race (stale) or never reached
  // protocol-complete (upstream 5xx, truncated stream) installed nothing, so
  // it must stop suppressing whoever is still trying to install.
  if (rec.routeRecovery.install !== "installed") releaseOwnReservation();
  // A failed forward AFTER a healthy compress — upstream 5xx/529 or a client
  // mid-stream abort — left no route and the client retries the identical
  // body, so drop the lane's attempt mark, lifting the backoff just set —
  // epoch-guarded, so a late settle cannot touch a later human turn's lane.
  // The retry's recompress is a compress-cache hit, so the re-attempt is
  // cheap. A later route reject-delete deliberately does NOT lift a backoff:
  // siblings sharing a parent-agent fallback lane genuinely mismatch each
  // other every turn, and lifting it there would be one real blocking
  // compress per tool step. The two fates are split in reqlog so the
  // attempt-rate tripwire can tell client behavior from upstream health;
  // the backoff lift treats them alike.
  if (
    (rec.routeRecovery.install === "upstream-failed" ||
      rec.routeRecovery.install === "client-aborted") &&
    state.mainRouteEpoch === routeEpoch
  ) {
    state.toolRecoveryAttemptedLanes.delete(routeKey);
  }
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

/**
 * Forward a buffered request and pipe the response back byte-for-byte. A
 * passive observer parses copies of SSE/JSON chunks for request logging and
 * completion validation; its output is discarded and can never change the
 * client response.
 */
/**
 * Requests whose streamed response gets a text block appended: the hidden
 * away-summary (recap) request, so the recap Claude Code shows ends with the
 * MemTree link. Keyed by the incoming request so every forwarding path below
 * picks it up without threading a parameter through each one.
 */
const recapLinkAppenders = new WeakMap<
  http.IncomingMessage,
  (streamedTextChars: number) => string | undefined
>();

function forwardRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream,
  shutdownSignal: AbortSignal,
  rec?: MessagesRecord,
  onProtocolComplete?: () => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    headers["content-length"] = String(bodyBuffer.length);
    const appendRecapText = recapLinkAppenders.get(req);
    // The passive observer must be able to decode its copy to verify complete
    // delivery (message_stop for SSE, complete JSON otherwise). Constrain the
    // negotiated coding to what the observation decoders support, so an
    // upstream choice like zstd cannot mark a byte-perfectly delivered
    // response as failed.
    // The bytes written to the client stay exact.
    headers["accept-encoding"] = observableAcceptEncoding(
      headers["accept-encoding"]
    );
    // Appending needs plain SSE text; the recap is tiny, so skip compression.
    if (appendRecapText) headers["accept-encoding"] = "identity";
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
      // Observability only: lets callers (and reqlog consumers) tell a
      // client-owned close from an upstream failure after the settle.
      if (rec) rec.clientAborted = true;
      activeUpstreamRes?.destroy();
      upstreamReq?.destroy();
      settle(false);
    };
    const completeUpstream = (complete: boolean) => {
      upstreamCompleted = true;
      protocolComplete = complete;
      if (complete && !res.destroyed) notifyProtocolComplete();
      if (res.destroyed && !res.writableFinished && !shutdownCancelled) {
        // The destroy is client-owned here: upstream ended cleanly (its
        // error/aborted handlers settle synchronously before this can run)
        // and the shutdownCancelled guard excludes the proxy-owned destroy —
        // on the decoder path, decoder.end() defers finish() a tick, and a
        // shutdown landing in that gap would otherwise be stamped as a
        // client abort (onResponseClose has the same guard). Stamp directly —
        // this settle detaches onResponseClose before the 'close' event that
        // normally stamps can fire, and losing that race would misclassify a
        // client abort as "upstream-failed" in the recovery settle.
        clientAborted = true;
        if (rec) rec.clientAborted = true;
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
        // Rewrite only a plain, successful SSE stream; anything else passes
        // through untouched and simply carries no link.
        const appendText =
          appendRecapText &&
          isSse &&
          !compressed &&
          (upstreamRes.statusCode ?? 0) >= 200 &&
          (upstreamRes.statusCode ?? 0) < 300
            ? appendRecapText
            : undefined;
        const sseObserver = isSse
          ? new SseNoticeRewriter({
              onEvent: observeSseEvent,
              ...(appendText ? { endOfTurnText: appendText } : {}),
            })
          : null;
        const incrementalDecoder = sseObserver && compressed
          ? createObservationDecoder(contentEncoding)
          : null;
        const observedChunks: Buffer[] | null =
          !isSse || (compressed && !incrementalDecoder) ? [] : null;
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

        if (appendText && sseObserver) {
          // Same observation as below, but the client gets the rewriter's
          // output (original frames plus the appended block) instead of the
          // raw bytes. Backpressure mirrors pipe().
          upstreamRes.on("data", (chunk: Buffer) => {
            if (rec && !sawFirstByte) {
              sawFirstByte = true;
              rec.ttfbMs = Date.now() - forwardStarted;
            }
            const out = sseObserver.push(chunk);
            if (!out || res.destroyed || res.writableEnded) return;
            if (!res.write(out)) {
              upstreamRes.pause();
              res.once("drain", () => upstreamRes.resume());
            }
            if (sawMessageStop && !observerFailed && !res.destroyed) {
              notifyProtocolComplete();
            }
          });
          upstreamRes.on("end", () => {
            const rest = sseObserver.flush();
            if (rest && !res.destroyed && !res.writableEnded) res.write(rest);
            if (!res.destroyed && !res.writableEnded) res.end();
            completeUpstream(!observerFailed && sawMessageStop);
          });
          upstreamRes.on("error", () => {
            res.destroy();
            settle(false);
          });
          upstreamRes.on("aborted", () => {
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
  upstreamRes: http.IncomingMessage
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir does not tighten a directory reused from an earlier run.
    chmodSync(dir, 0o700);
    const name = `${String(++captureCounter).padStart(4, "0")}-${kind}-${randomBytes(8).toString("hex")}.json`;
    // Never reuse an existing file (which may have permissive old modes).
    writeFileSync(join(dir, name), body, { mode: 0o600, flag: "wx" });
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

/** Test seam. */
export const __testCapCacheBreakpoints = capCacheBreakpoints;
export const __testEstimateRequestTokens = estimateRequestTokens;

/** Reads message times from the session's transcript, when there is one. */
function transcriptTimesFor(
  opts: ProxyOptions,
  sessionId: string | undefined,
  agentId?: string
): ((messages: Message[]) => MessageTimes) | undefined {
  const source = opts.transcriptUsage;
  if (sessionId === undefined || !source?.timesFor) return undefined;
  return (messages) => source.timesFor!(sessionId, messages, agentId);
}
