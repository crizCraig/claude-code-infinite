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
import { MemtreeClient } from "./memtree.js";
import type { MemtreeLinkPlacement } from "./cli-args.js";
import type { MemtreeLinkStore } from "./memtree-links.js";
import type { TranscriptUsageSource } from "./transcript-usage.js";
import type { ProjectMeta } from "./project-meta.js";
import { type RequestLogSink } from "./reqlog.js";
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
     * - "success": appended to the `✓ MemTree · conversation optimized` line,
     *   once per new index, nothing otherwise.
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
/** A request size Anthropic reported, and the bytes of the body it was for. */
interface SizeSample {
    /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens. */
    tokens: number;
    forwardedBytes: number;
}
/**
 * Budget fallback until the server reports `model_budget_tokens`: this share
 * of the model's context window (800k of Opus 5.5's 1M, matching the server's
 * large-context threshold).
 */
export declare const FALLBACK_BUDGET_WINDOW_RATIO = 0.8;
export declare function startProxy(opts: ProxyOptions): Promise<RunningProxy>;
/** The page id in a server-stamped link (`…/m/<id>` or `…/usage/memtree/<id>`). */
export declare function memtreePageId(pageUrl: string): string | undefined;
export declare const MEMTREE_COMPACT_MIN_TOKENS = 20000;
/** "50k", "50000", "1.5m" → tokens; undefined when not a positive count. */
export declare function parseTokenCount(text: string): number | undefined;
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
declare function estimateRequestTokens(sample: SizeSample | undefined, bytes: number): {
    tokens: number;
    source: "reported" | "bytes";
};
/**
 * Keep a request within Anthropic's breakpoint limit after the compressed
 * prefix (which carries one) is joined to Claude Code's own suffix. Drops
 * the earliest suffix breakpoints first, never the compressed prefix's or
 * the request's last one, so both the big prefix and the growing tail stay
 * cached.
 */
declare function capCacheBreakpoints(body: Record<string, any>, _prefixLength?: number): void;
/** Test seam. */
export declare const __testCapCacheBreakpoints: typeof capCacheBreakpoints;
export declare const __testEstimateRequestTokens: typeof estimateRequestTokens;
export {};
//# sourceMappingURL=proxy.d.ts.map