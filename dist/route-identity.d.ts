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
    originalPortableHashes: string[];
    originalPortableMediaFreeHashes: string[];
    originalMediaDigests: string[];
};
/**
 * Whether `message` still stands where a prefix's message stood: unchanged, or the same
 * apart from media Claude Code evicted or put back. Past its media caps (count, and bytes
 * in 2.1.310) Claude Code evicts the oldest images and documents from its history: a tool
 * result's becomes a placeholder, a top-level one is dropped, an emptied message becomes
 * the placeholder. A raised cap puts them back (2.1.325 on 2026-11-15: a flag took its byte
 * cap from 24 to 56 MiB and a resume sent 91 evicted images again). With no media left it
 * counts as eviction; with media left, only when `mediaDigests` (the stored message's
 * media, mediaDigests) shows the media dropped or added, never one replaced by another.
 * A newer Claude Code can also render the same history differently on resume (see
 * portableHash), with media kept or (no media left) evicted the same way.
 * Prefixes stored before media-free or portable hashes existed match exactly only.
 */
export declare function prefixMessageMatches(message: Message, kind: PrefixIdentity, exact: string, mediaFree: string | undefined, portable?: string, portableMediaFree?: string, storedMedia?: string): boolean;
/**
 * Whether `newer` carries everything `older` does: every message of `older` after the
 * system prompt (whose billing line changes per call), in place and unchanged apart from
 * media Claude Code evicted since (prefixMessageMatches). Past its media caps every new
 * screenshot evicts an old one, so an exact comparison would never hold there. About
 * 20 ms for a 25 MB history; each message is hashed once.
 */
export declare function extendsHistory(newer: Message[], older: Message[]): boolean;
/** A message's route identity without its media (Claude Code's eviction keeps it). */
export declare function mediaFreeMessageHash(message: Message): string;
/**
 * The digests of a message's images and documents, in order (top level and inside tool
 * results), joined by ","; "" when it carries none. Stored beside a prefix's hashes so a
 * later match can tell media put back from media replaced (prefixMessageMatches).
 */
export declare function mediaDigests(message: Message): string;
//# sourceMappingURL=route-identity.d.ts.map