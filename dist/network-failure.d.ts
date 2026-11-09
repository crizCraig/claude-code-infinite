/**
 * Connection failures (no answer at all) to MemTree or Anthropic, and the refusal a turn
 * gets while one can't be reached. 2026-11-09: with the network down, compression failed
 * with getaddrinfo ENOTFOUND and over-budget turns were refused as "MemTree couldn't fit
 * this request ... run /ccc:memtree-compact or /clear", blaming the fit for the network.
 */
/** A failure this recent still explains a refusal (outlasts the 60 s outage cooldown). */
export declare const NETWORK_FAILURE_FRESH_MS: number;
/** A call that got no answer because its host could not be reached. */
export interface NetworkFailure {
    code: string;
    host: string;
    at: number;
}
/** The network failure `err` describes (its own code or its cause's), else undefined. */
export declare function networkFailureOf(err: unknown, host: string, now?: number): NetworkFailure | undefined;
/** `failure` when it is recent enough to explain what happens now. */
export declare function freshFailure(failure: NetworkFailure | undefined, now?: number): NetworkFailure | undefined;
/**
 * What a turn is told while MemTree (and maybe Anthropic too) can't be reached: the
 * internet when neither answers, else the one that doesn't. Never the fit, /compact or /clear.
 */
export declare function unreachableMessage(memtree: NetworkFailure | undefined, anthropic: NetworkFailure | undefined): string;
//# sourceMappingURL=network-failure.d.ts.map