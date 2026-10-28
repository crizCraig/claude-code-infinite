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

import { capCacheBreakpoints } from "./route-cache.js";
import { PromptAccounting } from "./prompt-accounting.js";
import { INDEX_WAIT_RETRY_AFTER_SECONDS, RouteFallbackFailures, pausedRefusal }
  from "./route-fallback.js";
import {
  createCountTokensSession,
  CountTokensCooldowns,
  plausibleSample,
  type SizeSample,
} from "./count-tokens.js";
import { RequestSizing, estimateRequestTokens, fitsMeasured, fitsNative, outputReservation,
  type CandidateMeasurement, type PlannedSize, type RequestCandidate, type SizingLimits }
  from "./request-sizing.js";
import {
  extendsHistory, mediaFreeMessageHash, prefixIdentity, prefixMessageMatches, type PrefixIdentity,
} from "./route-identity.js";
import { COMPRESSION_RESERVE_TOKENS, compressionTrigger, PreparedCompressions,
  prepareStartTokens, type Prepared } from "./prepared-compression.js";
import { truncateToolResults } from "./tool-result-truncation.js";
import type { ToolOutputStore } from "./tool-output-store.js";
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
  indexLagEvidence,
  MemtreeClient,
  modelBudgetTokens,
  normalizeMessagesForMemtree,
  serverFlattenedMessages,
  type CompressRequestMeta,
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
  SseNoticeRewriter,
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
  urlLine,
  terminalSupportsHyperlinks,
  isMemtreeViewCommand,
  sessionCommandArgs,
  parseNoticeHookInput,
  type FirstTreeIntro,
  type SessionStartHookInput,
  type SuccessLink,
} from "./hooks.js";
import { USAGE_LABEL, USAGE_SIGN_IN_NOTE } from "./usage-link.js";
import { hyperlink } from "./payment-gate.js";
import { keyInvalidNoticeText, keyInvalidRefusalMessage } from "./key-status.js";
import { KEY_INVALID_KIND, type ModelNotice, ModelContextNotices, PAUSED_KIND,
  keyInvalidModelContext, lastToldKindInFile, pausedModelContext } from "./model-context.js";
import { PaymentNoticeThrottle, pausedCompactionText, pausedRefusalMessage, paymentNoticeText,
  subscribeUrlFromDetail } from "./payment-notice.js";
import type { MemtreeLinkPlacement } from "./cli-args.js";
import { MEMTREE_LINKS_MAX_SESSIONS, type MemtreeLinkStore } from "./memtree-links.js";
import type { PersistedEntry, StablePrefixStore } from "./prefix-store.js";
import type { NewestTreeLookup } from "./memtree-newest.js";
import {
  describeClaudeCodeRequest,
  inspectMonitorTranscript,
  knownSideRequestKind,
  transcriptWarning,
  isClaudeCodeSideRequest,
  memtreeClientMeta,
  sessionTag,
  type ClaudeCodeRequestInfo,
} from "./cc-request.js";
import type { MessageTimes, TranscriptUsageSource } from "./transcript-usage.js";
import type { ProjectMeta } from "./project-meta.js";
import { isResumableSessionId } from "./resume-hint.js";
import type { ProjectTreesHint } from "./project-trees.js";
import { conservativeBodyTokens } from "./token-estimate.js";
import { bodyImages } from "./image-tokens.js";
import type { DiagnosticsRecorder } from "./diagnostics.js";
import { claudeAuthFromHeaders, upstreamErrorCode } from "./claude-auth.js";
import { rateLimitFromResponse } from "./rate-limit.js";
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
/** Safety cap on a long-budget compress, should a transport ignore its abort. */
const MAX_LONG_COMPRESS_WAIT_MS = 10 * 60_000;
/** The most a blocking compress with a fallback may wait (its budget grows with its upload). */
const MAX_COMPRESS_WAIT_MS = 60_000;

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
   * How often the unpaid-key (402) notice may repeat in a session; defaults
   * to PAYMENT_NOTICE_INTERVAL_MS. Tests shorten it.
   */
  paymentNoticeIntervalMs?: number;
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
   * Size requests exactly with Anthropic's Count Tokens endpoint, using the
   * request's own credentials (count-tokens.ts): before a compaction decision
   * when the estimate is unknown or a jump nears the budget, and always before
   * refusing a request on an estimate. The CLI turns this on
   * (`CCC_COUNT_TOKENS=0` turns it off); embedders and tests keep estimates.
   */
  countTokens?: boolean;
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
  /** Bound on retrying an unfit request while MemTree indexes (route-fallback.ts). */
  indexWaitDeadlineMs?: number;
  /**
   * How long a compress answer from a lagging index keeps answering identical
   * retries before MemTree is asked again (default: the 503 retry-after).
   */
  indexWaitRefreshMs?: number;
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
   * Announces each session's first tree with a one-time notice (and, for the
   * user's first tree ever, what to do with it) instead of the routine link.
   * Omitted means no intro (tests); the CLI passes the on-disk FirstTreeMarker.
   */
  firstTreeIntro?: FirstTreeIntro;
  /**
   * Where each session's adopted compressed prefix is persisted so a resumed
   * session's first turn can ride it (prefix-store.ts). Omitted means no
   * persistence (tests); the CLI passes the store under ~/.claude-code-infinite.
   */
  stablePrefixStore?: StablePrefixStore;
  /**
   * Where a tool result shortened to fit the window (truncatedToFit) is saved
   * whole, for the model to read with its Read tool. Omitted means no such
   * shortening (tests); the CLI passes the store under ~/.claude-code-infinite.
   */
  toolOutputs?: ToolOutputStore;
  /**
   * The session's newest completed tree, asked of the server, which the link
   * shown to the user points at (the compress page is only the tree the memory
   * came from, and can be days old). Omitted means the link is the compress
   * page (tests); the CLI passes a lookup over the user's key.
   */
  newestTrees?: NewestTreeLookup;
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
  /**
   * An extra line for a main session's SessionStart (not compaction), e.g.
   * the auto-update result (auto-update.ts). Called on every such hook; the
   * provider decides how often it has something to say.
   */
  sessionStartNotice?: () => string | undefined;
  /**
   * A line to show as the user submits a main-session prompt (UserPromptSubmit),
   * e.g. a rate limit Anthropic answered with (rate-limit.ts). Called once per prompt.
   */
  promptSubmitNotice?: () => string | undefined;
  /**
   * Earlier MemTree sessions in this project, added to a main session's
   * SessionStart as model context (project-trees.ts). Omitted means none.
   */
  projectTrees?: ProjectTreesHint;
  /**
   * Client diagnostics (diagnostics.ts): session starts, paused notices shown,
   * and refusals, as allowlisted enums and numbers. Never content.
   */
  diagnostics?: DiagnosticsRecorder;
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
  /**
   * The main session a user could resume now (`ccc --resume <id>`): the last
   * one resumed or forked, or that sent a main-lane turn. Undefined until
   * then, and again after /clear until its first turn.
   */
  mainSessionId: () => string | undefined;
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
  /** Unpaid-key notice throttle; marked only when a hook delivers the notice. */
  paymentNotice: PaymentNoticeThrottle;
  /** Invalid-key (401/403) notice throttle, on the payment notice's interval. */
  keyNotice: PaymentNoticeThrottle;
  /** Whether MemTree's latest answer refused the key (MemtreeClient.keyInvalid). */
  keyInvalid: () => boolean;
  /** Where to get a new MemTree key (MemtreeClient.keyPageUrl). */
  keyPageUrl: string;
  /**
   * Sessions shown the paused notice's near-the-window line: once per session,
   * past the throttle, since /compact only works while the conversation fits.
   */
  pausedNearWindowWarned: Set<string>;
  /** The queued near-window line, so a refusal can withdraw it undelivered. */
  nearWindowNotice?: object;
  /** The MemTree client's last 402 detail, or null while the key is paid. */
  unpaidDetail: () => string | null;
  /** The 402 detail only while MemTree's latest answer was that 402 (MemtreeClient.pausedDetail). */
  pausedDetail: () => string | null;
  /** Why the key is paused, when the server said (MemtreeClient.pausedReason). */
  pausedReason: () => string | null;
  /** Whether MemTree's latest answer was a success (MemtreeClient.answering). */
  memtreeAnswering: () => boolean | undefined;
  /** What each session's model was told about MemTree's state; blocked /compacts. */
  modelNotices: ModelContextNotices;
  /** polychat's usage dashboard for the MemTree environment, if known. */
  usageUrl: string | undefined;
  /** ProxyOptions.sessionStartNotice. */
  sessionStartNotice?: () => string | undefined;
  /** ProxyOptions.promptSubmitNotice. */
  promptSubmitNotice?: () => string | undefined;
  /** ProxyOptions.projectTrees. */
  projectTrees?: ProjectTreesHint;
  /** ProxyOptions.diagnostics. */
  diagnostics?: DiagnosticsRecorder;
  notices: NoticeDeliveryQueue;
  /** RunningProxy.mainSessionId. */
  resumableMainSession?: string;
  /** Hook state affects notices only, never routing. */
  mainNoticePending: boolean;
  mainPromptId?: string;
  mainPromptText?: string;
  mainPromptGeneration: number;
  promptAccounting: PromptAccounting;
  fallbackFailures: RouteFallbackFailures;
  /** Suppress producer-side state changes while agent API traffic is active. */
  activeSubagents: Set<string>;
  /** Validated prefixes per API session/lane, LRU-bounded to MEMORY_ROUTE_MAX_LANES. */
  memoryRoutes: Map<string, MemoryRoute>;
  /** Latest main route for validated away-summary forks, independent of hook events. */
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
  /**
   * Per session, the page whose memory the prompt carries: set only when a
   * main-lane compress answer's route is installed after a complete upstream
   * response (the prefix later requests reuse), so `/memtree/current`
   * (the MCP tools' "current" tree, where bare node ids resolve) never moves to
   * a tree whose memory was rejected while an older prefix rides on. The link
   * (memtreePages) still follows every answer.
   */
  memorySourcePages: Map<string, MemtreePage>;
  /** Submission counter behind the pages' `seq`. */
  memtreeCallSeq: number;
  memtreeLinkStore?: MemtreeLinkStore;
  stablePrefixStore?: StablePrefixStore;
  /**
   * Session → its persisted prefix as loaded (null: none, or already adopted
   * or discarded), so the disk is read once per session. Bounded.
   */
  storedPrefixLookups: Map<string, PersistedEntry | null>;
  /** MemtreeClient.storageIdentity: whose persisted prefixes this process may use. */
  storageOwner?: string;
  newestTrees?: NewestTreeLookup;
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
   * Each session's prepared compressed prefix (prepared-compression.ts): made
   * in the background once the main thread's request nears the budget, and
   * installed as the stable prefix, with no compress call, on the turn that
   * would cross it.
   */
  prepared: PreparedCompressions<StablePrefix>;
  /** Each session's preparation still in flight (maybePrepareCompression). */
  preparing: Map<string, Promise<void>>;
  /**
   * Conversations with an under-budget background compress in flight
   * (compressInBackground), each with the newest call waiting for it, if any.
   * An entry lives only while its call runs, so this holds no more than the calls.
   */
  backgroundCompress: Map<string, { waiting?: BackgroundCompressArgs }>;
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
  countTokensCooldowns: CountTokensCooldowns;
  /**
   * Per session and model (sessionSizeKey): Anthropic's reported size of the
   * last main-thread request forwarded whole (no prefix), with its body bytes,
   * to estimate the next one while the session is still passing through. The
   * model is part of the key because the ratio is its tokenizer's: a Haiku
   * side request on the main lane once replaced the Opus sample (2026-10-13).
   */
  passthroughSizes: Map<string, SizeSample>;
  /**
   * The same for requests other than the main thread's (subagents), keyed by
   * laneSizeKey: the lane, the requester's own agent id and the model, so a
   * helper sharing a subagent's lane (a web-search call reporting server tool
   * results as input) cannot teach that subagent its ratio (2026-10-05).
   */
  laneSizes: Map<string, SizeSample>;
  /** Process lifetime identity; hooks never advance it. */
  mainRouteEpoch: number;
  /** Monotonically orders asynchronous replacements within each request lane. */
  mainRouteDecisionGeneration: number;
  /** Live and committed lane generations. At most 128 lanes; evicted generations fail closed. */
  routeDecisionsLive: Map<string, Set<number>>;
  retiredRouteDecisionFloor: number;
  /** At most 128 recovery attempts; failed attempts retry after growth or their deadline. */
  toolRecoveryAttemptedLanes: Map<string, ToolRecoveryAttempt>;
  /**
   * Epoch-ms deadline until which tool-route miss recovery skips its blocking
   * attempt, set when an attempt returns null. Zero means no cooldown.
   */
  toolRecoveryCooldownUntil: number;
  /** Fired by drain after its grace period so every forwarding path can stop. */
  shutdownSignal: AbortSignal;
  /**
   * Fired as drain starts: background compress and prepare calls (not awaited by any
   * request) stop, and none starts, so the exit drain is left to the final index.
   */
  backgroundSignal: AbortSignal;
  /** Test-only fault-injection seam; see ProxyOptions.routeInstallFault. */
  routeInstallFault?: () => void;
}

interface MemoryRoute {
  sessionId: string;
  originalSystemHash: string;
  originalPrefixHashes: string[];
  /** Media-free identities of the same messages (prefixMessageMatches); absent on old stores. */
  originalMediaFreeHashes?: string[];
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


/**
 * A session's stable compressed prefix (see ProxyState.stablePrefixes). The
 * route fields mean what they mean on MemoryRoute: the hashes of the original
 * messages the prefix stands for, and the compressed bytes sent instead.
 */
interface StablePrefix {
  sessionId: string;
  originalSystemHash: string;
  originalPrefixHashes: string[];
  /** Media-free identities of the same messages (prefixMessageMatches); absent on old stores. */
  originalMediaFreeHashes?: string[];
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
 * Budget fallback until the server reports `model_budget_tokens`, mirroring the
 * server's ccc policy (polychat index_budget.py near_window_budget_tokens):
 * every Claude model compresses near its window, at the window less the
 * reply's room (COMPRESSION_RESERVE_TOKENS, 40k) and never below
 * FALLBACK_BUDGET_WINDOW_RATIO of it: 960k of 1M, 160k of 200k; at most a
 * Sonnet's usable-context ceiling (SONNET_CEILINGS). Other models get
 * FALLBACK_BUDGET_WINDOW_RATIO. Plain Claude Code 2.1.302 auto-compacts at
 * window - 33k (967k of 1M), so MemTree compresses just before it would; ccc
 * lifts Claude Code's own 977k refusal (claude-env.ts) so a tool turn that
 * jumps past the budget reaches the proxy and is compressed here, on a
 * prepared prefix when there is one (prepared-compression.ts).
 */
export const FALLBACK_BUDGET_WINDOW_RATIO = 0.8;
/** The ids the server resolves to a Claude model (polychat ANTHROPIC_MODEL_FAMILIES). */
const CLAUDE_FAMILY_RE = /opus|sonnet|haiku|fable|mythos/i;
/**
 * polychat USABLE_CONTEXT_CEILING_TOKENS_BY_MODEL: the Sonnets degrade well
 * before their window. Sonnet 5 / 5.5 550k; every other Sonnet 400k. First match wins.
 */
const SONNET_CEILINGS: ReadonlyArray<readonly [RegExp, number]> = [
  [/sonnet-5(?![0-9])/i, 550_000],
  [/sonnet/i, 400_000],
];

/** The fallback whole-request budget for `model` on this window (see above). */
export function fallbackBudgetTokens(model: unknown, modelContextLimit: number): number {
  if (typeof model !== "string" || !CLAUDE_FAMILY_RE.test(model)) {
    return Math.floor(modelContextLimit * FALLBACK_BUDGET_WINDOW_RATIO);
  }
  const nearWindow = nearWindowBudgetTokens(modelContextLimit);
  const ceiling = SONNET_CEILINGS.find(([re]) => re.test(model))?.[1];
  return ceiling === undefined ? nearWindow : Math.min(nearWindow, ceiling);
}

/** A Claude model's near-window budget before any ceiling (fallbackBudgetTokens). */
function nearWindowBudgetTokens(modelContextLimit: number): number {
  return Math.max(Math.floor(modelContextLimit * FALLBACK_BUDGET_WINDOW_RATIO),
    modelContextLimit - COMPRESSION_RESERVE_TOKENS);
}
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
  retryDeadline?: number;
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
   * (a no-op with no indexed tokens), or a reply whose index trails the
   * conversation (indexLagEvidence). Until the
   * tree catches up a compress call cannot shrink that history: the server
   * keeps every unindexed message verbatim. The lane
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
  const probe = abortOnTimeoutOrShutdown(timeoutMs, shutdownSignal);
  opts.memtree
    .fetchMemTree(`/usage/memtree/${waiting.pageId}.json`, "application/json", probe.signal)
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
      probe.dispose();
      waiting.checking = false;
    });
}

/**
 * A signal that aborts after `timeoutMs` or when `shutdownSignal` aborts.
 * Not AbortSignal.any([shutdown, AbortSignal.timeout(ms)]): on Node 20 the
 * composite holds its sources weakly, so a GC can collect the timeout signal
 * and its abort never fires, leaving a hung probe open for good. Here the
 * timer and the shutdown listener hold the controller until dispose().
 */
function abortOnTimeoutOrShutdown(
  timeoutMs: number,
  shutdownSignal: AbortSignal
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  // Unreferenced like AbortSignal.timeout: a probe never holds the process open.
  const timer = setTimeout(abort, timeoutMs);
  timer.unref();
  shutdownSignal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      shutdownSignal.removeEventListener("abort", abort);
    },
  };
}

/**
 * Record lag evidence from `result` (indexLagEvidence): a refusal of this
 * request then waits for the index, and the cached answer expires after the
 * retry interval so a later retry asks MemTree again — at most one fresh
 * compress per interval for the same request.
 */
function noteIndexLag(opts: ProxyOptions, rec: MessagesRecord, result: CompressResult): boolean {
  if (!indexLagEvidence(result)) return false;
  rec.indexBehind = true;
  opts.memtree.expireCompressResult?.(result,
    opts.indexWaitRefreshMs ?? INDEX_WAIT_RETRY_AFTER_SECONDS * 1000);
  return true;
}

/** Mark a lane as waiting for the tree behind `result`'s MemTree page. */
function awaitIndex(
  opts: ProxyOptions,
  attempt: ToolRecoveryAttempt,
  record: NonNullable<MessagesRecord["routeRecovery"]>,
  result: CompressResult
): void {
  const pageId = result.memtreeUrl ? memtreePageId(result.memtreeUrl) : undefined;
  if (!pageId) return;
  attempt.awaitingIndex = {
    pageId,
    checking: false,
    deadline: Date.now() + (opts.awaitedIndexWaitTimeoutMs ?? 60_000),
  };
  record.awaitingIndex = true;
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

/** Record notice context without changing any route. */
function recordMainPromptNotice(
  state: ProxyState,
  promptId: string | undefined,
  prompt: string | undefined
): void {
  state.mainNoticePending = true;
  state.mainPromptId = promptId;
  state.mainPromptText = prompt;
  state.mainPromptGeneration++;
  state.notices.clearForUserRequest();
}

/** Snapshot display accounting before asynchronous work. It never controls forwarding. */
function capturePromptDelivery(
  state: ProxyState,
  isMainRequest: boolean,
  lastMsg: Message | undefined,
  sessionId: string | undefined
): { settle: (delivered: boolean) => void } {
  return { settle: isMainRequest
    ? state.promptAccounting.capture(sessionId, lastMsg) : () => {} };
}

/** Lookup a validated route and update its LRU position. */
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
  const backgroundAbort = new AbortController();
  const state: ProxyState = {
    paymentNotice: new PaymentNoticeThrottle(opts.paymentNoticeIntervalMs),
    keyNotice: new PaymentNoticeThrottle(opts.paymentNoticeIntervalMs),
    keyInvalid: () => opts.memtree.keyInvalid,
    keyPageUrl: opts.memtree.keyPageUrl,
    pausedNearWindowWarned: new Set(),
    unpaidDetail: () => opts.memtree.paymentRequiredDetail,
    pausedDetail: () => opts.memtree.pausedDetail,
    pausedReason: () => opts.memtree.pausedReason,
    memtreeAnswering: () => opts.memtree.answering,
    modelNotices: new ModelContextNotices(),
    usageUrl: opts.memtree.usageDashboardUrl,
    sessionStartNotice: opts.sessionStartNotice,
    promptSubmitNotice: opts.promptSubmitNotice,
    projectTrees: opts.projectTrees,
    diagnostics: opts.diagnostics,
    notices: new NoticeDeliveryQueue(),
    mainNoticePending: false,
    mainPromptGeneration: 0,
    promptAccounting: new PromptAccounting(),
    fallbackFailures: new RouteFallbackFailures(undefined, opts.indexWaitDeadlineMs),
    activeSubagents: new Set(),
    memoryRoutes: new Map(),
    mainRouteEpoch: 0,
    mainRouteDecisionGeneration: 0,
    routeDecisionsLive: new Map(),
    retiredRouteDecisionFloor: 0,
    toolRecoveryAttemptedLanes: new Map(),
    toolRecoveryCooldownUntil: 0,
    shutdownSignal: shutdownAbort.signal,
    backgroundSignal: backgroundAbort.signal,
    routeInstallFault: opts.routeInstallFault,
    memtreePages: new Map(),
    memorySourcePages: new Map(),
    memtreeCallSeq: 0,
    memtreeLinkStore: opts.memtreeLinkStore,
    stablePrefixStore: opts.stablePrefixStore,
    storedPrefixLookups: new Map(),
    storageOwner: typeof opts.memtree.storageIdentity === "string"
      ? opts.memtree.storageIdentity : undefined,
    newestTrees: opts.newestTrees,
    memtreeLinkPlacement: opts.memtreeLinkPlacement ?? "turn",
    compactTargets: new Map(),
    defaultCompactOff: opts.defaultCompactTarget === null,
    compactNow: new Set(),
    stablePrefixes: new Map(),
    prepared: new PreparedCompressions(),
    preparing: new Map(),
    backgroundCompress: new Map(),
    serverBudgets: new Map(),
    serverReportsBudget: false,
    countTokensCooldowns: new CountTokensCooldowns(),
    passthroughSizes: new Map(),
    laneSizes: new Map(),
  };
  installMemtreeLink(state, state.memtreeLinkPlacement);
  state.notices.setFirstTreeIntro(opts.firstTreeIntro ?? null);
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
    backgroundAbort.abort();
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
        mainSessionId: () => state.resumableMainSession,
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

  if (!isLocalCaller(req)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "The ccc proxy only serves programs on this machine" }));
    return;
  }
  if (url.pathname === hookPath) {
    return handleNoticeHook(req, res, state, opts.reqlog, (sessionId) =>
      opts.memtree.scheduleFinalIndex(sessionId, (signal) => opts.transcriptUsage?.finalReplyAsync
        ? opts.transcriptUsage.finalReplyAsync(sessionId!, signal)
        : opts.transcriptUsage?.finalReply?.(sessionId!)));
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

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BROWSER_SAME_SITE = new Set(["same-origin", "none"]);

/**
 * Every route acts with the user's MemTree key (the `/memtree/*` relay reads
 * their trees; `/v1/messages` indexes and compresses on their account), so only
 * callers on this machine may use the proxy: Claude Code, agents (curl, the MCP
 * server) and the MemTree page itself when opened from the loopback. A web page
 * on another site can reach the loopback too, either directly (its `origin` or
 * `sec-fetch-site` says so) or by rebinding its own hostname to 127.0.0.1 (its
 * `host` then names it). Same-origin means this exact host and port.
 */
function isLocalCaller(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !isLoopbackHost(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !isSameLoopbackOrigin(origin, host)) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || BROWSER_SAME_SITE.has(String(site));
}

function isLoopbackHost(host: string): boolean {
  try {
    const url = new URL(`http://${host}`);
    return url.host === host.toLowerCase() && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function isSameLoopbackOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.host === new URL(`http://${host}`).host;
  } catch {
    return false;
  }
}

/** Loopback prefix for reading the user's own MemTree pages through this proxy. */
const MEMTREE_PASSTHROUGH_PREFIX = "/memtree/";
/**
 * `<request id>`, `<request id>.json`, `<request id>/session.json` (the
 * page's session pane), `<request id>/search` (the server's term search over
 * that tree, `?q=&limit=`), `<request id>/messages` (the un-indexed messages
 * after it, `?start=&end=`), or `sessions/<Claude Code session id>.json` (every
 * page from one session, newest first); nothing that could walk the upstream
 * path. The id is the request UUID or the server's short form of it (leading
 * hex, as in the `/m/<id>` links it hands out) — the server accepts both.
 */
const MEMTREE_PASSTHROUGH_TARGET_RE =
  /^(?:[A-Za-z0-9-]+(\.json|\/session\.json|\/search|\/messages)?|sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json)$/;

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
  const page = currentMemorySourcePage(state, sessionId);
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

/** The page whose memory is in the prompt, else (none adopted yet) the newest page. */
function currentMemorySourcePage(
  state: ProxyState,
  sessionId: string | undefined
): { url: string; index: string; compressed: boolean; sessionId?: string } | undefined {
  if (!sessionId) return undefined;
  return state.memorySourcePages.get(sessionId) ?? currentMemtreePage(state, sessionId);
}

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

const SESSION_START_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

/** A main-agent SessionStart, for diagnostics; never fails the hook. */
function recordSessionStart(state: ProxyState, source: string | undefined): void {
  try {
    const known = source !== undefined && SESSION_START_SOURCES.has(source);
    state.diagnostics?.record("session_start", { source: known ? source : "other" });
  } catch {
    // Diagnostics are best effort.
  }
}

/**
 * A resumed or forked session can be resumed again at once; a fresh or
 * cleared one has nothing to resume until its first turn. Compaction keeps
 * the same session.
 */
function noteMainSessionStart(
  state: ProxyState,
  source: string | undefined,
  sessionId: string
): void {
  if (source === "resume" || source === "fork") {
    state.resumableMainSession = isResumableSessionId(sessionId) ? sessionId : undefined;
  } else if (source === "startup" || source === "clear") {
    state.resumableMainSession = undefined;
  }
}

/** Serve only validated Claude hook POSTs on the randomized localhost path. */
async function handleNoticeHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ProxyState,
  reqlog: RequestLogSink | undefined,
  /** A main-lane turn ended: the session may be over (its final index). */
  onMainStop?: (sessionId: string | undefined) => void
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
    if (parsed.agent_id === undefined) {
      recordSessionStart(state, parsed.source);
      noteMainSessionStart(state, parsed.source, parsed.session_id);
      // Claude Code's compaction dropped any MemTree notice from the transcript.
      if (parsed.source === "compact") state.modelNotices.forget(parsed.session_id);
    }
    // Earlier trees in this project: asked now, so its wait overlaps the resume's.
    const contextPromise = projectTreesContext(state.projectTrees, parsed);
    // A resumed or forked history may carry notices an earlier process gave.
    const restored = parsed.agent_id === undefined &&
        (parsed.source === "resume" || parsed.source === "fork")
      ? restoreModelNotices(state, parsed) : Promise.resolve();
    // A resume waits briefly for the newest tree; a fresh session has none to wait for.
    if (parsed.agent_id === undefined && parsed.source === "resume") {
      await state.newestTrees?.settle(parsed.session_id);
    }
    const line = joinNoticeLines(
      resumeLinkLine(state, parsed),
      resumePaymentNotice(state, parsed),
      extraSessionStartLine(state.sessionStartNotice, parsed)
    );
    const context = await contextPromise;
    await restored;
    if (!line && !context) {
      res.writeHead(204);
      res.end();
      return;
    }
    const body = Buffer.from(JSON.stringify(sessionStartOutput(line, context)), "utf-8");
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }
  if (parsed.hook_event_name === "PreCompact") {
    // A typed /compact while MemTree compresses: say why it isn't needed, once.
    const reason = parsed.agent_id === undefined && parsed.trigger === "manual"
      ? state.modelNotices.blockCompact(parsed.session_id, memtreeWorking(state))
      : undefined;
    if (reason === undefined) {
      res.writeHead(204);
      res.end();
      return;
    }
    const body = Buffer.from(JSON.stringify({ decision: "block", reason }), "utf-8");
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
    // `/memtree-view` waits briefly for the newest tree; a prompt only warms it.
    // In a subagent's view the command is answered too (with the main
    // session's page): unanswered, the plugin's fallback body would run.
    if (isMemtreeViewCommand(parsed.prompt)) await state.newestTrees?.settle(parsed.session_id);
    else if (parsed.agent_id === undefined) state.newestTrees?.peek(parsed.session_id);
    const commandReply =
      parsed.agent_id === undefined
        ? sessionCommandReply(state, parsed.session_id, parsed.prompt)
        : subagentCommandReply(state, parsed.session_id, parsed.prompt);
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
      state.promptAccounting.add(parsed.session_id, parsed.prompt_id, parsed.prompt);
      recordMainPromptNotice(state, parsed.prompt_id, parsed.prompt);
    }
    const line = parsed.agent_id === undefined ? promptSubmitLine(state) : undefined;
    const context = parsed.agent_id === undefined
      ? state.modelNotices.next(parsed.session_id, currentModelNotice(state))
      : undefined;
    if (line || context) {
      const body = Buffer.from(JSON.stringify(promptSubmitOutput(line, context)), "utf-8");
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
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
      (parsed.prompt_id !== undefined && state.promptAccounting.hasId(parsed.prompt_id)));
  const output =
    parsed.hook_event_name === "Stop" && !stopMatchesMainPrompt
      ? null
      : state.notices.claim(parsed);
  if (stopMatchesMainPrompt) {
    onMainStop?.(typeof parsed.session_id === "string" ? parsed.session_id : undefined);
    state.mainNoticePending = false;
    state.mainPromptId = undefined;
    state.mainPromptText = undefined;
    // Invalidate a response still in flight at Stop. Otherwise its late
    // delivery callback could enqueue a notice after Stop returned.
    state.mainPromptGeneration++;
    // Subagent lifetimes are independent; only their own stop events retire them.
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
    claudeAuth: claudeAuthFromHeaders(req.headers),
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
      const knownKind = knownSideRequestKind(clientInfo);
      if (knownKind) rec.transcript.knownKind = knownKind;
      const warning = transcriptWarning(rec.transcript);
      if (warning) console.error(warning);
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
    // Warm the newest-tree lookup now (never waits) so it can answer by the
    // time the recap finishes streaming.
    state.newestTrees?.peek(sessionId);
    recapLinkAppenders.set(req, (streamedTextChars) => {
      const link = recapLink(state, sessionId);
      return link ? recapLinkText(link.link, streamedTextChars, link.note) : undefined;
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
  const requestSizeKey = laneSizeKey(req, requestRouteKey, body.model);
  // Extended 1M context arrives as the `context-1m` beta header (Claude Code
  // strips the `[1m]` model suffix on the wire). Current native-1M models send
  // neither, so contextLimitForModel also needs the launcher's native setting.
  const modelContextLimit = contextLimitForModel(
    body.model,
    headerText(req.headers, "anthropic-beta"),
    opts.nativeOneMillionContext !== false
  );
  if (isMainRequest) rec.contextWindow = modelContextLimit;
  // Before anything reads the size sample: replace an unknown or stale
  // estimate with an exact count where it would decide the outcome.
  const requestSessionKey = requestSessionId(req);
  const countSession = createCountTokensSession({
    upstream, headers: forwardableRequestHeaders(req), requestUrl: req.url,
    signal: state.shutdownSignal,
    onAttempt: (result) => {
      (rec.countTokens ??= []).push({ statusClass: result.outcome, ms: result.ms,
        bytes: result.bytes ?? 0, timeoutMs: result.timeoutMs ?? 0 });
    },
  }, state.countTokensCooldowns);
  const requestSizing = new RequestSizing(countSession, opts.countTokens === true,
    typeof body.model === "string" ? body.model : undefined);
  if (carriesServerTools(body)) serverToolRecords.add(rec);
  const sizeSlot = wholeRequestSizeSlot(state, isMainRequest, requestSessionKey, requestSizeKey,
    body.model);
  const originalCandidate = requestSizing.register(rawBody, "original", sizeSlot.get());
  const forwardCandidate = requestSizing.register(forwardBody, "original", sizeSlot.get());
  candidateSizeOwners.set(originalCandidate, sizeSlot);
  candidateSizeOwners.set(forwardCandidate, sizeSlot);
  const sizingLimits = (): SizingLimits => ({
    budget: resolveBudget(opts, state, body.model, modelContextLimit).tokens,
    context: modelContextLimit,
    output: bodyOutputReservation(body),
    recountOutput: outputReservation(undefined, body.max_tokens), // full max_tokens
  });
  if (isMainRequest && requestSessionKey !== undefined) {
    adoptStoredPrefix(opts, state, rec, requestSessionKey, body, messages, modelContextLimit);
  }
  const rides = state.memoryRoutes.has(requestRouteKey) ||
    (isMainRequest && requestSessionKey !== undefined && state.stablePrefixes.has(requestSessionKey));
  if (!rides) {
    const measured = await requestSizing.measure(forwardCandidate, sizingLimits(), "plan");
    if (measured.source === "exact") {
      sizeSlot.set(sizeSampleOf(forwardCandidate.body, measured.tokens, rec.model ?? body.model));
    }
  }
  rec.routeLane = requestRouteLane;
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
  // API identity and validated history alone govern route eligibility.
  const rideableCandidate = getMemoryRoute(state, requestRouteKey);
  const existingRide = rideableCandidate && memoryRoutedToolBody(
    body, messages, rideableCandidate, state.mainRouteEpoch, requestSessionId(req)
  );
  const isFollowupUserTurn = isUserTurn && hasEarlierNonToolUserMessage(messages);
  const routeEpoch = state.mainRouteEpoch;
  let routeDecisionGeneration = state.mainRouteDecisionGeneration;
  let routeDecisionSettled = false;
  const toolForwarding = capturePromptDelivery(
    state, isMainRequest, lastMsg, requestSessionId(req)
  );
  if (isFollowupUserTurn) {
    routeDecisionGeneration = ++state.mainRouteDecisionGeneration;
    reserveRouteDecision(state, requestRouteKey, routeDecisionGeneration);
  }
  const hookOwnedMainFollowup =
    isFollowupUserTurn &&
    !isAwaySummary &&
    !isSubagentRequest &&
    state.mainNoticePending &&
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
  requestSendPolicies.set(req, {
    original: rawBody,
    failedRebuild: false,
    allowed: new WeakSet<Buffer>(),
    sizing: requestSizing,
    select: (buffer) => selectForwardCandidate({
      opts, state, res, rec, body, modelContextLimit, req, routeKey: requestRouteKey,
      preferredBody: buffer, limits: sizingLimits(),
    }),
    fitsNative: async (buffer) => {
      const candidate = requestSizing.register(buffer, rec.compress ? "replacement" : "ride");
      const measured = await requestSizing.measure(candidate, sizingLimits());
      // A validated ride is still eligible for bounded late recovery. Final
      // selection considers it together with the original and any replacement.
      return candidate.kind === "ride" || fitsMeasured(measured, sizingLimits());
    },
    // The ride's bytes are only what failed; recovery always compresses the
    // ORIGINAL conversation (the one MemTree indexed), never the ride itself.
    recoverLate: async (_ride, rideTokens, target) => {
      // A compression already made may be redone only to a smaller target.
      if ((rec.compress && target === undefined) ||
          compactionMode(opts, state, requestSessionKey).mode === "off" ||
          !hasEarlierNonToolUserMessage(messages) ||
          (rec.turnType.startsWith("tool") && opts.toolRouteRecovery === false)) return undefined;
      return recoverLateCount({ opts, state, req, rec, body, msgsForMemtree, hash, rideTokens,
        modelContextLimit, clientMeta, sizing: requestSizing, inputCandidate: forwardCandidate,
        route: { key: requestRouteKey, messages, epoch: routeEpoch,
          lane: isAwaySummary ? "away" : requestRouteLane === "main" ? "main" : "other" },
        ...(target !== undefined ? { target } : {}) });
    },
    delivered: () => { state.fallbackFailures.succeeded(requestRouteKey); toolForwarding.settle(true); },
  });
  const rawMsgsForMemtree = messagesWithSystem(messages, body.system);
  const msgsForMemtree = normalizeMessagesForMemtree(rawMsgsForMemtree);
  const hash = MemtreeClient.hashMessages(msgsForMemtree);
  // The main lane's latest conversation: what its final index sends, plus the
  // reply the session ends with (scheduleFinalIndex, on Stop).
  const mainSessionId = isMainRequest ? requestSessionId(req) : undefined;
  if (mainSessionId !== undefined) {
    if (isResumableSessionId(mainSessionId)) state.resumableMainSession = mainSessionId;
    opts.memtree.noteMainConversation(mainSessionId, {
      messages: msgsForMemtree,
      modelContextLimit,
      clientMeta,
      messageTimesFor: transcriptTimesFor(opts, mainSessionId),
      readReply: (signal) => opts.transcriptUsage?.finalReplyAsync
        ? opts.transcriptUsage.finalReplyAsync(mainSessionId, signal)
        : opts.transcriptUsage?.finalReply?.(mainSessionId),
    });
  }

  // Hook state controls notices only. Hidden requests cannot consume main notices.

  if (typeof body.model === "string") rec.model = body.model;
  if (typeof body.max_tokens === "number") rec.maxTokens = body.max_tokens;
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
    let routedBody = forwardBody;
    let routedTool = false;
    let routedCandidate: RequestCandidate | undefined;
    let routeMiss: "missing" | "rejected" | "superseded" | undefined;
    if (isToolResultTurn || isContinuationTurn || isUserTurn) {
      // Reuse only this API session/lane's independently validated prefix.
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
          const owner = activeRoute.stablePrefix ?? activeRoute;
          routedCandidate = requestSizing.register(rewritten, "ride", owner.lastSize);
          candidateSizeOwners.set(routedCandidate, owner);
          // Advisory window pressure can request recovery, but never removes a
          // structurally valid candidate before request-local counting/selection.
          if (!fitsMeasured(plannedMeasurement(requestSizing, routedCandidate), sizingLimits())) {
            routeMiss = "rejected";
            regrantSmallerWindowRecovery(state, requestRouteKey, modelContextLimit);
          }
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
          // same-session divergence: rebuild while retaining the previous route.
          routeMiss = "rejected";
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
    // A concurrently replaced stable prefix takes precedence over an older
    // route. The current prefix still undergoes its own history validation.
    if (
      routedTool &&
      isMainRequest &&
      toolSessionId !== undefined &&
      rideableCandidate?.stablePrefix !== state.stablePrefixes.get(toolSessionId)
    ) {
      if (routedCandidate) requestSizing.excludeFallback(routedCandidate);
      routedTool = false;
      routedBody = forwardBody;
      routeMiss = "superseded";
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
    } else if (isToolResultTurn || isContinuationTurn || (isUserTurn && !!existingRide)) {
      // Every lane's tool turn lives by the budget, like a main human turn:
      // under it, forward (on the lane's route or the session's stable
      // prefix, else whole) with no compress call; at it, compress once to
      // the target (planToolCompaction). A "replay" is a client retry of the
      // request that installed the route, forwarded verbatim.
      const plan = await planToolCompaction({
        opts,
        state,
        body,
        messages,
        sessionId: toolSessionId,
        routeKey: requestRouteKey,
        sizeKey: requestSizeKey,
        sizing: requestSizing,
        isMainRequest,
        modelContextLimit,
        forwardBody,
        rec,
        ride: toolRide,
        canCompress,
      });
      if (isMainRequest && toolSessionId !== undefined && canCompress &&
          (plan.kind === "ride" || plan.kind === "pass")) {
        maybePrepareCompression({ opts, state, body, messages, msgsForMemtree, hash,
          sessionId: toolSessionId, modelContextLimit, rec, clientMeta });
      }
      if (plan.kind === "ride") toolRide = plan.ride;
      if (plan.kind === "pass" && plan.original) {
        toolRide = undefined;
        toolNeedsOriginal = true;
      }
      if (plan.kind === "compress") {
        requestSendPolicies.get(req)!.failedRebuild = true;
        // Clear the caller's old ride before any in-flight/backoff/cooldown
        // exit. An over-window prefix cannot remain the implicit fallback.
        toolRide = plan.fallback;
        toolNeedsOriginal = plan.overWindow;
        const prior = state.toolRecoveryAttemptedLanes.get(requestRouteKey);
        if (prior?.awaitingIndex && Date.now() >= prior.awaitingIndex.deadline) {
          prior.awaitingIndex = undefined;
        }
        if (prior?.inFlight || (!prior && state.toolRecoveryAttemptedLanes.size >= 128 &&
            [...state.toolRecoveryAttemptedLanes.values()].every((attempt) => attempt.inFlight))) {
          // A concurrent request of this lane is already compressing.
          rec.routeRecovery = { outcome: "in-flight" };
        } else if (prior?.awaitingIndex && (!plan.overWindow || plan.uncountedOverWindowOnly)) {
          // The last attempt found no tree for this conversation, so a
          // compress call could only pass everything through again. Forward
          // now; the page check lets the next tool turn try once it exists.
          // Over the window only by its uncounted bound, delivery may still
          // count it; if it refuses, that is an index wait, not a strike.
          rec.routeRecovery = { outcome: "awaiting-index" };
          if (plan.uncountedOverWindowOnly) rec.indexBehind = true;
          checkAwaitedIndex(opts, prior, state.shutdownSignal);
        } else if (
          prior?.retryAtTokens !== undefined &&
          plan.estimateTokens < prior.retryAtTokens &&
          Date.now() < (prior.retryDeadline ?? 0)
        ) {
          // This lane's last attempt this human turn produced nothing; wait
          // for growth instead of paying a blocking call on every tool turn.
          rec.routeRecovery = { outcome: "backoff" };
        } else if (Date.now() < state.toolRecoveryCooldownUntil &&
            !(plan.overWindow && !plan.fallback && (!plan.uncountedOverWindowOnly ||
              await wholeRequestRefused(requestSizing, originalCandidate, sizingLimits())))) {
          // A recent attempt burned the full compress budget and still
          // failed. (Not when this turn is over the window with no prefix to
          // ride and delivery would refuse it: skipping could only end in a
          // refusal, so it compresses anyway, on the long budget.) Every tool turn appends a tool_result and rehashes, so
          // compress() dedup can never absorb the repeat: without this
          // cooldown a MemTree outage would add the whole blocking budget to
          // every tool turn over the budget. A cooldown skip does not start
          // the lane's backoff.
          rec.routeRecovery = { outcome: "cooldown" };
        } else {
          const recoveryAttempt: ToolRecoveryAttempt = { modelContextLimit, inFlight: true };
          if (!prior && state.toolRecoveryAttemptedLanes.size >= 128) {
            const idle = [...state.toolRecoveryAttemptedLanes].find(([, attempt]) => !attempt.inFlight);
            if (idle) state.toolRecoveryAttemptedLanes.delete(idle[0]);
          }
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
              sizeKey: requestSizeKey,
              isMainRequest,
              recoveryAttempt,
              sizing: requestSizing,
              inputCandidate: forwardCandidate,
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
              ...(plan.fallback ? {} : { wholeRefused: () =>
                wholeRequestRefused(requestSizing, originalCandidate, sizingLimits()) }),
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

    if (toolRide) requestSendPolicies.get(req)?.allowed.add(toolRide.raw);
    const sendBody = toolRide?.raw ?? (toolNeedsOriginal ? rawBody : forwardBody);
    recordTurn(
      rec,
      toolRide ? toolRide.turnType : isUserTurn ? "first-user" : "tool",
      sendBody
    );
    opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit, toolSessionId, clientMeta, transcriptTimesFor(opts, toolSessionId, agentAttributionId(req)));
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
        if (toolRide) noteRideSize(toolRide.sizeHolder, rec, sendBody);
        else {
          noteWholeRequestSize(state, isMainRequest, toolSessionId, requestSizeKey, body.model, rec,
            sendBody);
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
      requestSessionId(req)
    );
    if ("body" in fork) {
      requestSizing.register(fork.body, "ride");
      requestSendPolicies.get(req)?.allowed.add(fork.body);
      releaseRouteDecision(state, requestRouteKey, routeDecisionGeneration);
      recordTurn(rec, "fork-memory", fork.body);
      capture(opts, "anthropic-request-memory-fork", fork.body);
      return logged(
        forwardRaw(req, res, fork.body, opts, upstream, state.shutdownSignal, rec)
      );
    }
    rec.forkMiss = fork.miss;
  }

  const markMainPromptDelivered = () => toolForwarding.settle(true);

  // A newer same-lane replacement prevents older asynchronous installation.
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
  // An uncompressed fallback releases this replacement reservation. The old
  // validated route remains available to requests whose histories still match.
  const releaseForOriginalFallback = () => {
    requestSendPolicies.get(req)!.failedRebuild = true;
    releaseUncommittedRouteDecision();
  };

  const sessionId = requestSessionId(req);
  // Stable-prefix (edge) compaction: the main thread's human turns only. The
  // recap rides the main route above; subagents keep per-turn compression.
  const planEdge = () => planEdgeCompaction({ sizing: requestSizing, opts, state, body, messages,
    sessionId: sessionId!, modelContextLimit, forwardBody, rec });
  let edge = isMainRequest && sessionId !== undefined ? await planEdge() : undefined;
  if (edge?.kind === "compress" && (state.preparing.has(sessionId!) ||
      rec.compaction?.preparedWaitMs !== undefined || rec.compaction?.prepared !== undefined)) {
    // Never beside the session's preparation (both would be billed): wait for
    // it, then plan again with the settings now current (a /memtree-compact
    // that arrived while it waited or counted) and the preparation it left.
    const waited = rec.compaction?.preparedWaitMs ?? 0;
    const prepared = rec.compaction?.prepared;
    await awaitPreparation(state, sessionId!, opts.memtree.longCompressBudgetMs, rec.compaction!);
    const total = waited + (rec.compaction?.preparedWaitMs ?? 0);
    edge = await planEdge();
    if (rec.compaction) {
      rec.compaction.preparedWaitMs = total;
      rec.compaction.prepared ??= prepared;
    }
  }
  // Not beside a blocking compress call: the two would overlap on the server.
  if (sessionId !== undefined && edge && (edge.kind === "ride" || edge.kind === "pass")) {
    maybePrepareCompression({ opts, state, body, messages, msgsForMemtree, hash, sessionId,
      modelContextLimit, rec, clientMeta });
  }

  // An active subagent can repeat/embed the human prompt in its own request;
  // producer suppression must also preserve the arm for the later main call.
  if (displayForThisTurn) state.mainNoticePending = false;

  /**
   * Forward a compressed body — a fresh compaction, or a ride on the stable
   * prefix — and make it the route for the rest of this human turn's tool
   * loop (and, for a compaction, the session's new stable prefix).
   */
  const forwardCompressed = async (
    compressedBody: Record<string, any>,
    compressedRaw: Buffer,
    turnType: "followup-compressed" | "followup-prefix",
    stable: StablePrefixInstall | { ride: StablePrefix } | undefined,
    result: CompressResult | undefined
  ): Promise<void> => {
    if (!(await requestSendPolicies.get(req)!.fitsNative(compressedRaw))) {
      // A lagging index left history verbatim: a refusal waits for indexing.
      if (result) noteIndexLag(opts, rec, result);
      // Too large for the window: delivery recompresses it once, smaller.
      if (result && !rec.indexBehind) {
        noteOversizedCompression(rec, requestSizing, body, compressedRaw,
          rec.compaction?.targetTokens);
      }
      releaseUncommittedRouteDecision();
      recordTurn(rec, "followup-degraded", rawBody);
      return logged(forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec));
    }
    requestSendPolicies.get(req)?.allowed.add(compressedRaw);
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
      if (!requestSendPolicies.get(req)?.allowed.has(compressedRaw)) {
        releaseUncommittedRouteDecision();
        routeActivationAttempted = true;
        return;
      }
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
      // The answer's memory is now what future requests reuse; a ride keeps
      // the prior source, and a failed or stale forward adopts nothing.
      if (installed && result && linkSeq !== undefined) {
        noteMemorySource(state, linkSeq, sessionId, result);
      }
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
          if (sizePrefix) notePrefixSize(sizePrefix, rec, compressedRaw);
          // A route already installed at protocol-complete deliberately survives
          // delivered=false: that settle may be the fast-tool abort (client
          // consumed message_stop, closed the SSE response, and its immediate
          // tool request must ride the prefix). A socket death before flush
          // settles identically; an identical-body retry reuses the same
          // validated compressed prefix with an empty suffix.
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

  if (existingRide && (!edge || edge.kind === "off" || edge.kind === "pass")) {
    const owner = rideableCandidate!.stablePrefix ?? rideableCandidate!;
    const candidate = requestSizing.register(existingRide, "ride", owner.lastSize);
    candidateSizeOwners.set(candidate, owner);
    return forwardCompressed(JSON.parse(existingRide.toString("utf-8")), existingRide,
      "followup-prefix", undefined, undefined);
  }

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
  const sendingWhole = () => { requestSendPolicies.get(req)!.failedRebuild = true; };
  const noteWholeSize = () => {
    if (isMainRequest) notePassthroughSize(state, sessionId, body.model, rec, forwardBody);
  };

  if (edge?.kind === "pass") {
    // Clearly under the budget by its own count: the compress call could only
    // pass it through, so the turn goes out now and the call (which also
    // indexes it and reports the page and budget) runs in the background.
    compressInBackground({ opts, state, body, msgsForMemtree, hash, modelContextLimit, rec,
      sessionId, clientMeta, sizing: requestSizing, inputCandidate: forwardCandidate,
      // Never compress: the turn went out whole, so a compression the server's
      // own (more conservative) sizing chose could not be used, only billed.
      compaction: { target: NEVER_COMPRESS_TARGET_TOKENS },
      linkSeq: isAwaySummary ? undefined : nextMemtreeCallSeq(state) });
    releaseForOriginalFallback();
    sendingWhole();
    recordTurn(rec, "followup-under-budget", forwardBody);
    capture(opts, "anthropic-request", forwardBody);
    return logged(
      forwardRaw(req, res, forwardBody, opts, upstream, state.shutdownSignal, rec)
        .then((delivered) => {
          noteWholeSize();
          if (delivered) markMainPromptDelivered();
        })
    );
  }


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
      sizing: requestSizing,
      inputCandidate: forwardCandidate,
      ...(edge?.kind === "compress"
        ? { compaction: { target: edge.target, threshold: edge.threshold } }
        : edge?.kind === "off"
          ? { compaction: {} }
          : {}),
      // Riding the old prefix, or sending a raw request that fits, keeps the
      // short budget; with neither, a timeout could only end in a refusal.
      longBudget: !(edge?.kind === "compress" && edge.fallback) &&
        await wholeRequestRefused(requestSizing, forwardCandidate, sizingLimits()),
    });
  } catch {
    const kept = rideOldPrefix(false);
    if (kept) return kept;
    releaseUncommittedRouteDecision();
    recordTurn(rec, "followup-degraded", rawBody);
    capture(opts, "anthropic-request", rawBody);
    return logged(
      forwardRaw(req, res, rawBody, opts, upstream, state.shutdownSignal, rec)
        .then((delivered) => {
          if (isMainRequest) notePassthroughSize(state, sessionId, body.model, rec, rawBody);
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
  // A first 402 starts fetching the short checkout link (memtree.ts): give the
  // paused notice below a moment to show it instead of the long one. Only a turn
  // that can show the notice waits, and only while that fetch is in flight.
  if (!result && displayForThisTurn && state.mainPromptGeneration === noticePromptGeneration &&
      state.paymentNotice.due() && opts.memtree.paymentRequiredDetail !== null) {
    await opts.memtree.paymentLinkSettled?.(PAYMENT_LINK_NOTICE_WAIT_MS);
  }

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
    // a payment-specific notice with the subscribe link instead of the generic
    // degraded one: on the first 402, then at most once per throttle interval
    // (counted from actual delivery). In between, unpaid turns stay quiet.
    recordTurn(rec, "followup-degraded", forwardBody);
    releaseForOriginalFallback();
    sendingWhole();
    capture(opts, "anthropic-request", forwardBody);
    const paymentDetail = opts.memtree.paymentRequiredDetail;
    const mayQueueNotice =
      displayForThisTurn && state.mainPromptGeneration === noticePromptGeneration;
    const overBudget = reachedBudget(rec.compaction);
    if (state.keyInvalid()) {
      // A refused key (401/403) says why MemTree is off and how to fix it;
      // throttled like the payment notice, and quiet in between.
      if (mayQueueNotice && state.keyNotice.due()) {
        // A refusal of this very request says the same and withdraws it.
        pausedNotices.set(rec, state.notices.queueSuffix(keyInvalidNoticeText(state.keyPageUrl),
          () => state.keyNotice.markShown(), noticePromptId));
      }
    } else if (mayQueueNotice && paymentDetail !== null &&
        (state.paymentNotice.due() || (overBudget && !nearWindowWarned(state, sessionId)))) {
      // A paused refusal of this very request withdraws it (refuseWholeRequest),
      // and any later one withdraws its near-window line.
      const handle = state.notices.queueSuffix(
        paymentNoticeText(paymentDetail, recapLink(state, sessionId)?.link, { overBudget }),
        () => {
          state.paymentNotice.markShown();
          if (overBudget && sessionId !== undefined) addNearWindowWarned(state, sessionId);
          state.diagnostics?.record("paused_notice", { trigger: "turn" });
        },
        noticePromptId
      );
      pausedNotices.set(rec, handle);
      if (overBudget) state.nearWindowNotice = handle;
    } else if (mayQueueNotice && paymentDetail === null) {
      // Under the budget the whole request is what compression would have
      // sent: the turn is not degraded, so the failure stays in the logs.
      const warn = () => {
        state.notices.queueSuffix(DEGRADED_NOTICE, undefined, noticePromptId);
        rec.degradedNotice = "shown";
      };
      if (compressionNeeded(rec.compaction)) {
        warn();
      } else {
        // Delivery sizes the request again (an exact count, else a
        // conservative bound): a turn it finds over the budget warns then.
        rec.degradedNotice = "quiet-under-budget";
        quietDegrades.set(rec, () => {
          if (state.mainPromptGeneration === noticePromptGeneration) warn();
        });
      }
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
    // A pass-through from a cold index: if the history cannot go out whole,
    // the refusal waits for the tree instead of spending its strikes.
    if (!actuallyCompressed) noteIndexLag(opts, rec, result);
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
    releaseForOriginalFallback();
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
    releaseForOriginalFallback();
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
  const resolve = (sessionId: string | undefined) =>
    sessionLink(state, sessionId, currentMemtreePage(state, sessionId));
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
  const link = sessionLink(state, sessionId, page);
  if (!link) return undefined;
  if (page && page !== inMemory) {
    rememberMemtreePage(state, sessionId, {
      sessionId,
      url: page.url,
      index: page.index,
      compressed: page.compressed,
      seq: state.memtreeCallSeq,
    });
  }
  return state.notices.resumeLine(link, sessionId);
}

/**
 * The unpaid-key notice for a resumed main session whose key the server has
 * already answered 402 for: a resume is a fresh look at the session, so it
 * says again why it runs uncompressed, regardless of the throttle. The link
 * line above it already names the session's MemTree page.
 */
function resumePaymentNotice(
  state: ProxyState,
  input: SessionStartHookInput
): string | undefined {
  if (input.agent_id !== undefined || input.source !== "resume") return undefined;
  const detail = state.unpaidDetail();
  if (detail === null) return undefined;
  state.paymentNotice.markShown();
  state.diagnostics?.record("paused_notice", { trigger: "resume" });
  return state.notices.warningText(paymentNoticeText(detail));
}

/** ProxyOptions.promptSubmitNotice's line for this prompt; never throws. */
function promptSubmitLine(state: ProxyState): string | undefined {
  try {
    return state.promptSubmitNotice?.();
  } catch {
    return undefined;
  }
}

/**
 * Whether MemTree is known to be compressing: its latest answer a success and
 * no pause (402) remembered. Before any answer, or after an outage, it is not.
 */
function memtreeWorking(state: ProxyState): boolean {
  return state.memtreeAnswering() === true && state.unpaidDetail() === null;
}

/**
 * What the model should know about MemTree right now: a notice, undefined
 * when it is known to work, null when neither is known (no answer, an outage).
 */
function currentModelNotice(state: ProxyState): ModelNotice | undefined | null {
  if (state.keyInvalid()) {
    return { kind: KEY_INVALID_KIND, text: keyInvalidModelContext(state.keyPageUrl) };
  }
  const detail = state.unpaidDetail();
  if (detail !== null) {
    return { kind: PAUSED_KIND, text: pausedModelContext(detail, state.pausedReason()) };
  }
  return memtreeWorking(state) ? undefined : null;
}

/**
 * A resumed session's transcript may hold a notice from an earlier ccc process
 * (paused, then paid in between): start from it, so the change is announced.
 * A missing or unreadable transcript, or a scan past its time box, starts from
 * nothing. Never throws.
 */
async function restoreModelNotices(
  state: ProxyState,
  input: SessionStartHookInput
): Promise<void> {
  if (!input.transcript_path) return;
  state.modelNotices.restore(input.session_id, await lastToldKindInFile(input.transcript_path));
}

/** UserPromptSubmit's answer: a line for the user, context for the model, or both. */
function promptSubmitOutput(
  line: string | undefined,
  context: string | undefined
): Record<string, unknown> {
  return {
    ...(line ? { systemMessage: line } : {}),
    ...(context
      ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }
      : {}),
  };
}

/** The caller's extra SessionStart line; a throwing provider shows nothing. */
function extraSessionStartLine(
  provider: (() => string | undefined) | undefined,
  input: SessionStartHookInput
): string | undefined {
  if (!provider || input.agent_id !== undefined || input.source === "compact") return undefined;
  try {
    return provider();
  } catch {
    return undefined;
  }
}

/**
 * Earlier sessions in this project (project-trees.ts) for a main session's
 * start: fresh, resumed, cleared or forked, never a compaction. Never throws.
 */
async function projectTreesContext(
  hint: ProjectTreesHint | undefined,
  input: SessionStartHookInput
): Promise<string | undefined> {
  if (!hint || input.agent_id !== undefined || input.source === "compact") return undefined;
  try {
    return await hint.contextFor(input.session_id);
  } catch {
    return undefined;
  }
}

/**
 * The SessionStart hook's answer: the banner line for the user
 * (`systemMessage`), model context (`additionalContext`), or both.
 */
export function sessionStartOutput(
  line: string | undefined,
  context: string | undefined
): Record<string, unknown> {
  return {
    ...(line ? { systemMessage: line } : {}),
    ...(context
      ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }
      : {}),
  };
}

function joinNoticeLines(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => !!part);
  return present.length ? present.join("\n") : undefined;
}

export const MEMTREE_COMPACT_MIN_TOKENS = 20_000;
/** How long a paused turn waits for the short checkout link before its notice (once). */
export const PAYMENT_LINK_NOTICE_WAIT_MS = 1_000;

/** The reply to a ccc slash command, or undefined for an ordinary prompt. */
function sessionCommandReply(
  state: ProxyState,
  sessionId: string,
  prompt: string
): string | undefined {
  const unpaid = state.unpaidDetail();
  // Paused, compaction needs the MemTree it cannot reach: say how to resume instead.
  const paused = unpaid === null ? undefined
    : pausedCompactionText(viewUrl(subscribeUrlFromDetail(unpaid)));
  if (sessionCommandArgs(prompt, MEMTREE_HELP_COMMAND) !== undefined) {
    return [
      "• /memtree-view · show this session's MemTree page link",
      paused !== undefined ? `• ${paused}`
        : `• /memtree-compact [tokens | off] · compact this session on your next message (default half the budget, at least ${MEMTREE_COMPACT_MIN_TOKENS / 1000}k)`,
      usageLines(state),
    ].filter((line): line is string => line !== undefined).join("\n");
  }
  if (isMemtreeViewCommand(prompt)) {
    return joinNoticeLines(memtreeViewLine(state, sessionId), usageLines(state)) ?? "";
  }
  const args = sessionCommandArgs(prompt, MEMTREE_COMPACT_COMMAND);
  if (args === undefined) return undefined;
  const keep =
    "then that compressed history is reused unchanged until the conversation reaches the budget again. /memtree-compact off to stop.";
  if (/^off$/i.test(args)) {
    state.compactTargets.set(sessionId, null);
    state.memoryRoutes.delete(JSON.stringify([sessionId, "main"]));
    state.compactNow.delete(sessionId);
    state.stablePrefixes.delete(sessionId);
    if (state.storageOwner) state.stablePrefixStore?.delete(sessionId, state.storageOwner);
    state.storedPrefixLookups.set(sessionId, null);
    return `${TRAILER_LABEL} compaction off: the conversation is sent whole, and MemTree compresses only when it outgrows the model's budget.`;
  }
  if (paused !== undefined) return `${TRAILER_LABEL} ${paused}`;
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

export const SUBAGENT_VIEW_NOTE = "(main session's page; subagent pages aren't linked yet)";
export const SUBAGENT_COMPACT_REPLY = "MemTree compact applies to the main session only.";

/**
 * The reply to a ccc slash command typed in a subagent's view. `sessionId` is
 * the parent session's: the view shows its page, and compaction (per session)
 * is refused rather than applied to the main conversation from here.
 */
function subagentCommandReply(
  state: ProxyState,
  sessionId: string,
  prompt: string
): string | undefined {
  if (isMemtreeViewCommand(prompt)) {
    const view = `${memtreeViewLine(state, sessionId)}\n${SUBAGENT_VIEW_NOTE}`;
    return joinNoticeLines(view, usageLines(state)) ?? view;
  }
  if (sessionCommandArgs(prompt, MEMTREE_COMPACT_COMMAND) !== undefined) {
    return `${TRAILER_LABEL} ${SUBAGENT_COMPACT_REPLY}`;
  }
  return sessionCommandReply(state, sessionId, prompt);
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
  const link = sessionLink(state, sessionId, page);
  if (!link) {
    return `${TRAILER_LABEL} no page yet: this session has not been indexed. The link appears once it has.`;
  }
  // Blocked-prompt reasons need an explicit hyperlink in styled terminals.
  const lines = linkLines(LINK_LABEL, viewUrl(link.link), link.note);
  // The memory the agent works from can be an older tree than the newest one.
  return page?.compressed && page.url !== link.link
    ? `${lines}\n${urlLine(viewUrl(page.url), "memory from ")}`
    : lines;
}

/**
 * The usage dashboard link that `/memtree` and `/memtree-view` end with,
 * formatted like the MemTree link; undefined when the environment has none.
 */
function usageLines(state: ProxyState): string | undefined {
  return state.usageUrl === undefined
    ? undefined
    : linkLines(USAGE_LABEL, viewUrl(state.usageUrl), USAGE_SIGN_IN_NOTE);
}

/** A `/memtree-view` URL: an explicit OSC 8 link where the terminal has them. */
function viewUrl(url: string): string {
  return terminalSupportsHyperlinks() ? hyperlink(url, url) : url;
}

/**
 * The link shown for a session: its newest completed tree when the server
 * named one (newestTrees), else `source`, the page its memory came from. The
 * key is the tree, so each newly finished tree is announced once.
 */
function sessionLink(
  state: ProxyState,
  sessionId: string | undefined,
  source: { url: string; index: string; compressed: boolean } | undefined
): SuccessLink | undefined {
  const newest = state.newestTrees?.peek(sessionId);
  // The note suggests /memtree-compact, which cannot run while MemTree is paused.
  const note = source && !source.compressed && state.unpaidDetail() === null
    ? { note: NOT_COMPRESSED_NOTE } : {};
  if (newest) return { key: newest.key, link: newest.url, ...note };
  return source ? { key: source.index, link: source.url, ...note } : undefined;
}

/**
 * The recap's link: the session's newest tree like the Stop trailer, since the
 * recap rides the stable compressed prefix and its compress page goes stale.
 * Falls back to that page; never another session's.
 */
function recapLink(state: ProxyState, sessionId: string | undefined): SuccessLink | undefined {
  const page = currentMemtreePage(state, sessionId);
  const foreign =
    page !== undefined && sessionId !== undefined &&
    page.sessionId !== undefined && page.sessionId !== sessionId;
  return sessionLink(state, sessionId, foreign ? undefined : page);
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
  state.memtreeLinkStore?.put(sessionId, { url, index, compressed });
  // A cached newest tree may predate this page; ask again.
  state.newestTrees?.invalidate(sessionId);
}

/**
 * Record a compress answer's page as the source of the memory now forwarded
 * (memorySourcePages), unless a later-submitted call's memory already is.
 */
function noteMemorySource(
  state: ProxyState,
  seq: number,
  sessionId: string | undefined,
  result: CompressResult
): void {
  const url = result.memtreeUrl;
  const index = result.memtreeIndex;
  if (!sessionId || !url || !index) return;
  const latest = state.memorySourcePages.get(sessionId);
  if (latest && latest.seq >= seq) return;
  const page = { sessionId, url, index, compressed: didMemtreeCompress(result), seq };
  rememberPage(state.memorySourcePages, sessionId, page);
}

function rememberMemtreePage(state: ProxyState, sessionId: string, page: MemtreePage): void {
  rememberPage(state.memtreePages, sessionId, page);
}

/** Bound optional page state independently of how many sessions use the proxy. */
function rememberPage(pages: Map<string, MemtreePage>, sessionId: string, page: MemtreePage): void {
  pages.delete(sessionId);
  pages.set(sessionId, page);
  while (pages.size > MEMTREE_LINKS_MAX_SESSIONS) {
    pages.delete(pages.keys().next().value!);
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
    // Background calls the drain stopped (backgroundSignal) are no outage either.
    if (state.shutdownSignal.aborted || state.backgroundSignal.aborted) return;
    state.toolRecoveryCooldownUntil =
      Date.now() + TOOL_RECOVERY_FAILURE_COOLDOWN_MS;
    return;
  }
  if (compression.liveHealth === "success") {
    state.toolRecoveryCooldownUntil = 0;
    // Paid again: a later pause (next month's limit) warns near the window afresh.
    if (state.unpaidDetail() === null) state.pausedNearWindowWarned.clear();
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
  if (generation <= state.retiredRouteDecisionFloor) return false;
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
    if (state.routeDecisionsLive.size >= 128) {
      const oldest = state.routeDecisionsLive.keys().next().value!;
      const retired = state.routeDecisionsLive.get(oldest)!;
      state.retiredRouteDecisionFloor = Math.max(state.retiredRouteDecisionFloor, ...retired);
      state.routeDecisionsLive.delete(oldest);
    }
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
  // Same-lane generations order asynchronous installs. Hooks never mutate
  // these guards; a stale completion cannot overwrite a validated replacement.
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
    ...prefixIdentity(originalMessages, "route"),
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
    if (route.stablePrefix && key === JSON.stringify([sessionId, "main"])) {
      persistStablePrefix(state, sessionId, route.stablePrefix);
    }
  }
  setMemoryRoute(state, key, route);
  state.routeDecisionsLive.set(key, new Set([decisionGeneration]));
  if (!state.toolRecoveryAttemptedLanes.get(key)?.inFlight) state.toolRecoveryAttemptedLanes.delete(key);
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
    ...prefixIdentity(originalMessages, "stable"),
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
  // Prepared against the old prefix's ride sizes: a fresh one is made when
  // the new prefix's rides near the budget again.
  state.prepared.discard(sessionId);
  return prefix;
}

/**
 * Persist the main lane's newly adopted prefix with its memory-source page.
 * Deferred one tick so the page noted right after the install is included,
 * and skipped when a newer prefix replaced this one meanwhile.
 */
function persistStablePrefix(state: ProxyState, sessionId: string, prefix: StablePrefix): void {
  const store = state.stablePrefixStore;
  const owner = state.storageOwner;
  if (!store || !owner) return;
  state.storedPrefixLookups.set(sessionId, null);
  setImmediate(() => {
    if (state.stablePrefixes.get(sessionId) !== prefix) return;
    const page = state.memorySourcePages.get(sessionId);
    store.save(sessionId, owner, {
      originalSystemHash: prefix.originalSystemHash,
      originalPrefixHashes: prefix.originalPrefixHashes,
      originalMediaFreeHashes: prefix.originalMediaFreeHashes,
      compressedMessages: prefix.compressedMessages,
      compressedSystem: prefix.compressedSystem,
      hasCompressedSystem: prefix.hasCompressedSystem,
      targetTokens: prefix.targetTokens,
      explicitTarget: prefix.explicitTarget,
      modelContextLimit: prefix.modelContextLimit,
    }, page && { url: page.url, index: page.index, compressed: page.compressed });
  });
}

/**
 * A fresh process's main-lane requests for a session: adopt the session's
 * persisted prefix when this history passes the checks the in-memory prefix
 * would (same session, system and covered messages; same window; a routable
 * body). Only an authoritative main history may discard it: one with the same
 * system and window, no server tools, and at least the covered length, whose
 * covered messages differ. Anything else (a side or helper request such as
 * the Haiku WebSearch call) leaves it for a later request. The disk is read
 * once per session; the store checks the backend/account owner.
 */
function adoptStoredPrefix(
  opts: ProxyOptions, state: ProxyState, rec: MessagesRecord, sessionId: string,
  body: Record<string, any>, messages: Message[], modelContextLimit: number
): void {
  const { stablePrefixStore: store, storageOwner: owner } = state;
  if (!store || !owner || state.stablePrefixes.has(sessionId)) return;
  if (compactionMode(opts, state, sessionId).mode === "off") return;
  let entry = state.storedPrefixLookups.get(sessionId);
  if (entry === undefined) {
    entry = store.load(sessionId, owner) ?? null;
    boundedSet(state.storedPrefixLookups, sessionId, entry);
  }
  if (entry === null) return;
  const prefix: StablePrefix = { sessionId, ...entry.prefix };
  const verdict = storedPrefixVerdict(body, messages, prefix, modelContextLimit);
  if (verdict === "defer") return;
  state.storedPrefixLookups.set(sessionId, null);
  if (verdict === "discard") {
    store.delete(sessionId, owner);
    rec.storedPrefix = "discarded";
    return;
  }
  boundedSet(state.stablePrefixes, sessionId, prefix);
  if (entry.source && !state.memorySourcePages.has(sessionId)) {
    rememberPage(state.memorySourcePages, sessionId, { sessionId, ...entry.source, seq: 0 });
  }
  rec.storedPrefix = "adopted";
}

/** What this request says about a persisted prefix (adoptStoredPrefix). */
function storedPrefixVerdict(
  body: Record<string, any>, messages: Message[], prefix: StablePrefix,
  modelContextLimit: number
): "adopt" | "discard" | "defer" {
  if (carriesServerTools(body) || prefix.modelContextLimit !== modelContextLimit) return "defer";
  const miss = prefixMismatch(body, messages, prefix, prefix.sessionId, "stable");
  if (miss === null) return prefixRoutedBody(body, messages, prefix) ? "adopt" : "defer";
  const authoritative = miss === "prefix" &&
    messages.length >= prefix.originalPrefixHashes.length;
  return authoritative ? "discard" : "defer";
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
  sessionId: string | undefined
): { body: Buffer } | { miss: ForkMiss } {
  if (!route) return { miss: "no-route" };
  const miss = prefixMismatch(body, messages, route, sessionId);
  if (miss) return { miss };
  const routed = prefixRoutedBody(body, messages, route);
  if (!routed) return { miss: "prefix" };
  return { body: routed.raw };
}

/** The compressed-prefix fields a route and a stable prefix share. */
type PrefixLike = Pick<
  MemoryRoute,
  | "sessionId"
  | "originalSystemHash"
  | "originalPrefixHashes"
  | "originalMediaFreeHashes"
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
  kind: PrefixIdentity = "route"
): "session" | "system" | "prefix" | null {
  if (!sessionId || prefix.sessionId !== sessionId) return "session";
  if (routeValueHash(normalizeRouteSystem(body.system)) !== prefix.originalSystemHash) {
    return "system";
  }
  const prefixLength = prefix.originalPrefixHashes.length;
  if (messages.length < prefixLength) return "prefix";
  for (let i = 0; i < prefixLength; i++) {
    if (!prefixMessageMatches(messages[i], kind, prefix.originalPrefixHashes[i],
      prefix.originalMediaFreeHashes?.[i])) {
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
  if (!capCacheBreakpoints(routed, prefix.compressedMessages.length, { preserveSystem: true })) return null;
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
 * The session's whole-request budget, the size at which a request is
 * compressed: CCC_BUDGET_TOKENS when set (tests), else the model budget the
 * server last reported for this model and window, else fallbackBudgetTokens
 * (servers that predate `model_budget_tokens`, and the first request before
 * any response). Never above the window less the reply's room
 * (compressionTrigger): a request is compressed when its projected size plus
 * that reserve would exceed the window, or the budget.
 */
function resolveBudget(
  opts: ProxyOptions,
  state: ProxyState,
  model: unknown,
  modelContextLimit: number
): Budget {
  const trigger = (tokens: number) => compressionTrigger(tokens, modelContextLimit);
  if (opts.budgetTokensOverride !== undefined) {
    return { tokens: trigger(opts.budgetTokensOverride), source: "override" };
  }
  const reported = state.serverBudgets.get(serverBudgetKey(model, modelContextLimit));
  if (reported !== undefined) return { tokens: trigger(reported), source: "server" };
  return {
    tokens: trigger(fallbackBudgetTokens(model, modelContextLimit)),
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
  // An exact count reserves the model's output floor, as delivery does; an
  // estimate reserves the full max_tokens.
  const outputTokens = bodyOutputReservation(body, exactSizedRecords.has(record));
  return record.uncountedOverWindow === true || (record.sizeSource === "reported" &&
    (record.estimatedTokens ?? 0) + outputTokens > modelContextLimit);
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
 * high. bytes/4 when there is no sample, or only an implausible one
 * (plausibleSample): a 12 tokens/byte sample once sized a 469,801-byte
 * subagent request at 5.78M tokens and refused it (2026-10-05).
 */
/** Something a request's reported size is recorded on: a stable prefix or a route. */
type SizeHolder = { lastSize?: SizeSample };

/** Keep the newest (largest-body) reported size of a request on this prefix. */
function notePrefixSize(prefix: SizeHolder, rec: MessagesRecord, sent: Buffer): void {
  const sample = reportedSample(rec, sent);
  if (sample === undefined) return;
  if (prefix.lastSize && sent.length < prefix.lastSize.forwardedBytes) return;
  prefix.lastSize = sample;
}

/** Record the reported size of a main-thread request forwarded whole. */
function notePassthroughSize(
  state: ProxyState,
  sessionId: string | undefined,
  model: unknown,
  rec: MessagesRecord,
  sent: Buffer
): void {
  const sample = reportedSample(rec, sent);
  if (sessionId === undefined || sample === undefined) return;
  boundedSet(state.passthroughSizes, sessionSizeKey(sessionId, model), sample);
}

/** Key of a main-thread size sample (ProxyState.passthroughSizes). */
function sessionSizeKey(sessionId: string, model: unknown): string {
  return JSON.stringify([sessionId, typeof model === "string" ? model : null]);
}

/** Requests whose reported input includes server-injected tool results. */
const serverToolRecords = new WeakSet<MessagesRecord>();

/**
 * Whether the request offers server tools (web search, web fetch, code
 * execution, tool search): their results are added to the input server-side,
 * so the reported size says nothing about the body's bytes.
 */
function carriesServerTools(body: Record<string, any>): boolean {
  return Array.isArray(body.tools) && body.tools.some((tool: any) =>
    typeof tool?.type === "string" && SERVER_TOOL_TYPE.test(tool.type));
}

const SERVER_TOOL_TYPE = /^(web_search|web_fetch|code_execution|tool_search_tool)_/;

/** Whether the response reports any server tool use (server_tool_use counts). */
function usedServerTools(rec: MessagesRecord): boolean {
  const used = rec.usage?.server_tool_use;
  return !!used && Object.values(used).some((count) => count > 0);
}

/**
 * The size Anthropic reported for a body of `bytes`, if it can describe one:
 * an implausible ratio would mis-size every later request it anchors, so it
 * is dropped and the previous sample kept.
 */
function reportedSample(rec: MessagesRecord, sent: Buffer): SizeSample | undefined {
  const tokens = reportedBodyTokens(rec);
  if (tokens === undefined) return undefined;
  const sample = sizeSampleOf(sent, tokens, rec.model);
  return plausibleSample(sample) ? sample : undefined;
}

/** A size sample of `sent` carrying its inline images (estimateRequestTokens). */
function sizeSampleOf(sent: Buffer, tokens: number, model: unknown): SizeSample {
  const { imageBytes, imageTokens } = bodyImages(sent, typeof model === "string" ? model : undefined);
  return { tokens, forwardedBytes: sent.length, imageBytes, imageTokens };
}

/**
 * Anthropic's input tokens for the body this request forwarded, when its usage
 * describes that body (not a changed delivery, no server tools). Not filtered
 * by plausibility: a body that is mostly images is truly cheap per byte.
 */
function reportedBodyTokens(rec: MessagesRecord): number | undefined {
  if (changedDeliveryRecords.has(rec)) return undefined;
  if (serverToolRecords.has(rec) || usedServerTools(rec)) return undefined;
  return reportedInputTokens(rec);
}

/**
 * Key of a non-main request's size sample (ProxyState.laneSizes): its lane,
 * its own agent id (helpers that carry only a parent id stay apart from the
 * agent), and its model, whose tokenizer the ratio belongs to.
 */
function laneSizeKey(req: http.IncomingMessage, routeKey: string, model: unknown): string {
  return JSON.stringify([
    routeKey,
    firstNonEmptyHeader(req, "x-claude-code-agent-id") ?? null,
    typeof model === "string" ? model : null,
  ]);
}

/** Where a request forwarded whole keeps its size sample, read and written. */
interface SizeSlot {
  get(): SizeSample | undefined;
  /** Stores a plausible sample; an implausible one is dropped. */
  set(sample: SizeSample): void;
}

/** The session's passthrough size on the main thread, else the lane's. */
function wholeRequestSizeSlot(
  state: ProxyState,
  isMainRequest: boolean,
  sessionId: string | undefined,
  sizeKey: string,
  model: unknown
): SizeSlot {
  const main = isMainRequest && sessionId !== undefined;
  const mainKey = main ? sessionSizeKey(sessionId!, model) : "";
  return {
    get: () => (main ? state.passthroughSizes.get(mainKey) : state.laneSizes.get(sizeKey)),
    set: (sample) => {
      if (!plausibleSample(sample)) return;
      if (main) boundedSet(state.passthroughSizes, mainKey, sample);
      else boundedSet(state.laneSizes, sizeKey, sample, MEMORY_ROUTE_MAX_LANES);
    },
  };
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
  sizeKey: string,
  model: unknown,
  rec: MessagesRecord,
  sent: Buffer
): void {
  if (isMainRequest && sessionId !== undefined) {
    notePassthroughSize(state, sessionId, model, rec, sent);
    return;
  }
  const sample = reportedSample(rec, sent);
  if (sample === undefined) return;
  boundedSet(state.laneSizes, sizeKey, sample, MEMORY_ROUTE_MAX_LANES);
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
  /**
   * No prefix, and clearly under the budget by its token count
   * (clearlyUnderBudget): forward whole now and make the compress call, which
   * could only pass it through, in the background.
   */
  | { kind: "pass" }
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
async function planEdgeCompaction(args: {
  sizing: RequestSizing;
  opts: ProxyOptions;
  state: ProxyState;
  body: Record<string, any>;
  messages: Message[];
  sessionId: string;
  modelContextLimit: number;
  forwardBody: Buffer;
  rec: MessagesRecord;
}): Promise<EdgePlan> {
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
    const miss = prefixMismatch(body, messages, prefix, sessionId, "stable");
    if (miss) {
      // Rewind, edit, fork, /clear, or a changed system prompt: the prefix no
      // longer stands for this conversation. Start over from passthrough.
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
      return forced("prefix-mismatch");
    }
    const prefixCandidate = args.sizing.register(routed.raw, "ride", prefix.lastSize);
    candidateSizeOwners.set(prefixCandidate, prefix);
    await countIfOverBound(args.sizing, prefixCandidate, body, modelContextLimit);
    const size = args.sizing.plan(prefixCandidate);
    compaction.estimatedTokens = size.tokens;
    compaction.estimatedBytes = routed.raw.length;
    compaction.sizeSource = size.source;
    noteUncountedBound(compaction, args.sizing, prefixCandidate, body, modelContextLimit);
    // Request-local sizing (an exact count, a calibrated sample, or the
    // image-aware bound), not bytes: a flatten that kept images is mostly
    // base64 that costs a fixed amount per image.
    const overWindow = calibratedSizeExceedsWindow(compaction, body, modelContextLimit);
    const fallback = overWindow ? undefined : { prefix, routed };
    if (state.compactNow.has(sessionId)) return forced("manual", fallback);
    if (
      prefix.modelContextLimit !== modelContextLimit ||
      (explicitTarget && prefix.targetTokens !== targetTokens)
    ) {
      return forced("target-change", fallback);
    }
    if (size.tokens >= budget.tokens || overWindow) {
      const adopted = await adoptPreparedPrefix({ ...args, budgetTokens: budget.tokens, compaction,
        waitMs: opts.memtree.longCompressBudgetMs });
      if (adopted) return { kind: "ride", ...adopted };
      return forced("budget", fallback);
    }
    return { kind: "ride", prefix, routed };
  }

  if (state.compactNow.has(sessionId)) return forced("manual");
  const originalCandidate = args.sizing.register(forwardBody, "original");
  await countIfOverBound(args.sizing, originalCandidate, body, modelContextLimit);
  const size = args.sizing.plan(originalCandidate);
  compaction.estimatedTokens = size.tokens;
  compaction.estimatedBytes = forwardBody.length;
  compaction.sizeSource = size.source;
  noteUncountedBound(compaction, args.sizing, originalCandidate, body, modelContextLimit);
  if (calibratedSizeExceedsLimits(compaction, body, modelContextLimit)) {
    const adopted = await adoptPreparedPrefix({ ...args, budgetTokens: budget.tokens, compaction,
      waitMs: opts.memtree.longCompressBudgetMs });
    if (adopted) return { kind: "ride", ...adopted };
    return forced(compaction.prefixMiss ? "prefix-mismatch" : "budget");
  }
  if (state.serverReportsBudget) {
    // The server measures the request and compresses only past the budget.
    const threshold = Math.max(SERVER_MIN_TARGET_TOKENS, budget.tokens);
    compaction.thresholdTokens = threshold;
    if (clearlyUnderBudget(opts, state, budget, size, compaction)) return { kind: "pass" };
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
      /** Over the window only by its uncounted conservative bound
       * (CompactionRecord.uncountedOverWindow), not by any estimate. */
      uncountedOverWindowOnly?: true;
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
async function planToolCompaction(args: {
  sizing: RequestSizing;
  opts: ProxyOptions;
  state: ProxyState;
  body: Record<string, any>;
  messages: Message[];
  sessionId: string | undefined;
  routeKey: string;
  /** laneSizeKey: where a non-main request's size sample lives. */
  sizeKey: string;
  isMainRequest: boolean;
  modelContextLimit: number;
  forwardBody: Buffer;
  rec: MessagesRecord;
  ride: ToolRide | undefined;
  canCompress: boolean;
}): Promise<ToolPlan> {
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
  if (!ride && current && !prefixMismatch(body, messages, current, sessionId, "stable")) {
    const routed = prefixRoutedBody(body, messages, current);
    if (routed) {
      const prefixCandidate = args.sizing.register(routed.raw, "ride", current.lastSize);
      candidateSizeOwners.set(prefixCandidate, current);
      // Sized below with the request-local sizing; an over-window ride is not
      // kept as a fallback.
      ride = { raw: routed.raw, turnType: "tool-prefix", sizeHolder: current };
    }
  }
  const sample = ride
    ? ride.sizeHolder.lastSize
    : stableLane
      ? state.passthroughSizes.get(sessionSizeKey(sessionId!, body.model))
      : state.laneSizes.get(args.sizeKey);
  const candidate = args.sizing.register(ride?.raw ?? forwardBody,
    ride ? "ride" : "original", sample);
  if (ride) candidateSizeOwners.set(candidate, ride.sizeHolder);
  await countIfOverBound(args.sizing, candidate, body, modelContextLimit);
  const size = args.sizing.plan(candidate);
  compaction.estimatedTokens = size.tokens;
  compaction.estimatedBytes = (ride?.raw ?? forwardBody).length;
  compaction.sizeSource = size.source;
  noteUncountedBound(compaction, args.sizing, candidate, body, modelContextLimit);
  // Judged after any planning count, so a fitting exact count is not
  // overridden by the estimate it replaced.
  let overWindow = !fitsNative(size.tokens, { budget: budget.tokens, context: modelContextLimit,
    output: bodyOutputReservation(body, args.sizing.isExact(candidate)) });
  const uncountedOnly = !overWindow && compaction.uncountedOverWindow === true;
  overWindow ||= uncountedOnly;
  if (!args.canCompress) {
    if (overWindow) return { kind: "pass", original: true };
    return ride ? { kind: "ride", ride } : { kind: "pass" };
  }
  if (size.tokens < budget.tokens && !overWindow) {
    return ride ? { kind: "ride", ride } : { kind: "pass" };
  }
  const adopted = stableLane
    ? await adoptPreparedPrefix({ ...args, sessionId: sessionId!, budgetTokens: budget.tokens,
      compaction, waitMs: opts.memtree.longCompressBudgetMs })
    : undefined;
  if (adopted) {
    return { kind: "ride",
      ride: { raw: adopted.routed.raw, turnType: "tool-prefix", sizeHolder: adopted.prefix } };
  }
  // Settings current after any wait for a preparation (a /memtree-compact N meanwhile).
  const modeNow = compactionMode(opts, state, sessionId);
  if (modeNow.mode === "off") return { kind: "off" };
  const targetNow = compactionTarget(modeNow, budget.tokens);
  compaction.mode = modeNow.mode;
  compaction.targetTokens = targetNow;
  compaction.reason = "budget";
  return {
    kind: "compress",
    ...budgetCompaction(state, compaction, targetNow, body, modelContextLimit),
    targetTokens: targetNow,
    explicitTarget: modeNow.mode === "explicit",
    estimateTokens: size.tokens,
    budgetTokens: budget.tokens,
    overWindow,
    ...(uncountedOnly ? { uncountedOverWindowOnly: true as const } : {}),
    ...(ride && !overWindow ? { fallback: ride } : {}),
    ...(stableLane ? { replaces: current ?? null } : {}),
  };
}

/** Server `compression_target_tokens` sentinel: never compress, always pass through. */
const NEVER_COMPRESS_TARGET_TOKENS = -1;
/** Share of the budget under which a counted human turn skips its blocking call. */
const CLEARLY_UNDER_BUDGET_RATIO = 0.85;

/**
 * Whether a main human turn with no prefix is clearly under the budget by its
 * token count (an exact count, or a projection from Anthropic's reported
 * usage; never a byte guess) against a budget the server reported. The
 * compress call could then only pass it through, so it need not wait for it.
 */
function clearlyUnderBudget(
  opts: ProxyOptions, state: ProxyState, budget: Budget, size: PlannedSize,
  compaction: CompactionRecord,
): boolean {
  // A known payment or key failure keeps the blocking path: it gives the notice.
  if (opts.memtree.paymentRequiredDetail !== null || state.keyInvalid()) return false;
  return budget.source !== "window-ratio" && size.source === "reported" &&
    compaction.uncountedOverWindow !== true &&
    size.tokens <= Math.floor(budget.tokens * CLEARLY_UNDER_BUDGET_RATIO);
}

/**
 * Whether this model and window prepare compressions: a Claude model on a 1M
 * window whose budget is the near-window one (not a Sonnet ceiling).
 */
function preparesCompression(model: unknown, modelContextLimit: number): boolean {
  return modelContextLimit >= ONE_MILLION_TOKENS &&
    fallbackBudgetTokens(model, modelContextLimit) === nearWindowBudgetTokens(modelContextLimit) &&
    typeof model === "string" && CLAUDE_FAMILY_RE.test(model);
}
const ONE_MILLION_TOKENS = 1_000_000;

/**
 * The session's prepared prefix (prepared-compression.ts) as this turn's
 * ride, now the session's stable prefix, when it still covers this history
 * and prefix + the turns after it fit under the budget. Undefined otherwise,
 * and the prepared prefix is dropped: the turn compresses as before.
 */
async function adoptPreparedPrefix(args: {
  sizing: RequestSizing;
  state: ProxyState;
  body: Record<string, any>;
  messages: Message[];
  sessionId: string;
  modelContextLimit: number;
  budgetTokens: number;
  compaction: CompactionRecord;
  opts: ProxyOptions;
  /** How long to wait for a preparation still in flight (its own budget). */
  waitMs: number;
}): Promise<{ prefix: StablePrefix; routed: { body: Record<string, any>; raw: Buffer } } | undefined> {
  const { state, sessionId } = args;
  const base = state.stablePrefixes.get(sessionId);
  await awaitPreparation(state, sessionId, args.waitMs, args.compaction);
  const entry = state.prepared.get(sessionId);
  if (!entry) return undefined;
  state.prepared.discard(sessionId);
  const fit = await preparedFit(args, entry);
  // Another request installed a prefix, or `/memtree-compact` asked for its
  // own target, while this one waited or counted: that wins.
  const kind = fit.kind === "used" && (state.stablePrefixes.get(sessionId) !== base ||
    state.compactNow.has(sessionId) || compactionMode(args.opts, state, sessionId).mode !== "auto")
    ? "stale" : fit.kind;
  args.compaction.prepared = kind;
  if (kind !== "used" || fit.kind !== "used") {
    // A preparation not adopted is never sent, not even as a fallback.
    if (fit.candidate) args.sizing.excludeFallback(fit.candidate);
    if (kind === "too-large" && fit.candidate) {
      notePreparedTruncationBase(args, entry, base, fit.candidate);
    }
    return undefined;
  }
  args.compaction.estimatedTokens = fit.tokens;
  args.compaction.estimatedBytes = fit.routed.raw.length;
  installPreparedPrefix(state, sessionId, entry);
  return { prefix: entry.prefix, routed: fit.routed };
}

/** An adopted preparation becomes the session's stable prefix (and its page, persisted). */
function installPreparedPrefix(
  state: ProxyState, sessionId: string, entry: Prepared<StablePrefix>
): void {
  boundedSet(state.stablePrefixes, sessionId, entry.prefix);
  state.compactNow.delete(sessionId);
  if (entry.source) notePreparedSource(state, sessionId, entry.source);
  persistStablePrefix(state, sessionId, entry.prefix);
}

/**
 * A prepared prefix too large for this turn (preparedFit "too-large") is never sent as it
 * is, but the safety net may shorten its newest tool result (truncatedToFit). Delivered that
 * way, it is installed as an adopted one would be, unless a prefix or `/memtree-compact`
 * replaced it meanwhile.
 */
interface PreparedTruncationBase {
  candidate: RequestCandidate;
  /** The shortened request built on `candidate`, once truncatedToFit chose it. */
  derived?: RequestCandidate;
  install: () => void;
}
const preparedTruncationBases = new WeakMap<RequestSizing, PreparedTruncationBase>();

function notePreparedTruncationBase(
  args: Parameters<typeof adoptPreparedPrefix>[0], entry: Prepared<StablePrefix>,
  base: StablePrefix | undefined, candidate: RequestCandidate,
): void {
  const { state, sessionId } = args;
  preparedTruncationBases.set(args.sizing, { candidate, install: () => {
    if (state.stablePrefixes.get(sessionId) !== base || state.compactNow.has(sessionId) ||
        compactionMode(args.opts, state, sessionId).mode !== "auto") return;
    args.compaction.prepared = "truncated";
    installPreparedPrefix(state, sessionId, entry);
  } });
}

/**
 * The turn that crosses the budget while its session's preparation is still
 * in flight waits for it (it started earlier than a fresh compression could),
 * for at most `waitMs`, rather than making a second, concurrent compress call.
 */
async function awaitPreparation(
  state: ProxyState, sessionId: string, waitMs: number, compaction: CompactionRecord
): Promise<void> {
  const pending = state.preparing.get(sessionId);
  if (!pending) return;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pending, new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, waitMs));
  })]).finally(() => clearTimeout(timer));
  compaction.preparedWaitMs = Date.now() - started;
}

/** An adopted preparation's MemTree page becomes the session's memory source and page. */
function notePreparedSource(
  state: ProxyState, sessionId: string, source: NonNullable<Prepared<StablePrefix>["source"]>
): void {
  const result = { messages: [], compressed: true, memtreeUrl: source.url,
    memtreeIndex: source.index } as CompressResult;
  noteMemtreePage(state, source.seq, sessionId, result);
  noteMemorySource(state, source.seq, sessionId, result);
}

type PreparedFit =
  | { kind: "used"; routed: { body: Record<string, any>; raw: Buffer }; tokens: number;
      candidate: RequestCandidate }
  | { kind: "stale" | "mismatch" | "too-large"; candidate?: RequestCandidate };

/** Whether a prepared prefix can carry this request (adoptPreparedPrefix). */
async function preparedFit(
  args: Parameters<typeof adoptPreparedPrefix>[0], entry: Prepared<StablePrefix>
): Promise<PreparedFit> {
  const { sizing, body, messages, modelContextLimit, budgetTokens, compaction } = args;
  if (entry.prefix.modelContextLimit !== modelContextLimit || entry.triggerTokens !== budgetTokens ||
      entry.prefix.targetTokens !== compaction.targetTokens ||
      entry.prefix.explicitTarget !== (compaction.mode === "explicit")) {
    return { kind: "stale" };
  }
  if (prefixMismatch(body, messages, entry.prefix, args.sessionId, "stable")) {
    return { kind: "mismatch" };
  }
  const routed = prefixRoutedBody(body, messages, entry.prefix);
  if (!routed) return { kind: "mismatch" };
  const candidate = sizing.register(routed.raw, "ride", entry.prefix.lastSize);
  candidateSizeOwners.set(candidate, entry.prefix);
  await countIfOverBound(sizing, candidate, body, modelContextLimit);
  const tokens = sizing.plan(candidate).tokens;
  const fits = tokens < budgetTokens && fitsNative(tokens, { budget: budgetTokens,
    context: modelContextLimit, output: bodyOutputReservation(body, sizing.isExact(candidate)) }) &&
    (sizing.isExact(candidate) || sizing.boundFits(candidate,
      { budget: budgetTokens, context: modelContextLimit, output: bodyOutputReservation(body, false) }));
  // Too large, the turn compresses as before; the ride stays registered, so
  // if that cannot fit either, delivery's safety net may shorten its newest
  // tool result instead (truncatedToFit).
  return fits ? { kind: "used", routed, tokens, candidate } : { kind: "too-large", candidate };
}

/**
 * After a main-thread turn's plan: once its size nears the budget, ask
 * MemTree in the background for the compressed prefix the turn that crosses
 * it will ride (prepared-compression.ts). Fire and forget, one call per
 * session at a time; never delays this turn.
 */
function maybePrepareCompression(args: {
  opts: ProxyOptions;
  state: ProxyState;
  body: Record<string, any>;
  messages: Message[];
  msgsForMemtree: Message[];
  hash: string;
  sessionId: string;
  modelContextLimit: number;
  rec: MessagesRecord;
  clientMeta?: Record<string, string>;
}): void {
  const { state, sessionId, rec } = args;
  const compaction = rec.compaction;
  // Automatic compaction only: an explicit target (/memtree-compact N) is the
  // user's own schedule, and a high one would leave nothing to prepare for.
  if (!compaction || compaction.mode !== "auto" || compaction.estimatedTokens === undefined ||
      compaction.targetTokens === undefined || state.keyInvalid() ||
      state.backgroundSignal.aborted ||
      state.pausedDetail() !== null ||
      !preparesCompression(args.body.model, args.modelContextLimit)) return;
  const tokens = compaction.estimatedTokens;
  if (tokens < prepareStartTokens(compaction.budgetTokens)) return;
  const decision = state.prepared.decide(sessionId, tokens, compaction.budgetTokens);
  rec.prepare = decision;
  if (decision !== "prepare" ||
      !state.prepared.begin(sessionId, tokens, compaction.budgetTokens)) return;
  const base = state.stablePrefixes.get(sessionId);
  const pending = prepareInBackground({ ...args, tokens, targetTokens: compaction.targetTokens,
    explicitTarget: false, triggerTokens: compaction.budgetTokens,
    linkSeq: nextMemtreeCallSeq(state) })
    .catch(() => undefined)
    .then((prepared) => {
      // A prefix installed meanwhile (a blocking compaction) supersedes it.
      const current = state.stablePrefixes.get(sessionId) === base;
      state.prepared.finish(sessionId, current ? prepared : undefined);
      if (state.preparing.get(sessionId) === pending) state.preparing.delete(sessionId);
    });
  boundedSet(state.preparing, sessionId, pending);
}

/** The background prepare call and the prefix it yields (maybePrepareCompression). */
async function prepareInBackground(args: Parameters<typeof maybePrepareCompression>[0] & {
  tokens: number; targetTokens: number; explicitTarget: boolean; triggerTokens: number;
  linkSeq: number;
}): Promise<Prepared<StablePrefix> | undefined> {
  const { opts, state, body, msgsForMemtree, modelContextLimit, sessionId } = args;
  const result = await opts.memtree.compress(args.hash, msgsForMemtree, modelContextLimit,
    state.backgroundSignal, preparedCompressMeta(args));
  noteServerBudget(state, body.model, modelContextLimit, result);
  if (!result) return undefined;
  state.prepared.noteServerAnswer(result.prepared === true);
  if (result.prepared !== true || !didMemtreeCompress(result) ||
      !checkCompressedHistory(result, msgsForMemtree).usable) return undefined;
  const built = buildCompressedBody(body, result);
  if (!built) return undefined;
  const prefix: StablePrefix = {
    sessionId,
    originalSystemHash: routeValueHash(normalizeRouteSystem(body.system)),
    ...prefixIdentity(args.messages, "stable"),
    compressedMessages: cloneJson(built.compressedBody.messages),
    compressedSystem: cloneJson(built.compressedBody.system),
    hasCompressedSystem: Object.prototype.hasOwnProperty.call(built.compressedBody, "system"),
    targetTokens: args.targetTokens,
    explicitTarget: args.explicitTarget,
    modelContextLimit,
  };
  const source = result.memtreeUrl && result.memtreeIndex
    ? { url: result.memtreeUrl, index: result.memtreeIndex, seq: args.linkSeq } : undefined;
  return { prefix, atTokens: args.tokens, triggerTokens: args.triggerTokens,
    ...(source ? { source } : {}) };
}

/** What a prepare call sends: a forced compression to the target, no threshold. */
function preparedCompressMeta(args: Parameters<typeof prepareInBackground>[0]): CompressRequestMeta {
  const { opts, body, sessionId, msgsForMemtree, modelContextLimit } = args;
  const messageUsage = opts.transcriptUsage?.usageFor(sessionId, msgsForMemtree, undefined);
  const messageTimes = transcriptTimesFor(opts, sessionId, undefined)?.(msgsForMemtree);
  return {
    model: modelForMemtree(typeof body.model === "string" ? body.model : undefined,
      modelContextLimit),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    compressionTargetTokens: args.targetTokens,
    prepare: true,
    ...(messageUsage && Object.keys(messageUsage).length ? { messageUsage } : {}),
    ...(messageTimes && Object.keys(messageTimes).length ? { messageTimes } : {}),
    sessionId,
    ...(args.clientMeta ? { clientMeta: args.clientMeta } : {}),
    // Nothing waits on it: the long budget, so a slow server still prepares.
    timeoutMs: opts.memtree.longCompressBudgetMs,
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
  if (messages.length < prefixLength) return null;
  for (let i = 0; i < prefixLength; i++) {
    if (!prefixMessageMatches(messages[i], "route", route.originalPrefixHashes[i],
      route.originalMediaFreeHashes?.[i])) {
      return null;
    }
  }
  const suffix = messages.slice(prefixLength);
  if (suffix.length && !validToolRouteSuffix(suffix) && !isNonToolUserMessage(suffix[suffix.length - 1])) return null;
  const routed: Record<string, any> = {
    ...body,
    messages: [...cloneJson(route.compressedMessages), ...suffix],
  };
  if (route.hasCompressedSystem) {
    routed.system = currentRouteSystem(route.compressedSystem, body.system);
  } else {
    delete routed.system;
  }
  if (!capCacheBreakpoints(routed, route.compressedMessages.length, { preserveSystem: true })) return null;
  if (!validCacheTtlOrder(routed)) return null;
  return Buffer.from(JSON.stringify(routed), "utf-8");
}

/**
 * Count the candidate a planner is about to judge (ride or original, sampled
 * or not) when only a count could admit it: no exact count, and its per-model
 * conservative bound plus max_tokens exceeds the window. Delivery reuses the
 * result.
 */
async function countIfOverBound(
  sizing: RequestSizing, candidate: RequestCandidate, body: Record<string, any>,
  modelContextLimit: number,
): Promise<void> {
  await sizing.countIfOverBound(candidate,
    { budget: modelContextLimit, context: modelContextLimit, output: bodyOutputReservation(body, false) });
}

/** Compaction records whose estimatedTokens is an exact count (noteUncountedBound). */
const exactSizedRecords = new WeakSet<CompactionRecord>();

/**
 * Note an exactly counted candidate (exactSizedRecords), or mark a planned
 * candidate still without an exact count (counting off, or its
 * planning count failed: countIfOverBound ran first) whose conservative bound
 * plus max_tokens exceeds the window: delivery would refuse it uncounted, so
 * it is over the window for planning and takes the normal gated compression.
 */
function noteUncountedBound(
  record: CompactionRecord, sizing: RequestSizing, candidate: RequestCandidate,
  body: Record<string, any>, modelContextLimit: number,
): void {
  if (sizing.isExact(candidate)) {
    exactSizedRecords.add(record);
    return;
  }
  if (sizing.exceedsRequestLimit(candidate) ||
      candidate.conservativeTokens + bodyOutputReservation(body, false) > modelContextLimit) {
    record.uncountedOverWindow = true;
  }
}

/**
 * Whether a forwarded compressed body still overflows the window: its exact
 * count (`exactTokens`, made for delivery), else its reported input tokens,
 * both Anthropic's own count, so the output floor applies; else its
 * conservative image-aware bound (token-estimate.ts) with full max_tokens,
 * never bytes/4, which reads base64 images as text.
 */
function compressedResultExceedsWindow(
  body: Record<string, any>,
  rec: MessagesRecord,
  compressedRaw: Buffer,
  modelContextLimit: number,
  exactTokens?: number
): boolean {
  const counted = exactTokens ?? reportedBodyTokens(rec);
  const tokens = counted ??
    conservativeBodyTokens(compressedRaw, typeof body.model === "string" ? body.model : undefined);
  return tokens + bodyOutputReservation(body, counted !== undefined) > modelContextLimit;
}

/** Output room a native-fit check reserves: the model's floor for an exact
 * count, else (an estimate) the full max_tokens. */
function bodyOutputReservation(body: Record<string, any>, exact = true): number {
  return outputReservation(exact && typeof body.model === "string" ? body.model : undefined,
    body.max_tokens);
}

/** A planned size as a measurement, exact only when Count Tokens measured it. */
function plannedMeasurement(sizing: RequestSizing, candidate: RequestCandidate):
  { tokens: number; source: "exact" | "reported" | "bytes" } {
  const planned = sizing.plan(candidate);
  return { tokens: planned.tokens, source: sizing.isExact(candidate) ? "exact" : planned.source };
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

/** Deterministic system identity. Message identities use cached per-message hashes. */
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
  const cacheControl: Record<string, string> = { type: "ephemeral" };
  if (ttl !== undefined) cacheControl.ttl = ttl;
  if (Array.isArray(only.content) && only.content.length > 0) {
    // A flatten that kept images: the breakpoint goes on its last block.
    const blocks = only.content.map((block: Record<string, unknown>) => ({ ...block }));
    blocks[blocks.length - 1].cache_control = cacheControl;
    return [{ ...only, content: blocks }];
  }
  const text = typeof only.content === "string" ? only.content : undefined;
  if (text === undefined) return messages;
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
  sizing: RequestSizing;
  inputCandidate?: RequestCandidate;
  /**
   * compression_target_tokens / compression_threshold_tokens for this call.
   * Omitted: laneCompaction's (never a bare forcing target).
   */
  compaction?: { target?: number; threshold?: number };
  /**
   * Nothing else could be sent if this compress fails (no prefix to ride, raw
   * request known over the window): use the long budget. See longCompressFor.
   */
  longBudget?: boolean;
  /** Aborts the compress call; default state.shutdownSignal. */
  signal?: AbortSignal;
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
  // The upload is about the request's size: the budget grows with it.
  const budgetMs = Math.min(args.longBudget ? MAX_LONG_COMPRESS_WAIT_MS : MAX_COMPRESS_WAIT_MS,
    args.longBudget ? opts.memtree.longCompressBudgetMs
      : opts.memtree.compressBudgetForBytes(rec.requestBytes));
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
    // The size this request was judged by, when a plausible sample (reported
    // usage or an exact count) calibrated it. Sent so the server compresses
    // whatever the fallback gate would refuse to send uncompressed; a bytes/4
    // guess is not sent, as it would force needless compression.
    ...(args.inputCandidate && args.sizing.clientInputTokens(args.inputCandidate) !== undefined
      ? { clientInputTokens: args.sizing.clientInputTokens(args.inputCandidate),
        // Only an exact count of these bytes may loosen the server's sizing.
        clientInputTokensExact: args.sizing.isExact(args.inputCandidate) }
      : {}),
    ...(messageUsage && Object.keys(messageUsage).length ? { messageUsage } : {}),
    ...(messageTimes && Object.keys(messageTimes).length ? { messageTimes } : {}),
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.clientMeta ? { clientMeta: args.clientMeta } : {}),
    // The deadline this wait uses (the upload-scaled budget included), so the
    // call and its waiters end together.
    timeoutMs: budgetMs,
  };
  // Sampled BEFORE the call, while it still describes this call: after the
  // await the hash is in the cache regardless of who put it there.
  const cached = opts.memtree.hasCachedCompress(
    hash,
    modelContextLimit,
    compressMeta
  );
  // compress() maps every failure to a resolved null (it never rejects).
  // Keep foreground work finite even if a transport ignores its abort signal.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const maximumWait = Math.min(args.longBudget ? MAX_LONG_COMPRESS_WAIT_MS : MAX_COMPRESS_WAIT_MS,
    Math.max(1, Number.isFinite(budgetMs) ? budgetMs : 15_000));
  const result = await Promise.race([
    opts.memtree.compress(hash, msgsForMemtree, modelContextLimit,
      args.signal ?? state.shutdownSignal, compressMeta),
    new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), maximumWait); }),
  ]).finally(() => { if (deadline) clearTimeout(deadline); });
  const compressMs = Date.now() - compressStarted;
  noteServerBudget(state, body.model, modelContextLimit, result);
  // Sampled at this call's settle, before a concurrent same-request failure of
  // another class can overwrite the complete-key entry.
  const failureArming =
    result === null &&
    opts.memtree.lastCompressFailureArming(hash, modelContextLimit, compressMeta);
  const failureStatus = result === null
    ? opts.memtree.lastCompressFailureStatus?.(hash, modelContextLimit, compressMeta) : undefined;
  const hadLiveSuccess = !cached && result !== null;
  // Only arming-class live failures (network error, timeout, 5xx, 402) are
  // fuse evidence. A responsive server's other 4xx failed THIS call but says
  // nothing about MemTree's health, so it contributes neither failure nor
  // success — the fuse is untouched.
  // Budget-consumed heuristic: the client maps every failure to null, so a
  // null that took (roughly) the whole abort budget was almost certainly
  // the AbortSignal timeout, not a fast server error.
  const timedOut = result === null && compressMs >= Math.min(budgetMs, maximumWait);
  // A timeout while other compress calls answered (one succeeded after this
  // one started) is this call's size or the server's slow reply, not an outage: it arms no cooldown (2026-10-23:
  // healthy-server timeouts kept the fuse lit and a screenshot turn was refused).
  const othersAnswered = timedOut && (opts.memtree.lastCompressSuccessAt ?? 0) >= compressStarted;
  const hadLiveFailure = !cached && result === null && failureArming && !othersAnswered;
  rec.compress = {
    ms: compressMs,
    ok: result !== null,
    timedOut,
    ...(!cached && failureStatus === OVER_CONTEXT_STATUS ? { refused: true as const } : {}),
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
 * A clearly under-budget human turn's compress call, not awaited: its answer
 * (a passthrough) only updates the server budget, MemTree health and the
 * session's page link. Its telemetry goes to a copy of the turn's record.
 */
function compressInBackground(args: BackgroundCompressArgs): void {
  if (args.state.backgroundSignal.aborted) return;
  const lanes = args.state.backgroundCompress;
  const lane = backgroundCompressLane(args);
  if (lane === undefined) {
    void runBackgroundCompress(args);
    return;
  }
  const busy = lanes.get(lane);
  if (busy) {
    // One whole-history call at a time per conversation: under the budget each turn
    // started its own (16 to 22 s each on staging in the long-session test, about 12 at
    // once beside the index uploads). A waiting call is replaced only by one whose
    // history contains all of it; otherwise it goes now.
    if (busy.waiting && !extendsHistory(args.msgsForMemtree, busy.waiting.msgsForMemtree)) {
      void runBackgroundCompress(busy.waiting);
    }
    busy.waiting = args;
    return;
  }
  const owner: { waiting?: BackgroundCompressArgs } = {};
  lanes.set(lane, owner);
  void runBackgroundCompress(args).finally(() => {
    if (lanes.get(lane) === owner) lanes.delete(lane);
    if (owner.waiting) compressInBackground(owner.waiting);
  });
}

type BackgroundCompressArgs =
  Omit<Parameters<typeof runBlockingCompression>[0], "longBudget"> & { linkSeq?: number };

function runBackgroundCompress(args: BackgroundCompressArgs): Promise<void> {
  const { state, sessionId, linkSeq } = args;
  return runBlockingCompression({ ...args, rec: { ...args.rec }, signal: state.backgroundSignal })
    .then((compression) => {
      noteMemtreeHealth(state, compression);
      if (linkSeq !== undefined) noteMemtreePage(state, linkSeq, sessionId, compression.result);
    })
    .catch(() => undefined);
}

/**
 * A conversation for compressInBackground: session and first message, media left out (Claude
 * Code's media eviction keeps it, as indexLaneKey does); none without a session.
 */
function backgroundCompressLane(args: BackgroundCompressArgs): string | undefined {
  if (args.sessionId === undefined) return undefined;
  const first = args.msgsForMemtree.find((message) => message.role !== "system");
  return JSON.stringify([args.sessionId, first ? mediaFreeMessageHash(first) : ""]);
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
  if (!capCacheBreakpoints(compressedBody, compressedBody.messages.length)) return null;
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
  /** laneSizeKey: where a non-main request's size sample lives. */
  sizeKey: string;
  isMainRequest: boolean;
  recoveryAttempt: ToolRecoveryAttempt;
  sizing: RequestSizing;
  inputCandidate?: RequestCandidate;
  toolForwarding: ReturnType<typeof capturePromptDelivery>;
  clientMeta?: Record<string, string>;
  /** compression_target_tokens / threshold for the compress call. */
  compaction?: { target?: number; threshold?: number };
  /** Main thread with a session: store the result as the stable prefix. */
  stable?: StablePrefixInstall;
  /** Sent instead of the whole history when the attempt produces nothing. */
  fallback?: ToolRide;
  /** The lane's backoff size, set when the attempt produces no prefix. */
  retryAtTokens?: number;
  /**
   * Without a ride fallback: whether delivery would refuse the whole request
   * too, in which case the compress gets the long budget.
   */
  wholeRefused?: () => Promise<boolean>;
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
    if (args.retryAtTokens !== undefined) {
      recoveryAttempt.retryAtTokens = args.retryAtTokens;
      recoveryAttempt.retryDeadline = Date.now() + TOOL_RECOVERY_FAILURE_COOLDOWN_MS;
    }
  };

  const sessionId = requestSessionId(req);
  const routeOwning = sessionId !== undefined;
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

  /**
   * The attempt produced nothing: send what the turn would have sent without
   * it — the old ride (kept prefix) or the whole history — and back off.
   */
  const forwardOriginal = (growthBackoff = true) => {
    requestSendPolicies.get(req)!.failedRebuild = true;
    if (growthBackoff) backOff();
    if (fallback) {
      requestSendPolicies.get(req)?.allowed.add(fallback.raw);
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
        noteRideSize(fallback.sizeHolder, rec, fallback.raw);
      });
    }
    recordTurn(rec, "tool", args.originalBody);
    capture(opts, "anthropic-request", args.originalBody);
    return forwardRaw(
      req,
      res,
      args.originalBody,
      opts,
      upstream,
      state.shutdownSignal,
      rec
    ).then((delivered) => {
      toolForwarding.settle(delivered);
      noteWholeRequestSize(state, isMainRequest, sessionId, args.sizeKey, body.model, rec,
        args.originalBody);
    });
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
      sizing: args.sizing,
      inputCandidate: args.inputCandidate,
      ...(args.compaction ? { compaction: args.compaction } : {}),
      longBudget: args.wholeRefused ? await args.wholeRefused() : false,
    });
  } catch {
    releaseOwnReservation();
    rec.routeRecovery = { conversationBytes, outcome: "failed" };
    return forwardOriginal();
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
    // closes are deliberately never fed into compress()). Retire only this
    // attempt so a late settle cannot remove a newer attempt.
    if (state.toolRecoveryAttemptedLanes.get(routeKey) === recoveryAttempt) {
      state.toolRecoveryAttemptedLanes.delete(routeKey);
    }
    recordTurn(rec, "tool", Buffer.alloc(0));
    return;
  }


  if (!result) {
    rec.routeRecovery = { conversationBytes, outcome: "failed" };
    releaseOwnReservation();
    // An ordinary server/network failure or timeout retains the background
    // submission: its longer independent budget can still warm the index for
    // a later turn. An unpaid key (402, possibly set by this very compress)
    // or a shutting-down proxy gets no retry.
    if (
      !state.shutdownSignal.aborted &&
      opts.memtree.paymentRequiredDetail === null &&
      !opts.memtree.keyInvalid // a refused key refuses the index too
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
    releaseOwnReservation();
    if (actuallyCompressed || !noteIndexLag(opts, rec, result)) return forwardOriginal();
    awaitIndex(opts, recoveryAttempt, rec.routeRecovery, result);
    return forwardOriginal(false);
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
  if (!(await requestSendPolicies.get(req)!.fitsNative(compressedRaw))) {
    rec.routeRecovery = { conversationBytes, outcome: "unusable" };
    noteOversizedCompression(rec, args.sizing, body, compressedRaw,
      args.compaction?.target ?? rec.compaction?.targetTokens);
    releaseOwnReservation();
    if (!noteIndexLag(opts, rec, result)) return forwardOriginal();
    // The index trails the conversation, so this result kept most of it
    // verbatim. Growth cannot help; the next compress after indexing can.
    // Skip the growth backoff so retries compress again, and let a refusal
    // wait for the index rather than spend the strike budget.
    awaitIndex(opts, recoveryAttempt, rec.routeRecovery, result);
    return forwardOriginal(false);
  }
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
  let installFate: "installed" | "stale" | undefined;
  let installedRoute: MemoryRoute | undefined;
  const activateRecoveredRoute = () => {
    if (activationAttempted) return;
    if (!requestSendPolicies.get(req)?.allowed.has(compressedRaw)) {
      releaseOwnReservation();
      activationAttempted = true;
      return;
    }
    if (!routeOwning) {
      // A sessionless request can use this response but cannot store a reusable route.
      activationAttempted = true;
      return;
    }
    // Installation checks the same lane-generation guard before any mutation.
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
    // Only an installed route makes this answer's memory the reused one.
    if (installed && linkSeq !== undefined) {
      noteMemorySource(state, linkSeq, requestSessionId(req), result);
    }
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
  requestSendPolicies.get(req)?.allowed.add(compressedRaw);
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
  rec.routeRecovery.install = !routeOwning
    ? "no-session"
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
  if (sizeHolder) notePrefixSize(sizeHolder, rec, compressedRaw);
  // Nothing to ride next turn, or a result that still does not fit the
  // window (the next turn would reject it and compress again): wait for
  // growth before the lane tries again.
  const exactTokens = args.sizing.exactTokensFor(compressedRaw);
  if (!sizeHolder ||
      compressedResultExceedsWindow(body, rec, compressedRaw, modelContextLimit, exactTokens)) {
    backOff();
  }
  // A reservation that lost its race (stale) or never reached
  // protocol-complete (upstream 5xx, truncated stream) installed nothing, so
  // it must stop suppressing whoever is still trying to install.
  if (rec.routeRecovery.install !== "installed") releaseOwnReservation();
  // A failed forward AFTER a healthy compress — upstream 5xx/529 or a client
  // mid-stream abort — left no route and the client retries the identical
  // body, so drop the lane's attempt mark, lifting the backoff just set —
  // identity-guarded so a late settle cannot remove a newer lane attempt.
  // The retry's recompress is a compress-cache hit, so the re-attempt is
  // cheap. A later route mismatch deliberately does NOT lift a backoff:
  // siblings sharing a parent-agent fallback lane genuinely mismatch each
  // other every turn, and lifting it there would be one real blocking
  // compress per tool step. The two fates are split in reqlog so the
  // attempt-rate tripwire can tell client behavior from upstream health;
  // the backoff lift treats them alike.
  if (
    (rec.routeRecovery.install === "upstream-failed" ||
      rec.routeRecovery.install === "client-aborted") &&
    state.toolRecoveryAttemptedLanes.get(routeKey) === recoveryAttempt
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

/**
 * One delivery-time retry after a ride's exact count exceeded the budget. It
 * compresses the request's ORIGINAL conversation at a tighter target: the
 * ride carries a memory prefix MemTree never indexed, so compressing it would
 * miss the tree, index a divergent conversation and bill for it.
 */
async function recoverLateCount(args: {
  opts: ProxyOptions; state: ProxyState; req: http.IncomingMessage; rec: MessagesRecord;
  /** The request as Claude Code sent it, and its MemTree conversation. */
  body: Record<string, any>; msgsForMemtree: Message[]; hash: string;
  /** The exact count that put the ride over the budget. */
  rideTokens: number;
  modelContextLimit: number; sizing: RequestSizing; inputCandidate: RequestCandidate;
  clientMeta: Record<string, string>;
  /** Where a delivered replacement is installed (LateRouteInstall). */
  route: LateRouteContext;
  /** The target to recompress to (a compression came back too large); else derived. */
  target?: number;
}): Promise<Buffer | undefined> {
  let generation: number | undefined;
  try {
    const { body, msgsForMemtree: messages } = args;
    const budget = resolveBudget(args.opts, args.state, body.model, args.modelContextLimit).tokens;
    const target = args.target ?? lateRecoveryTarget(compactionTarget(
      compactionMode(args.opts, args.state, requestSessionId(args.req)), budget),
      budget, args.rideTokens);
    const sessionId = requestSessionId(args.req);
    const linkSeq = args.route.lane === "main" ? nextMemtreeCallSeq(args.state) : undefined;
    const replaces = sessionId !== undefined
      ? args.state.stablePrefixes.get(sessionId) ?? null : null;
    // Reserved before the compress call: a newer same-lane decision made
    // while it runs outranks this one, so this never overwrites its route.
    generation = ++args.state.mainRouteDecisionGeneration;
    reserveRouteDecision(args.state, args.route.key, generation);
    const outcome = await runBlockingCompression({
      opts: args.opts, state: args.state, body, msgsForMemtree: messages,
      hash: args.hash, modelContextLimit: args.modelContextLimit,
      rec: args.rec, sessionId, agentId: agentAttributionId(args.req),
      clientMeta: args.clientMeta, sizing: args.sizing, inputCandidate: args.inputCandidate,
      compaction: { target },
    });
    noteMemtreeHealth(args.state, outcome);
    if (linkSeq !== undefined) noteMemtreePage(args.state, linkSeq, sessionId, outcome.result);
    // Like every compress path: a refusal after a lagging answer waits for
    // the index, and the cached answer expires so a retry asks again.
    if (outcome.result) noteIndexLag(args.opts, args.rec, outcome.result);
    if (!outcome.result || !didMemtreeCompress(outcome.result) ||
        !checkCompressedHistory(outcome.result, messages).usable) return undefined;
    const built = buildCompressedBody(body, outcome.result);
    if (!built) return undefined;
    lateRouteInstalls.set(args.rec, lateRouteInstall(args, built.compressedBody, outcome.result, {
      targetTokens: target, explicitTarget: true, modelContextLimit: args.modelContextLimit,
      replaces }, linkSeq, generation));
    generation = undefined; // the install owns the reservation now
    return built.compressedRaw;
  } catch {
    return undefined;
  } finally {
    if (generation !== undefined) releaseRouteDecision(args.state, args.route.key, generation);
  }
}

/** The request's route a late recovery's replacement may become. */
interface LateRouteContext {
  key: string;
  /** The request's messages (the route's original prefix). */
  messages: Message[];
  epoch: number;
  /** "main": the session's main thread (a stable prefix and memory source page);
   * "away": the hidden away summary, which nothing reads a route of (none stored). */
  lane: "main" | "other" | "away";
}

/**
 * A late recovery's replacement, installed like any compression once it is
 * the body delivered: the lane's route (main thread: the session's stable
 * prefix, unless another replaced the one it started from) and its memory
 * source page, under its own route-decision reservation so an older
 * completion never overwrites it and it never overwrites a newer one.
 */
interface LateRouteInstall {
  /** The delivered body is the replacement: install it (once). */
  activate: () => void;
  /** Delivery of `sent` settled (or the replacement was not selected): note
   * its reported size on what it installed, else release the reservation. */
  settle: (delivered: boolean, sent?: Buffer) => void;
}

/** Late recoveries' installs, per request, until delivery settles. */
const lateRouteInstalls = new WeakMap<MessagesRecord, LateRouteInstall>();

function lateRouteInstall(
  args: { state: ProxyState; req: http.IncomingMessage; body: Record<string, any>;
    rec: MessagesRecord; route: LateRouteContext },
  compressedBody: Record<string, any>, result: CompressResult, stable: StablePrefixInstall,
  linkSeq: number | undefined,
  /** Reserved (reserveRouteDecision) before the compress call; released here if unused. */
  generation: number,
): LateRouteInstall {
  const { state, route } = args;
  const sessionId = requestSessionId(args.req);
  let done = false;
  let installed: MemoryRoute | undefined;
  return {
    activate: () => {
      if (done) return;
      done = true;
      if (sessionId !== undefined && route.lane !== "away") {
        installed = installMemoryRoute(state, route.key, args.req, args.body, route.messages,
          compressedBody, route.epoch, generation, route.lane === "main" ? stable : undefined);
      }
      if (!installed) releaseRouteDecision(state, route.key, generation);
      else if (linkSeq !== undefined) noteMemorySource(state, linkSeq, sessionId, result);
    },
    settle(delivered, sent) {
      if (delivered) this.activate();
      // The replacement is a changed delivery (reportedSample skips those):
      // its reported size is this very body's, so it is noted directly.
      const holder: SizeHolder | undefined = stable.installed ?? installed;
      const tokens = reportedInputTokens(args.rec);
      if (holder && sent && delivered && tokens !== undefined &&
          !serverToolRecords.has(args.rec) && !usedServerTools(args.rec)) {
        const sample = sizeSampleOf(sent, tokens, args.rec.model);
        if (plausibleSample(sample) && !(holder.lastSize && sent.length < holder.lastSize.forwardedBytes)) {
          holder.lastSize = sample;
        }
      }
      if (!installed) {
        done = true;
        releaseRouteDecision(state, route.key, generation);
      }
    },
  };
}

/**
 * The ride compressed to `target` still counted `rideTokens` (over the
 * budget), so the recompression of the original aims proportionally lower.
 */
function lateRecoveryTarget(target: number, budget: number, rideTokens: number): number {
  if (!(rideTokens > budget) || !(budget > 0)) return target;
  return Math.max(SERVER_MIN_TARGET_TOKENS, Math.floor(target * budget / rideTokens));
}

/** Select a measured eligible body before delivery; refusing one candidate never
 * prevents considering the original or a validated prefix retained by planning. */
async function selectForwardCandidate(args: {
  opts: ProxyOptions; state: ProxyState; res: http.ServerResponse; rec: MessagesRecord;
  body: Record<string, any>; modelContextLimit: number; req: http.IncomingMessage;
  routeKey: string; preferredBody: Buffer; limits: SizingLimits;
}): Promise<Buffer | undefined> {
  const policy = requestSendPolicies.get(args.req)!;
  const intended = policy.failedRebuild && !policy.allowed.has(args.preferredBody)
    ? policy.original : args.preferredBody;
  const preferred = policy.sizing.register(intended,
    policy.allowed.has(intended) ? args.rec.compress ? "replacement" : "ride" : "original");
  const measured = await policy.sizing.measure(preferred, args.limits);
  let target = preferred;
  const late = lateRecoveryPlan(args.state, args.rec, preferred, measured, args.limits,
    args.routeKey);
  if (late) {
    args.rec.lateCountRecovery = { outcome: "forwarded" };
    const replacement = await holdingLane(args.state, args.routeKey,
      () => policy.recoverLate(preferred.body, late.tokens, late.target));
    if (replacement) target = policy.sizing.register(replacement, "replacement");
  }
  const selection = await policy.sizing.select(target, args.limits) ??
    await policy.sizing.retryTimedOutCount(args.limits) ??
    (args.rec.routeLane === "main" && args.opts.toolOutputs
      ? await truncatedToFit(args.rec, policy.sizing, target, args.limits, args.opts.toolOutputs)
      : undefined);
  const quietDegrade = quietDegrades.get(args.rec);
  quietDegrades.delete(args.rec);
  const lateInstall = lateRouteInstalls.get(args.rec);
  if (lateInstall && (!selection || selection.candidate !== target || target === preferred)) {
    lateRouteInstalls.delete(args.rec);
    lateInstall.settle(false);
  }
  if (!selection) {
    if (args.rec.lateCountRecovery) args.rec.lateCountRecovery.outcome = "refused";
    refuseWholeRequest(args, measured.tokens, args.limits.budget);
    return undefined;
  }
  const { candidate, measurement } = selection;
  const preparedBase = preparedTruncationBases.get(policy.sizing);
  if (preparedBase?.derived !== undefined && preparedBase.derived === candidate) {
    preparedBase.install();
  }
  const changed = candidate !== preferred || intended !== args.preferredBody;
  if (changed) {
    policy.allowed.delete(args.preferredBody);
    changedDeliveryRecords.add(args.rec);
    selectedCandidates.set(args.rec, candidate);
    recordTurn(args.rec, args.rec.turnType, candidate.body);
  }
  if (args.rec.lateCountRecovery) args.rec.lateCountRecovery.outcome =
    changed && candidate.kind === "replacement" ? "compressed" : "forwarded";
  delete args.rec.overBudgetForward;
  if (measurement.tokens > args.limits.budget ||
      (measurement.source !== "exact" && candidate.kind === "original" &&
        measurement.estimatedTokens > args.limits.budget)) {
    args.rec.overBudgetForward = { reason: measurement.source === "exact"
      ? "exact-count-fits-window" : measurement.source === "bytes"
        ? "bytes-fallback-fits-window" : "estimate-fits-window" };
    warnPausedNearWindow(args.state, args.rec, requestSessionId(args.req));
    quietDegrade?.();
  }
  return changed ? candidate.body : intended;
}

/** MemTree's answer when the conversation cannot fit the window even compressed. */
const OVER_CONTEXT_STATUS = 413;
/** Truncation attempts, each cutting more, before the request is refused. */
const TRUNCATION_ATTEMPTS = 3;
/** Cut this much more than the measured excess (tokens per character vary). */
const TRUNCATION_MARGIN = 1.25;

/**
 * The safety net for a main-thread request that does not fit even after
 * compression (tool-result-truncation.ts): its newest tool result saved whole
 * (tool-output-store.ts) and sent with the middle replaced by a pointer to
 * that copy, cut until the request leaves the reply's room below the window.
 * A compressed candidate first (a ride on a prefix, or a replacement whose
 * suffix is structured), else the whole history.
 */
async function truncatedToFit(
  rec: MessagesRecord, sizing: RequestSizing, preferred: RequestCandidate, limits: SizingLimits,
  store: ToolOutputStore,
): Promise<{ candidate: RequestCandidate; measurement: CandidateMeasurement } | undefined> {
  if (!compressionSettled(rec)) return undefined;
  const prepared = preparedTruncationBases.get(sizing);
  const rank = (item: RequestCandidate) => item.kind === "original" ? 1 : 0;
  const bases = [preferred, ...sizing.fallbacks().filter((item) => item !== preferred),
    ...(prepared && prepared.candidate !== preferred ? [prepared.candidate] : [])]
    .sort((a, b) => rank(a) - rank(b) || a.body.length - b.body.length);
  for (const base of bases) {
    const fitted = await truncateCandidate(rec, sizing, base, limits, store);
    if (fitted && prepared && base === prepared.candidate) prepared.derived = fitted.candidate;
    if (fitted) return fitted;
  }
  return undefined;
}

/**
 * Whether compression had its chance and the request still cannot fit: a ride
 * on a prepared prefix, a compress answer that compressed (sent or found too
 * large), or MemTree's 413 (it cannot fit the window even compressed). Not
 * after a failed or skipped compress call (an outage, an exception, an auth
 * or payment refusal, a backoff: the retryable refusal stands), a passthrough
 * of a warming index, or while the index is behind: waiting for it lets
 * compression summarize instead.
 */
function compressionSettled(rec: MessagesRecord): boolean {
  if (rec.indexBehind === true) return false;
  if (rec.compress?.refused === true || rec.compaction?.prepared === "used") return true;
  return rec.compress?.ok === true && rec.routeRecovery?.outcome !== "noop" &&
    rec.turnType !== "followup-noop";
}

/** truncatedToFit for one candidate; undefined when it has no tool result to
 * shorten, the copy could not be saved, or it cannot be made to fit. */
async function truncateCandidate(
  rec: MessagesRecord, sizing: RequestSizing, base: RequestCandidate, limits: SizingLimits,
  store: ToolOutputStore,
): Promise<{ candidate: RequestCandidate; measurement: CandidateMeasurement } | undefined> {
  const goal = limits.context - Math.max(limits.output, COMPRESSION_RESERVE_TOKENS);
  const parsed = JSON.parse(base.body.toString("utf-8"));
  const first = await sizing.measure(base, limits);
  const bytesPerToken = base.body.length / Math.max(1, first.tokens);
  for (let attempt = 1; attempt <= TRUNCATION_ATTEMPTS; attempt++) {
    const excess = Math.max(1_000, first.tokens - goal);
    const cut = Math.ceil(excess * bytesPerToken * TRUNCATION_MARGIN * attempt);
    // The store pins each copy it saves, so none this request points at is
    // evicted while it is counted and forwarded.
    const plan = truncateToolResults(parsed, cut, (text) => store.save(text));
    if (!plan) return undefined;
    const candidate = sizing.register(Buffer.from(JSON.stringify(plan.body), "utf-8"),
      "replacement");
    const measurement = await sizing.measure(candidate, limits);
    if (fitsMeasured(measurement, limits) && measurement.tokens <= goal) {
      rec.truncatedToolResult = { originalChars: plan.originalChars,
        omittedChars: plan.omittedChars };
      return { candidate, measurement };
    }
  }
  return undefined;
}

/**
 * Whether delivery recompresses before sending, and to what: a ride counted
 * over the budget (no compression yet); the whole history counted over the
 * window with no compression yet (outside an outage cooldown: a refusal is
 * all that is left otherwise); or a compression that came back too large for
 * the window (oversizedCompressions), redone once to a target smaller by the
 * excess, so the turn is compressed and sent in the same request instead of
 * being refused and retried.
 */
function lateRecoveryPlan(
  state: ProxyState, rec: MessagesRecord, preferred: RequestCandidate,
  measured: CandidateMeasurement, limits: SizingLimits, routeKey: string,
): { tokens: number; target?: number } | undefined {
  if (rec.lateCountRecovery) return undefined;
  const oversized = oversizedCompressions.get(rec);
  // A lagging index kept history verbatim: the refusal waits for it instead.
  if (oversized && rec.indexBehind !== true) {
    const goal = limits.context - Math.max(limits.output, COMPRESSION_RESERVE_TOKENS);
    const excess = oversized.tokens - goal;
    const target = Math.floor(oversized.target - excess - oversized.target * SMALLER_TARGET_MARGIN);
    return target >= SERVER_MIN_TARGET_TOKENS ? { tokens: oversized.tokens, target } : undefined;
  }
  if (rec.compress || measured.source !== "exact" || !(measured.tokens > limits.budget)) {
    return undefined;
  }
  // Another request of this lane is compressing (rec.routeRecovery "in-flight"):
  // a second compression of the same history at another target would miss its
  // dedupe and bill twice. This one waits for neither and goes as it is.
  if (state.toolRecoveryAttemptedLanes.get(routeKey)?.inFlight) return undefined;
  if (preferred.kind === "ride") return { tokens: measured.tokens };
  // Over the window with nothing compressed, a refusal is all that is left:
  // an outage cooldown does not skip this one compress.
  return preferred.kind === "original" && !fitsMeasured(measured, limits)
    ? { tokens: measured.tokens } : undefined;
}

/**
 * Run a delivery-time compression as the lane's in-flight operation, so a
 * concurrent request of the lane neither starts its own (planning sees
 * "in-flight") nor races it; the lane's own attempt state is kept.
 */
async function holdingLane<T>(state: ProxyState, routeKey: string, run: () => Promise<T>): Promise<T> {
  const lanes = state.toolRecoveryAttemptedLanes;
  const prior = lanes.get(routeKey);
  const attempt: ToolRecoveryAttempt = prior ?? { modelContextLimit: 0, inFlight: true };
  // Clears only what it set: an attempt another request holds in flight
  // stays that request's to end.
  const setHere = !attempt.inFlight;
  attempt.inFlight = true;
  if (!prior) lanes.set(routeKey, attempt);
  try {
    return await run();
  } finally {
    if (setHere) attempt.inFlight = false;
    if (!prior && lanes.get(routeKey) === attempt) lanes.delete(routeKey);
  }
}

/** A recompression aims this share of its old target lower than the excess alone. */
const SMALLER_TARGET_MARGIN = 0.1;

/**
 * Compressions of this request that came back too large for the window: their
 * size (an exact count, else the conservative bound) and the target they had.
 */
const oversizedCompressions = new WeakMap<MessagesRecord, { tokens: number; target: number }>();

/** Note a compression of `rec` that does not fit the window (lateRecoveryPlan). */
function noteOversizedCompression(
  rec: MessagesRecord, sizing: RequestSizing, body: Record<string, any>, compressedRaw: Buffer,
  target: number | undefined,
): void {
  if (target === undefined) return;
  const tokens = sizing.exactTokensFor(compressedRaw) ??
    conservativeBodyTokens(compressedRaw, typeof body.model === "string" ? body.model : undefined);
  oversizedCompressions.set(rec, { tokens, target });
}

/**
 * Whether delivery would refuse `candidate` sent whole, by delivery's own
 * admission: it is sendable only when its plan fits and either an exact count
 * or its conservative per-model bound (with the full max_tokens) fits too;
 * otherwise the measurement delivery would use (a count, else that bound)
 * decides. Only when it is refused is there no fallback, and only then may a
 * compress take the long budget.
 */
async function wholeRequestRefused(
  sizing: RequestSizing, candidate: RequestCandidate, limits: SizingLimits
): Promise<boolean> {
  if (fitsNative(sizing.plan(candidate).tokens, limits) &&
      (sizing.isExact(candidate) || sizing.boundFits(candidate, limits))) return false;
  return !fitsMeasured(await sizing.measure(candidate, limits), limits);
}

/** Write the bounded fallback refusal (route-fallback.ts); always false. */
function refuseWholeRequest(
  args: { state: ProxyState; res: http.ServerResponse; rec: MessagesRecord;
    body: Record<string, any>; modelContextLimit: number; routeKey: string;
    req: http.IncomingMessage },
  inputTokens: number,
  budgetTokens: number
): false {
  // A refused key or a paused one: a retry cannot fix either, so it is final at once.
  const keyInvalid = args.state.keyInvalid();
  const unpaid = keyInvalid ? null : args.state.pausedDetail();
  const failure = keyInvalid ? pausedRefusal(keyInvalidRefusalMessage(args.state.keyPageUrl))
    : unpaid !== null ? pausedRefusal(pausedRefusalMessage(unpaid))
    : args.state.fallbackFailures.fail(args.routeKey,
      { awaitingIndex: args.rec.indexBehind === true });
  args.rec.forwardedBytes = 0;
  args.rec.approxInputTokens = 0;
  args.state.diagnostics?.record("refusal", {
    status: failure.status, attempt: failure.attempt,
    input_ktokens: Math.round(inputTokens / 1000), budget_ktokens: Math.round(budgetTokens / 1000),
  });
  // To requests.jsonl, never the console: Claude Code's TUI shows stderr inline.
  args.rec.refusal = {
    lane: args.routeKey, attempt: failure.attempt, status: failure.status,
    inputTokens, outputTokens: args.body.max_tokens ?? 0,
    outputReservation: bodyOutputReservation(args.body), indexBehind: args.rec.indexBehind === true,
    budgetTokens, modelContextLimit: args.modelContextLimit, ...(unpaid !== null ? { paused: true } : {}),
    ...(keyInvalid ? { keyInvalid: true } : {}),
  };
  if (unpaid !== null || keyInvalid) cancelPausedNotice(args.state, args.rec);
  if (args.res.headersSent || args.res.destroyed) return false;
  args.res.writeHead(failure.status, { "content-type": "application/json", ...failure.headers });
  args.res.end(JSON.stringify(failure.body));
  if (unpaid !== null) {
    notePausedRefusal(args.state, args.rec, args.routeKey, requestSessionId(args.req));
  }
  // The refusal named the key: it counts as the key notice on the user's screen.
  if (keyInvalid && args.rec.routeLane === "main") args.state.keyNotice.markShown();
  return false;
}

/**
 * The refusal text already says MemTree is paused and how to resume, so it
 * counts as the paused notice: the throttle restarts, and this request's
 * queued notice is withdrawn rather than shown a second time after it.
 */
function notePausedRefusal(
  state: ProxyState, rec: MessagesRecord, lane: string, sessionId: string | undefined
): void {
  // A subagent's or hidden away-summary's refusal is not on the user's screen.
  if (rec.routeLane === "main") {
    state.paymentNotice.markShown();
    // Past the window /compact no longer fits: withdraw an undelivered
    // near-window line and show none later.
    state.notices.cancel(state.nearWindowNotice);
    if (sessionId !== undefined) addNearWindowWarned(state, sessionId);
  }
  // A tool turn in the outage cooldown or its lane's growth backoff refuses on
  // the last 402 without asking. End both so the next request asks MemTree
  // again (a 402 answers fast) and paying takes effect with no restart. A
  // concurrent attempt still compressing (no backoff yet) keeps its slot.
  state.toolRecoveryCooldownUntil = 0;
  const attempt = state.toolRecoveryAttemptedLanes.get(lane);
  if (attempt && (!attempt.inFlight || attempt.retryAtTokens !== undefined)) {
    state.toolRecoveryAttemptedLanes.delete(lane);
  }
}

/** Withdraw the paused notice this request queued: its refusal says the same. */
function cancelPausedNotice(state: ProxyState, rec: MessagesRecord): void {
  state.notices.cancel(pausedNotices.get(rec));
  pausedNotices.delete(rec);
}

/**
 * A paused main-lane request over the budget, still fitting the window (often a
 * tool round): once per session, say /compact still works now. A turn that
 * already queued the paused notice carries the line itself.
 */
function warnPausedNearWindow(
  state: ProxyState, rec: MessagesRecord, sessionId: string | undefined
): void {
  if (state.keyInvalid()) return; // a refused key, not a pause: the key notice says why
  const detail = state.unpaidDetail();
  // Paid again: a later pause (next month's limit) warns afresh.
  if (detail === null) state.pausedNearWindowWarned.clear();
  // Never replace another queued notice (or this one again): a later request tries.
  if (detail === null || rec.routeLane !== "main" || sessionId === undefined ||
      pausedNotices.has(rec) || nearWindowWarned(state, sessionId) ||
      state.notices.hasPending(state.mainPromptId)) return;
  state.nearWindowNotice = state.notices.queueSuffix(
    paymentNoticeText(detail, undefined, { overBudget: true }), () => {
    state.paymentNotice.markShown();
    addNearWindowWarned(state, sessionId);
    state.diagnostics?.record("paused_notice", { trigger: "turn" });
  }, state.mainPromptId);
}

/** Remember a warned session, keeping the set bounded (oldest first out). */
function addNearWindowWarned(state: ProxyState, sessionId: string): void {
  state.pausedNearWindowWarned.delete(sessionId);
  state.pausedNearWindowWarned.add(sessionId);
  if (state.pausedNearWindowWarned.size > MEMTREE_LINKS_MAX_SESSIONS) {
    const oldest = state.pausedNearWindowWarned.values().next().value;
    if (oldest !== undefined) state.pausedNearWindowWarned.delete(oldest);
  }
}

function nearWindowWarned(state: ProxyState, sessionId: string | undefined): boolean {
  return sessionId !== undefined && state.pausedNearWindowWarned.has(sessionId);
}

/** Whether this turn's own size estimate reached its whole-request budget. */
function reachedBudget(compaction: CompactionRecord | undefined): boolean {
  return compaction !== undefined && (compaction.estimatedTokens ?? 0) >= compaction.budgetTokens;
}

/**
 * Whether the planned size says a turn needed MemTree to compress it: a
 * forced compaction (budget, window, `/memtree-compact`, a rebuilt prefix), a
 * size at or over the budget, or a size nobody measured. A planned fit is
 * provisional: delivery's own sizing can still find the turn over the budget
 * (quietDegrades), since a plan can undercount.
 */
function compressionNeeded(compaction: CompactionRecord | undefined): boolean {
  if (compaction === undefined || compaction.reason !== undefined) return true;
  if (compaction.estimatedTokens === undefined) return true;
  return compaction.estimatedTokens >= compaction.budgetTokens;
}

/**
 * A degraded turn whose plan fit the budget, so it queued no notice: the
 * notice to queue if delivery's sizing finds it over the budget after all.
 */
const quietDegrades = new WeakMap<MessagesRecord, () => void>();

/** The paused notice a degraded request queued, until it is refused or settles. */
const pausedNotices = new WeakMap<MessagesRecord, object>();
const changedDeliveryRecords = new WeakSet<MessagesRecord>();
const selectedCandidates = new WeakMap<MessagesRecord, RequestCandidate>();
const candidateSizeOwners = new WeakMap<RequestCandidate, SizeHolder | SizeSlot>();

const requestSendPolicies = new WeakMap<http.IncomingMessage, {
  original: Buffer; failedRebuild: boolean; allowed: WeakSet<Buffer>;
  sizing: RequestSizing;
  fitsNative: (body: Buffer) => Promise<boolean>;
  /** Recompress the ORIGINAL conversation after a ride counted `tokens` late. */
  recoverLate: (ride: Buffer, tokens: number, target?: number) => Promise<Buffer | undefined>;
  /** The exact body selected for delivery, or undefined after a refusal. */
  select: (body: Buffer) => Promise<Buffer | undefined>;
  delivered: () => void;
}>();

async function forwardRaw(
  req: http.IncomingMessage, res: http.ServerResponse, bodyBuffer: Buffer,
  opts: ProxyOptions, upstream: Upstream, shutdownSignal: AbortSignal,
  rec?: MessagesRecord, onProtocolComplete?: () => void
): Promise<boolean> {
  const policy = requestSendPolicies.get(req);
  const selected = policy ? await policy.select(bodyBuffer) : bodyBuffer;
  if (!selected) return false;
  // A late recovery's replacement went out instead: it installs as its route.
  const lateInstall = rec && selected !== bodyBuffer ? lateRouteInstalls.get(rec) : undefined;
  if (rec) lateRouteInstalls.delete(rec);
  const delivered = await forwardAccepted(req, res, selected, opts, upstream, shutdownSignal, rec,
    selected === bodyBuffer ? onProtocolComplete : lateInstall?.activate);
  lateInstall?.settle(delivered, selected);
  if (delivered && rec) noteSelectedCandidateSize(rec);
  return delivered;
}

/** Attribute a fallback response only to the body and size owner actually sent. */
function noteSelectedCandidateSize(rec: MessagesRecord): void {
  const candidate = selectedCandidates.get(rec);
  const owner = candidate && candidateSizeOwners.get(candidate);
  const tokens = reportedInputTokens(rec);
  if (!candidate || !owner || tokens === undefined) return;
  // Server tools' injected results inflate the reported input (reportedSample).
  if (serverToolRecords.has(rec) || usedServerTools(rec)) return;
  const sample = sizeSampleOf(candidate.body, tokens, rec.model);
  if (!plausibleSample(sample)) return;
  if ("set" in owner) owner.set(sample);
  else if (!owner.lastSize || sample.forwardedBytes >= owner.lastSize.forwardedBytes) {
    owner.lastSize = sample;
  }
}

/** forwardRaw once the request's send policy (if any) accepted the body. */
function forwardAccepted(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream,
  shutdownSignal: AbortSignal,
  rec?: MessagesRecord,
  onProtocolComplete?: () => void
): Promise<boolean> {
  const policy = requestSendPolicies.get(req);
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
      if (ok) policy?.delivered();
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
          const rateLimit = rateLimitFromResponse(rec.upstreamStatus, upstreamRes.headers);
          if (rateLimit) rec.rateLimit = rateLimit;
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
              if ((upstreamRes.statusCode ?? 0) >= 400) {
                rec.upstreamError = upstreamErrorCode(observed);
              }
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
export const __testCompressedResultExceedsWindow = compressedResultExceedsWindow;

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
export const __testHoldingLane = holdingLane;
