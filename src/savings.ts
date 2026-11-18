/** Prompt cache model for a single turn's plain-Claude-Code counterfactual. */
import { createHash } from 'node:crypto';
import type { SavingsReplay } from './savings-history.js';
import type { SavingsUsage } from './savings-report.js';

type SavingsTokens = SavingsUsage;
interface Prefix { hash: string; tokens: number; ttl: number; at: number }
export interface SavingsLane { prefixes: Prefix[]; full_hash: string; at: number; removed: number; model: string; warm?: {five: number; hour: number; at: number} }
export interface SavingsState { lanes: Record<string, SavingsLane> }
type LaneKind = 'main' | 'agent' | 'away';
export interface SavingsTurnInput {
  laneKind?: LaneKind;
  replay?: SavingsReplay<SavingsPromptCheckpoint>;
  request: unknown; usage: unknown; model?: string; contextWindow: number; outputReserve?: number;
  requestModified: boolean; originalInputTokens?: number; nowMs?: number; laneKey?: string; previousAt?: number;
}
export interface SavingsTurn {
  original_input_tokens: number; plain_input_tokens: number;
  input_source: 'actual' | 'counted' | 'estimated'; compacted: boolean;
  plain_tokens: SavingsTokens; actual_tokens?: SavingsTokens;
  fast_mode: boolean; window_crossing: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSavingsSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
const MAX_TOKENS = 1_000_000_000;
const MAX_LANES = 32;
const MAX_PREFIXES = 128;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TOKENS;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const savingsLaneKey = hash;
// Median observed gap in milliseconds for each conversation lane (see docs/savings.md).
const medianGapMs: Record<LaneKind, number> = {main:10_278.5, agent:6_624.5, away:1_986_285};
const totalInput = (v: SavingsTokens) => v.input + v.cache_read + v.cache_creation_5m + v.cache_creation_1h;

/** Reject partial or obsolete checkpoints without discarding their known dispatch time. */
export function isSavingsLane(value: unknown, at: number): value is SavingsLane {
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (!record(value) || value.at !== at || !digest(value.full_hash) || !count(value.removed) ||
      typeof value.model !== 'string' || !/^[a-zA-Z0-9._-]{1,96}$/.test(value.model) ||
      !Array.isArray(value.prefixes) || value.prefixes.length > MAX_PREFIXES) return false;
  const warm = value.warm;
  return (warm === undefined || (record(warm) && warm.at === at && count(warm.five) && count(warm.hour))) &&
    value.prefixes.every(p => record(p) && digest(p.hash) && count(p.tokens) &&
      (p.ttl === 300_000 || p.ttl === 3_600_000) && Number.isSafeInteger(p.at) && p.at <= at);
}

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

export function createSavingsState(): SavingsState {
  return {lanes: {}};
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
interface PromptPart { value: unknown; ttl?: number; cacheable: boolean; toolRun?: string; messageIndex?: number }
const cacheTtl = (value: unknown): number | undefined => record(value) && value.type === 'ephemeral'
  ? value.ttl === '1h' ? 3_600_000 : value.ttl === undefined || value.ttl === '5m' ? 300_000 : undefined : undefined;
/** Only API content blocks carry cache markers. Tool input/schema keys are prompt content. */
function withoutControls(value: unknown): unknown {
  if (!record(value)) return value;
  const { cache_control, ...block } = value;
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    block.content = block.content.map(withoutControls);
    return block;
  }
  return cache_control === undefined ? value : block;
}
interface SourcePrefix {
  hash: string; history: string; weight: number; position: number; index: number; ttl: number;
  toolRun?: string; cacheable: boolean; messageIndex: number;
}
export interface SavingsPromptCheckpoint {
  model: string; frame: string; prefixes: SourcePrefix[];
}

function promptPrefixes(request: Record<string, any>, model: string, replay?: SavingsReplay<SavingsPromptCheckpoint>) {
  let prefixes: SourcePrefix[] = [];
  const append = (part: PromptPart, message = false) => {
    const last = prefixes.at(-1);
    const content = hash(JSON.stringify(part.value));
    const history = last?.history ?? '';
    prefixes.push({hash:hash((last?.hash ?? '') + content),
      history:message ? hash(history + content) : history,
      weight:(last?.weight ?? 0) + textWeight(part.value), index:(last?.index ?? -1) + 1,
      position:(last?.position ?? 0) + Number(!part.toolRun || last?.toolRun !== part.toolRun),
      messageIndex:part.messageIndex ?? -1, toolRun:part.toolRun, ttl:part.ttl ?? 0, cacheable:part.cacheable});
  };
  const blockPart = (value: unknown, role?: string, system = false, messageIndex = -1) => {
    if (system || role === 'system') {
      const text = record(value) ? value.text : value;
      if (typeof text === 'string' && text.startsWith('x-anthropic-billing-header:')) {
        const stable = text.replace(/^x-anthropic-billing-header:(?:[ \t]*[a-z_]+=[^;\n]*;)+/, 'x-anthropic-billing-header:');
        value = record(value) ? { ...value, text: stable } : stable;
      }
    }
    const cacheable = !(record(value) && ['thinking', 'redacted_thinking'].includes(value.type)) &&
      !(typeof value === 'string' && !value.length) && !(record(value) && value.type === 'text' && value.text === '');
    append({ messageIndex, value: role === undefined ? withoutControls(value) : { role, content: withoutControls(value) },
      ttl: cacheable && record(value) ? cacheTtl(value.cache_control) : undefined, cacheable,
      toolRun: role && record(value) && ['tool_use', 'tool_result'].includes(value.type) ? value.type : undefined }, role !== undefined);
  };
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const cached = replay?.prefix();
  let frame: string;
  if (cached?.sameFrame && cached.prompt.model === model) {
    frame = cached.prompt.frame;
  } else {
    append({value:{model, tool_choice:request.tool_choice ?? null, thinking:request.thinking ?? null,
      speed:request.speed ?? null},cacheable:false});
    for (const tool of Array.isArray(request.tools) ? request.tools : []) blockPart(tool);
    const system = Array.isArray(request.system) ? request.system : request.system ? [request.system] : [];
    for (const block of system) blockPart(block, undefined, true);
    frame = hash(JSON.stringify(prefixes.map(p => [p.hash,p.ttl])));
  }
  const reuse = cached && cached.prompt.frame === frame && cached.count <= messages.length ? cached : undefined;
  if (reuse) prefixes = [...reuse.prompt.prefixes];
  // Claude often moves the final message's explicit breakpoint on the next request.
  const tail = replay && reuse?.count !== messages.length && messages.at(-1)?.content;
  const movingMarker = Array.isArray(tail) && tail.some(p => record(p) && p.cache_control);
  const stableCount = movingMarker && messages.length > 1 ? messages.length - 1 : messages.length;
  const checkpoint = Math.max(reuse?.count ?? 0, stableCount);
  for (let i = reuse?.count ?? 0; i < messages.length; i++) {
    const message = messages[i];
    for (const block of Array.isArray(message.content) ? message.content : [message.content]) blockPart(block, message.role, false, i);
    if (replay && i+1 === checkpoint) {
      // Keep the lookback for each explicit breakpoint and the live tail. The
      // full message payloads and older non-cacheable positions are discarded.
      const end = prefixes.at(-1)!;
      const lastCacheable = prefixes.findLast(p => p.cacheable);
      const breaks = prefixes.filter(p => p.ttl || p === lastCacheable);
      const kept = prefixes.filter(p => p.position > end.position-20 ||
        breaks.some(e => p.index <= e.index && p.position > e.position-20));
      replay.remember(checkpoint, {model,frame,prefixes:kept});
    }
  }
  const automatic = cacheTtl(request.cache_control);
  if (automatic !== undefined) {
    const i = prefixes.findLastIndex(p => p.cacheable);
    if (i >= 0 && !prefixes[i].ttl) prefixes[i] = {...prefixes[i],ttl:automatic};
  }
  return prefixes;
}
function minimumCacheTokens(model: string): number {
  model = model.toLowerCase();
  if (/^claude-(?:opus-4[-.]([56])|haiku-4[-.]5)(?:-|$)/.test(model)) return 4096;
  if (/^claude-opus-4[-.]7(?:-|$)/.test(model)) return 2048;
  if (/^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:[-.]|$)/.test(model) && !/^claude-sonnet-5(?:[-.]0)?(?:-\d{8}|-latest)?$/.test(model)) return 512;
  return 1024;
}

/** Account one successfully forwarded response. The optional local replay cache holds prefix work. */
export function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): { state: SavingsState; turn: SavingsTurn } {
  const request = record(input.request) ? input.request : {};
  const model = input.model ?? (typeof request.model === 'string' ? request.model : '');
  const actual = normalizeSavingsUsage(input.usage);
  const laneKey = savingsLaneKey(input.laneKey ?? 'main');
  const prior = previous.lanes[laneKey];
  let parts = input.requestModified ? promptPrefixes(request, model, input.replay) : [];
  if (input.requestModified && prior?.removed && prior.model === model && input.replay?.prefix() &&
      !parts.some(p => p.history === prior.full_hash)) {
    parts = promptPrefixes(request, model);
  }
  const weight = parts.at(-1)?.weight ?? 0;
  const inputSource = !input.requestModified && actual ? 'actual' : count(input.originalInputTokens) ? 'counted' : 'estimated';
  const original = inputSource === 'actual' ? totalInput(actual!) : inputSource === 'counted' ? input.originalInputTokens! : Math.min(MAX_TOKENS, Math.floor(weight / 4));
  const now = input.nowMs ?? Date.now();
  const sourcePrefixes = parts.map(p => ({...p, tokens:Math.floor(original*p.weight/(weight || 1)),
    eligible:p.ttl > 0}));
  const comparable = prior?.model === model;
  const extendsPrior = comparable && sourcePrefixes.some(p => p.history === prior.full_hash);
  // On edits or observed Claude compaction discard the virtual reduction. A growing source
  // transcript retains the removed count, so a synthetic plain compaction really resets growth.
  let removed = comparable && extendsPrior ? prior.removed : 0;
  const window = count(input.contextWindow) && input.contextWindow > 0 ? input.contextWindow : 200_000;
  const reserveValue = input.outputReserve ?? request.max_tokens ?? Math.min(32_000, Math.floor(window * .2));
  const reserve = count(reserveValue) ? Math.min(reserveValue, window - 1) : Math.min(32_000, window - 1);
  const ceiling = Math.max(1, Math.floor(Math.min(window - reserve, window * .8)));
  let plainInput = Math.max(0, original - removed);
  const compacted = input.requestModified && plainInput > ceiling;
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
  const previousAt = input.previousAt ?? prior?.at;
  const gap = previousAt === undefined ? undefined : Math.max(0, now - previousAt);
  const effectiveGap = gap ?? medianGapMs[input.laneKind ?? 'main'];
  const warm = (ttl: number) => effectiveGap < ttl;
  const liveEndpoints = eligible.filter(p => warm(p.ttl));
  let cached = 0;
  for (const endpoint of liveEndpoints) {
    for (const candidate of virtualPrefixes.filter(p => p.index <= endpoint.index && p.position > endpoint.position - 20)) {
      for (const entry of priorEntries) {
        if (entry.hash === candidate.hash && now >= entry.at && now - entry.at < entry.ttl) cached = Math.max(cached, Math.min(entry.tokens, candidate.tokens));
      }
    }
  }
  const liveEnd = liveEndpoints.at(-1)?.tokens ?? 0;
  if (!prior && !removed && liveEnd) {
    // A resume may predate local observations. The conversation through the last
    // user request could have been cached. Its reply and the new input are fresh.
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const assistant = messages.findLastIndex((m: {role?: string}) => m.role === 'assistant');
    const history = assistant >= 0
      ? virtualPrefixes.findLast(p => p.messageIndex < assistant)?.tokens ?? 0 : 0;
    cached = Math.min(liveEnd, Math.max(history, actual?.cache_read ?? 0));
  }
  if (comparable && prior.warm && !removed && liveEnd) {
    const age = now - prior.warm.at;
    const coverage = age >= 0 && age < 3_600_000
      ? prior.warm.hour + (age < 300_000 ? prior.warm.five : 0) : 0;
    cached = Math.max(cached, Math.min(coverage, liveEnd));
  }
  cached = Math.min(cached, plainInput);
  const hourEnd = Math.max(cached, ...eligible.filter(p => p.ttl === 3_600_000).map(p => p.tokens));
  const cacheEnd = Math.max(hourEnd, ...eligible.map(p => p.tokens));
  let plain: SavingsTokens = { input: plainInput - cacheEnd, cache_read: cached,
    cache_creation_1h: hourEnd - cached, cache_creation_5m: cacheEnd - hourEnd, output: actual?.output ?? 0 };
  if (!input.requestModified && actual) plain = actual;
  // Preserve only entries still represented by this source and refresh reads.
  const usedHashes = new Set(virtualPrefixes.filter(p => p.tokens <= cached).map(p => p.hash));
  const entries = priorEntries.filter(p => now >= p.at && now - p.at < p.ttl)
    .map(p => usedHashes.has(p.hash) ? { ...p, at: now } : p);
  for (const endpoint of eligible) {
    const entry = { hash: endpoint.hash, tokens: endpoint.tokens, ttl: endpoint.ttl, at: now };
    const index = entries.findIndex(p => p.hash === entry.hash);
    if (index >= 0) entries[index] = endpoint.tokens <= cached ? { ...entries[index], at: now } : entry; else entries.push(entry);
  }
  const reportedSpeed = record(input.usage) ? input.usage.speed : undefined;
  const fast = (reportedSpeed ?? request.speed) === 'fast';
  const lanes = { ...previous.lanes };
  if (!(laneKey in lanes) && Object.keys(lanes).length >= MAX_LANES) delete lanes[Object.keys(lanes).sort((a, b) => lanes[a].at - lanes[b].at)[0]];
  if (input.requestModified) {
    lanes[laneKey] = {
      prefixes: entries.slice(-MAX_PREFIXES), full_hash: sourcePrefixes.at(-1)!.history || hash(''),
      at: Number.isFinite(now) ? now : 0, removed, model,
    };
  } else if (actual) {
    const lane = comparable ? prior : {prefixes:[], full_hash:hash(''), removed:0, model};
    lanes[laneKey] = {...lane, at:now, warm:{at:now, five:actual.cache_creation_5m,
      hour:actual.cache_creation_1h + actual.cache_read}};
  }
  return { state: {lanes}, turn: {
    original_input_tokens: original, plain_input_tokens: plainInput, input_source: inputSource,
    compacted, plain_tokens: plain, actual_tokens: actual, fast_mode: fast, window_crossing: original > window,
  }};
}
