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
    originalMediaSlots: string[];
};
/**
 * Whether `message` still stands where a prefix's message stood: unchanged, or the same
 * apart from media Claude Code evicted or put back. Past its media caps (count, and bytes
 * in 2.1.310) Claude Code evicts the oldest images and documents from its history: a tool
 * result's becomes a placeholder, a top-level one is dropped, an emptied message becomes
 * the placeholder. A raised cap puts them back (2.1.325 on 2026-11-15: a flag took its byte
 * cap from 24 to 56 MiB and a resume sent 91 evicted images again). With no media left it
 * counts as eviction. With media left, only slot by slot against `storedSlots` (the stored
 * message's mediaSlots): the same content around the same media slots, each slot now a
 * placeholder (evicted), the stored media, or media where the stored message had a
 * placeholder (put back). A top-level image Claude Code dropped left no slot, so putting
 * it back does not match (the prefix is rebuilt); nor does media in a message whose
 * stored form had no slot there, or one image replaced by another.
 * A newer Claude Code can also render the same history differently on resume (see
 * portableHash), with media kept or (no media left) evicted the same way.
 * Prefixes stored before media-free or portable hashes existed match exactly only.
 */
export declare function prefixMessageMatches(message: Message, kind: PrefixIdentity, exact: string, mediaFree: string | undefined, portable?: string, portableMediaFree?: string, storedSlots?: string): boolean;
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
 * Where a message's images, documents and Claude Code's placeholders for them sit, and what
 * each one is: "" when it has none, else `<slot hash>|<entries>`. The slot hash is the
 * message's identity with each of them replaced by the same slot marker (so it pins all
 * other content, which tool result each slot is in and its place among the blocks); the
 * entries, one per slot in order and comma-joined, are a media block's sha-256 or "" for a
 * placeholder.
 */
export declare function mediaSlots(message: Message, kind: PrefixIdentity): string;
//# sourceMappingURL=route-identity.d.ts.map