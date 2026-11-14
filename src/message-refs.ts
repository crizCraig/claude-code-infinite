/**
 * Delta uploads (message refs): messages MemTree already stores are named by hash instead
 * of being uploaded again.
 *
 * Every MemTree call sends the whole conversation (~11.7 GB/week in 2026-10; one
 * image-heavy agent lane alone uploaded 6.7 GB). A server with delta uploads on answers
 * each call that declares `message-refs` with `memtree_message_refs`: once the request is
 * in its conversation store, every item the call sent may be named next time by the hash
 * of its hashing form, except the `unservable` ones (rows holding a redacted secret) and
 * messages holding an image in `unserved_images`. The server puts the named messages back
 * before reading the request, so billing, hashing and indexing are those of a full upload.
 * Anything it cannot serve answers 409 `missing_message_hashes`; the call is then sent
 * again in full. Contract and golden vectors: polychat docs/memtree_delta_upload.md and
 * polychat/conversation_store_delta_vectors.json (test/fixtures/delta_vectors.json).
 *
 * Off unless CCC_MEMTREE_DELTA=1 (the client half of polychat's CONVERSATION_STORE_DELTA).
 */
import { createHash } from "node:crypto";
import { isCanonicalBase64 } from "./image-refs.js";
import { stripCcSystemReminders, type Message } from "./turns.js";

/** Declared in x-client-features: this client sends refs and reads STORED_MESSAGES_FIELD. */
export const MESSAGE_REFS_FEATURE = "message-refs";
/** Answer field: whether the request is stored, and what may not be named. */
export const STORED_MESSAGES_FIELD = "memtree_message_refs";
/** 409 detail field: the refs the server could not serve. */
export const MISSING_MESSAGES_FIELD = "missing_message_hashes";
export const MISSING_MESSAGES_STATUS = 409;
export const REF_KEY = "memtree_ref";
const MARKS_KEY = "cache_marks";
const HEADER_KEY = "billing_header";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header";
/** Conversations whose acks are remembered, and hashes per conversation (memory bound). */
const SESSIONS_MAX = 32;
const ACKED_PER_SESSION_MAX = 200_000;
/** 409s in a row naming every ref before a conversation goes back to full uploads. */
const ALL_MISSING_MAX = 2;
const HEX_RE = /^[0-9a-f]{64}$/;
/** The server's limits per request: ref entries, and cache marks on refs (past them, inline). */
const MAX_REFS = 50_000;
const MAX_MARKS = 64;
/** What the named messages may expand to (their JSON, images as bytes: an overestimate of
 *  what the server reads, which keeps images as refs), under its 32 MiB rebuild cap. */
const MAX_NAMED_CHARS = 30 * 1024 * 1024;
/** A character both JS trim and Python strip keep (Python also strips \x1c-\x1f, \x85). */
const SUBSTANCE_RE = /[^\s\x1c-\x1f\x85]/;

/** A message's ref as the server hashes it. `marks`: [path, position, value]. */
export interface Ref {
  digest: string;
  marks: unknown[][];
  header?: unknown;
  /** Length of the hashed JSON (the message without its marks and header). */
  chars: number;
}

/** A body as sent, and the hashes it names by ref (hex, in order). */
export interface Delta {
  messages: Message[];
  refs: string[];
}

export class MessageRefs {
  /** Per conversation (session and opening, as the server's scope): acked digests. */
  private acked = new Map<string, Set<string>>();
  /** Per conversation: digests a 409 named (a hash the server never had, or computes
   *  differently): never acked again, so a mismatch costs one 409, not one per turn. */
  private never = new Map<string, Set<string>>();
  /** Per conversation: 409s in a row that named every ref sent. */
  private allMissing = new Map<string, number>();
  private off = new Set<string>();
  private disabled = false;

  constructor(readonly enabled: boolean) {}

  /** Whether calls declare message-refs (on, and not refused by the server for good). */
  get active(): boolean {
    return this.enabled && !this.disabled;
  }

  /** `messages` with every acked message after the opening as a ref (none: the same list). */
  delta(sessionId: string | undefined, messages: Message[]): Delta {
    const lane = this.laneFor(sessionId, messages);
    const acked = lane ? this.acked.get(lane) : undefined;
    if (!acked || acked.size === 0) return { messages, refs: [] };
    return buildDelta(messages, acked);
  }

  /**
   * Learn what an answer to a call that sent `messages` (in full) lets the next one name.
   * `finalIndex`: the early answer to an exit index, which never carries the field.
   */
  noteAnswer(sessionId: string | undefined, messages: Message[], json: unknown,
             opts: { finalIndex?: boolean; sentRefs?: number } = {}): void {
    const lane = this.laneFor(sessionId, messages);
    if (!lane) return;
    const field = (json as Record<string, unknown> | null)?.[STORED_MESSAGES_FIELD];
    if (field === undefined) {
      // A server that takes no refs (off, or never had them): name nothing until it does.
      if (!opts.finalIndex) this.acked.delete(lane);
      return;
    }
    if (opts.sentRefs) this.allMissing.delete(lane);
    const acks = field as Record<string, unknown> | null;
    if (!acks || acks.stored !== true || acks.messages !== messages.length) return;
    this.remember(lane, ackedDigests(messages, acks, this.acked.get(lane)));
  }

  /**
   * A refusal of a call that sent `messages` naming `refs` (hex): true when the call should
   * go again in full. A 409 names what is never named again in this conversation; two in a
   * row naming every ref end refs for it; a 400 about refs ends them all; a 400 about the
   * images the refs brought back only resends.
   */
  noteRefusal(sessionId: string | undefined, messages: Message[], refs: readonly string[],
              status: number, bodyText: string): boolean {
    if (refs.length === 0) return false;
    // Over a size cap (stored text or the images the refs bring back): this call only.
    if (status === 400 && /expand past/i.test(bodyText)) return true;
    if (status === 400 && /message refs/i.test(bodyText)) {
      this.disabled = true;
      this.acked.clear();
      return true;
    }
    const missing = status === MISSING_MESSAGES_STATUS ? missingMessageHashes(bodyText) : undefined;
    if (missing === undefined) return false;
    // Resent whatever the lane's state (a call in flight when it went off still resends).
    const lane = this.laneFor(sessionId, messages);
    if (lane) this.noteMissing(lane, refs, missing);
    return true;
  }

  /** The conversation `messages` belong to, while refs may be named for it. */
  private laneFor(sessionId: string | undefined, messages: Message[]): string | undefined {
    if (!this.enabled || this.disabled || !sessionId) return undefined;
    const opening = messages.find(isOpening);
    if (!opening) return undefined;
    const lane = `${sessionId}\n${laneDigest(opening)}`;
    return this.off.has(lane) ? undefined : lane;
  }

  /**
   * A partial 409 names hashes the server lacks or computes differently: never named
   * again. One naming every ref (a lookup that failed, the kill switch) only drops them
   * from the acks; two in a row end refs for the conversation.
   */
  private noteMissing(lane: string, refs: readonly string[], missing: string[]): void {
    const named = new Set(missing);
    if (!refs.every((ref) => named.has(ref))) {
      this.forget(lane, missing);
      return;
    }
    const acked = this.acked.get(lane);
    for (const hash of missing) acked?.delete(hash);
    const inRow = (this.allMissing.get(lane) ?? 0) + 1;
    this.allMissing.delete(lane);
    this.allMissing.set(lane, inRow);
    boundMap(this.allMissing, SESSIONS_MAX);
    if (inRow >= ALL_MISSING_MAX) {
      this.off.add(lane);
      while (this.off.size > SESSIONS_MAX) {
        const first = this.off.values().next().value;
        if (first === undefined) break;
        this.off.delete(first);
      }
    }
  }

  private forget(lane: string, hashes: readonly string[]): void {
    const never = this.never.get(lane) ?? new Set<string>();
    this.never.delete(lane);
    this.never.set(lane, never);
    for (const hash of hashes) {
      never.add(hash);
      this.acked.get(lane)?.delete(hash);
    }
    bound(never, ACKED_PER_SESSION_MAX);
    boundMap(this.never, SESSIONS_MAX);
  }

  private remember(lane: string, digests: Iterable<string>): void {
    let set = this.acked.get(lane);
    if (set) this.acked.delete(lane);
    else set = new Set();
    this.acked.set(lane, set);
    const never = this.never.get(lane);
    for (const digest of digests) if (!never?.has(digest)) set.add(digest);
    bound(set, ACKED_PER_SESSION_MAX);
    boundMap(this.acked, SESSIONS_MAX);
  }
}

/**
 * The reference client of the contract: acked messages as refs, except the opening (the
 * first message that is not system/developer and not only <system-reminder> blocks) and
 * everything before it that is not a system/developer message.
 */
export function buildDelta(messages: Message[], acked: ReadonlySet<string>): Delta {
  const opening = messages.findIndex(isOpening);
  if (opening < 0) return { messages, refs: [] };
  let headerSeen = false;
  let marks = 0;
  let chars = 0;
  const refs: string[] = [];
  const out = messages.map((message, index) => {
    const eligible = (index > opening || isSkipped(message)) && refs.length < MAX_REFS;
    const ref = eligible ? refFor(message, !headerSeen) : undefined;
    headerSeen = headerSeen || billingHeaderOf(message) !== undefined;
    if (!ref || !acked.has(ref.digest) || marks + ref.marks.length > MAX_MARKS ||
        chars + ref.chars > MAX_NAMED_CHARS) return message;
    const named = refJson(ref);
    // A short message is smaller than its ref: sent as it is.
    if (JSON.stringify(named).length >= ref.chars) return message;
    marks += ref.marks.length;
    chars += ref.chars;
    refs.push(ref.digest);
    return named;
  });
  return refs.length ? { messages: out, refs } : { messages, refs: [] };
}

/**
 * A message's ref as the server's store hashes it: sha256 of the compact JSON of the
 * message without its `cache_control` keys and, when `stripHeader` (no earlier message of
 * the request had one), without a system message's leading billing-header block.
 */
export function refFor(message: Message, stripHeader = true): Ref | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const header = stripHeader ? billingHeaderOf(message) : undefined;
  const form = header === undefined ? message
    : { ...message, content: (message.content as unknown[]).slice(1) };
  const marks: unknown[][] = [];
  const text = JSON.stringify(withoutCacheControl(form, [], marks));
  return { digest: hashText(text), marks, chars: text.length,
    ...(header !== undefined ? { header } : {}) };
}

/** The digests an answer's acks allow for `messages`, in the request's header order. */
export function ackedDigests(messages: Message[], acks: Record<string, unknown>,
                             known: ReadonlySet<string> = new Set()): string[] {
  const unservable = new Set(stringsOf(acks.unservable));
  const images = new Set(stringsOf(acks.unserved_images));
  const out: string[] = [];
  let headerSeen = false;
  for (const message of messages) {
    const ref = refFor(message, !headerSeen);
    headerSeen = headerSeen || billingHeaderOf(message) !== undefined;
    if (!ref || unservable.has(ref.digest)) continue;
    // Images are checked once, when a message is first acked (a served image stays served).
    if (images.size && !known.has(ref.digest) &&
        imageShas(message).some((sha) => images.has(sha))) continue;
    out.push(ref.digest);
  }
  return out;
}

/** The hashes a 409 names, or undefined when it names none. */
export function missingMessageHashes(bodyText: string): string[] | undefined {
  try {
    const listed = JSON.parse(bodyText)?.detail?.[MISSING_MESSAGES_FIELD];
    if (!Array.isArray(listed)) return undefined;
    return listed.filter((hash): hash is string => typeof hash === "string" && HEX_RE.test(hash));
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------- leaves

function refJson(ref: Ref): Message {
  return {
    [REF_KEY]: ref.digest,
    ...(ref.marks.length ? { [MARKS_KEY]: ref.marks } : {}),
    ...(ref.header !== undefined ? { [HEADER_KEY]: ref.header } : {}),
  };
}

function hashOf(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function billingHeaderOf(message: Message): unknown {
  if (message?.role !== "system" || !Array.isArray(message.content)) return undefined;
  const first = message.content[0];
  return first?.type === "text" && typeof first.text === "string" &&
    first.text.startsWith(BILLING_HEADER_PREFIX) ? first : undefined;
}

/** A copy without `cache_control` keys; each removal as [path, key position, value]. */
function withoutCacheControl(value: unknown, path: (string | number)[],
                             marks: unknown[][]): unknown {
  if (Array.isArray(value)) {
    const out = value.map((item, i) => withoutCacheControl(item, [...path, i], marks));
    return out.every((item, i) => item === value[i]) ? value : out;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  let changed = false;
  let position = 0;   // among the keys JSON keeps (it drops undefined and functions)
  entries.forEach(([key, item]) => {
    const kept = item !== undefined && typeof item !== "function" && typeof item !== "symbol";
    if (key === "cache_control" && kept) {
      marks.push([path, position, item]);
      changed = true;
      position += 1;
      return;
    }
    if (kept) position += 1;
    const next = withoutCacheControl(item, [...path, key], marks);
    if (next !== item) changed = true;
    out[key] = next;
  });
  return changed ? out : value;
}

/**
 * The server's opening rule (the first message not system/developer that is not only
 * <system-reminder> blocks), erring toward "not yet": a message left with only
 * whitespace either side may count as such (JS trim and Python strip differ on a few
 * characters) is not the opening, so it and the real one both stay inline.
 */
function isOpening(message: Message): boolean {
  if (isSkipped(message)) return false;
  const stripped = stripCcSystemReminders([message])[0];
  return stripped !== undefined && substantive(stripped.content);
}

function substantive(content: unknown): boolean {
  if (typeof content === "string") return SUBSTANCE_RE.test(content);
  if (!Array.isArray(content)) return content !== undefined;
  return content.some((part: any) => typeof part === "string" ? SUBSTANCE_RE.test(part)
    : part?.type === "text" ? typeof part.text === "string" && SUBSTANCE_RE.test(part.text)
      : true);
}

/** A conversation's key: its opening without reminders and cache marks (both call kinds). */
function laneDigest(opening: Message): string {
  const stripped = stripCcSystemReminders([opening])[0] ?? opening;
  return hashOf(withoutCacheControl(stripped, [], []));
}

function bound(set: Set<string>, max: number): void {
  while (set.size > max) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
}

function boundMap(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function isSkipped(message: Message): boolean {
  return message?.role === "system" || message?.role === "developer";
}

/** Shas of the message's canonical base64 images (the ones the server stores). */
function imageShas(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) imageShas(item, out);
  } else if (value && typeof value === "object") {
    const block = value as Record<string, any>;
    const data = block.type === "image" ? block.source?.data : undefined;
    if (block.source?.type === "base64" && typeof data === "string" && isCanonicalBase64(data)) {
      out.push(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
      return out;
    }
    for (const item of Object.values(block)) imageShas(item, out);
  }
  return out;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
