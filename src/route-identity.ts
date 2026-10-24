import { createHash, type Hash } from "node:crypto";
import { stripSystemReminderText, type Message } from "./turns.js";

// Request messages are immutable snapshots. Weak keys retain no completed request.
// Route installation stores these digests, not the original megabytes of history.
const routeHashes = new WeakMap<Message, string>();
const stableHashes = new WeakMap<Message, string>();

/** Hash each incoming message once, then reuse it across route candidates/checks. */
export function routeMessageHash(message: Message): string {
  return messageHash(message, false);
}

/** Stable prefixes span turns in which Claude can omit earlier thinking blocks. */
export function stablePrefixMessageHash(message: Message): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return routeMessageHash(message);
  }
  return messageHash(message, true);
}

function messageHash(message: Message, stable: boolean): string {
  const cache = stable ? stableHashes : routeHashes;
  const cached = cache.get(message);
  if (cached !== undefined) return cached;
  let content = message.content;
  if (stable && Array.isArray(content)) {
    content = content.filter(
      (part: any) => part?.type !== "thinking" && part?.type !== "redacted_thinking"
    );
  }
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const normalized = {
    ...message, content: stripBlockCache(withoutMedia(normalizeReminders(blocks))),
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

/** Claude Code's stand-ins for media it removed from its own history. */
const MEDIA_PLACEHOLDERS = new Set([
  "[media removed: request limit]", "(media removed \u2014 rejected by API)",
]);

/**
 * Media is not identity. Past its media caps (count, and bytes in 2.1.310) Claude Code
 * evicts the oldest images and documents from history: a tool result's becomes a
 * placeholder, a top-level one is dropped, an emptied message becomes the placeholder.
 * A route or stable prefix covering those messages stays valid (its compressed bytes
 * stand in for them), so media blocks and the placeholders alike are left out.
 */
function withoutMedia(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((part) => !isMediaOrPlaceholder(part)).map((part) =>
    part && typeof part === "object" && part.type === "tool_result"
      ? { ...part, content: withoutMedia(part.content) }
      : part);
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
