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
/** A well-formed span (two ISO times with a zone), earliest first; else undefined. */
export declare function timeSpan(value: unknown): TimeSpan | undefined;
/** `block_times` (`{"3": [start, end]}`) as block -> span; malformed entries dropped. */
export declare function blockTimes(raw: unknown): Map<number, TimeSpan>;
/** The span covering both. */
export declare function mergeSpans(a: TimeSpan | undefined, b: TimeSpan): TimeSpan;
/**
 * Show times in ``zone`` instead of this process's (undefined: back to the
 * process's). For tests: Windows ICU ignores a TZ set at runtime.
 */
export declare function setDisplayTimeZone(zone: string | undefined): void;
/** The zone times are shown in: the override, else this process's, else "UTC". */
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
/**
 * One block's messages: `[first line, UTC ISO time or undefined]`, lines ascending
 * (the page's `line_times`, polychat memtree_line_lookup.py). A line's time is its
 * message's: the last entry at or before it.
 */
export type LineEntry = [number, string | undefined];
/** `line_times` (`{"3": [[1, iso], [7, null]]}`) as block -> entries; malformed blocks dropped. */
export declare function lineTimes(raw: unknown): Map<number, LineEntry[]>;
/** The time of the message `line` belongs to; undefined when unknown. */
export declare function timeAt(entries: LineEntry[] | undefined, line: number): string | undefined;
/** The entries in effect over lines `start..end`: the one `start` falls in, then each starting inside. */
export declare function entriesIn(entries: LineEntry[] | undefined, start: number, end: number): LineEntry[];
/** `[earliest, latest]` of the messages lines `start..end` belong to; undefined when none is known. */
export declare function linesSpan(entries: LineEntry[] | undefined, start: number, end: number): TimeSpan | undefined;
/**
 * Compact times for one result, in the zone its header names: the date and time the
 * first time and whenever the date changes (`2026-10-16 08:38`), else the time only
 * (`08:38`). One instance per tool output.
 */
export declare class ClockFormat {
    private readonly zone;
    private lastDate?;
    constructor(zone?: string);
    format(value: string | undefined): string | undefined;
}
/** Said once per result where a time would be, instead of silence. */
export declare const TIME_NOT_RECORDED = "time not recorded";
/** Hands out TIME_NOT_RECORDED once per tool output. */
export declare class MissingTimeNote {
    private said;
    /** The note the first time a time is missing, then "". */
    next(): string;
}
//# sourceMappingURL=memtree-times.d.ts.map