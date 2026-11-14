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
 * This module only measures: the time since each lane's previous request (LaneCacheClock)
 * and the TTL the request's own markers ask for (cacheTtlMs). proxy.ts decides.
 */
/** Anthropic's default prompt-cache TTL, and the one a `ttl: "1h"` marker asks for. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
export const LONG_CACHE_TTL_MS = 60 * 60_000;
/**
 * A cold lane compresses only when its context is this much above its target: just above
 * it, a compression would buy back almost nothing for its call.
 */
export const COLD_CACHE_MIN_EXCESS_RATIO = 1.1;
const MAX_LANES = 512;
/** When each lane (route key) last sent a request. */
export class LaneCacheClock {
    now;
    last = new Map();
    constructor(now = () => Date.now()) {
        this.now = now;
    }
    /** Note a request on `lane` now; the time since its previous one, or undefined if none. */
    touch(lane) {
        const now = this.now();
        const previous = this.last.get(lane);
        this.last.delete(lane);
        this.last.set(lane, now);
        if (this.last.size > MAX_LANES)
            this.last.delete(this.last.keys().next().value);
        return previous === undefined ? undefined : Math.max(0, now - previous);
    }
}
/**
 * The sample for a request on a lane last used `gapMs` ago, or undefined when there is
 * nothing to judge (no earlier request, or no cache marker in this one).
 */
export function coldCacheSample(gapMs, body) {
    const ttlMs = cacheTtlMs(body);
    if (gapMs === undefined || ttlMs === undefined)
        return undefined;
    return { gapMs, ttlMs, cold: gapMs > ttlMs };
}
/**
 * The TTL of the request's last cache_control marker in Anthropic's tools, system, messages
 * order. Anthropic requires 1h markers before 5m ones, so the last is the shortest: the
 * conversation's cache lives that long. Undefined when the request has no marker.
 */
export function cacheTtlMs(body) {
    let last;
    const visit = (value) => {
        if (!Array.isArray(value))
            return;
        for (const item of value) {
            const cc = item && typeof item === "object" ? item.cache_control : undefined;
            if (cc && typeof cc === "object")
                last = cc;
        }
    };
    visit(body.tools);
    visit(body.system);
    if (Array.isArray(body.messages))
        for (const m of body.messages)
            visit(m?.content);
    if (!last)
        return undefined;
    return last.ttl === "1h" ? LONG_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
}
/** Whether a cold lane at `tokens` is far enough above `targetTokens` to compress. */
export function coldCacheWorthCompressing(tokens, targetTokens) {
    return tokens > Math.floor(targetTokens * COLD_CACHE_MIN_EXCESS_RATIO);
}
//# sourceMappingURL=cold-cache.js.map