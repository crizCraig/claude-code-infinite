/** Verify reusable plain-prompt checkpoints after a modified request has been forwarded. */
import { createHash } from 'node:crypto';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const white = (c) => c === 32 || c === 9 || c === 13 || c === 10;
function skipSpace(b, i) {
    while (white(b[i]))
        i++;
    return i;
}
const QUOTE = 34, BACKSLASH = 92, COMMA = 44;
const ARRAY_START = 91, ARRAY_END = 93, OBJECT_START = 123, OBJECT_END = 125;
function stringEnd(b, i) {
    for (;;) {
        const quote = b.indexOf(QUOTE, i + 1);
        if (quote < 0)
            return b.length;
        let slash = quote;
        while (slash > i && b[slash - 1] === BACKSLASH)
            slash--;
        if ((quote - slash) % 2 === 0)
            return quote + 1;
        i = quote;
    }
}
/** Skip one value in an already JSON-parsed body. Skip string payloads natively. */
function valueEnd(b, i) {
    if (b[i] === QUOTE)
        return stringEnd(b, i);
    if (b[i] !== ARRAY_START && b[i] !== OBJECT_START) {
        while (i < b.length && !white(b[i]) && ![COMMA, ARRAY_END, OBJECT_END].includes(b[i]))
            i++;
        return i;
    }
    let depth = 0;
    do {
        const c = b[i++];
        if (c === QUOTE)
            i = stringEnd(b, i - 1);
        else if (c === ARRAY_START || c === OBJECT_START)
            depth++;
        else if (c === ARRAY_END || c === OBJECT_END)
            depth--;
    } while (depth && i < b.length);
    return i;
}
function messagesStart(b) {
    let i = skipSpace(b, 0);
    if (b[i++] !== OBJECT_START)
        return;
    do {
        i = skipSpace(b, i);
        if (b[i] !== QUOTE)
            return;
        const end = stringEnd(b, i);
        const messages = end - i === 10 && b.toString('utf8', i, end) === '"messages"';
        i = skipSpace(b, skipSpace(b, end) + 1);
        if (messages && b[i] === ARRAY_START)
            return i + 1;
        i = skipSpace(b, valueEnd(b, i));
    } while (b[i++] === COMMA);
    return;
}
function messagesClose(bytes, afterMessage) {
    let i = skipSpace(bytes, afterMessage);
    while (bytes[i] === COMMA)
        i = skipSpace(bytes, valueEnd(bytes, skipSpace(bytes, i + 1)));
    return bytes[i] === ARRAY_END ? i : -1;
}
/** JSON.parse chooses the last duplicate property, including escaped keys. */
function finalMessagesProperty(bytes, close) {
    let i = skipSpace(bytes, close + 1);
    while (bytes[i] === COMMA) {
        const key = skipSpace(bytes, i + 1);
        if (bytes[key] !== QUOTE)
            return false;
        const end = stringEnd(bytes, key);
        if (JSON.parse(bytes.toString('utf8', key, end)) === 'messages')
            return false;
        i = skipSpace(bytes, valueEnd(bytes, skipSpace(bytes, skipSpace(bytes, end) + 1)));
    }
    return bytes[i] === OBJECT_END;
}
export class SavingsHistory {
    lanes = new Map();
    request(lane, bytes) {
        if (bytes.length < 64 * 1024)
            return;
        const previous = this.lanes.get(lane);
        // Check the most recent offset first. An unchanged head needs no JSON scan.
        const headHint = previous && bytes[previous.start - 1] === ARRAY_START
            ? digest(bytes.subarray(0, previous.start)) : undefined;
        const knownHead = previous && previous.headDigest === headHint;
        let start = knownHead ? previous.start : previous && messagesStart(bytes);
        const expectedClose = previous ? bytes.length - previous.tailLength : -1;
        let verified;
        const headDigest = knownHead ? headHint : start === undefined ? undefined : digest(bytes.subarray(0, start));
        const tailDigest = expectedClose < 0 ? undefined : digest(bytes.subarray(expectedClose));
        if (previous && start !== undefined) {
            const end = start + previous.length;
            if ([COMMA, ARRAY_END].includes(bytes[skipSpace(bytes, end)]) &&
                digest(bytes.subarray(start, end)) === previous.digest)
                verified = previous;
        }
        let close;
        let valid;
        const usable = (end) => {
            close ??= messagesClose(bytes, end);
            const knownTail = previous && close === expectedClose && tailDigest === previous.tailDigest;
            return valid ??= close >= 0 && (knownTail || finalMessagesProperty(bytes, close));
        };
        return {
            prefix: () => {
                if (!verified || start === undefined || !usable(start + verified.length))
                    return;
                const sameFrame = headDigest === verified.headDigest && close === expectedClose &&
                    tailDigest === verified.tailDigest;
                return { count: verified.count, prompt: verified.prompt, sameFrame };
            },
            remember: (count, prompt) => {
                start ??= messagesStart(bytes);
                if (start === undefined || !count)
                    return;
                const base = verified && verified.count <= count ? verified : undefined;
                let i = start + (base?.length ?? 0);
                const from = i;
                for (let n = base?.count ?? 0; n < count; n++) {
                    i = skipSpace(bytes, i);
                    if (n && bytes[i++] !== COMMA)
                        return;
                    i = valueEnd(bytes, skipSpace(bytes, i));
                }
                if (!usable(i))
                    return;
                const hash = (base?.hash.copy() ?? createHash('sha256')).update(bytes.subarray(from, i));
                this.lanes.delete(lane);
                this.lanes.set(lane, {
                    hash, digest: hash.copy().digest('hex'), count, length: i - start, prompt, start,
                    headDigest: headDigest ?? digest(bytes.subarray(0, start)),
                    tailLength: bytes.length - close,
                    tailDigest: close === expectedClose && tailDigest ? tailDigest : digest(bytes.subarray(close)),
                });
                if (this.lanes.size > 32)
                    this.lanes.delete(this.lanes.keys().next().value);
            },
        };
    }
}
//# sourceMappingURL=savings-history.js.map