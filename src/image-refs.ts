/**
 * Image references on MemTree calls: images MemTree already stores are not uploaded again.
 *
 * Every index and compress call sends the whole conversation, so a screenshot-heavy
 * session re-sent every image as base64 on every call (2026-10: 8.7, 12.5 and 18.5 MB
 * bodies for 194k-384k tokens of context), heading for the 32 MiB HTTP/1 limit. A
 * server that resolves references lists, on each answer, the request's images it
 * stores (`memtree_image_sha256s`); later calls send those images as their block with
 * `source.data` replaced by IMAGE_REF_PREFIX + the sha256 of the image bytes, and the
 * server puts the bytes back before reading the request, so hashing, billing and what
 * it returns are unchanged. Only the MemTree upload changes: what ccc forwards to
 * Anthropic never carries a reference. Servers that never list stored images (older
 * ones, or with the image store off) only ever get bytes.
 */
import { createHash } from "node:crypto";
import type { Message } from "./turns.js";

export const IMAGE_REF_PREFIX = "memtree-image:sha256:";
/** Declared in x-client-features: this client reads STORED_IMAGES_FIELD. */
export const IMAGE_REFS_FEATURE = "image-refs";
/** Answer field: shas of the request's images the server stores. */
export const STORED_IMAGES_FIELD = "memtree_image_sha256s";
/** 409 detail field: references the server could not serve. */
export const MISSING_IMAGES_FIELD = "missing_image_sha256s";
/** The server's answer to references it cannot serve; the call is sent again with bytes. */
export const MISSING_IMAGES_STATUS = 409;
/** Stored shas remembered (a 1M-token window holds ~600 images). */
const KNOWN_MAX = 4096;
/** Base64 strings whose sha is remembered, by total length (memory bound). */
const SHA_CACHE_MAX_CHARS = 64 * 1024 * 1024;
const SHA_HEX_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** A message list as sent, and the shas it references (empty: nothing changed). */
export interface Referenced<T> {
  value: T;
  refs: string[];
}

export class ImageRefs {
  private known = new Map<string, true>();
  private shaOf = new Map<string, string>();
  private shaChars = 0;
  private disabled = false;

  /** Whether calls may carry references at all (the server listed stored images). */
  get active(): boolean {
    return !this.disabled && this.known.size > 0;
  }

  /** Learn the stored images an answer lists; a server that lists none changes nothing. */
  noteAnswer(json: unknown): void {
    const listed = (json as Record<string, unknown> | null)?.[STORED_IMAGES_FIELD];
    if (!Array.isArray(listed)) return;
    for (const sha of listed) {
      if (typeof sha !== "string" || !SHA_HEX_RE.test(sha)) continue;
      this.known.delete(sha);
      this.known.set(sha, true);
    }
    while (this.known.size > KNOWN_MAX) {
      const first = this.known.keys().next().value;
      if (first === undefined) break;
      this.known.delete(first);
    }
  }

  /** The server could not serve these (or, without a list, any): send bytes for them. */
  forget(shas: readonly string[]): void {
    for (const sha of shas) this.known.delete(sha);
  }

  /** The server refused references outright (an older or misconfigured server). */
  disable(): void {
    this.disabled = true;
    this.known.clear();
  }

  /** `messages` with each stored image as a reference; copy on write. */
  referenceMessages(messages: Message[]): Referenced<Message[]> {
    if (!this.active) return { value: messages, refs: [] };
    const refs: string[] = [];
    const value = messages.map((message) => {
      const result = this.referenceMessage(message);
      refs.push(...result.refs);
      return result.value;
    });
    return refs.length ? { value, refs } : { value: messages, refs };
  }

  /** One message with each stored image as a reference; the same object if none is. */
  referenceMessage(message: Message): Referenced<Message> {
    if (!this.active || !Array.isArray(message?.content)) return { value: message, refs: [] };
    const refs: string[] = [];
    const content = this.referenceBlocks(message.content, refs);
    return { value: content === message.content ? message : { ...message, content }, refs };
  }

  private referenceBlocks(blocks: unknown[], refs: string[]): unknown[] {
    let changed = false;
    const out = blocks.map((block) => {
      const next = this.referenceBlock(block, refs);
      if (next !== block) changed = true;
      return next;
    });
    return changed ? out : blocks;
  }

  private referenceBlock(block: any, refs: string[]): unknown {
    if (block?.type === "tool_result" && Array.isArray(block.content)) {
      const content = this.referenceBlocks(block.content, refs);
      return content === block.content ? block : { ...block, content };
    }
    const source = block?.type === "image" ? block.source : undefined;
    if (source?.type !== "base64" || typeof source.data !== "string") return block;
    const sha = this.storedSha(source.data);
    if (sha === undefined) return block;
    refs.push(sha);
    return { ...block, source: { ...source, data: IMAGE_REF_PREFIX + sha } };
  }

  /** The image's sha when the server stores it and its base64 re-encodes identically. */
  private storedSha(data: string): string | undefined {
    let sha = this.shaOf.get(data);
    if (sha === undefined) {
      if (!isCanonicalBase64(data)) return undefined;
      sha = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
      this.rememberSha(data, sha);
    }
    return this.known.has(sha) ? sha : undefined;
  }

  private rememberSha(data: string, sha: string): void {
    if (data.length > SHA_CACHE_MAX_CHARS) return;
    this.shaOf.set(data, sha);
    this.shaChars += data.length;
    while (this.shaChars > SHA_CACHE_MAX_CHARS) {
      const first = this.shaOf.keys().next().value;
      if (first === undefined) break;
      this.shaOf.delete(first);
      this.shaChars -= first.length;
    }
  }
}

/** The shas a refusal names (409 detail), or undefined when it names none. */
export function missingImageShas(bodyText: string): string[] | undefined {
  try {
    const listed = JSON.parse(bodyText)?.detail?.[MISSING_IMAGES_FIELD];
    if (!Array.isArray(listed)) return undefined;
    return listed.filter((sha): sha is string => typeof sha === "string");
  } catch {
    return undefined;
  }
}

/**
 * A 400 about references: "never" when this key may not send any (stop for the
 * process), "this" when only this request's were refused (too many: send its bytes).
 */
export function refusesImageRefs(status: number, bodyText: string): "never" | "this" | false {
  if (status !== 400 || !/image reference/i.test(bodyText)) return false;
  return /own MemTree key/i.test(bodyText) ? "never" : "this";
}

/**
 * The server re-encodes the bytes it stores, so only base64 that decodes and re-encodes
 * to the same text may be referenced (padding included, no whitespace).
 */
export function isCanonicalBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) return false;
  // Only the last quantum can hide non-zero padding bits ("QR==" decodes like "QQ==").
  const tail = data.slice(-4);
  return Buffer.from(tail, "base64").toString("base64") === tail;
}
