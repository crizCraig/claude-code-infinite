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

import { sanitizeNoticeDetail } from "./notices.js";
import { FALLBACK_SUBSCRIBE_URL, SHORT_PAYMENT_URL_RE } from "./payment-gate.js";
import { REASON_FREE_CREDIT_USED, REASON_PLAN_LIMIT } from "./payment-link.js";

export const SUPPORT_EMAIL = "support@polychat.co";
const PAUSED_PREFIX = "ccc: MemTree is paused: ";
const KEY_INVALID_PREFIX = "ccc: MemTree is off: ";
const ACTIVE_AGAIN_PREFIX = "ccc: MemTree is working again";
/** Larger transcripts are not searched on resume (a whole read; never on the turn path). */
export const TRANSCRIPT_SCAN_MAX_BYTES = 256 * 1024 * 1024;
/** Told once MemTree answers again after a paused or refused-key notice. */
export const MEMTREE_ACTIVE_AGAIN_CONTEXT =
  `${ACTIVE_AGAIN_PREFIX}; compression is back on, so the earlier paused notice ` +
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

/** The model's notice for a paused key (402): `detail` is the server's text. */
export function pausedModelContext(detail: string, reason: string | null): string {
  const account = sanitizeNoticeDetail(detail.split(/[\r\n]/, 1)[0] ?? "", 160);
  return [
    `${PAUSED_PREFIX}${pausedReasonText(reason)}.`,
    account ? `(MemTree server: "${account}".)` : "",
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
  restore(sessionId: string, transcript: string): void {
    const kind = lastToldKind(transcript);
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
export function lastToldKind(fullTranscript: string): string | undefined {
  const boundary = fullTranscript.lastIndexOf(COMPACT_BOUNDARY);
  const transcript = boundary < 0 ? fullTranscript : fullTranscript.slice(boundary);
  const last = Math.max(
    transcript.lastIndexOf(PAUSED_PREFIX),
    transcript.lastIndexOf(KEY_INVALID_PREFIX),
    transcript.lastIndexOf(ACTIVE_AGAIN_PREFIX)
  );
  if (last < 0) return undefined;
  if (transcript.startsWith(PAUSED_PREFIX, last)) return PAUSED_KIND;
  if (transcript.startsWith(KEY_INVALID_PREFIX, last)) return KEY_INVALID_KIND;
  return undefined;
}

function pausedReasonText(reason: string | null): string {
  if (reason === REASON_FREE_CREDIT_USED) return "the free MemTree credit is used up";
  if (reason === REASON_PLAN_LIMIT) return "the MemTree plan's usage limit is reached";
  return "MemTree usage limit reached";
}
