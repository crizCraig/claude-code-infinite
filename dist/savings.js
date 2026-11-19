/** Plain Claude's structural conversation cursor contains no prompt content. */
import { createHash } from 'node:crypto';
import { DEFAULT_CACHE_TTL_MS, LONG_CACHE_TTL_MS } from './cold-cache.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSavingsSessionId(value) {
    return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
const MAX_TOKENS = 1_000_000_000;
const MAX_LANES = 32;
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKENS;
export const savingsLaneKey = (s) => createHash('sha256').update(s).digest('hex');
const totalInput = (v) => v.input + v.cache_read + v.cache_creation_5m + v.cache_creation_1h;
export function isSavingsState(value) {
    if (!record(value) || !record(value.lanes) ||
        (value.evicted !== undefined && typeof value.evicted !== 'boolean') ||
        (value.unknownHistory !== undefined && typeof value.unknownHistory !== 'boolean'))
        return false;
    const lanes = Object.entries(value.lanes);
    return lanes.length <= MAX_LANES && lanes.every(([key, lane]) => /^[a-f0-9]{64}$/.test(key) && record(lane) && count(lane.messages) && count(lane.sequence) &&
        Number.isSafeInteger(lane.at) && lane.at >= 0 && count(lane.minRemoved) &&
        (lane.writer === undefined || typeof lane.writer === 'string') &&
        count(lane.maxRemoved) && lane.minRemoved <= lane.maxRemoved &&
        (lane.total === null || count(lane.total)) && Array.isArray(lane.durations) &&
        lane.durations.every((r) => record(r) && [0, DEFAULT_CACHE_TTL_MS, LONG_CACHE_TTL_MS].includes(r.ttl)
            && (r.end === null || count(r.end))));
}
/** Cache creation total includes its duration buckets; never count it twice. */
export function normalizeSavingsUsage(value) {
    if (!record(value) || !count(value.input_tokens) || !count(value.output_tokens))
        return;
    const read = value.cache_read_input_tokens ?? 0;
    if (!count(read))
        return;
    const split = value.cache_creation;
    if (split != null && !record(split))
        return;
    const measuredSplit = count(split?.ephemeral_5m_input_tokens) && count(split?.ephemeral_1h_input_tokens);
    if (value.cache_creation_input_tokens == null && split != null && !measuredSplit)
        return;
    const creation = value.cache_creation_input_tokens ??
        ((split?.ephemeral_5m_input_tokens ?? 0) + (split?.ephemeral_1h_input_tokens ?? 0));
    if (!count(creation))
        return;
    const five = split == null ? creation : split.ephemeral_5m_input_tokens ?? 0;
    const hour = split?.ephemeral_1h_input_tokens ?? 0;
    if (!count(five) || !count(hour) || five + hour !== creation)
        return;
    if (value.input_tokens + read + creation > MAX_TOKENS)
        return;
    return { input: value.input_tokens, cache_read: read, cache_creation_5m: five, cache_creation_1h: hour, output: value.output_tokens };
}
export function createSavingsState() {
    return { lanes: {} };
}
const cacheTtl = (value) => record(value) && value.type === 'ephemeral'
    ? value.ttl === '1h' ? LONG_CACHE_TTL_MS : value.ttl === undefined || value.ttl === '5m' ? DEFAULT_CACHE_TTL_MS : undefined : undefined;
function minimumCacheTokens(model) {
    model = model.toLowerCase();
    if (/^claude-(?:opus-4[-.]([56])|haiku-4[-.]5)(?:-|$)/.test(model))
        return 4096;
    if (/^claude-opus-4[-.]7(?:-|$)/.test(model))
        return 2048;
    if (/^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:[-.]|$)/.test(model) && !/^claude-sonnet-5(?:[-.]0)?(?:-\d{8}|-latest)?$/.test(model))
        return 512;
    return 1024;
}
// OpenAI-style role messages can carry the same frame as a top-level system
// prompt. They travel with every prefix count, wherever the client put them.
const framing = (message) => message?.role === 'system' || message?.role === 'developer';
export function savingsRetainedRequest(request, retained) {
    let position = 0;
    return { ...request, messages: request.messages.filter((m) => framing(m) || position++ < retained) };
}
// Only positional markers and measured token boundaries participate in price.
function durationRanges(request, total, passthrough) {
    const markers = [];
    let position = 0, lastEligible = 0;
    const block = (v) => {
        ++position;
        if (v === '' || v?.type === 'text' && v.text === '' || ['thinking', 'redacted_thinking'].includes(v?.type))
            return;
        lastEligible = position;
        const ttl = cacheTtl(v?.cache_control);
        if (ttl)
            markers.push({ position, ttl });
    };
    for (const tool of request.tools ?? [])
        block(tool);
    const content = (v) => Array.isArray(v) ? v.forEach(block) : block(v);
    if (request.system)
        content(request.system);
    for (const message of request.messages ?? [])
        content(message?.content);
    const ttl = cacheTtl(request.cache_control);
    if (ttl && lastEligible && lastEligible !== markers.at(-1)?.position)
        markers.push({ position: lastEligible, ttl });
    const hourMarkers = markers.filter(m => m.ttl === LONG_CACHE_TTL_MS).length;
    const ranges = [];
    for (const marker of markers) {
        let end = marker.position === position ? total : null;
        if (end === null && passthrough && marker.ttl === LONG_CACHE_TTL_MS && hourMarkers === 1 &&
            passthrough.cache_creation_1h > 0)
            end = passthrough.cache_read + passthrough.cache_creation_1h;
        if (end === null && passthrough && markers.length === 1 && passthrough.cache_creation_5m > 0)
            end = total - passthrough.input;
        if (ranges.at(-1)?.ttl === marker.ttl)
            ranges.pop();
        ranges.push({ ttl: marker.ttl, end });
    }
    if (!markers.length || markers.at(-1).position < position)
        ranges.push({ ttl: 0, end: total });
    return ranges;
}
function gapDiagnostics(prior, read, now, unknown) {
    const missing = { floor_read_possibly_uncached_tokens: null, floor_read_max_gap_seconds: null };
    if (!read)
        return { floor_read_possibly_uncached_tokens: 0, floor_read_max_gap_seconds: 0 };
    if (unknown || !prior || now < prior.at || !prior.durations.length)
        return missing;
    const gap = now - prior.at;
    const stale = prior.durations.map(r => gap > r.ttl);
    if (stale.every(Boolean))
        return { floor_read_possibly_uncached_tokens: read, floor_read_max_gap_seconds: Math.floor(gap / 1000) };
    let expired = 0;
    let start = 0;
    let any = false;
    for (const [i, r] of prior.durations.entries()) {
        const end = i === stale.length - 1 ? read : r.end;
        if (stale[i] && (start === null || start < read)) {
            any = true;
            expired = end === null || start === null || expired === null ? null :
                expired + Math.max(0, Math.min(read, end) - start);
        }
        start = end;
    }
    return { floor_read_possibly_uncached_tokens: expired, floor_read_max_gap_seconds: any ? Math.floor(gap / 1000) : 0 };
}
/** Monotone bounds on removal, including the discontinuity at compaction.
 * A lost count may hide a crossing. Following measured turns can use the
 * shortest possible prompt at the read rate until the two cursors converge. */
function compact(prior, original, ceiling, gap) {
    const low = gap ? 0 : prior?.minRemoved ?? 0;
    const high = gap ? MAX_TOKENS : prior?.maxRemoved ?? 0;
    if (original === null)
        return { minRemoved: 0, maxRemoved: MAX_TOKENS, total: null, compacted: false };
    const shortest = Math.max(0, original - high), longest = Math.max(0, original - low);
    const retained = Math.min(1024, Math.floor(ceiling * .1)) + Math.floor(ceiling * .1);
    if (shortest > ceiling)
        return { minRemoved: original - retained, maxRemoved: original - retained, total: retained, compacted: true };
    const max = Math.min(longest, ceiling);
    const min = longest > ceiling ? Math.min(shortest, retained) : shortest;
    return { minRemoved: original - max, maxRemoved: original - min, total: min, compacted: false };
}
export function refineSavingsState(current, settled, dispatched) {
    const lanes = { ...current.lanes };
    for (const [key, lane] of Object.entries(settled.lanes)) {
        if (lanes[key]?.sequence === dispatched.lanes[key]?.sequence &&
            lanes[key]?.writer === dispatched.lanes[key]?.writer)
            lanes[key] = lane;
    }
    return { ...current, lanes };
}
function contextCeiling(window, requestedReserve) {
    const reserve = count(requestedReserve) ? requestedReserve : Math.min(32_000, Math.floor(window * .2));
    return Math.max(1, Math.floor(Math.min(window * .8, window - Math.min(window - 1, reserve))));
}
/** Price fresh input only through measured, cache-eligible boundaries.
 * The unchanged upstream request can provide an even cheaper measured price. */
function priceInput(total, read, durations, model, output, identical) {
    let cached = 0, hour = 0;
    const minimum = minimumCacheTokens(model);
    for (const range of durations) {
        if (!range.ttl || range.end === null || range.end < minimum)
            continue;
        cached = Math.max(cached, range.end);
        if (range.ttl === LONG_CACHE_TTL_MS)
            hour = Math.max(hour, range.end);
    }
    if (identical) {
        read = Math.max(read, identical.cache_read);
        cached = Math.min(cached, total - identical.input);
        hour = Math.min(hour, identical.cache_read + identical.cache_creation_1h);
    }
    hour = Math.max(read, hour);
    cached = Math.max(hour, cached);
    return { input: total - cached, cache_read: read, cache_creation_5m: cached - hour,
        cache_creation_1h: hour - read, output };
}
export function accountSavingsTurn(previous, input) {
    const request = record(input.request) ? input.request : {};
    const messages = Array.isArray(request.messages) ? request.messages.filter(m => !framing(m)) : [];
    const model = input.model ?? request.model ?? '';
    const actual = normalizeSavingsUsage(input.usage);
    const identical = input.requestModified ? undefined : actual;
    const original = identical ? totalInput(identical) : count(input.originalInputTokens) ? input.originalInputTokens : null;
    const key = savingsLaneKey(input.laneKey ?? 'main');
    const prior = previous.lanes[key];
    const window = count(input.contextWindow) && input.contextWindow > 0 ? input.contextWindow : 200_000;
    const ceiling = contextCeiling(window, input.outputReserve ?? request.max_tokens);
    const now = input.nowMs ?? Date.now();
    const assistant = messages.findLastIndex(m => m?.role === 'assistant');
    const gap = assistant > (prior?.messages ?? 0) || (!prior && (assistant >= 0 || input.possiblyResumed));
    const unknown = !!(previous.unknownHistory || !prior && previous.evicted || gap || prior && (prior.at > now || prior.writer !== input.writer));
    const cursor = compact(prior, original, ceiling, unknown);
    const total = cursor.total;
    const continuation = !!prior || unknown;
    const boundary = Math.min(messages.length, prior?.messages ?? Math.max(0, assistant));
    let read = 0;
    if (!cursor.compacted && continuation && total !== null) {
        const measured = input.prefixCount;
        if (cursor.minRemoved !== cursor.maxRemoved || previous.unknownHistory || boundary === messages.length ||
            (!prior && !boundary))
            read = total;
        else if (measured?.messages === boundary && count(measured.tokens) && measured.tokens <= original)
            read = Math.max(0, measured.tokens - cursor.maxRemoved);
        else
            read = null;
    }
    const durations = total === null ? [] : durationRanges(request, total, cursor.maxRemoved ? undefined : identical);
    // An unobserved dispatch could be an identical retry or could already have
    // compacted. Its UTC day has no publishable input count. For subsequent
    // measured turns, the lower endpoint at the read rate bounds every cursor.
    const ambiguous = cursor.minRemoved !== cursor.maxRemoved;
    const plain = total === null || read === null || unknown && ambiguous ? null :
        priceInput(total, read, durations, model, actual?.output ?? 0, cursor.maxRemoved ? undefined : identical);
    // Reuse a measured duration split for timing diagnostics only. Its boundaries
    // never determine reads, writes or compaction on a later request.
    if (!unknown && prior?.total === total && prior.messages === messages.length &&
        prior.durations.length === durations.length && durations.every((r, i) => r.ttl === prior.durations[i].ttl))
        durations.forEach((r, i) => { r.end ??= prior.durations[i].end; });
    const lanes = { ...previous.lanes };
    let evicted = previous.evicted;
    if (!prior && Object.keys(lanes).length >= MAX_LANES) {
        delete lanes[Object.keys(lanes)[0]];
        evicted = true;
    }
    lanes[key] = { sequence: (prior?.sequence ?? 0) + 1, messages: messages.length, at: now,
        minRemoved: cursor.minRemoved, maxRemoved: cursor.maxRemoved, writer: input.writer, total, durations };
    if (prior && prior.at > now) {
        // The later send is still the structural predecessor. Its compaction
        // decision may have depended on this previously unregistered request.
        lanes[key] = { ...prior, sequence: prior.sequence + 1, minRemoved: 0, maxRemoved: MAX_TOKENS,
            total: null, durations: [] };
    }
    const diagnostics = gapDiagnostics(prior, plain?.cache_read ?? 0, now, unknown);
    return { state: { lanes, ...(evicted && { evicted }) }, turn: {
            ...(read === null && !unknown && { prefix_messages_to_count: boundary }),
            original_input_tokens: original, plain_input_tokens: total, input_source: identical ? 'actual' : original === null ? 'unmeasured' : 'counted',
            compacted: cursor.compacted, plain_tokens: plain, actual_tokens: actual,
            fast_mode: ((record(input.usage) ? input.usage.speed : undefined) ?? request.speed) === 'fast',
            window_crossing: original !== null && original > window, ...(plain && !unknown ? diagnostics :
                { floor_read_possibly_uncached_tokens: null, floor_read_max_gap_seconds: null }),
        } };
}
//# sourceMappingURL=savings.js.map