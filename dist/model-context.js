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
import { subscribeUrlFromDetail } from "./payment-notice.js";
import { REASON_FREE_CREDIT_USED, REASON_PLAN_LIMIT } from "./payment-link.js";
export const SUPPORT_EMAIL = "support@polychat.co";
/** Told once MemTree answers again after a paused or refused-key notice. */
export const MEMTREE_ACTIVE_AGAIN_CONTEXT = "ccc: MemTree is working again; compression is back on, so the earlier paused notice " +
    "and its /compact fallback no longer apply.";
/** The one line a blocked manual /compact shows (PreCompact hook reason). */
export const COMPACT_BLOCKED_REASON = "MemTree already keeps this session within its budget; /compact would discard detail. " +
    "Use /ccc:memtree-compact if you really want to compress now, or run /compact again " +
    "to use Claude Code's anyway.";
/** A second manual /compact within this long of a blocked one runs. */
export const COMPACT_CONFIRM_WINDOW_MS = 2 * 60 * 1000;
const PAUSED_FALLBACK = "Until then nothing is compressed or indexed, so near the context limit /compact " +
    "(Claude Code's own) or a fresh session is the fallback.";
/** The model's notice for a paused key (402): `detail` is the server's text. */
export function pausedModelContext(detail, reason) {
    const account = sanitizeNoticeDetail(detail.split(/[\r\n]/, 1)[0] ?? "", 160);
    return [
        `ccc: MemTree is paused: ${pausedReasonText(reason)}.`,
        account ? `(MemTree server: "${account}".)` : "",
        "This is MemTree's own billing at polychat.co, not Claude, the user's Claude plan or " +
            "Anthropic credits; Claude works normally.",
        `Fix: subscribe at ${subscribeUrlFromDetail(detail)}, or for credit questions email ` +
            `${SUPPORT_EMAIL}.`,
        PAUSED_FALLBACK,
    ].filter(Boolean).join(" ");
}
/** The model's notice for a refused key (401/403). */
export function keyInvalidModelContext(keyPageUrl) {
    return "ccc: MemTree is off: the user's MemTree key was refused (revoked or mistyped); " +
        `Claude itself is unaffected. Fix: get a new key at ${keyPageUrl} and run \`ccc\` in a ` +
        `terminal to paste it. ${PAUSED_FALLBACK}`;
}
/** Per-session record of what the model was told, and of blocked /compacts. */
export class ModelContextNotices {
    now;
    told = new Map();
    compactBlockedAt = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    /**
     * The notice to add to this session's prompt, given MemTree's current state
     * (undefined: working), or undefined when its kind has not changed since the
     * session was last told: a refreshed link alone is no news.
     */
    next(sessionId, current) {
        const last = this.told.get(sessionId);
        if (current === undefined) {
            if (last === undefined)
                return undefined;
            this.told.delete(sessionId);
            return MEMTREE_ACTIVE_AGAIN_CONTEXT;
        }
        if (last === current.kind)
            return undefined;
        this.told.set(sessionId, current.kind);
        return current.text;
    }
    /** The session's transcript lost its notices (Claude Code compacted it). */
    forget(sessionId) {
        this.told.delete(sessionId);
    }
    /**
     * The reason to block a manual /compact, or undefined to let it run: always
     * when MemTree is not compressing, and for a repeat within the window.
     */
    blockCompact(sessionId, memtreeWorking) {
        if (!memtreeWorking)
            return undefined;
        const blockedAt = this.compactBlockedAt.get(sessionId);
        if (blockedAt !== undefined && this.now() - blockedAt < COMPACT_CONFIRM_WINDOW_MS) {
            this.compactBlockedAt.delete(sessionId);
            return undefined;
        }
        this.compactBlockedAt.set(sessionId, this.now());
        return COMPACT_BLOCKED_REASON;
    }
}
function pausedReasonText(reason) {
    if (reason === REASON_FREE_CREDIT_USED)
        return "the free MemTree credit is used up";
    if (reason === REASON_PLAN_LIMIT)
        return "the MemTree plan's usage limit is reached";
    return "MemTree usage limit reached";
}
//# sourceMappingURL=model-context.js.map