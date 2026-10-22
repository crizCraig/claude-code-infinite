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
/** A well-formed span (two parseable times), else undefined. */
export function timeSpan(value) {
    if (!Array.isArray(value) || value.length !== 2)
        return undefined;
    const [start, end] = value;
    if (typeof start !== "string" || typeof end !== "string")
        return undefined;
    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)))
        return undefined;
    return [start, end];
}
/** `block_times` (`{"3": [start, end]}`) as block -> span; malformed entries dropped. */
export function blockTimes(raw) {
    const out = new Map();
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return out;
    for (const [key, value] of Object.entries(raw)) {
        const span = timeSpan(value);
        if (/^\d+$/.test(key) && span)
            out.set(Number(key), span);
    }
    return out;
}
/** The span covering both. */
export function mergeSpans(a, b) {
    if (!a)
        return b;
    return [
        Date.parse(b[0]) < Date.parse(a[0]) ? b[0] : a[0],
        Date.parse(b[1]) > Date.parse(a[1]) ? b[1] : a[1],
    ];
}
/** This process's IANA zone, or "UTC" when it has none. */
export function localTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
    catch {
        return "UTC";
    }
}
/**
 * `2026-09-30 14:02–14:40 PT` (same day), `2026-09-30 23:50–2026-10-01 00:10 PT`,
 * `2026-09-30 14:02 PT` (same minute); undefined for an unknown or malformed span.
 */
export function formatTimeSpan(span, zone = localTimeZone()) {
    const valid = timeSpan(span);
    if (!valid)
        return undefined;
    const parts = zoneParts(zone);
    const start = parts.format(new Date(valid[0]));
    const end = parts.format(new Date(valid[1]));
    const label = parts.label(new Date(valid[0]));
    if (start === end)
        return `${start} ${label}`;
    if (start.slice(0, 10) === end.slice(0, 10))
        return `${start}–${end.slice(11)} ${label}`;
    return `${start}–${end} ${label}`;
}
/** One time (`2026-09-30 14:02 PT`), or undefined when it does not parse. */
export function formatTime(value, zone) {
    return value ? formatTimeSpan([value, value], zone) : undefined;
}
/** `[2026-09-30 14:02–14:40 PT]` with a leading space, or "" when unknown. */
export function bracketedSpan(span, zone) {
    const text = formatTimeSpan(span, zone);
    return text ? ` [${text}]` : "";
}
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Etc/Zulu"]);
function zoneParts(zone) {
    const resolved = UTC_ZONES.has(zone) ? "UTC" : zone;
    try {
        const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: resolved, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        });
        return {
            format: (date) => {
                const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
                return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
            },
            label: (date) => (resolved === "UTC" ? "UTC" : zoneLabel(resolved, date)),
        };
    }
    catch {
        return zoneParts("UTC"); // an unknown zone name: say UTC, labelled
    }
}
/** `PT`, `ET`, `MST`; else the offset form (`GMT+2`) where no short name exists. */
function zoneLabel(zone, date) {
    const name = (style) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style })
        .formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
    const generic = name("shortGeneric");
    if (/^[A-Z]{2,5}$/.test(generic))
        return generic;
    const short = name("short");
    return short === "GMT+0" ? "UTC" : short || "UTC";
}
//# sourceMappingURL=memtree-times.js.map