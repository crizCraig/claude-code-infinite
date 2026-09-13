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
 * - Followup user turn: blocking compress + substitute. The compressed body
 *   remains the prefix for that turn's tool loop.
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
    /**
     * Test-only fault-injection seam: invoked inside installMemoryRoute after
     * its guards pass, immediately before the route is stored. Throwing here
     * simulates route bookkeeping failing (the cloneJson/JSON.stringify
     * calls), which no natural input can trigger — every install input has
     * already survived JSON.parse. Exists solely so the "activation-error"
     * install fate (label precedence over clientAborted, release without
     * refund) is pinnable by tests. Undefined in production.
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
export declare function startProxy(opts: ProxyOptions): Promise<RunningProxy>;
//# sourceMappingURL=proxy.d.ts.map