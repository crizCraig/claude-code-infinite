/**
 * Whether MemTree's 413 to a compress call means "the index is still catching up on this
 * conversation" (waiting fixes it) rather than "this request cannot fit" (it never will),
 * and how long the server expects indexing to take.
 *
 * Today's server (polychat index_eta.py, 2026-11-02 on) answers an indexing 413 with
 * `{"detail": "Memory for this conversation is being compressed in the background ...
 * Estimated indexing time left: about 4 minutes. ..."}` and `Retry-After: 240` (30 s to
 * 1 h). Its 413s that waiting cannot fix (the newest message alone over the window, too
 * many unindexed tokens) carry no Retry-After. An explicit `index_pending` (or
 * `index_behind`) boolean in the body, top level or in `detail`, decides when present.
 * Older servers sent the background-compression text with a range ("5 to 9.9 hours").
 * Since polychat 53459dbd every over-context 413 also says `X-Polychat-Index-Pending`:
 * `true` when a live index job will cover what did not fit (then this is a wait, whatever
 * else the answer says); `false` or absent decides nothing (a newest message too large
 * says false while the server may still shrink it), and the rules above apply.
 * Retry-After can be far too low (an incident's said 30 s; the job took ~14 min), so a
 * wait goes on while MemTree keeps saying so (route-fallback.ts extends it).
 */

/** The background-indexing sentence every indexing 413 starts with (polychat constants). */
const INDEXING_TEXT = "being compressed in the background";
/** Seconds assumed when an indexing 413 says it is behind but not for how long. */
export const UNKNOWN_INDEX_WAIT_SECONDS = 60;

/** Seconds of indexing the server expects before this request fits; undefined: no wait. */
export function indexWaitFrom413(
  status: number, bodyText: string, retryAfter: string | null | undefined, now = Date.now(),
  indexPendingHeader?: string | null
): number | undefined {
  if (status !== 413) return undefined;
  const fields = bodyFields(bodyText);
  const flag = indexPendingHeader?.trim().toLowerCase() === "true" ? true
    : explicitFlag(fields);
  if (flag === false) return undefined;
  const headerSeconds = retryAfterSeconds(retryAfter, now);
  const detail = detailText(fields, bodyText);
  if (flag !== true && headerSeconds === undefined && !detail.includes(INDEXING_TEXT)) {
    return undefined;
  }
  return headerSeconds ?? bodySeconds(fields) ?? textSeconds(detail) ??
    UNKNOWN_INDEX_WAIT_SECONDS;
}

/** A Retry-After header in seconds (delta-seconds or an HTTP date), if valid. */
export function retryAfterSeconds(
  value: string | null | undefined, now = Date.now()
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return positive(Number(text));
  const at = Date.parse(text);
  return Number.isFinite(at) ? positive(Math.ceil((at - now) / 1000)) : undefined;
}

/** The body's top-level object and its `detail` object, when they are objects. */
function bodyFields(bodyText: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  return isObject(parsed.detail) ? [parsed, parsed.detail] : [parsed];
}

function explicitFlag(fields: Record<string, unknown>[]): boolean | undefined {
  for (const field of fields) {
    for (const key of ["index_pending", "index_behind"]) {
      if (typeof field[key] === "boolean") return field[key] as boolean;
    }
  }
  return undefined;
}

function bodySeconds(fields: Record<string, unknown>[]): number | undefined {
  for (const field of fields) {
    for (const key of ["retry_after_seconds", "index_seconds_left", "seconds_left"]) {
      const value = field[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

function detailText(fields: Record<string, unknown>[], bodyText: string): string {
  for (const field of fields) {
    for (const key of ["detail", "message"]) {
      if (typeof field[key] === "string") return field[key] as string;
    }
  }
  return fields.length ? "" : bodyText;
}

const UNIT_SECONDS: Record<string, number> = { second: 1, minute: 60, hour: 3600 };

/**
 * The time in an indexing 413's text: "about 4 minutes", "about 1.5 hours", "< 1 minute",
 * or an older server's range ("5 to 9.9 hours": its upper end).
 */
function textSeconds(text: string): number | undefined {
  if (/<\s*1 minute/.test(text)) return 60;
  const range = /(\d+(?:\.\d+)?)\s*(second|minute|hour)?s?\s+to\s+(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/
    .exec(text);
  if (range) return Number(range[3]) * UNIT_SECONDS[range[4]];
  const about = /about\s+(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/.exec(text);
  return about ? Number(about[1]) * UNIT_SECONDS[about[2]] : undefined;
}

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
