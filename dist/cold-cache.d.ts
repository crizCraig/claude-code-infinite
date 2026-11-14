/**
 * Compress on a cold cache (`CCC_COMPRESS_ON_COLD_CACHE=1`, off by default).
 *
 * Anthropic's prompt cache keeps an entry for its TTL after its last use: 5 minutes, or an
 * hour for a `cache_control: { ttl: "1h" }` marker. A lane that idles past it (a subagent
 * waiting on a background command, a main session left for lunch) pays to write its whole
 * context again on the next request. When that context is above the lane's normal
 * compaction target, compressing it to the target first makes that rewrite smaller and
 * every later read cheaper, with no change to what the model sees in the steady state
 * (plans: memtree-marketing notes/subscription_savings_2026-11-14.md, lever c).
 *
 * This module only measures: the time since each lane last sent a request upstream
 * (LaneCacheClock; an in-memory clock, so a fresh ccc process has no gap to judge) and the
 * TTL the request's own markers ask for (cacheTtlMs). proxy.ts decides. The clock is per
 * lane while Anthropic's cache is per prefix, so it approximates: a fork subagent that shares
 * an uncompressed main thread's prefix warms that cache without stamping the main lane, and
 * a refused (429/529) send still stamps it.
 */
/** Anthropic's default prompt-cache TTL, and the one a `ttl: "1h"` marker asks for. */
export declare const DEFAULT_CACHE_TTL_MS: number;
export declare const LONG_CACHE_TTL_MS: number;
/**
 * A cold lane compresses only when its context is this much above its target: just above
 * it, a compression would buy back almost nothing for its call.
 */
export declare const COLD_CACHE_MIN_EXCESS_RATIO = 1.1;
/** What a lane's cache looked like when a request arrived (MessagesRecord.coldCache). */
export interface ColdCacheSample {
    gapMs: number;
    ttlMs: number;
    cold: boolean;
}
/**
 * When each lane (route key) last sent a request to Anthropic, which is when its cache entry
 * was last refreshed, and which of those sends a cold compression has already answered.
 */
export declare class LaneCacheClock {
    private readonly now;
    private readonly last;
    private readonly claimed;
    constructor(now?: () => number);
    /**
     * The time since `lane` last sent a request, and that send's time (the gap's identity), or
     * undefined if it has sent none. Arrival time, not the proxy's own waits, is what counts.
     */
    gap(lane: string): {
        gapMs: number;
        basis: number;
    } | undefined;
    /** A request of `lane` is going out to Anthropic now: its cache is warm from here. */
    sent(lane: string): void;
    /**
     * Whether a cold compression may answer the gap that began at `basis`: true once per gap,
     * so a compression that fails, or a request refused before it is sent, does not force
     * again on every retry. A send starts a new gap.
     */
    claim(lane: string, basis: number): boolean;
}
/**
 * The sample for a request on a lane last used `gapMs` ago, or undefined when there is
 * nothing to judge (no earlier request, or no cache marker in this one).
 */
export declare function coldCacheSample(gapMs: number | undefined, body: Record<string, any>): ColdCacheSample | undefined;
/**
 * The TTL of the request's last cache_control marker in Anthropic's tools, system, messages
 * order. Anthropic requires 1h markers before 5m ones, so the last is the shortest: the
 * conversation's cache lives that long. Undefined when the request has no marker.
 */
export declare function cacheTtlMs(body: Record<string, any>): number | undefined;
/** Whether a cold lane at `tokens` is far enough above `targetTokens` to compress. */
export declare function coldCacheWorthCompressing(tokens: number, targetTokens: number): boolean;
//# sourceMappingURL=cold-cache.d.ts.map