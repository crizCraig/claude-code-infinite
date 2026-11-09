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
 */
/** Seconds assumed when an indexing 413 says it is behind but not for how long. */
export declare const UNKNOWN_INDEX_WAIT_SECONDS = 60;
/** Seconds of indexing the server expects before this request fits; undefined: no wait. */
export declare function indexWaitFrom413(status: number, bodyText: string, retryAfter: string | null | undefined, now?: number): number | undefined;
/** A Retry-After header in seconds (delta-seconds or an HTTP date), if valid. */
export declare function retryAfterSeconds(value: string | null | undefined, now?: number): number | undefined;
//# sourceMappingURL=index-wait-413.d.ts.map