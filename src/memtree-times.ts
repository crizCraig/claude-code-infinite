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

/** An ISO 8601 time with a zone (`Z` or an offset); anything else is not a time here. */
const ISO_TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;

/** A well-formed span (two ISO times with a zone), earliest first; else undefined. */
export function timeSpan(value: unknown): TimeSpan | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (!isIsoTime(start) || !isIsoTime(end)) return undefined;
  return Date.parse(start) <= Date.parse(end) ? [start, end] : [end, start];
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** `block_times` (`{"3": [start, end]}`) as block -> span; malformed entries dropped. */
export function blockTimes(raw: unknown): Map<number, TimeSpan> {
  const out = new Map<number, TimeSpan>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const span = timeSpan(value);
    if (/^\d+$/.test(key) && span) out.set(Number(key), span);
  }
  return out;
}

/** The span covering both. */
export function mergeSpans(a: TimeSpan | undefined, b: TimeSpan): TimeSpan {
  if (!a) return b;
  return [
    Date.parse(b[0]) < Date.parse(a[0]) ? b[0] : a[0],
    Date.parse(b[1]) > Date.parse(a[1]) ? b[1] : a[1],
  ];
}

let displayZone: string | undefined;

/**
 * Show times in ``zone`` instead of this process's (undefined: back to the
 * process's). For tests: Windows ICU ignores a TZ set at runtime.
 */
export function setDisplayTimeZone(zone: string | undefined): void {
  displayZone = zone;
}

/** The zone times are shown in: the override, else this process's, else "UTC". */
export function localTimeZone(): string {
  if (displayZone) return displayZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * `2026-09-30 14:02–14:40 PT` (same day), `2026-09-30 23:50–2026-10-01 00:10 PT`,
 * `2026-09-30 14:02 PT` (same minute); undefined for an unknown or malformed span.
 */
export function formatTimeSpan(span: unknown, zone: string = localTimeZone()): string | undefined {
  const valid = timeSpan(span);
  if (!valid) return undefined;
  const [from, to] = valid.map((t) => new Date(t));
  const parts = zoneParts(zone);
  const [start, end] = [parts.format(from), parts.format(to)];
  const [startLabel, endLabel] = [labelAt(parts, from), labelAt(parts, to)];
  // By instant, not by text: when clocks go back, an hour apart can read the same.
  if (Math.floor(from.getTime() / 60_000) === Math.floor(to.getTime() / 60_000)) {
    return `${start} ${startLabel}`;
  }
  if (startLabel !== endLabel) {
    const tail = start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end;
    return `${start} ${startLabel}–${tail} ${endLabel}`;
  }
  if (start.slice(0, 10) === end.slice(0, 10)) return `${start}–${end.slice(11)} ${endLabel}`;
  return `${start}–${end} ${endLabel}`;
}

const HOUR_MS = 3_600_000;

/**
 * The zone's name at ``date``: the generic one (`PT`), except within an hour of a
 * DST change, where the clock repeats or skips and only `PDT` / `PST` say which.
 */
function labelAt(parts: ZoneFormat, date: Date): string {
  const offset = parts.offsetLabel(date);
  const near = [date.getTime() - HOUR_MS, date.getTime() + HOUR_MS]
    .some((t) => parts.offsetLabel(new Date(t)) !== offset);
  return near ? offset : parts.label(date);
}

/** One time (`2026-09-30 14:02 PT`), or undefined when it does not parse. */
export function formatTime(value: string | null | undefined, zone?: string): string | undefined {
  return value ? formatTimeSpan([value, value], zone) : undefined;
}

/** `[2026-09-30 14:02–14:40 PT]` with a leading space, or "" when unknown. */
export function bracketedSpan(span: unknown, zone?: string): string {
  const text = formatTimeSpan(span, zone);
  return text ? ` [${text}]` : "";
}

interface ZoneFormat {
  format(date: Date): string;
  label(date: Date): string;
  /** The name that differs across a DST change (`PDT`, `GMT+2`). */
  offsetLabel(date: Date): string;
}

const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Etc/Zulu"]);
/** Formatters per zone: a read_node with many children formats many spans. */
const ZONE_FORMATS = new Map<string, ZoneFormat>();

function zoneParts(zone: string): ZoneFormat {
  const resolved = UTC_ZONES.has(zone) ? "UTC" : zone;
  let format = ZONE_FORMATS.get(resolved);
  if (!format) {
    format = buildZoneFormat(resolved);
    if (ZONE_FORMATS.size > 16) ZONE_FORMATS.clear();
    ZONE_FORMATS.set(resolved, format);
  }
  return format;
}

function buildZoneFormat(zone: string): ZoneFormat {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch {
    return zoneParts("UTC"); // an unknown zone name: say UTC, labelled
  }
  const names = zone === "UTC" ? undefined : zoneNames(zone);
  return {
    format: (date) => {
      const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    },
    label: (date) => (names ? zoneLabel(names, date) : "UTC"),
    offsetLabel: (date) => (names ? zoneLabel({ short: names.short }, date) : "UTC"),
  };
}

type ZoneNames = Partial<Record<"shortGeneric" | "short", Intl.DateTimeFormat>>;

/** The zone's name formatters; a style this ICU build lacks is left out. */
function zoneNames(zone: string): ZoneNames {
  const names: ZoneNames = {};
  for (const style of ["shortGeneric", "short"] as const) {
    try {
      names[style] = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style });
    } catch {
      // older ICU: no shortGeneric
    }
  }
  return names;
}

/** `PT`, `ET`, `MST`; else the offset form (`GMT+2`) where no short name exists. */
function zoneLabel(names: ZoneNames, date: Date): string {
  const name = (fmt?: Intl.DateTimeFormat) =>
    fmt?.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  const generic = name(names.shortGeneric);
  if (/^[A-Z]{2,5}$/.test(generic)) return generic;
  const short = name(names.short);
  return short === "GMT+0" || !short ? "UTC" : short;
}
