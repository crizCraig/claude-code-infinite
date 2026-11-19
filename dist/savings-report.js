/** The only savings fields that may reach disk or the authenticated turn endpoint. */
import { isSavingsSessionId } from './savings.js';
const incompleteReasons = ['interrupted_dispatch', 'interrupted_stream', 'unmeasured_input', 'missing_usage'];
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
    const report = { ...identity, model: v.model, fast_mode: v.fast_mode,
        window_crossing: v.window_crossing, actual, plain };
    if (actual === null || plain === null) {
        const reason = incompleteReasons.find(allowed => allowed === v.incomplete_reason);
        if (reason)
            report.incomplete_reason = reason;
    }
    for (const field of ['floor_read_possibly_uncached_tokens', 'floor_read_max_gap_seconds']) {
        const count = v[field];
        const max = field === 'floor_read_max_gap_seconds' ? Number.MAX_SAFE_INTEGER : plain?.cache_read ?? 1_000_000_000;
        if (count === null || (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= max)) {
            report[field] = count;
        }
    }
    return report;
}
//# sourceMappingURL=savings-report.js.map