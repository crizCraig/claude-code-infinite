/** Display-only session accounting. Never controls routing, context sizing, or billing. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SavingsTokens { input: number; cache_read: number; cache_creation_5m: number; cache_creation_1h: number; output: number }
interface Prefix { hash: string; tokens: number; ttl: number; at: number }
interface Lane { prefixes: Prefix[]; full_hash: string; at: number; removed: number; model: string }
export interface SavingsState {
  schema: 1; session_id: string; sequence: number; costs_complete: boolean; turns: number;
  window_crossings: number; plain_api_usd: number; actual_api_usd: number;
  token_counts: SavingsTokens; plain_token_counts: SavingsTokens;
  estimated_turns: number; progress_tokens?: number; budget_tokens?: number;
  lanes: Record<string, Lane>;
}
export interface SavingsTurnInput {
  request: unknown; usage: unknown; model?: string; contextWindow: number; outputReserve?: number;
  requestModified: boolean; originalInputTokens?: number; nowMs?: number; laneKey?: string;
  progress_tokens?: number; budget_tokens?: number;
}
export interface SavingsTurn {
  original_input_tokens: number; plain_input_tokens: number;
  input_source: 'actual' | 'counted' | 'estimated'; compacted: boolean;
  plain_tokens: SavingsTokens; actual_tokens?: SavingsTokens;
  plain_api_usd: number; actual_api_usd: number; costs_complete: boolean;
}
export interface AuthoritativeSavingsCosts { memtree_charged_usd: number; compression_api_usd: number; costs_complete: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKENS = 1_000_000_000;
const MAX_LANES = 32;
const MAX_PREFIXES = 128;
const MAX_FILE_BYTES = 600_000;
const zero = (): SavingsTokens => ({ input: 0, cache_read: 0, cache_creation_5m: 0, cache_creation_1h: 0, output: 0 });
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TOKENS;
const money = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const totalInput = (v: SavingsTokens) => v.input + v.cache_read + v.cache_creation_5m + v.cache_creation_1h;
const add = (a: SavingsTokens, b: SavingsTokens): SavingsTokens => Object.fromEntries(Object.keys(a).map(k => [k, a[k as keyof SavingsTokens] + b[k as keyof SavingsTokens]])) as unknown as SavingsTokens;

/** Cache creation total includes its duration buckets; never count it twice. */
export function normalizeSavingsUsage(value: unknown): SavingsTokens | undefined {
  if (!record(value) || !count(value.input_tokens) || !count(value.output_tokens)) return;
  const read = value.cache_read_input_tokens ?? 0;
  const creation = value.cache_creation_input_tokens ?? 0;
  if (!count(read) || !count(creation)) return;
  let five = creation, hour = 0;
  if (value.cache_creation != null) {
    if (!record(value.cache_creation)) return;
    five = value.cache_creation.ephemeral_5m_input_tokens ?? 0;
    hour = value.cache_creation.ephemeral_1h_input_tokens ?? 0;
    if (!count(five) || !count(hour) || five + hour !== creation) return;
  }
  if (value.input_tokens + read + creation > MAX_TOKENS) return;
  return { input: value.input_tokens, cache_read: read, cache_creation_5m: five, cache_creation_1h: hour, output: value.output_tokens };
}

/** Published base input prices, checked 2026-11-17. Unknown generations are unpriced. */
export function modelInputPriceUsd(model: string, inputTokens: number): number | undefined {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?=$|-))?(?:-(?:\d{8}|latest))?$/.exec(model.toLowerCase());
  if (!m) return;
  const family = m[1], version = `${m[2]}.${m[3] ?? '0'}`;
  if (family === 'haiku' && version === '5.5') return inputTokens <= 100_000 ? .1 : .5;
  const rates: Record<string, number> = {
    'opus/5.5': 4, 'sonnet/5.5': 2, 'sonnet/5.0': 2,
    'fable/5.2': 8, 'mythos/5.2': 8, 'fable/5.1': 10, 'mythos/5.1': 10, 'fable/5.0': 10, 'mythos/5.0': 10,
    'opus/5.0': 5, 'opus/4.5': 5, 'opus/4.6': 5, 'opus/4.7': 5, 'opus/4.8': 5,
    'opus/4.0': 15, 'opus/4.1': 15, 'sonnet/4.0': 3, 'sonnet/4.5': 3, 'sonnet/4.6': 3, 'haiku/4.5': 1,
  };
  return rates[`${family}/${version}`];
}
function cost(tokens: SavingsTokens, price: number): number {
  // Craig's explicit comparison policy; some current published cache rates differ.
  return price * (tokens.input + .1 * tokens.cache_read + 1.25 * tokens.cache_creation_5m + 2 * tokens.cache_creation_1h + 5 * tokens.output) / 1e6;
}
export function createSavingsState(sessionId: string): SavingsState {
  if (!UUID.test(sessionId)) throw new Error('Savings session ID must be a UUID');
  return { schema: 1, session_id: sessionId, sequence: 0, costs_complete: true, turns: 0, window_crossings: 0,
    plain_api_usd: 0, actual_api_usd: 0, token_counts: zero(), plain_token_counts: zero(), estimated_turns: 0, lanes: {} };
}

/** A modest text estimate, intentionally unrelated to the high safety fit estimator.
 * Opaque media contributes zero; exclude API controls and base64 rather than inflate savings. */
function textWeight(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + textWeight(v), 0);
  if (!record(value)) return 0;
  if (['image', 'document', 'audio', 'video'].includes(value.type)) return 0;
  return Object.entries(value).reduce((n, [k, v]) => n + (['cache_control', 'source', 'signature'].includes(k) ? 0 : textWeight(v)), 0);
}
interface PromptPart { value: unknown; ttl?: number; cacheable: boolean }
const cacheTtl = (value: unknown): number | undefined => record(value) && value.type === 'ephemeral'
  ? value.ttl === '1h' ? 3_600_000 : value.ttl === undefined || value.ttl === '5m' ? 300_000 : undefined : undefined;
function withoutControls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutControls);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, v]) => [key, withoutControls(v)]));
}
function promptParts(request: Record<string, any>, model: string): PromptPart[] {
  const parts: PromptPart[] = [{ value: { model, tool_choice: request.tool_choice ?? null, thinking: request.thinking ?? null, speed: request.speed ?? null }, cacheable: false }];
  const append = (value: unknown, role?: string) => {
    const cacheable = !(record(value) && ['thinking', 'redacted_thinking'].includes(value.type)) &&
      !(typeof value === 'string' && !value.length) && !(record(value) && value.type === 'text' && value.text === '');
    parts.push({ value: role === undefined ? withoutControls(value) : { role, content: withoutControls(value) },
      ttl: cacheable && record(value) ? cacheTtl(value.cache_control) : undefined, cacheable });
  };
  for (const tool of Array.isArray(request.tools) ? request.tools : []) append(tool);
  for (const block of Array.isArray(request.system) ? request.system : request.system ? [request.system] : []) append(block);
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    for (const block of Array.isArray(message.content) ? message.content : [message.content]) append(block, message.role);
  }
  const automatic = cacheTtl(request.cache_control);
  const last = parts.findLast(p => p.cacheable);
  if (automatic !== undefined && last && last.ttl === undefined) last.ttl = automatic;
  return parts;
}
function prefixHashes(parts: PromptPart[], tokens: number): (Prefix & { eligible: boolean; index: number })[] {
  const weights = parts.map(p => textWeight(p.value)), sum = weights.reduce((a, b) => a + b, 0) || 1;
  let digest = '', weight = 0;
  return parts.map((part, i) => {
    digest = hash(digest + JSON.stringify(part.value)); weight += weights[i];
    return { hash: digest, tokens: Math.floor(tokens * weight / sum), ttl: part.ttl ?? 0, at: 0, eligible: part.ttl !== undefined, index: i };
  });
}
function minimumCacheTokens(model: string): number {
  model = model.toLowerCase();
  if (/^claude-(?:opus-4[-.]([56])|haiku-4[-.]5)(?:-|$)/.test(model)) return 4096;
  if (/^claude-opus-4[-.]7(?:-|$)/.test(model)) return 2048;
  if (/^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:[-.]|$)/.test(model) && !/^claude-sonnet-5(?:[-.]0)?(?:-\d{8}|-latest)?$/.test(model)) return 512;
  return 1024;
}

/** Pure immutable accounting. The caller settles only successfully forwarded responses once. */
export function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): { state: SavingsState; turn: SavingsTurn } {
  const request = record(input.request) ? input.request : {};
  const model = input.model ?? (typeof request.model === 'string' ? request.model : '');
  const actual = normalizeSavingsUsage(input.usage);
  const parts = promptParts(request, model);
  const inputSource = !input.requestModified && actual ? 'actual' : count(input.originalInputTokens) ? 'counted' : 'estimated';
  const original = inputSource === 'actual' ? totalInput(actual!) : inputSource === 'counted' ? input.originalInputTokens! : Math.min(MAX_TOKENS, Math.floor(parts.reduce<number>((n, v) => n + textWeight(v.value), 0) / 4));
  const now = input.nowMs ?? Date.now();
  const laneKey = hash(input.laneKey ?? 'main');
  const prior = previous.lanes[laneKey];
  const sourcePrefixes = prefixHashes(parts, original);
  const comparable = prior?.model === model;
  const extendsPrior = comparable && sourcePrefixes.some(p => p.hash === prior.full_hash);
  // On edits or observed Claude compaction discard the virtual reduction. A growing source
  // transcript retains the removed count, so a synthetic plain compaction really resets growth.
  let removed = comparable && extendsPrior ? prior.removed : 0;
  const window = count(input.contextWindow) && input.contextWindow > 0 ? input.contextWindow : 200_000;
  const reserveValue = input.outputReserve ?? request.max_tokens ?? Math.min(32_000, Math.floor(window * .2));
  const reserve = count(reserveValue) ? Math.min(reserveValue, window - 1) : Math.min(32_000, window - 1);
  const ceiling = Math.max(1, Math.floor(Math.min(window - reserve, window * .8)));
  let plainInput = Math.max(0, original - removed);
  const compacted = plainInput > ceiling;
  if (compacted) {
    // Free compaction and a deliberately small summary plus tail favor plain Claude.
    plainInput = Math.min(plainInput, Math.min(1024, Math.floor(ceiling * .1)) + Math.floor(ceiling * .1));
    removed = original - plainInput;
  }
  // A compaction creates a new virtual prefix identity. It cannot read the old
  // full-history cache, but it can write a new entry and reuse it on later turns.
  const virtualPrefixes = sourcePrefixes.map(p => ({ ...p, tokens: Math.max(0, p.tokens - removed),
    hash: removed ? hash(`compact:${removed}:${p.hash}`) : p.hash }));
  const eligible = virtualPrefixes.filter(p => p.eligible && p.tokens >= minimumCacheTokens(model));
  const priorEntries = comparable && !compacted ? prior.prefixes : [];
  let cached = 0;
  for (const endpoint of eligible) {
    for (const candidate of virtualPrefixes.filter(p => p.index <= endpoint.index && p.index > endpoint.index - 20)) {
      for (const entry of priorEntries) {
        if (entry.hash === candidate.hash && now >= entry.at && now - entry.at < entry.ttl) cached = Math.max(cached, Math.min(entry.tokens, candidate.tokens));
      }
    }
  }
  // On the first observation only, measured upstream reads can establish a warm
  // original prefix. Never transfer that shortcut across synthetic compaction.
  if (!prior && !removed && eligible.length) cached = Math.max(cached, Math.min(actual?.cache_read ?? 0, eligible.at(-1)!.tokens));
  cached = Math.min(cached, plainInput);
  const hourEnd = Math.max(cached, ...eligible.filter(p => p.ttl === 3_600_000).map(p => p.tokens));
  const cacheEnd = Math.max(hourEnd, ...eligible.map(p => p.tokens));
  let plain: SavingsTokens = { input: plainInput - cacheEnd, cache_read: cached,
    cache_creation_1h: hourEnd - cached, cache_creation_5m: cacheEnd - hourEnd, output: actual?.output ?? 0 };
  if (!input.requestModified && actual && !compacted && removed === 0) plain = { ...actual };
  // Preserve only entries still represented by this source and refresh reads.
  const usedHashes = new Set(virtualPrefixes.filter(p => p.tokens <= cached).map(p => p.hash));
  const entries = priorEntries.filter(p => now >= p.at && now - p.at < p.ttl)
    .map(p => usedHashes.has(p.hash) ? { ...p, at: now } : p);
  const canWrite = input.requestModified || removed > 0 || !!actual && actual.cache_creation_5m + actual.cache_creation_1h + actual.cache_read > 0;
  if (canWrite) for (const endpoint of eligible) {
    const entry = { hash: endpoint.hash, tokens: endpoint.tokens, ttl: endpoint.ttl, at: now };
    const index = entries.findIndex(p => p.hash === entry.hash);
    if (index >= 0) entries[index] = endpoint.tokens <= cached ? { ...entries[index], at: now } : entry; else entries.push(entry);
  }
  const actualRate = actual ? modelInputPriceUsd(model, totalInput(actual)) : undefined;
  const plainRate = modelInputPriceUsd(model, plainInput);
  const complete = actual !== undefined && actualRate !== undefined && plainRate !== undefined && count(input.contextWindow) && input.contextWindow > 0 && Number.isFinite(now);
  const actualCost = actual && actualRate !== undefined ? cost(actual, actualRate) : 0;
  // Incomplete observations never manufacture a positive delta.
  const plainCost = complete ? cost(plain, plainRate!) : actualCost;
  const lanes = { ...previous.lanes };
  if (!(laneKey in lanes) && Object.keys(lanes).length >= MAX_LANES) delete lanes[Object.keys(lanes).sort((a, b) => lanes[a].at - lanes[b].at)[0]];
  lanes[laneKey] = { prefixes: entries.slice(-MAX_PREFIXES), full_hash: sourcePrefixes.at(-1)!.hash, at: Number.isFinite(now) ? now : 0, removed, model };
  const state: SavingsState = { ...previous, sequence: previous.sequence + 1, turns: previous.turns + 1,
    costs_complete: previous.costs_complete && complete, window_crossings: previous.window_crossings + Number(original > window),
    plain_api_usd: previous.plain_api_usd + plainCost, actual_api_usd: previous.actual_api_usd + actualCost,
    token_counts: add(previous.token_counts, actual ?? zero()), plain_token_counts: add(previous.plain_token_counts, plain),
    estimated_turns: previous.estimated_turns + Number(inputSource === 'estimated'), lanes };
  if (count(input.progress_tokens)) state.progress_tokens = input.progress_tokens;
  if (count(input.budget_tokens)) state.budget_tokens = input.budget_tokens;
  return { state, turn: { original_input_tokens: original, plain_input_tokens: plainInput, input_source: inputSource,
    compacted, plain_tokens: plain, actual_tokens: actual, plain_api_usd: plainCost, actual_api_usd: actualCost, costs_complete: complete } };
}

export function savingsSummary(state: SavingsState, remote?: AuthoritativeSavingsCosts) {
  const complete = state.costs_complete && remote?.costs_complete === true && money(remote.memtree_charged_usd) && money(remote.compression_api_usd);
  const pure = complete ? state.plain_api_usd - state.actual_api_usd - remote!.compression_api_usd : null;
  const net = pure === null ? null : pure - remote!.memtree_charged_usd;
  return { pure_usd: pure, net_usd: net, net_percent: net !== null && state.plain_api_usd > 0 ? 100 * net / state.plain_api_usd : null,
    less_usage_percent: net !== null && state.plain_api_usd > 0 ? 100 * net / state.plain_api_usd : null,
    costs_complete: complete, estimated: state.estimated_turns > 0, plain_api_usd: state.plain_api_usd, actual_api_usd: state.actual_api_usd };
}

const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
function validState(value: unknown, sessionId: string): value is SavingsState {
  if (!record(value) || value.schema !== 1 || value.session_id !== sessionId || typeof value.costs_complete !== 'boolean') return false;
  if (!onlyKeys(value, ['schema', 'session_id', 'sequence', 'costs_complete', 'turns', 'window_crossings', 'plain_api_usd', 'actual_api_usd', 'token_counts', 'plain_token_counts', 'estimated_turns', 'progress_tokens', 'budget_tokens', 'lanes'])) return false;
  if (!['sequence', 'turns', 'window_crossings', 'estimated_turns'].every(k => count(value[k]))) return false;
  if (!money(value.plain_api_usd) || !money(value.actual_api_usd)) return false;
  for (const name of ['token_counts', 'plain_token_counts']) {
    if (!record(value[name]) || !onlyKeys(value[name], Object.keys(zero())) || !Object.keys(zero()).every(k => typeof value[name][k] === 'number' && Number.isSafeInteger(value[name][k]) && value[name][k] >= 0)) return false;
  }
  if (!record(value.lanes) || Object.keys(value.lanes).length > MAX_LANES) return false;
  if ([value.progress_tokens, value.budget_tokens].some(v => v !== undefined && !count(v))) return false;
  return Object.entries(value.lanes).every(([key, lane]) => /^[a-f0-9]{64}$/.test(key) && record(lane) &&
    onlyKeys(lane, ['prefixes', 'full_hash', 'at', 'removed', 'model']) && typeof lane.model === 'string' && lane.model.length <= 100 && Number.isSafeInteger(lane.at) && lane.at >= 0 && count(lane.removed) &&
    typeof lane.full_hash === 'string' && /^[a-f0-9]{64}$/.test(lane.full_hash) && Array.isArray(lane.prefixes) && lane.prefixes.length <= MAX_PREFIXES &&
    lane.prefixes.every((p: unknown) => record(p) && onlyKeys(p, ['hash', 'tokens', 'ttl', 'at']) && [300_000, 3_600_000].includes(p.ttl) && Number.isSafeInteger(p.at) && p.at >= 0 && typeof p.hash === 'string' && /^[a-f0-9]{64}$/.test(p.hash) && count(p.tokens)));
}
/** Fail closed on corrupt, oversized, redirected, or foreign-session files. */
export function loadSavingsState(directory: string, sessionId: string): SavingsState | undefined {
  if (!UUID.test(sessionId)) return;
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(directory).isDirectory()) return;
    const file = path.join(directory, `${sessionId}.savings.json`);
    if (!fs.lstatSync(file).isFile()) return;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (fs.fstatSync(fd).size > MAX_FILE_BYTES) return;
    const value: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return validState(value, sessionId) ? value : undefined;
  } catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** One writer per session; callers serialize settlement. Atomic rename protects resumed readers. */
export function saveSavingsState(directory: string, state: SavingsState): boolean {
  if (!UUID.test(state.session_id) || !validState(state, state.session_id)) return false;
  let temp: string | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) return false;
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) return false;
    temp = path.join(directory, `.${state.session_id}.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, serialized, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, path.join(directory, `${state.session_id}.savings.json`));
    temp = undefined;
    // This directory can contain other status files: only prune this module's UUID files.
    const files = fs.readdirSync(directory).filter(n => n.endsWith('.savings.json') && UUID.test(n.slice(0, -13)))
      .map(n => ({ name: n, time: fs.lstatSync(path.join(directory, n)).mtimeMs })).sort((a, b) => b.time - a.time);
    for (const old of files.slice(512)) fs.unlinkSync(path.join(directory, old.name));
    return true;
  } catch { return false; } finally { if (temp) { try { fs.unlinkSync(temp); } catch { /* best effort */ } } }
}
