/**
 * Why ccc refused a turn, said in one line: what is happening and what to do.
 *
 * The final refusal used to be one generic sentence ("couldn't fit this request ... if
 * MemTree is still indexing, wait a minute and retry; otherwise /ccc:memtree-compact or
 * /clear") whatever the cause. The request log already knows the cause (requests.jsonl
 * `compaction.reason`, `compress`, `refusal.indexBehind`), and the causes want different
 * actions (Craig, 2026-11-12, after a night of refusals that were slow uploads, not
 * indexing):
 *
 * - indexing: MemTree's index trails the conversation; say how long it should take;
 * - upload-timeout: the compress call ran out of time on a large body (a slow link);
 * - rebuilding: Claude Code resent earlier messages changed (prefix mismatch), so the
 *   stored compressed start no longer applies and MemTree must compress afresh;
 * - compress-failed: MemTree answered with an error;
 * - over-budget: everything worked and it still does not fit (today's advice).
 */
import { MEMTREE_COMPACT_COMMAND, MEMTREE_VIEW_COMMAND, SESSION_PLUGIN_NAME } from "./hooks.js";

/**
 * Indexing rate assumed when the server gave no estimate: about what we tell partners
 * (polychat reports/2026-11-11_partner_traffic_sim.md, "Indexing (~40k tokens a minute)").
 * The server's own default is faster (index_rates.py: 12 min per 1M own-work tokens, ~83k a
 * minute); the slower figure keeps a client-side guess from promising too little.
 */
export const INDEX_TOKENS_PER_MINUTE = 40_000;

export type RefusalCause =
  | { kind: "indexing"; secondsLeft?: number; unindexedTokens?: number }
  | { kind: "upload-timeout"; bytes: number; ms: number; nextBudgetMs?: number }
  | { kind: "slow-answer"; ms: number }
  | { kind: "rebuilding"; secondsLeft?: number }
  | { kind: "compress-failed"; status?: number }
  | { kind: "over-budget"; inputTokens: number; contextTokens: number };

/** The parts of a request's log record (reqlog MessagesRecord) a refusal is judged by. */
export interface RefusalEvidence {
  compaction?: { reason?: string };
  compress?: {
    ok: boolean; timedOut: boolean; ms: number; refused?: true; status?: number;
    /** A large upload that spent its whole long budget (slow-upload.ts), not just slow. */
    uploadTimeout?: true;
  };
  indexBehind?: true;
  /** The compress answer's index lag: the server's memory ETA and the un-indexed tokens. */
  indexLag?: { etaSeconds?: number; unindexedTokens?: number };
  requestBytes?: number;
}

export interface RefusalFacts {
  inputTokens: number;
  modelContextLimit: number;
  /** Seconds of indexing MemTree last said were left (an indexing 413), if any. */
  indexSecondsLeft?: number;
  /** The budget the next compress of this session gets after an upload timeout. */
  nextCompressBudgetMs?: number;
}

/** Which cause explains this refusal (first match wins). */
export function refusalCause(rec: RefusalEvidence, facts: RefusalFacts): RefusalCause {
  // The caller's stated time left (an indexing 413's, never its 60 s stand-in), else this
  // request's own compress answer. Not rec.indexWait: it holds the stand-in too.
  const serverSeconds = facts.indexSecondsLeft ?? rec.indexLag?.etaSeconds;
  if (rec.indexBehind) {
    return { kind: "indexing", ...defined({ secondsLeft: serverSeconds,
      unindexedTokens: rec.indexLag?.unindexedTokens }) };
  }
  const compress = rec.compress;
  if (compress?.timedOut && compress.uploadTimeout) {
    return { kind: "upload-timeout", bytes: rec.requestBytes ?? 0, ms: compress.ms,
      ...defined({ nextBudgetMs: facts.nextCompressBudgetMs }) };
  }
  // Small, short-budget or cut short by a hold: MemTree was slow, not the upload.
  if (compress?.timedOut) return { kind: "slow-answer", ms: compress.ms };
  const failed = compress !== undefined && !compress.ok && !compress.refused;
  if (failed && rec.compaction?.reason === "prefix-mismatch") {
    // Only this request's own answer: a lane's index wait may be long over.
    return { kind: "rebuilding", ...defined({ secondsLeft: rec.indexLag?.etaSeconds }) };
  }
  if (failed) return { kind: "compress-failed", ...defined({ status: compress.status }) };
  return { kind: "over-budget", inputTokens: facts.inputTokens,
    contextTokens: facts.modelContextLimit };
}

/** The refusal's one line, ending with where the session's MemTree page is. */
export function refusalMessage(cause: RefusalCause, sessionLink?: string): string {
  const where = sessionLink ? ` Session: ${sessionLink}`
    : ` Session link: /${SESSION_PLUGIN_NAME}:${MEMTREE_VIEW_COMMAND}.`;
  return `${causeText(cause)}${where}`;
}

const COMPACT_OR_CLEAR = `/${SESSION_PLUGIN_NAME}:${MEMTREE_COMPACT_COMMAND} or /clear`;

function causeText(cause: RefusalCause): string {
  switch (cause.kind) {
    case "indexing": return indexingText(cause.secondsLeft, cause.unindexedTokens);
    case "upload-timeout": return uploadTimeoutText(cause);
    case "slow-answer":
      return `MemTree didn't answer within ${secondsText(cause.ms)}. Retry in a minute; if it ` +
        `keeps happening, run ${COMPACT_OR_CLEAR}.`;
    case "rebuilding": return rebuildingText(cause.secondsLeft);
    case "compress-failed":
      return `MemTree couldn't compress this turn${cause.status ? ` (HTTP ${cause.status})` : ""}. ` +
        `Retry in a minute; if it keeps failing, run ${COMPACT_OR_CLEAR}.`;
    case "over-budget":
      return `MemTree couldn't fit this request (~${tokensText(cause.inputTokens)} tokens) in ` +
        `the model's ${tokensText(cause.contextTokens)}-token context window. ` +
        `Run ${COMPACT_OR_CLEAR}.`;
  }
}

/** "MemTree is still indexing ~1.2M new tokens (~3 min). Retry then." */
function indexingText(secondsLeft: number | undefined, unindexedTokens: number | undefined): string {
  const seconds = secondsLeft ?? (unindexedTokens !== undefined && unindexedTokens > 0
    ? (unindexedTokens / INDEX_TOKENS_PER_MINUTE) * 60 : undefined);
  const what = unindexedTokens !== undefined && unindexedTokens > 0
    ? `~${tokensText(unindexedTokens)} new tokens` : "this session's newest messages";
  return seconds === undefined
    ? `MemTree is still indexing ${what}. Retry in a few minutes.`
    : `MemTree is still indexing ${what} (~${durationText(seconds)}). Retry then.`;
}

/** "MemTree timed out after 139 s on this 51 MB request (likely a slow upload). ..." */
function uploadTimeoutText(cause: { bytes: number; ms: number; nextBudgetMs?: number }): string {
  const size = cause.bytes > 0 ? ` on this ${megabytesText(cause.bytes)} request` : "";
  // Only a clearly longer wait is worth naming (this try may already have had it).
  const next = cause.nextBudgetMs !== undefined && cause.nextBudgetMs > cause.ms * 1.2
    ? `Retry: the next try waits up to ${secondsText(cause.nextBudgetMs)}. `
    : "Retry, ideally on a faster connection. ";
  return `MemTree timed out after ${secondsText(cause.ms)}${size} (likely a slow upload). ${next}` +
    "CCC_COMPRESS_TIMEOUT_MS (ms) raises the base wait.";
}

function rebuildingText(secondsLeft: number | undefined): string {
  const when = secondsLeft === undefined ? "Retry in a minute."
    : `(~${durationText(secondsLeft)}). Retry then.`;
  return "MemTree is rebuilding this session's compressed history (Claude Code resent " +
    `earlier messages changed)${secondsLeft === undefined ? "." : ""} ${when}`;
}

/** "1.2M", "480k", "900": rounded for a one-line message. */
export function tokensText(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimZero((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.max(0, Math.round(tokens)));
}

/** "3 min", "1.5 h": minutes rounded up, hours from two on. */
export function durationText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 120) return `${minutes} min`;
  return `${trimZero((minutes / 60).toFixed(1))} h`;
}

function secondsText(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

function megabytesText(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, "");
}

/** `fields` without its undefined values (records stay free of `key: undefined`). */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
