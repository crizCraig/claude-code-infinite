import { createHash, type Hash } from "node:crypto";
import { stripSystemReminderText, type Message } from "./turns.js";

// Request messages are immutable snapshots. Weak keys retain no completed request.
// Route installation stores these digests, not the original megabytes of history.
const routeHashes = new WeakMap<Message, string>();
const stableHashes = new WeakMap<Message, string>();
const routeMediaFreeHashes = new WeakMap<Message, string>();
const stableMediaFreeHashes = new WeakMap<Message, string>();

/** Which identity a compressed prefix uses: a route's, or a stable prefix's. */
export type PrefixIdentity = "route" | "stable";

/** Hash each incoming message once, then reuse it across route candidates/checks. */
export function routeMessageHash(message: Message): string {
  return messageHash(message, false, false);
}

/** Stable prefixes span turns in which Claude can omit earlier thinking blocks. */
export function stablePrefixMessageHash(message: Message): string {
  return messageHash(message, stableShape(message), false);
}

/** The identities a prefix stores for the messages it stands for. */
export function prefixIdentity(
  messages: Message[], kind: PrefixIdentity
): { originalPrefixHashes: string[]; originalMediaFreeHashes: string[] } {
  const exact = kind === "stable" ? stablePrefixMessageHash : routeMessageHash;
  return {
    originalPrefixHashes: messages.map(exact),
    originalMediaFreeHashes: messages.map((m) => mediaFreeHash(m, kind)),
  };
}

/**
 * Whether `message` still stands where a prefix's message stood: unchanged, or the same
 * apart from media Claude Code evicted. Past its media caps (count, and bytes in 2.1.310)
 * Claude Code evicts the oldest images and documents from its history: a tool result's
 * becomes a placeholder, a top-level one is dropped, an emptied message becomes the
 * placeholder. That counts only when the message has no media left, so an attachment
 * replaced by another never matches; a removed one is indistinguishable from eviction.
 * Prefixes stored before media-free hashes existed match exactly only.
 */
export function prefixMessageMatches(
  message: Message, kind: PrefixIdentity, exact: string, mediaFree: string | undefined
): boolean {
  const hash = kind === "stable" ? stablePrefixMessageHash(message) : routeMessageHash(message);
  if (hash === exact) return true;
  return mediaFree !== undefined && !carriesMedia(message.content) &&
    mediaFreeHash(message, kind) === mediaFree;
}

/**
 * Whether `newer` carries everything `older` does: every message of `older` after the
 * system prompt (whose billing line changes per call), in place and unchanged apart from
 * media Claude Code evicted since (prefixMessageMatches). Past its media caps every new
 * screenshot evicts an old one, so an exact comparison would never hold there. About
 * 20 ms for a 25 MB history; each message is hashed once.
 */
export function extendsHistory(newer: Message[], older: Message[]): boolean {
  const a = newer.filter((message) => message.role !== "system");
  const b = older.filter((message) => message.role !== "system");
  return a.length >= b.length && b.every((message, i) =>
    prefixMessageMatches(a[i], "route", routeMessageHash(message), mediaFreeMessageHash(message)));
}

/** A message's route identity without its media (Claude Code's eviction keeps it). */
export function mediaFreeMessageHash(message: Message): string {
  return mediaFreeHash(message, "route");
}

function mediaFreeHash(message: Message, kind: PrefixIdentity): string {
  return messageHash(message, kind === "stable" && stableShape(message), true);
}

function stableShape(message: Message): boolean {
  return message.role === "assistant" && Array.isArray(message.content);
}

function messageHash(message: Message, stable: boolean, mediaFree: boolean): string {
  const cache = mediaFree
    ? (stable ? stableMediaFreeHashes : routeMediaFreeHashes)
    : (stable ? stableHashes : routeHashes);
  const cached = cache.get(message);
  if (cached !== undefined) return cached;
  let content = message.content;
  if (stable && Array.isArray(content)) {
    content = content.filter(
      (part: any) => part?.type !== "thinking" && part?.type !== "redacted_thinking"
    );
  }
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const reminded = normalizeReminders(blocks);
  const normalized = {
    ...message, content: stripBlockCache(mediaFree ? withoutMedia(reminded) : reminded),
  };
  const hash = createHash("sha256");
  updateCanonical(hash, normalized);
  const digest = hash.digest("hex");
  cache.set(message, digest);
  return digest;
}

/** Same transform for stored and incoming messages, including nested tool results. */
function normalizeReminders(content: unknown): unknown {
  if (typeof content === "string") return stripSystemReminderText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part === "string") return stripSystemReminderText(part);
    if (!part || typeof part !== "object") return part;
    if (part.type === "text" && typeof part.text === "string") {
      return { ...part, text: stripSystemReminderText(part.text) };
    }
    if (part.type === "tool_result") {
      return { ...part, content: normalizeReminders(part.content) };
    }
    return part;
  });
}

/**
 * Claude Code's stand-ins for media it removed from its own history. After the API
 * rejects media it removes a message left empty altogether; that shifts positions and
 * still breaks a prefix (rare, and a recompress follows).
 */
const MEDIA_PLACEHOLDERS = new Set([
  "[media removed: request limit]", "(media removed \u2014 rejected by API)",
]);

/** Content without media blocks and without Claude Code's placeholders for them. */
function withoutMedia(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((part) => !isMediaOrPlaceholder(part)).map((part) =>
    part && typeof part === "object" && part.type === "tool_result"
      ? { ...part, content: withoutMedia(part.content) }
      : part);
}

/** Whether any image or document is left, at the top level or in a tool result. */
function carriesMedia(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part: any) => part?.type === "image" || part?.type === "document" ||
    (part?.type === "tool_result" && carriesMedia(part.content)));
}

function isMediaOrPlaceholder(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  if (part.type === "image" || part.type === "document") return true;
  return part.type === "text" && MEDIA_PLACEHOLDERS.has(part.text);
}

/** Cache metadata on blocks is incidental; identically named tool input keys aren't. */
function stripBlockCache(content: unknown): unknown {
  if (Array.isArray(content)) return content.map(stripBlockCache);
  if (!content || typeof content !== "object") return content;
  const { cache_control: _ignored, ...block } = content as Record<string, unknown>;
  return block;
}

/**
 * Typed, length-framed canonical encoding avoids serializing large strings twice.
 * UTF-16 preserves lone surrogates too; UTF-8 would equate them with U+FFFD.
 * This is a process-local identity digest, not a wire-format hash.
 */
function updateCanonical(hash: Hash, value: unknown): void {
  if (value === null || value === undefined) {
    hash.update("n");
  } else if (typeof value === "string") {
    hash.update(`s${value.length}:`).update(value, "utf16le");
  } else if (typeof value === "number") {
    hash.update(Number.isFinite(value) ? `d${String(value)};` : "n");
  } else if (typeof value === "boolean") {
    hash.update(value ? "t" : "f");
  } else if (Array.isArray(value)) {
    hash.update(`a${value.length}:`);
    for (const item of value) updateCanonical(hash, item);
  } else if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    hash.update(`o${keys.length}:`);
    for (const key of keys) {
      updateCanonical(hash, key);
      updateCanonical(hash, object[key]);
    }
  } else {
    throw new TypeError("Route identity requires JSON message data");
  }
}
