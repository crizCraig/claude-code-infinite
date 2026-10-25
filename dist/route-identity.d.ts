import { type Message } from "./turns.js";
/** Which identity a compressed prefix uses: a route's, or a stable prefix's. */
export type PrefixIdentity = "route" | "stable";
/** Hash each incoming message once, then reuse it across route candidates/checks. */
export declare function routeMessageHash(message: Message): string;
/** Stable prefixes span turns in which Claude can omit earlier thinking blocks. */
export declare function stablePrefixMessageHash(message: Message): string;
/** The identities a prefix stores for the messages it stands for. */
export declare function prefixIdentity(messages: Message[], kind: PrefixIdentity): {
    originalPrefixHashes: string[];
    originalMediaFreeHashes: string[];
};
/**
 * Whether `message` still stands where a prefix's message stood: unchanged, or the same
 * apart from media Claude Code evicted. Past its media caps (count, and bytes in 2.1.310)
 * Claude Code evicts the oldest images and documents from its history: a tool result's
 * becomes a placeholder, a top-level one is dropped, an emptied message becomes the
 * placeholder. That counts only when the message has no media left, so an attachment
 * replaced by another never matches; a removed one is indistinguishable from eviction.
 * Prefixes stored before media-free hashes existed match exactly only.
 */
export declare function prefixMessageMatches(message: Message, kind: PrefixIdentity, exact: string, mediaFree: string | undefined): boolean;
/** A message's route identity without its media (Claude Code's eviction keeps it). */
export declare function mediaFreeMessageHash(message: Message): string;
//# sourceMappingURL=route-identity.d.ts.map