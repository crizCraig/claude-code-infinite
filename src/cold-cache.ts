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
 * TTL the request's own markers ask for (cacheTtlMs). proxy.ts decides.
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
export class LaneCacheClock {
  private readonly last = new Map<string, number>();
  private readonly claimed = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * The time since `lane` last sent a request, and that send's time (the gap's identity), or
   * undefined if it has sent none. Arrival time, not the proxy's own waits, is what counts.
   */
  gap(lane: string): { gapMs: number; basis: number } | undefined {
    const basis = this.last.get(lane);
    return basis === undefined ? undefined : { gapMs: Math.max(0, this.now() - basis), basis };
  }

  /** A request of `lane` is going out to Anthropic now: its cache is warm from here. */
  sent(lane: string): void {
    bounded(this.last, lane, this.now());
  }

  /**
   * Whether a cold compression may answer the gap that began at `basis`: true once per gap,
   * so a compression that fails, or a request refused before it is sent, does not force
   * again on every retry. A send starts a new gap.
   */
  claim(lane: string, basis: number): boolean {
    if (this.claimed.get(lane) === basis) return false;
    bounded(this.claimed, lane, basis);
    return true;
  }
}

function bounded(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_LANES) map.delete(map.keys().next().value!);
}

/**
 * The sample for a request on a lane last used `gapMs` ago, or undefined when there is
 * nothing to judge (no earlier request, or no cache marker in this one).
 */
export function coldCacheSample(
  gapMs: number | undefined, body: Record<string, any>
): ColdCacheSample | undefined {
  const ttlMs = cacheTtlMs(body);
  if (gapMs === undefined || ttlMs === undefined) return undefined;
  return { gapMs, ttlMs, cold: gapMs > ttlMs };
}

/**
 * The TTL of the request's last cache_control marker in Anthropic's tools, system, messages
 * order. Anthropic requires 1h markers before 5m ones, so the last is the shortest: the
 * conversation's cache lives that long. Undefined when the request has no marker.
 */
export function cacheTtlMs(body: Record<string, any>): number | undefined {
  let last: Record<string, any> | undefined;
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const cc = item && typeof item === "object" ? (item as any).cache_control : undefined;
      if (cc && typeof cc === "object") last = cc;
    }
  };
  visit(body.tools);
  visit(body.system);
  if (Array.isArray(body.messages)) for (const m of body.messages) visit(m?.content);
  if (!last) return undefined;
  return last.ttl === "1h" ? LONG_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
}

/** Whether a cold lane at `tokens` is far enough above `targetTokens` to compress. */
export function coldCacheWorthCompressing(tokens: number, targetTokens: number): boolean {
  return tokens > Math.floor(targetTokens * COLD_CACHE_MIN_EXCESS_RATIO);
}
