/** The only savings fields that may reach disk or the authenticated turn endpoint. */
import { isSavingsSessionId } from './savings.js';
function usage(value) {
    if (value === null)
        return null;
    if (!value || typeof value !== 'object')
        return;
    const result = {};
    for (const key of ['input', 'cache_read', 'cache_creation_5m', 'cache_creation_1h', 'output']) {
        const count = value[key];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) ||
            count < 0 || count > 1_000_000_000)
            return;
        result[key] = count;
    }
    return result;
}
export function savingsReport(value) {
    if (!value || typeof value !== 'object')
        return;
    const v = value;
    if (!isSavingsSessionId(v.turn_id) || !isSavingsSessionId(v.session_id) ||
        typeof v.requested_at !== 'string' || !Number.isFinite(Date.parse(v.requested_at)))
        return;
    const identity = { turn_id: v.turn_id.toLowerCase(), session_id: v.session_id,
        requested_at: new Date(v.requested_at).toISOString() };
    // Replay old outbox segments unchanged so either generation of server can acknowledge them.
    if (v.outcome === 'not_dispatched' && Number.isSafeInteger(v.expected_memtree_calls) &&
        typeof v.expected_memtree_calls === 'number' && v.expected_memtree_calls > 0) {
        return { ...identity, outcome: v.outcome, expected_memtree_calls: v.expected_memtree_calls };
    }
    if (v.outcome !== undefined)
        return;
    if (typeof v.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(v.model) ||
        typeof v.fast_mode !== 'boolean' || typeof v.window_crossing !== 'boolean')
        return;
    const actual = usage(v.actual), plain = usage(v.plain);
    if (actual === undefined || plain === undefined)
        return;
    return { ...identity, model: v.model, fast_mode: v.fast_mode,
        window_crossing: v.window_crossing, actual, plain };
}
//# sourceMappingURL=savings-report.js.map