/** Wire allowlist: content and local cache fingerprints never leave this boundary. */
export interface SavingsReport {
  schema: 1;
  session_id: string;
  sequence: number;
  plain_api_usd: number;
  actual_api_usd: number;
  costs_complete: boolean;
  turns: number;
  window_crossings: number;
  token_counts: Record<string, number>;
}
export function savingsReport(value: unknown): SavingsReport | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1 || typeof v.session_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v.session_id) ||
      typeof v.costs_complete !== 'boolean') return;
  for (const key of ['sequence','plain_api_usd','actual_api_usd','turns','window_crossings']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < 0) return;
  }
  if (!Number.isSafeInteger(v.sequence) || !Number.isSafeInteger(v.turns) ||
      !Number.isSafeInteger(v.window_crossings)) return;
  const counts = v.token_counts as Record<string, unknown> | undefined;
  const token_counts: Record<string, number> = {};
  for (const key of ['input','cache_read','cache_creation_5m','cache_creation_1h','output']) {
    const n = counts?.[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return;
    token_counts[key] = n;
  }
  return {schema:1, session_id:v.session_id,sequence:v.sequence as number,
    plain_api_usd:v.plain_api_usd as number, actual_api_usd:v.actual_api_usd as number,
    costs_complete:v.costs_complete,turns:v.turns as number,
    window_crossings:v.window_crossings as number, token_counts};
}
