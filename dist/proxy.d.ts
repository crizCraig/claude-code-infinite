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
import { RouteFallbackFailures } from "./route-fallback.js";
import { CountTokensCooldowns, type SizeSample } from "./count-tokens.js";
import { RequestSizing, estimateRequestTokens, type RequestCandidate } from "./request-sizing.js";
import { PreparedCompressions } from "./prepared-compression.js";
import type { ToolOutputStore } from "./tool-output-store.js";
import { MemtreeClient, type CompressResult } from "./memtree.js";
import { type Message } from "./turns.js";
import { NoticeDeliveryQueue, type FirstTreeIntro } from "./hooks.js";
import { ModelContextNotices } from "./model-context.js";
import { PaymentNoticeThrottle } from "./payment-notice.js";
import type { MemtreeLinkPlacement } from "./cli-args.js";
import { type MemtreeLinkStore } from "./memtree-links.js";
import type { PersistedEntry, StablePrefixStore } from "./prefix-store.js";
import type { NewestTreeLookup } from "./memtree-newest.js";
import type { TranscriptUsageSource } from "./transcript-usage.js";
import type { ProjectMeta } from "./project-meta.js";
import type { ProjectTreesHint } from "./project-trees.js";
import type { DiagnosticsRecorder } from "./diagnostics.js";
import { type MessagesRecord, type RequestLogSink } from "./reqlog.js";
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
    lastNoticedIndexCoverage?: {
        sessionId?: string;
        indexedTokens: number;
    };
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
    backgroundCompress: Map<string, {
        waiting?: BackgroundCompressArgs;
    }>;
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
export declare const FALLBACK_BUDGET_WINDOW_RATIO = 0.8;
/** The fallback whole-request budget for `model` on this window (see above). */
export declare function fallbackBudgetTokens(model: unknown, modelContextLimit: number): number;
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
    awaitingIndex?: {
        pageId: string;
        checking: boolean;
        deadline: number;
    };
}
export declare function startProxy(opts: ProxyOptions): Promise<RunningProxy>;
/** The page id in a server-stamped link (`…/m/<id>` or `…/usage/memtree/<id>`). */
export declare function memtreePageId(pageUrl: string): string | undefined;
/**
 * The SessionStart hook's answer: the banner line for the user
 * (`systemMessage`), model context (`additionalContext`), or both.
 */
export declare function sessionStartOutput(line: string | undefined, context: string | undefined): Record<string, unknown>;
export declare const MEMTREE_COMPACT_MIN_TOKENS = 20000;
/** How long a paused turn waits for the short checkout link before its notice (once). */
export declare const PAYMENT_LINK_NOTICE_WAIT_MS = 1000;
export declare const SUBAGENT_VIEW_NOTE = "(main session's page; subagent pages aren't linked yet)";
export declare const SUBAGENT_COMPACT_REPLY = "MemTree compact applies to the main session only.";
/** "50k", "50000", "1.5m" → tokens; undefined when not a positive count. */
export declare function parseTokenCount(text: string): number | undefined;
/**
 * Whether a forwarded compressed body still overflows the window: its exact
 * count (`exactTokens`, made for delivery), else its reported input tokens,
 * both Anthropic's own count, so the output floor applies; else its
 * conservative image-aware bound (token-estimate.ts) with full max_tokens,
 * never bytes/4, which reads base64 images as text.
 */
declare function compressedResultExceedsWindow(body: Record<string, any>, rec: MessagesRecord, compressedRaw: Buffer, modelContextLimit: number, exactTokens?: number): boolean;
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
declare function runBlockingCompression(args: {
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
    compaction?: {
        target?: number;
        threshold?: number;
    };
    /**
     * Nothing else could be sent if this compress fails (no prefix to ride, raw
     * request known over the window): use the long budget. See longCompressFor.
     */
    longBudget?: boolean;
    /** Aborts the compress call; default state.shutdownSignal. */
    signal?: AbortSignal;
}): Promise<BlockingCompressionOutcome>;
type BackgroundCompressArgs = Omit<Parameters<typeof runBlockingCompression>[0], "longBudget"> & {
    linkSeq?: number;
};
/**
 * Run a delivery-time compression as the lane's in-flight operation, so a
 * concurrent request of the lane neither starts its own (planning sees
 * "in-flight") nor races it; the lane's own attempt state is kept.
 */
declare function holdingLane<T>(state: ProxyState, routeKey: string, run: () => Promise<T>): Promise<T>;
/** Test seam. */
export declare const __testCapCacheBreakpoints: typeof capCacheBreakpoints;
export declare const __testEstimateRequestTokens: typeof estimateRequestTokens;
export declare const __testCompressedResultExceedsWindow: typeof compressedResultExceedsWindow;
export declare const __testHoldingLane: typeof holdingLane;
export {};
//# sourceMappingURL=proxy.d.ts.map