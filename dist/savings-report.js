/** Wire allowlist: content and local cache fingerprints never leave this boundary. */
import { isSavingsSessionId } from './savings.js';
export function savingsReport(value) {
    if (!value || typeof value !== 'object')
        return;
    const v = value;
    if (v.schema !== 1 || !isSavingsSessionId(v.session_id) ||
        typeof v.costs_complete !== 'boolean')
        return;
    for (const key of ['sequence', 'plain_api_usd', 'actual_api_usd', 'turns', 'window_crossings']) {
        if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < 0)
            return;
    }
    if (!Number.isSafeInteger(v.sequence) || !Number.isSafeInteger(v.turns) ||
        !Number.isSafeInteger(v.window_crossings))
        return;
    const counts = v.token_counts;
    const token_counts = {};
    for (const key of ['input', 'cache_read', 'cache_creation_5m', 'cache_creation_1h', 'output']) {
        const n = counts?.[key];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
            return;
        token_counts[key] = n;
    }
    return { schema: 1, session_id: v.session_id, sequence: v.sequence,
        plain_api_usd: v.plain_api_usd, actual_api_usd: v.actual_api_usd,
        costs_complete: v.costs_complete, turns: v.turns,
        window_crossings: v.window_crossings, token_counts };
}
//# sourceMappingURL=savings-report.js.map