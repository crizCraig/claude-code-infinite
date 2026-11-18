/** Price plain Claude Code against its own dispatch history. */
import { createHash } from 'node:crypto';
import { DEFAULT_CACHE_TTL_MS, LONG_CACHE_TTL_MS } from './cold-cache.js';
import type { SavingsReplay } from './savings-history.js';
import type { SavingsUsage } from './savings-report.js';

type SavingsTokens = SavingsUsage;
// Every hash identifies the entire plain prefix up to one block. Keep previous
// branches too: editing a turn and then restoring it is still a repeat send.
interface SentPrefix {
  at: number;
  ttl: number;
  exact?: number;
  upper: number;
}
interface SavingsLane {
  model: string;
  full_hash: string;
  removed: number;
  sent: Record<string, SentPrefix>;
}
export interface SavingsState {
  lanes: Record<string, SavingsLane>;
  unknownHistory?: boolean;
}
export interface SavingsTurnInput {
  replay?: SavingsReplay<SavingsPromptCheckpoint>;
  request: unknown; usage: unknown; model?: string; contextWindow: number; outputReserve?: number;
  requestModified: boolean; originalInputTokens?: number; nowMs?: number; laneKey?: string;
}
export interface SavingsTurn {
  original_input_tokens: number; plain_input_tokens: number;
  input_source: 'actual' | 'counted' | 'estimated'; compacted: boolean;
  plain_tokens: SavingsTokens; actual_tokens?: SavingsTokens;
  fast_mode: boolean; window_crossing: boolean;
  floor_read_possibly_uncached_tokens: number | null; floor_read_max_gap_seconds: number | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSavingsSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
const MAX_TOKENS = 1_000_000_000;
const MAX_LANES = 32;
const MAX_PREFIXES = 65_536;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TOKENS;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const savingsLaneKey = hash;
const totalInput = (v: SavingsTokens) => v.input + v.cache_read + v.cache_creation_5m + v.cache_creation_1h;

const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function isSavingsState(value: unknown): value is SavingsState {
  if (!record(value) || !record(value.lanes) ||
      (value.unknownHistory !== undefined && typeof value.unknownHistory !== 'boolean')) return false;
  const lanes = Object.entries(value.lanes);
  return lanes.length <= MAX_LANES && lanes.every(([key,lane]) =>
    digest(key) && record(lane) && typeof lane.model === 'string' && digest(lane.full_hash) &&
    count(lane.removed) && record(lane.sent) && Object.keys(lane.sent).length <= MAX_PREFIXES &&
    Object.entries(lane.sent).every(([key,entry]) => digest(key) && record(entry) &&
      Number.isSafeInteger(entry.at) && entry.at >= 0 && count(entry.upper) &&
      [0,DEFAULT_CACHE_TTL_MS,LONG_CACHE_TTL_MS].includes(entry.ttl) &&
      (entry.exact === undefined || count(entry.exact) && entry.exact <= entry.upper)));
}

/** Cache creation total includes its duration buckets; never count it twice. */
export function normalizeSavingsUsage(value: unknown): SavingsTokens | undefined {
  if (!record(value) || !count(value.input_tokens) || !count(value.output_tokens)) return;
  const read = value.cache_read_input_tokens ?? 0;
  if (!count(read)) return;
  const split = value.cache_creation;
  if (split != null && !record(split)) return;
  const measuredSplit = count(split?.ephemeral_5m_input_tokens) && count(split?.ephemeral_1h_input_tokens);
  if (value.cache_creation_input_tokens == null && split != null && !measuredSplit) return;
  const creation = value.cache_creation_input_tokens ??
    ((split?.ephemeral_5m_input_tokens ?? 0) + (split?.ephemeral_1h_input_tokens ?? 0));
  if (!count(creation)) return;
  const five = split == null ? creation : split.ephemeral_5m_input_tokens ?? 0;
  const hour = split?.ephemeral_1h_input_tokens ?? 0;
  if (!count(five) || !count(hour) || five + hour !== creation) return;
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
interface PromptPart { value: unknown; ttl?: number; cacheable: boolean }
const cacheTtl = (value: unknown): number | undefined => record(value) && value.type === 'ephemeral'
  ? value.ttl === '1h' ? LONG_CACHE_TTL_MS : value.ttl === undefined || value.ttl === '5m' ? DEFAULT_CACHE_TTL_MS : undefined : undefined;
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
  hash: string; history: string; weight: number; ttl: number; cacheable: boolean;
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
      weight:(last?.weight ?? 0) + (last ? textWeight(part.value) : 0), ttl:part.ttl ?? 0, cacheable:part.cacheable});
  };
  const blockPart = (value: unknown, role?: string, system = false) => {
    if (system || role === 'system') {
      const text = record(value) ? value.text : value;
      if (typeof text === 'string' && text.startsWith('x-anthropic-billing-header:')) {
        const stable = text.replace(/^x-anthropic-billing-header:(?:[ \t]*[a-z_]+=[^;\n]*;)+/, 'x-anthropic-billing-header:');
        value = record(value) ? { ...value, text: stable } : stable;
      }
    }
    const cacheable = !(record(value) && ['thinking', 'redacted_thinking'].includes(value.type)) &&
      !(typeof value === 'string' && !value.length) && !(record(value) && value.type === 'text' && value.text === '');
    append({ value: role === undefined ? withoutControls(value) : { role, content: withoutControls(value) },
      ttl: cacheable && record(value) ? cacheTtl(value.cache_control) : undefined, cacheable }, role !== undefined);
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
    for (const block of Array.isArray(message.content) ? message.content : [message.content]) blockPart(block, message.role);
    if (replay && i+1 === checkpoint && prefixes.length <= MAX_PREFIXES) {
      replay.remember(checkpoint, {model,frame,prefixes:[...prefixes]});
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

/** Sum contiguous expired ranges. If a change of TTL or send time puts the
 * dividing line inside an unmeasured span, its token count is unknown. */
function gapDiagnostics(seen: (SentPrefix | undefined)[], exact: (number | undefined)[],
                        match: number, matchedRead: number, now: number, missing: boolean) {
  const unknown = {floor_read_possibly_uncached_tokens:null,floor_read_max_gap_seconds:null};
  if (missing) return unknown;
  let tokens: number | null = 0;
  let maxGap = 0;
  let start: number | undefined = 0;
  let expired = false;
  for (let i = 1; i <= match; i++) {
    const last = seen[i];
    if (!last || now < last.at) return unknown;
    const gap = now-last.at;
    const stale = gap > last.ttl;
    const boundary = i === 1 ? 0 : exact[i-1];
    if (stale !== expired) {
      if (expired) tokens = addRange(tokens,start,boundary,matchedRead);
      start = boundary;
      expired = stale;
    }
    if (stale && matchedRead > (boundary ?? 0)) maxGap = Math.max(maxGap,Math.floor(gap/1000));
  }
  if (expired) tokens = addRange(tokens,start,matchedRead,matchedRead);
  return {floor_read_possibly_uncached_tokens:tokens,floor_read_max_gap_seconds:maxGap};
}

function addRange(total: number | null, start: number | undefined, end: number | undefined, limit: number) {
  if (total === null || start === undefined || end === undefined) return null;
  return total + Math.max(0,Math.min(limit,end) - Math.min(limit,start));
}

/** Only a response to the original request can measure its token boundaries. */
function measuredBoundaries(parts: SourcePrefix[], exact: (number | undefined)[], actual: SavingsUsage) {
  const marked = parts.flatMap((p,i) => p.ttl ? [i] : []);
  const hours = marked.filter(i => parts[i].ttl === LONG_CACHE_TTL_MS);
  if (hours.length === 1 && actual.cache_creation_1h > 0) {
    exact[hours[0]] = actual.cache_read + actual.cache_creation_1h;
  }
  const cached = totalInput(actual) - actual.input;
  if (marked.length === 1 && actual.cache_creation_5m + actual.cache_creation_1h > 0) exact[marked[0]] = cached;
}

/** A settlement can improve the size of an already recorded dispatch. It
 * cannot change who last sent the prefix, its TTL, or the compaction cursor. */
export function refineSavingsState(current: SavingsState, settled: SavingsState, dispatched: SavingsState): SavingsState {
  const lanes = {...current.lanes};
  for (const [key,lane] of Object.entries(settled.lanes)) {
    if (!lanes[key]) continue;
    const sent = {...lanes[key].sent};
    for (const [hash,entry] of Object.entries(lane.sent)) {
      if (entry.exact === undefined || entry.exact === dispatched.lanes[key]?.sent[hash]?.exact || !sent[hash]) continue;
      sent[hash] = {...sent[hash], exact:entry.exact, upper:entry.exact};
    }
    lanes[key] = {...lanes[key],sent};
  }
  return {...current,lanes};
}

export function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): { state: SavingsState; turn: SavingsTurn } {
  const request = record(input.request) ? input.request : {};
  const model = input.model ?? (typeof request.model === 'string' ? request.model : '');
  const actual = normalizeSavingsUsage(input.usage);
  const laneKey = savingsLaneKey(input.laneKey ?? 'main');
  const prior = previous.lanes[laneKey];
  const parts = promptPrefixes(request, model, input.replay);
  const weight = parts.at(-1)?.weight ?? 0;
  const identical = input.requestModified ? undefined : actual;
  const inputSource = identical ? 'actual' : count(input.originalInputTokens) ? 'counted' : 'estimated';
  let removed = prior?.model === model && parts.some(p => p.history === prior.full_hash) ? prior.removed : 0;
  let original: number;
  if (identical) original = totalInput(identical);
  else if (count(input.originalInputTokens)) original = input.originalInputTokens;
  else {
    // Estimate only the unseen suffix when an earlier send measured the
    // identical head. A different text density cannot shrink that boundary.
    const idx = parts.findLastIndex(p => prior?.sent[p.hash]?.exact !== undefined);
    const boundary = idx >= 0 ? prior!.sent[parts[idx].hash].exact! : 0;
    original = Math.min(MAX_TOKENS,boundary + Math.floor((weight - (parts[idx]?.weight ?? 0))/4));
  }
  const now = input.nowMs ?? Date.now();
  const window = count(input.contextWindow) && input.contextWindow > 0 ? input.contextWindow : 200_000;
  const reserveValue = input.outputReserve ?? request.max_tokens ?? Math.min(32_000, Math.floor(window * .2));
  const reserve = count(reserveValue) ? Math.min(reserveValue, window - 1) : Math.min(32_000, window - 1);
  const ceiling = Math.max(1, Math.floor(Math.min(window - reserve, window * .8)));
  let plainInput = input.requestModified ? Math.max(0, original - removed) : original;
  const compacted = input.requestModified && plainInput > ceiling;
  if (compacted) {
    // Free compaction and a deliberately small summary plus tail favor plain Claude.
    plainInput = Math.min(plainInput, Math.min(1024, Math.floor(ceiling * .1)) + Math.floor(ceiling * .1));
    removed = original - plainInput;
  }
  const reduction = original - plainInput;
  const keys = parts.map(p => reduction ? hash(reduction + ':' + p.hash) : p.hash);
  const seen = keys.map(key => prior?.sent[key]);
  const exact = seen.map(p => p?.exact);
  if (identical) measuredBoundaries(parts,exact,identical);
  if (inputSource !== 'estimated') exact[parts.length-1] = plainInput;
  // An exact full-prefix count also supersedes an unavailable current count.
  if (inputSource === 'estimated' && exact.at(-1) !== undefined) plainInput = exact.at(-1)!;
  // A write costs more than ordinary input, and a one-hour write costs more
  // than a five-minute write. Promote only through a known boundary. An end
  // marker covers the whole input, including when the total itself is estimated.
  let lower = 0;
  let cacheEnd = 0;
  let hourEnd = 0;
  const minimum = minimumCacheTokens(model);
  for (let i = 0; i < parts.length; i++) {
    lower = i === parts.length-1 ? plainInput : Math.min(plainInput,exact[i] ?? lower);
    if (!parts[i].ttl || lower < minimum) continue;
    cacheEnd = lower;
    if (parts[i].ttl === LONG_CACHE_TTL_MS) hourEnd = lower;
  }
  const match = seen.findLastIndex((p,i) => !!p && i > 0);
  // An unmeasured interior boundary may be anywhere up to the next measured
  // boundary. Give the entire ambiguous span the cheaper price.
  const upper = Array<number>(parts.length);
  let nextBound = inputSource === 'estimated' ? MAX_TOKENS : plainInput;
  for (let i = parts.length-1; i >= 0; i--) {
    nextBound = exact[i] ?? nextBound;
    upper[i] = nextBound;
  }
  const matchedRead = match < 0 ? 0 : match === parts.length-1 ? plainInput :
    Math.min(plainInput, upper[match], seen[match]!.upper);
  let read = previous.unknownHistory ? plainInput : matchedRead;

  // On a byte-identical passthrough the API directly measures the original
  // request, including cache hits predating this launch and ignored markers.
  // Its billed write ranges cap writes to previously unseen tokens.
  if (identical) {
    read = Math.max(read,identical.cache_read);
    cacheEnd = Math.min(cacheEnd,totalInput(identical) - identical.input);
    hourEnd = Math.min(hourEnd,identical.cache_read + identical.cache_creation_1h);
  }
  const longEnd = Math.max(read,hourEnd);
  const writeEnd = Math.max(longEnd,cacheEnd);
  const plain = {input:plainInput-writeEnd,cache_read:read,cache_creation_1h:longEnd-read,
    cache_creation_5m:writeEnd-longEnd,output:actual?.output ?? 0};

  const lanes = {...previous.lanes};
  let unknownHistory = previous.unknownHistory;
  if (!prior && Object.keys(lanes).length >= MAX_LANES) {
    delete lanes[Object.keys(lanes)[0]];
    unknownHistory = true;
  }
  const sent = {...prior?.sent};
  let ttl = 0;
  for (let i = parts.length-1; i > 0; i--) {
    if (parts[i].ttl) ttl = parts[i].ttl;
    // Concurrent launchers can finish registering an older send second.
    const last = seen[i];
    const newer = last && last.at > now;
    sent[keys[i]] = {at:newer ? last.at : now,ttl:newer ? last.ttl : ttl,upper:upper[i],exact:exact[i]};
  }
  if (Object.keys(sent).length > MAX_PREFIXES) {
    // Once history is incomplete, future unknown prefix costs must favor plain.
    unknownHistory = true;
    for (const key of Object.keys(sent).slice(0,-MAX_PREFIXES)) delete sent[key];
  }
  lanes[laneKey] = {model,removed,full_hash:parts.at(-1)?.history || hash(''),sent};
  const reportedSpeed = record(input.usage) ? input.usage.speed : undefined;
  return { state:{lanes,...(unknownHistory && {unknownHistory})}, turn:{
    original_input_tokens:original,plain_input_tokens:plainInput,input_source:inputSource,
    compacted,plain_tokens:plain,actual_tokens:actual,fast_mode:(reportedSpeed ?? request.speed) === 'fast',
    window_crossing:original > window,
    ...gapDiagnostics(seen,exact,match,matchedRead,now,!!previous.unknownHistory && matchedRead < read),
  }};
}
