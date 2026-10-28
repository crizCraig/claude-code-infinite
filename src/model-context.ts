/**
 * What Claude itself is told about MemTree's state, and the manual /compact
 * interception.
 *
 * The display notices (notices.ts, payment-notice.ts) reach only the user:
 * hook `systemMessage`s and rendered deltas never enter the model's context.
 * So a model asked "why am I still blocked?" while MemTree was paused guessed
 * about Anthropic credits and Claude plan limits (2026-10-28, ccc 1.0.30).
 * While MemTree is paused or its key is refused, the UserPromptSubmit hook adds
 * one short `additionalContext` notice to the next prompt: what is paused
 * (MemTree, not Claude), why, and what fixes it. It stays in the transcript
 * (a paused MemTree compresses nothing), so it is said once per change of
 * state, and again after Claude Code's own compaction drops it.
 *
 * MemTree's normal state needs no notice: the MCP server's instructions
 * (memtree-mcp.ts) already say context is MemTree's job, with the paused case
 * as the exception these notices announce.
 */

import fs from "node:fs";
import { FALLBACK_SUBSCRIBE_URL, SHORT_PAYMENT_URL_RE } from "./payment-gate.js";
import { REASON_FREE_CREDIT_USED, REASON_PLAN_LIMIT } from "./payment-link.js";

export const SUPPORT_EMAIL = "support@polychat.co";
const PAUSED_PREFIX = "ccc: MemTree is paused: ";
const KEY_INVALID_PREFIX = "ccc: MemTree is off: ";
const ACTIVE_AGAIN_PREFIX = "ccc: MemTree is working again";
/** A resume's transcript scan reads backward in chunks of this size, from the end. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** Each chunk overlaps the next by this much, so a marker split between them is found. */
const MARKER_OVERLAP_BYTES = 64;
/** A scan that has not found a marker by then restores nothing. */
export const TRANSCRIPT_SCAN_MS = 1_000;
/** Told once MemTree answers again after a paused or refused-key notice. */
export const MEMTREE_ACTIVE_AGAIN_CONTEXT =
  `${ACTIVE_AGAIN_PREFIX}; compression is back on, so the earlier paused/off notice ` +
  "and its /compact fallback no longer apply.";
/** The one line a blocked manual /compact shows (PreCompact hook reason). */
export const COMPACT_BLOCKED_REASON =
  "MemTree already keeps this session within its budget; /compact would discard detail. " +
  "Use /ccc:memtree-compact if you really want to compress now, or run /compact again " +
  "to use Claude Code's anyway.";
/** A second manual /compact within this long of a blocked one runs. */
export const COMPACT_CONFIRM_WINDOW_MS = 2 * 60 * 1000;

const PAUSED_FALLBACK =
  "Until then nothing is compressed or indexed, so near the context limit a fresh session " +
  "(/clear) or, while the conversation still fits, /compact (Claude Code's own) is the fallback.";

/**
 * The model's notice for a paused key (402): `detail` is the server's text.
 * None of it is quoted: its first line names the account's email, and this
 * text stays in the transcript (and MemTree's copy of it).
 */
export function pausedModelContext(detail: string, reason: string | null): string {
  return [
    `${PAUSED_PREFIX}${pausedReasonText(reason)}.`,
    "This is MemTree's own billing at polychat.co, not Claude, the user's Claude plan or " +
      "Anthropic credits; Claude works normally.",
    `Fix: ${reason === REASON_PLAN_LIMIT ? "upgrade" : "subscribe"} at ${modelSubscribeUrl(detail)}, ` +
      `or for credit questions email ${SUPPORT_EMAIL}.`,
    PAUSED_FALLBACK,
  ].filter(Boolean).join(" ");
}

/** The model's notice for a refused key (401/403). */
export function keyInvalidModelContext(keyPageUrl: string): string {
  return `${KEY_INVALID_PREFIX}the user's MemTree key was refused (revoked or mistyped); ` +
    `Claude itself is unaffected. Fix: get a new key at ${keyPageUrl} and run \`ccc\` in a ` +
    `terminal to paste it. ${PAUSED_FALLBACK}`;
}

export const PAUSED_KIND = "paused";
export const KEY_INVALID_KIND = "key-invalid";

/** A notice for the model; `kind` says whether it is news (PAUSED_KIND, KEY_INVALID_KIND). */
export type ModelNotice = { kind: string; text: string };

/** Per-session record of what the model was told, and of blocked /compacts. */
export class ModelContextNotices {
  private told = new Map<string, string>();
  private compactBlockedAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The notice to add to this session's prompt, given MemTree's current state
   * (undefined: working; null: not known yet, so no news), or undefined when
   * its kind has not changed since the session was last told: a refreshed
   * link alone is no news.
   */
  next(sessionId: string, current: ModelNotice | undefined | null): string | undefined {
    if (current === null) return undefined;
    const last = this.told.get(sessionId);
    if (current === undefined) {
      if (last === undefined) return undefined;
      this.told.delete(sessionId);
      return MEMTREE_ACTIVE_AGAIN_CONTEXT;
    }
    if (last === current.kind) return undefined;
    this.told.set(sessionId, current.kind);
    return current.text;
  }

  /**
   * A resumed session: what its transcript last told the model (a notice
   * from an earlier ccc process), so a later change is announced.
   */
  restore(sessionId: string, kind: string | undefined): void {
    if (kind === undefined) this.told.delete(sessionId);
    else this.told.set(sessionId, kind);
  }

  /** The session's transcript lost its notices (Claude Code compacted it). */
  forget(sessionId: string): void {
    this.told.delete(sessionId);
  }

  /**
   * The reason to block a manual /compact, or undefined to let it run: always
   * when MemTree is not compressing, and for a repeat within the window.
   */
  blockCompact(sessionId: string, memtreeWorking: boolean): string | undefined {
    if (!memtreeWorking) return undefined;
    const blockedAt = this.compactBlockedAt.get(sessionId);
    if (blockedAt !== undefined && this.now() - blockedAt < COMPACT_CONFIRM_WINDOW_MS) {
      this.compactBlockedAt.delete(sessionId);
      return undefined;
    }
    this.compactBlockedAt.set(sessionId, this.now());
    return COMPACT_BLOCKED_REASON;
  }
}

/**
 * The short checkout link, else the pricing page: the long `/payment?…` link
 * carries the user's email, and this text stays in the transcript.
 */
function modelSubscribeUrl(detail: string): string {
  return SHORT_PAYMENT_URL_RE.exec(detail)?.[0] ?? FALLBACK_SUBSCRIBE_URL;
}

/** Claude Code's marker in a transcript: what precedes it is no longer in the model's context. */
const COMPACT_BOUNDARY = '"compact_boundary"';

/**
 * The kind of the last notice in a transcript's live part (after its last
 * compaction), undefined when none or "working again".
 */
export function lastToldKind(transcript: string): string | undefined {
  return lastMarker(transcript)?.kind;
}

/**
 * lastToldKind of a transcript file, read backward from its end until the
 * last marker, so a long session's file is not read whole. Undefined when the
 * file is missing or unreadable, or after `budgetMs`. Never throws.
 */
export async function lastToldKindInFile(
  file: string,
  budgetMs = TRANSCRIPT_SCAN_MS,
  chunkBytes = SCAN_CHUNK_BYTES
): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const size = (await handle.stat()).size;
    for (let end = size; end > 0 && Date.now() < deadline;) {
      const start = Math.max(0, end - chunkBytes);
      const buffer = Buffer.alloc(Math.min(end + MARKER_OVERLAP_BYTES, size) - start);
      await handle.read(buffer, 0, buffer.length, start);
      // Markers are ASCII: latin1 keeps them intact wherever a chunk splits a character.
      const marker = lastMarker(buffer.toString("latin1"));
      if (marker !== undefined) return marker.kind;
      end = start;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The last marker in `text`: a notice's kind, or undefined for "working again" or a compaction. */
function lastMarker(text: string): { kind: string | undefined } | undefined {
  const markers: [string, string | undefined][] = [
    [PAUSED_PREFIX, PAUSED_KIND], [KEY_INVALID_PREFIX, KEY_INVALID_KIND],
    [ACTIVE_AGAIN_PREFIX, undefined], [COMPACT_BOUNDARY, undefined],
  ];
  let found: { at: number; kind: string | undefined } | undefined;
  for (const [marker, kind] of markers) {
    const at = text.lastIndexOf(marker);
    if (at >= 0 && (found === undefined || at > found.at)) found = { at, kind };
  }
  return found && { kind: found.kind };
}

function pausedReasonText(reason: string | null): string {
  if (reason === REASON_FREE_CREDIT_USED) return "the free MemTree credit is used up";
  if (reason === REASON_PLAN_LIMIT) return "the MemTree plan's usage limit is reached";
  return "MemTree usage limit reached";
}
