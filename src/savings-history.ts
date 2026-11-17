/** Verify an append during the full-body fingerprint that request sizing already needs.
 * Every candidate in one request uses the same byte ranges. The range digests
 * identify all its bytes, including the bytes on either side of the messages.
 * The digests also verify which prompt checkpoints can be reused. */
import { createHash, type Hash } from 'node:crypto';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const white = (c: number) => c === 32 || c === 9 || c === 13 || c === 10;
function skipSpace(b: Buffer, i: number): number {
  while (white(b[i])) i++;
  return i;
}
const QUOTE = 34, BACKSLASH = 92, COMMA = 44;
const ARRAY_START = 91, ARRAY_END = 93, OBJECT_START = 123, OBJECT_END = 125;

function stringEnd(b: Buffer, i: number): number {
  for (;;) {
    const quote = b.indexOf(QUOTE, i + 1);
    if (quote < 0) return b.length;
    let slash = quote;
    while (slash > i && b[slash - 1] === BACKSLASH) slash--;
    if ((quote - slash) % 2 === 0) return quote + 1;
    i = quote;
  }
}
/** Skip one value in an already JSON-parsed body. Skip string payloads natively. */
function valueEnd(b: Buffer, i: number): number {
  if (b[i] === QUOTE) return stringEnd(b, i);
  if (b[i] !== ARRAY_START && b[i] !== OBJECT_START) {
    while (i < b.length && !white(b[i]) && ![COMMA, ARRAY_END, OBJECT_END].includes(b[i])) i++;
    return i;
  }
  let depth = 0;
  do {
    const c = b[i++];
    if (c === QUOTE) i = stringEnd(b, i - 1);
    else if (c === ARRAY_START || c === OBJECT_START) depth++;
    else if (c === ARRAY_END || c === OBJECT_END) depth--;
  } while (depth && i < b.length);
  return i;
}
function messagesStart(b: Buffer): number | undefined {
  let i = skipSpace(b, 0);
  if (b[i++] !== OBJECT_START) return;
  do {
    i = skipSpace(b, i);
    if (b[i] !== QUOTE) return;
    const end = stringEnd(b, i);
    const messages = end - i === 10 && b.toString('utf8', i, end) === '"messages"';
    i = skipSpace(b, skipSpace(b, end) + 1);
    if (messages && b[i] === ARRAY_START) return i + 1;
    i = skipSpace(b, valueEnd(b, i));
  } while (b[i++] === COMMA);
  return;
}

function messagesClose(bytes: Buffer, afterMessage: number): number {
  let i = skipSpace(bytes, afterMessage);
  while (bytes[i] === COMMA) i = skipSpace(bytes, valueEnd(bytes, skipSpace(bytes,i+1)));
  return bytes[i] === ARRAY_END ? i : -1;
}

/** JSON.parse chooses the last duplicate property, including escaped keys. */
function finalMessagesProperty(bytes: Buffer, close: number): boolean {
  let i = skipSpace(bytes, close + 1);
  while (bytes[i] === COMMA) {
    const key = skipSpace(bytes,i+1);
    if (bytes[key] !== QUOTE) return false;
    const end = stringEnd(bytes,key);
    if (JSON.parse(bytes.toString('utf8',key,end)) === 'messages') return false;
    i = skipSpace(bytes, valueEnd(bytes, skipSpace(bytes,skipSpace(bytes,end)+1)));
  }
  return bytes[i] === OBJECT_END;
}

interface Checkpoint<T> {
  count: number; length: number; digest: string; hash: Hash; prompt: T;
  start: number; headDigest: string; tailLength: number; tailDigest: string;
}
export interface SavingsReplay<T> {
  bodyKey?: (bytes: Buffer) => string;
  prefix(): {count: number; prompt: T; sameFrame: boolean} | undefined;
  remember(count: number, prompt: T): void;
}
export class SavingsHistory<T> {
  private readonly lanes = new Map<string, Checkpoint<T>>();
  request(lane: string, bytes: Buffer): SavingsReplay<T> | undefined {
    if (bytes.length < 64 * 1024) return;
    const previous = this.lanes.get(lane);
    // Check the most recent offset first. An unchanged head needs no JSON scan.
    const headHint = previous && bytes[previous.start - 1] === ARRAY_START
      ? digest(bytes.subarray(0, previous.start)) : undefined;
    const knownHead = previous && previous.headDigest === headHint;
    let start = knownHead ? previous.start : previous && messagesStart(bytes);
    const offset = start;
    const expectedClose = previous ? bytes.length - previous.tailLength : -1;
    let verified: Checkpoint<T> | undefined;
    let headDigest: string | undefined;
    let tailDigest: string | undefined;
    let close: number | undefined;
    let valid: boolean | undefined;
    const usable = (end: number) => {
      close ??= messagesClose(bytes, end);
      const knownTail = previous && close === expectedClose && tailDigest === previous.tailDigest;
      return valid ??= close >= 0 && (knownTail || finalMessagesProperty(bytes, close));
    };
    return {
      bodyKey: previous && offset !== undefined ? (body => {
        const end = offset + previous.length;
        const tail = Math.max(end, expectedClose);
        const head = body === bytes && knownHead ? headHint! : digest(body.subarray(0, offset));
        const middle = digest(body.subarray(offset, end));
        const rest = digest(body.subarray(tail));
        if (body === bytes) {
          headDigest = head;
          tailDigest = rest;
          if (middle === previous.digest && [COMMA, ARRAY_END].includes(body[skipSpace(body, end)])) {
            verified = previous;
          }
        }
        return head + middle + digest(body.subarray(end, tail)) + rest;
      }) : undefined,
      prefix: () => {
        if (!verified || !usable(offset! + verified.length)) return;
        const sameFrame = headDigest === verified.headDigest && close === expectedClose &&
          tailDigest === verified.tailDigest;
        return {count: verified.count, prompt: verified.prompt, sameFrame};
      },
      remember: (count, prompt) => {
        start ??= messagesStart(bytes);
        if (start === undefined || !count) return;
        const base = verified && verified.count <= count ? verified : undefined;
        let i = start + (base?.length ?? 0);
        const from = i;
        for (let n = base?.count ?? 0; n < count; n++) {
          i = skipSpace(bytes, i);
          if (n && bytes[i++] !== COMMA) return;
          i = valueEnd(bytes, skipSpace(bytes, i));
        }
        if (!usable(i)) return;
        const hash = (base?.hash.copy() ?? createHash('sha256')).update(bytes.subarray(from,i));
        this.lanes.delete(lane);
        this.lanes.set(lane, {
          hash, digest: hash.copy().digest('hex'), count, length: i - start, prompt, start,
          headDigest: headDigest ?? digest(bytes.subarray(0, start)),
          tailLength: bytes.length - close!,
          tailDigest: close === expectedClose && tailDigest ? tailDigest : digest(bytes.subarray(close!)),
        });
        if (this.lanes.size > 32) this.lanes.delete(this.lanes.keys().next().value!);
      },
    };
  }
}
