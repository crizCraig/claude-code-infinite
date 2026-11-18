/** Price one plain Claude Code turn from the delivered request's measured cache usage. */
import { createHash } from 'node:crypto';
import { DEFAULT_CACHE_TTL_MS, LONG_CACHE_TTL_MS } from './cold-cache.js';
import type { SavingsReplay } from './savings-history.js';
import type { SavingsUsage } from './savings-report.js';

type SavingsTokens = SavingsUsage;
interface SavedPrefix {hash: string; tokens: number}
export interface SavingsLane {
  at: number; model: string; full_hash: string; removed: number;
  // Ends of the measured one-hour and total cached ranges, in plain input tokens.
  hourEnd: number; cacheEnd: number; prefixes: SavedPrefix[];
}
export interface SavingsState { lanes: Record<string, SavingsLane> }
export interface SavingsTurnInput {
  /** A new compression/preparation/truncation, as opposed to riding an existing prefix. */
  prefixRewritten: boolean;
  forwardedRequest?: unknown;
  replay?: SavingsReplay<SavingsPromptCheckpoint>;
  request: unknown; usage: unknown; model?: string; contextWindow: number; outputReserve?: number;
  requestModified: boolean; originalInputTokens?: number; nowMs?: number; laneKey?: string;
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
const MAX_PREFIXES = 65_536;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TOKENS;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const savingsLaneKey = hash;
const totalInput = (v: SavingsTokens) => v.input + v.cache_read + v.cache_creation_5m + v.cache_creation_1h;

/** Old simulated checkpoints cannot establish measured coverage. */
export function isSavingsLane(value: unknown, at: number): value is SavingsLane {
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  return record(value) && value.at === at && digest(value.full_hash) && count(value.removed) &&
    typeof value.model === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(value.model) &&
    count(value.hourEnd) && count(value.cacheEnd) && value.hourEnd <= value.cacheEnd &&
    Array.isArray(value.prefixes) && value.prefixes.length <= MAX_PREFIXES &&
    value.prefixes.every(p => record(p) && digest(p.hash) && count(p.tokens));
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
  hash: string; content: string; history: string; weight: number; ttl: number; cacheable: boolean;
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
    prefixes.push({content, hash:hash((last?.hash ?? '') + content),
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

/** Align unchanged blocks at the two ends. Relative text weights estimate token
 * positions because the API supplies whole-request counts, never per-block usage. */
function changedRegion(source: (SourcePrefix & {tokens:number})[], sent: SourcePrefix[] | undefined,
                       plainSize: number, sentSize: number) {
  if (!sent) return {start:0, plainEnd:plainSize, sentEnd:sentSize};
  const weight = sent.at(-1)?.weight || 1;
  const sentAt = (i: number) => Math.round(sentSize * (sent[i]?.weight ?? 0) / weight);
  let head = 0;
  while (head < source.length && head < sent.length && source[head].hash === sent[head].hash) head++;
  const start = Math.min(source[head-1]?.tokens ?? 0,sentAt(head-1));
  let plainLast = source.length - 1;
  let sentLast = sent.length - 1;
  while (plainLast >= head && sentLast >= head && source[plainLast].content === sent[sentLast].content) {
    plainLast--;
    sentLast--;
  }
  const tail = Math.min(plainSize - (source[plainLast]?.tokens ?? 0), sentSize - sentAt(sentLast),
    plainSize - start, sentSize - start);
  return {start, plainEnd:plainSize-tail, sentEnd:sentSize-tail};
}

/** Change prices only inside the part ccc rewrote. Outside it both prompts
 * keep the current response's measured cache outcome, including fresh suffixes. */
function priceRewrite(plain: SavingsUsage, source: (SourcePrefix & {tokens:number})[],
                      model: string, region: ReturnType<typeof changedRegion>, now: number, prior?: SavingsLane) {
  const minimum = minimumCacheTokens(model);
  const marked = source.filter(p => p.ttl && p.tokens >= minimum);
  const cacheableEnd = marked.at(-1)?.tokens ?? 0;
  const verifiedEnd = Math.min(cacheableEnd,previousCoverage(source,prior,now));
  // Changing an earlier block invalidates later cached blocks too. Restore that
  // tail only as far as the previous observation actually covered it.
  const start = region.start;
  const end = Math.max(region.plainEnd,verifiedEnd);
  const clip = (n: number) => Math.min(end,Math.max(start,n));
  const readEnd = clip(plain.cache_read);
  const hourEnd = clip(plain.cache_read + plain.cache_creation_1h);
  const cacheEnd = clip(plain.cache_read + plain.cache_creation_1h + plain.cache_creation_5m);
  const writeEnd = clip(cacheableEnd);
  const longEnd = clip(marked.findLast(p => p.ttl === LONG_CACHE_TTL_MS)?.tokens ?? 0);
  const liveEnd = clip(verifiedEnd);
  const longWriteEnd = Math.max(liveEnd,longEnd);

  plain.cache_read += liveEnd - readEnd;
  plain.cache_creation_1h += (longWriteEnd - liveEnd) - (hourEnd - readEnd);
  plain.cache_creation_5m += (writeEnd - longWriteEnd) - (cacheEnd - hourEnd);
  plain.input += cacheEnd - writeEnd;
}

/** Only the preceding response can establish warmth for the rewrite exception. */
function previousCoverage(source: SavedPrefix[], prior: SavingsLane | undefined, now: number) {
  if (!prior || now < prior.at) return 0;
  const age = now - prior.at;
  const coverage = age < DEFAULT_CACHE_TTL_MS ? prior.cacheEnd : age < LONG_CACHE_TTL_MS ? prior.hourEnd : 0;
  if (!coverage) return 0;
  const matched = new Map(prior.prefixes.map(p => [p.hash,p.tokens]));
  // Prefix hashes are cumulative. The last match proves all earlier blocks.
  const end = source.findLast(p => matched.has(p.hash));
  return end ? Math.min(coverage,end.tokens,matched.get(end.hash)!) : 0;
}

/** Account one successfully forwarded response. The optional local replay cache holds prefix work. */
export function accountSavingsTurn(previous: SavingsState, input: SavingsTurnInput): { state: SavingsState; turn: SavingsTurn } {
  const request = record(input.request) ? input.request : {};
  const model = input.model ?? (typeof request.model === 'string' ? request.model : '');
  const actual = normalizeSavingsUsage(input.usage);
  const laneKey = savingsLaneKey(input.laneKey ?? 'main');
  const prior = previous.lanes[laneKey];
  const warmTokens = actual && actual.cache_read + actual.cache_creation_5m + actual.cache_creation_1h;
  const partsNeeded = input.requestModified || !!warmTokens || !!prior?.removed;
  const parts = partsNeeded ? promptPrefixes(request, model, input.replay) : [];
  const weight = parts.at(-1)?.weight ?? 0;
  const inputSource = !input.requestModified && actual ? 'actual' : count(input.originalInputTokens) ? 'counted' : 'estimated';
  const original = inputSource === 'actual' ? totalInput(actual!) : inputSource === 'counted' ? input.originalInputTokens! : Math.min(MAX_TOKENS, Math.floor(weight / 4));
  const now = input.nowMs ?? Date.now();
  const comparable = prior !== undefined && prior.model === model;
  const extendsPrior = comparable && parts.some(p => p.history === prior.full_hash);
  // On edits or observed Claude compaction discard the virtual reduction. A growing source
  // transcript retains the removed count, so a synthetic plain compaction really resets growth.
  let removed = comparable && extendsPrior ? prior.removed : 0;
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
  const measured = actual ?? {input:0, cache_read:0, cache_creation_5m:0, cache_creation_1h:0, output:0};
  const actualSize = totalInput(measured);
  const sent = record(input.forwardedRequest) ? promptPrefixes(input.forwardedRequest, model) : undefined;
  const source = parts.map(p => ({...p, tokens:Math.max(0,Math.floor(original*p.weight/(weight || 1)) - removed)}));
  const region = changedRegion(source, sent, plainInput, actualSize);
  // Project observed bucket boundaries through the resized prefix. Identical head
  // and tail blocks retain their measured traffic. Within the resized part only
  // the upstream proportions are known.
  const project = (n: number) => {
    if (!input.requestModified) return n;
    if (n <= region.start) return n;
    if (n >= region.sentEnd) return Math.min(plainInput,region.plainEnd + n - region.sentEnd);
    return region.start + Math.round((n-region.start) * (region.plainEnd-region.start) /
      (region.sentEnd-region.start));
  };
  const readEnd = project(measured.cache_read);
  const writeHourEnd = project(measured.cache_read + measured.cache_creation_1h);
  const cacheEnd = project(actualSize - measured.input);
  const plain = {cache_read:readEnd,cache_creation_1h:writeHourEnd-readEnd,
    cache_creation_5m:cacheEnd-writeHourEnd,input:plainInput-cacheEnd,output:measured.output};
  if (input.requestModified && input.prefixRewritten) {
    priceRewrite(plain, source, model, region, now,
      comparable && !compacted && removed === prior.removed ? prior : undefined);
  }
  const reportedSpeed = record(input.usage) ? input.usage.speed : undefined;
  const fast = (reportedSpeed ?? request.speed) === 'fast';
  const lanes = { ...previous.lanes };
  if (!(laneKey in lanes) && Object.keys(lanes).length >= MAX_LANES) delete lanes[Object.keys(lanes).sort((a, b) => lanes[a].at - lanes[b].at)[0]];
  if (actual) {
    const sentParts = sent ?? parts;
    const longMarker = sentParts.findLast(p => p.ttl === LONG_CACHE_TTL_MS);
    const sentWeight = sentParts.at(-1)?.weight ?? 0;
    // Usage splits writes exactly. Reads have no TTL field. Attribute only the
    // read span covered by a one-hour marker on the request that actually went out.
    const longRead = longMarker && sentWeight ? Math.min(actual.cache_read,
      Math.round(actualSize * longMarker.weight / sentWeight)) : 0;
    const hourEnd = actual.cache_creation_1h ? writeHourEnd : project(longRead);
    const passthroughReduction = input.requestModified ? 0 : removed;
    lanes[laneKey] = {at:now,model,removed,full_hash:parts.at(-1)?.history || hash(''),
      hourEnd:Math.max(0,hourEnd - passthroughReduction),
      cacheEnd:Math.max(0,cacheEnd - passthroughReduction),
      prefixes:cacheEnd ? source.slice(0,MAX_PREFIXES).map(({hash,tokens}) => ({hash,tokens})) : []};
  }
  return { state: {lanes}, turn: {
    original_input_tokens: original, plain_input_tokens: plainInput, input_source: inputSource,
    compacted, plain_tokens: plain, actual_tokens: actual, fast_mode: fast, window_crossing: original > window,
  }};
}
