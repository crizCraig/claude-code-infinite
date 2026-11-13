// UTF-8 "byte strings" for the redaction twin: one JS char per UTF-8 byte (0x00-0xFF), so
// regexes, offsets and byte windows behave as in polychat's Python detector, which works on
// text.encode("utf-8", "surrogatepass"). A lone surrogate is encoded as its 3 bytes the way
// surrogatepass does, and decoded back, so the round trip never changes the text.
const NON_ASCII = /[^\x00-\x7f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const ENCODED_SURROGATE = /\xed[\xa0-\xbf]/;
/** The UTF-8 bytes of text as a byte string (the same string when it is ASCII). */
export function toBytes(text) {
    if (!NON_ASCII.test(text))
        return text;
    if (!LONE_SURROGATE.test(text))
        return Buffer.from(text, "utf8").toString("latin1");
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
        const unit = text.charCodeAt(i);
        const next = text.charCodeAt(i + 1);
        if (unit >= 0xd800 && unit < 0xdc00 && next >= 0xdc00 && next < 0xe000) {
            out += Buffer.from(text.slice(i, i + 2), "utf8").toString("latin1");
            i += 1;
        }
        else if (unit >= 0xd800 && unit < 0xe000) {
            out += String.fromCharCode(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
        }
        else {
            out += Buffer.from(text[i], "utf8").toString("latin1");
        }
    }
    return out;
}
/** The text of a byte string made by toBytes (markers inserted between characters). */
export function fromBytes(data) {
    if (!NON_ASCII.test(data))
        return data;
    if (!ENCODED_SURROGATE.test(data))
        return Buffer.from(data, "latin1").toString("utf8");
    let out = "";
    let pos = 0;
    for (let at = data.search(ENCODED_SURROGATE); at !== -1; at = searchAfter(data, pos)) {
        out += Buffer.from(data.slice(pos, at), "latin1").toString("utf8");
        out += String.fromCharCode(((data.charCodeAt(at) & 0x0f) << 12)
            | ((data.charCodeAt(at + 1) & 0x3f) << 6) | (data.charCodeAt(at + 2) & 0x3f));
        pos = at + 3;
    }
    return out + Buffer.from(data.slice(pos), "latin1").toString("utf8");
}
/** ASCII-only lowercase (Python bytes.lower): other bytes keep their values and offsets. */
export function asciiLower(value) {
    return value.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}
/** The characters of a byte string decoded as UTF-8, skipping invalid bytes (Python's
 * decode("utf-8", "ignore"): no surrogates, no overlong forms). */
export function decodeIgnore(data) {
    const chars = [];
    let i = 0;
    while (i < data.length) {
        const size = sequenceSize(data, i);
        if (size === 0) {
            i += 1;
            continue;
        }
        chars.push(Buffer.from(data.slice(i, i + size), "latin1").toString("utf8"));
        i += size;
    }
    return chars;
}
/** Bytes in the valid UTF-8 sequence at i (1-4), or 0 when it is not one. */
function sequenceSize(data, i) {
    const b0 = data.charCodeAt(i);
    if (b0 < 0x80)
        return 1;
    const [size, lo, hi] = leadByte(b0);
    if (size === 0 || i + size > data.length)
        return 0;
    const b1 = data.charCodeAt(i + 1);
    if (b1 < lo || b1 > hi)
        return 0;
    for (let k = 2; k < size; k += 1) {
        const b = data.charCodeAt(i + k);
        if (b < 0x80 || b > 0xbf)
            return 0;
    }
    return size;
}
/** [sequence size, allowed range of the second byte] for a lead byte (size 0: invalid). */
function leadByte(b0) {
    if (b0 >= 0xc2 && b0 <= 0xdf)
        return [2, 0x80, 0xbf];
    if (b0 === 0xe0)
        return [3, 0xa0, 0xbf];
    if (b0 === 0xed)
        return [3, 0x80, 0x9f];
    if (b0 >= 0xe1 && b0 <= 0xef)
        return [3, 0x80, 0xbf];
    if (b0 === 0xf0)
        return [4, 0x90, 0xbf];
    if (b0 >= 0xf1 && b0 <= 0xf3)
        return [4, 0x80, 0xbf];
    if (b0 === 0xf4)
        return [4, 0x80, 0x8f];
    return [0, 0, 0];
}
function searchAfter(data, pos) {
    const at = data.slice(pos).search(ENCODED_SURROGATE);
    return at === -1 ? -1 : pos + at;
}
//# sourceMappingURL=utf8-bytes.js.map