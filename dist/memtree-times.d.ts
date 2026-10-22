/**
 * When MemTree messages were written, as the MCP tools show it to the model.
 *
 * Trees record each input block's `[earliest, latest]` message time (UTC ISO;
 * the page JSON's `block_times`, polychat memtree_node_times.py). A leaf's time
 * is its block's; a branch's spans its leaves'. Shown compactly in the user's
 * local time zone (the system's, as this process sees it; UTC when it has none):
 * `2026-09-30 14:02–14:40 PT`, one date when both ends share it. Trees from
 * before times were recorded have none, and nothing is shown for them.
 */
/** `[earliest, latest]` UTC ISO times. */
export type TimeSpan = [string, string];
/** A well-formed span (two parseable times), else undefined. */
export declare function timeSpan(value: unknown): TimeSpan | undefined;
/** `block_times` (`{"3": [start, end]}`) as block -> span; malformed entries dropped. */
export declare function blockTimes(raw: unknown): Map<number, TimeSpan>;
/** The span covering both. */
export declare function mergeSpans(a: TimeSpan | undefined, b: TimeSpan): TimeSpan;
/** This process's IANA zone, or "UTC" when it has none. */
export declare function localTimeZone(): string;
/**
 * `2026-09-30 14:02–14:40 PT` (same day), `2026-09-30 23:50–2026-10-01 00:10 PT`,
 * `2026-09-30 14:02 PT` (same minute); undefined for an unknown or malformed span.
 */
export declare function formatTimeSpan(span: unknown, zone?: string): string | undefined;
/** One time (`2026-09-30 14:02 PT`), or undefined when it does not parse. */
export declare function formatTime(value: string | null | undefined, zone?: string): string | undefined;
/** `[2026-09-30 14:02–14:40 PT]` with a leading space, or "" when unknown. */
export declare function bracketedSpan(span: unknown, zone?: string): string;
//# sourceMappingURL=memtree-times.d.ts.map