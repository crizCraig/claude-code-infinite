// Financial-detail rules: cards, bank details, IBANs, SSNs (twin of polychat's
// polychat/financial_redaction.py). Change both together: the shared golden vectors
// (test/fixtures/secret_redaction_vectors.json, "financial_vectors") must match byte for byte.
//
// Everything here works on a "byte string": the text's UTF-8 bytes, one char per byte
// (see utf8-bytes.ts), so offsets, the 40-byte context windows and the 200-byte line reach are
// the same as in Python. Each rule has to prove itself; a long number alone is never enough:
//
// - card_number: 13-19 digits (one consistent space or dash between groups), a known IIN
//   prefix with that brand's length, and a valid Luhn check digit. Public test cards and
//   numbers of 3 or fewer distinct digits are kept.
// - bank_routing: 9 digits, ABA checksum, a Federal Reserve prefix and a context word
//   ("routing", "ABA", "RTN", "transit") within 40 bytes.
// - iban: country code, that country's length, mod-97 = 1.
// - bank_account: 6-17 digits after an account label, or another standalone such number on
//   the line of a detected routing number.
// - ssn: NNN-NN-NNNN outside never-issued ranges; dashless/spaced only with SSN context.
//
// A number never counts inside a longer token (next to a letter, digit or "_", or joined to
// one by ".-/:+@"). Every pattern is bounded.
import { asciiLower, decodeIgnore } from "./utf8-bytes.js";
export const CARD = "card_number";
export const ROUTING = "bank_routing";
export const IBAN = "iban";
export const ACCOUNT = "bank_account";
export const SSN = "ssn";
export const FINANCIAL_KINDS = [CARD, ROUTING, IBAN, ACCOUNT, SSN];
const CONTEXT_WINDOW = 40; // bytes either side searched for a routing/SSN context word
const MAX_WORD = 24; // longer than any context word plus its lookahead byte
const KEY_MAX = 32; // a longer field key is reduced to its context words
const LINE_REACH = 200; // bytes either side of a routing number searched for its line
const ACCOUNT_NEGATIVE_REACH = 24; // bytes before "account" searched for a non-bank qualifier
const ALNUM = /^[A-Za-z0-9_]$/;
const UNICODE_ALNUM = /^[\p{L}\p{N}]$/u;
const JOINERS = ".-/:+@";
const JSON_ESCAPES = "nrt";
const DIGIT_RUN = /(?<![0-9])[0-9]{6,19}(?![0-9])/g;
// 4-4-4-4 (16), 4-4-4-4-3 (19), Amex 4-6-5 (15), Diners 4-6-4 (14); one separator.
const CARD_GROUPED = /(?<![0-9])[0-9]{4}([ -])(?:[0-9]{4}\1[0-9]{4}\1[0-9]{4}(\1[0-9]{3})?|[0-9]{6}\1[0-9]{4,5})(?![0-9])/dg;
const SSN_DASHED = /(?<![0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9])/g;
const SSN_SPACED = /(?<![0-9])[0-9]{3} [0-9]{2} [0-9]{4}(?![0-9])/g;
const IBAN_CANDIDATE = /(?<![A-Za-z0-9_])[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9_])/g;
// A word starts after a non-letter, or after a JSON escape (\n, \t, \r) read as raw text.
const WORD_START = String.raw `(?:(?<![a-z])|(?<=\\[nrt]))`;
const ROUTING_CONTEXT = new RegExp(WORD_START + "(?:routing|transit|aba|rtn)(?:numbers?|num|nbr|no)?(?![a-z])", "g");
const SSN_CONTEXT = new RegExp(WORD_START + String.raw `(?:ssn|social[ _\-]?security|soc[ .]?sec)(?![a-z])`, "g");
const ACCOUNT_WORD = new RegExp(WORD_START + "(?:account|acct|a/c)", "g");
const KEY_ACCOUNT_LABEL = new RegExp(WORD_START + String.raw `(?:account|acct|a/c)[ _\-]?(?:numbers?|num|nbr|no|#)(?![a-z])`);
// What may sit between an account word and its number ("account" needs a label or ":#=").
const ACCOUNT_TAIL = new RegExp(String.raw `(?<label>[ _\-]?(?:numbers?|num|nbr|no\.?|#))?["']?[ \t]{0,3}`
    + String.raw `(?<sep>[:#=]|is(?= )|-(?= ))?[ \t]{0,3}["']?[ \t]{0,2}`, "y");
const ACCOUNT_PLAIN = /[0-9]{6,17}(?![0-9])/y;
const ACCOUNT_GROUPED = /[0-9]{2,6}([ -])[0-9]{2,6}(?:\1[0-9]{2,6}){0,3}(?![0-9])/y;
// 2026-10-27, 27-10-2026, 2026 10 27: a date after "account:".
const DATE = /^(?:(?:19|20)[0-9]{2}([ -])[01][0-9]\1[0-3][0-9]|[0-3][0-9]([ -])[01][0-9]\2(?:19|20)[0-9]{2})$/;
const ACCOUNT_NEGATIVE = /(?<![a-z])(?:aws|gcp|google|azure|service|stripe)(?![a-z])/g;
const LINE_END = /\n|\\n/;
const CARD_FIRST_DIGITS = "23456"; // every brand below starts with one of these
// A financial label glued to a colon before a number. (?=\n?$) is Python's "$".
const COLON_LABEL = /(?<![a-z])(?:routing|transit|aba|rtn|ssn|security|account|acct|a\/c|iban|card|pan|number|num|nbr|no)(?=\n?$)/;
const LINE_NUMBER = /(?<![0-9])[0-9]{2,17}/g;
const TWO_DIGITS = /[0-9]{2}/;
const MARKER_LOW = "[redacted:";
const MARKER_RE = /\[redacted:[a-z_]{1,40}\]/g;
// [brand, prefixes as [low, high] over the first String(low).length digits, lengths].
const BRANDS = [
    ["visa", [[4, 4]], new Set([13, 16, 19])],
    ["mastercard", [[51, 55], [2221, 2720]], new Set([16])],
    ["amex", [[34, 34], [37, 37]], new Set([15])],
    ["discover", [[6011, 6011], [65, 65], [644, 649]], new Set([16, 17, 18, 19])],
    ["jcb", [[3528, 3589]], new Set([16, 17, 18, 19])],
    ["diners", [[300, 305], [3095, 3095], [36, 36], [38, 39]], new Set([14, 15, 16, 17, 18, 19])],
];
// Public test numbers from Stripe, Braintree, Adyen and card-network docs: kept as written.
const TEST_CARDS = new Set([
    "4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222",
    "5200828282828210", "5105105105105100", "378282246310005", "371449635398431",
    "6011111111111117", "6011000990139424", "6011981111111113", "3056930009020004",
    "36227206271667", "6555900000604105", "3566002020360505", "6200000000000005",
    "4000002500003155", "4000002760003184", "4000003800000446", "4000000000003220",
    "4000000000009995", "4000000000000002", "4000000000000069", "4000000000000127",
    "4000000000000119", "4000000000000077", "4000000000000341", "4100000000000019",
    "4000000000000101", "4111111111111111", "4005519200000004", "4009348888881881",
    "4012000033330026", "4012000077777777", "4012888888881881", "4217651111111119",
    "4500600000000061", "3530111333300000", "30569309025904", "38520000023237",
    "2223000048400011", "4111111145551142", "4988438843884305", "5101180000000007",
    "2222400070000005", "5555444433331111", "370000000000002", "6011601160116611",
    "3600666633336666", "3569990010095841", "4400000000000008", "5500000000000004",
    "4166676667666746", "4646464646464644", "5577000055770004", "4000020000000000",
    "5454545454545454", "4222222222222", "4012888888881", "378734493671000",
    "6011000400000000", "3566111111111113", "5425233430109903", "2222420000001113",
    "4263982640269299", "4917484589897107", "5185540810000019", "4035501000000008",
]);
// Public example IBANs (ECBS, Wikipedia, provider docs) and Stripe's test bank details.
const TEST_IBANS = new Set([
    "DE89370400440532013000", "GB82WEST12345698765432", "GB29NWBK60161331926819",
    "FR1420041010050500013M02606", "NL91ABNA0417164300", "ES9121000418450200051332",
    "IT60X0542811101000000123456", "BE68539007547034", "CH9300762011623852957",
    "AT611904300234573201", "DE89370400440532013001",
]);
const TEST_ROUTING = new Set(["110000000"]);
const TEST_ACCOUNTS = new Set(["000123456789", "000111111116", "000222222227", "000333333335",
    "000444444440", "000111111113", "1234567890", "123456789"]);
const EXAMPLE_SSNS = new Set(["123456789", "078051120", "219099999"]);
const IBAN_LENGTHS = {
    AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
    BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
    EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
    GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
    IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
    LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18,
    NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24,
    SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24,
    TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};
const ROUTING_PREFIXES = new Set([
    ...range(0, 13), ...range(21, 33), ...range(61, 73), 80,
]);
/** Non-overlapping [start, end, kind] spans of financial details in a byte string. */
export function financialSpans(data) {
    if (!TWO_DIGITS.test(data))
        return [];
    const low = blankMarkers(asciiLower(data));
    const spans = [...cardSpans(data), ...ibanSpans(data), ...ssnDashedSpans(data)];
    const routing = nineDigitSpans(data, low); // before accounts: a proven routing number wins
    spans.push(...routing, ...accountContextSpans(data, low));
    spans.push(...routingLineSpans(data, routing.filter((s) => s[2] === ROUTING)));
    return nonOverlapping(spans);
}
/** financialSpans of a field value whose key ("routing_number"...) is context. */
export function spansWithContext(data, context) {
    if (!context)
        return financialSpans(data);
    const [joined, offset] = withContext(data, context);
    return financialSpans(joined).filter((s) => s[0] >= offset)
        .map(([s, e, k]) => [s - offset, e - offset, k]);
}
// --------------------------------------------------------------------------- rules
function cardSpans(data) {
    const spans = [];
    for (const m of data.matchAll(DIGIT_RUN)) {
        const end = m.index + m[0].length;
        if (standalone(data, m.index, end) && isCard(m[0]))
            spans.push([m.index, end, CARD]);
    }
    let pos = 0; // a rejected grouped candidate is searched again from inside ("2026 4532 ...")
    let m;
    while ((m = searchFrom(CARD_GROUPED, data, pos)) !== null) {
        const end = groupedCardEnd(data, m);
        if (end !== null)
            spans.push([m.index, end, CARD]);
        pos = end ?? m.index + 5; // the next group
    }
    return spans;
}
/** Where a grouped card ends: all of it, else without its 3-digit tail, or null. */
function groupedCardEnd(data, m) {
    if (!CARD_FIRST_DIGITS.includes(data[m.index]))
        return null;
    const ends = [m.index + m[0].length];
    if (m[2] !== undefined)
        ends.push(m.indices[2][0]);
    for (const end of ends) {
        if (standalone(data, m.index, end) && isCard(digits(data.slice(m.index, end))))
            return end;
    }
    return null;
}
/** IBANs; after a rejected candidate the search resumes inside it. */
function ibanSpans(data) {
    const spans = [];
    let pos = 0;
    let m;
    while ((m = searchFrom(IBAN_CANDIDATE, data, pos)) !== null) {
        const end = ibanEnd(data, m);
        if (end !== null)
            spans.push([m.index, end, IBAN]);
        pos = end ?? m.index + 1;
    }
    return spans;
}
/** The end of the IBAN at m: its country's length of alnum chars from the start, or null. */
function ibanEnd(data, m) {
    const want = IBAN_LENGTHS[m[0].slice(0, 2)];
    if (want === undefined)
        return null;
    const stop = m.index + m[0].length;
    let end = m.index;
    let seen = 0;
    while (end < stop && seen < want) {
        if (data[end] !== " ")
            seen += 1;
        end += 1;
    }
    if (seen !== want || !standalone(data, m.index, end))
        return null;
    return isIban(data.slice(m.index, end).replaceAll(" ", "")) ? end : null;
}
function ssnDashedSpans(data) {
    const spans = [];
    for (const m of data.matchAll(SSN_DASHED)) {
        const end = m.index + m[0].length;
        if (standalone(data, m.index, end) && isSsn(digits(m[0])))
            spans.push([m.index, end, SSN]);
    }
    return spans;
}
/** Contiguous or spaced 9-digit numbers proven by context: routing first, then SSN. */
function nineDigitSpans(data, low) {
    const spans = [];
    for (const m of data.matchAll(DIGIT_RUN)) {
        const end = m.index + m[0].length;
        if (m[0].length !== 9 || !standalone(data, m.index, end))
            continue;
        const kind = nineDigitKind(low, m.index, end, m[0]);
        if (kind)
            spans.push([m.index, end, kind]);
    }
    for (const m of data.matchAll(SSN_SPACED)) {
        const end = m.index + m[0].length;
        if (standalone(data, m.index, end) && isSsn(digits(m[0]))
            && near(SSN_CONTEXT, low, m.index, end))
            spans.push([m.index, end, SSN]);
    }
    return spans;
}
function nineDigitKind(low, start, end, value) {
    if (isRouting(value) && near(ROUTING_CONTEXT, low, start, end))
        return ROUTING;
    if (isSsn(value) && near(SSN_CONTEXT, low, start, end))
        return SSN;
    return null;
}
function accountContextSpans(data, low) {
    const spans = [];
    for (const word of low.matchAll(ACCOUNT_WORD)) {
        const span = accountAfter(data, low, word.index, word[0]);
        if (span !== null)
            spans.push(span);
    }
    return spans;
}
function accountAfter(data, low, wordStart, word) {
    ACCOUNT_TAIL.lastIndex = wordStart + word.length;
    const tail = ACCOUNT_TAIL.exec(low); // every part is optional: always matches
    const tailEnd = tail.index + tail[0].length;
    const sep = tail.groups.sep;
    if (word === "account" && !tail.groups.label && !(sep === ":" || sep === "#" || sep === "=")) {
        return null;
    }
    if (searchWithin(ACCOUNT_NEGATIVE, low, Math.max(0, wordStart - ACCOUNT_NEGATIVE_REACH), wordStart, 1) !== null)
        return null;
    if (tailEnd > 0 && wordBefore(data, tailEnd))
        return null; // acct3829105567: one identifier
    const end = accountValueEnd(data, tailEnd);
    if (end === null || TEST_ACCOUNTS.has(digits(data.slice(tailEnd, end)))
        || DATE.test(data.slice(tailEnd, end)))
        return null;
    return [tailEnd, end, ACCOUNT];
}
/** End of the 6-17 digit account number at start: the most separated groups (2-5) that end
 * the number cleanly, else plain. */
function accountValueEnd(data, start) {
    ACCOUNT_GROUPED.lastIndex = start;
    const grouped = ACCOUNT_GROUPED.exec(data);
    if (grouped !== null) {
        const groupedEnd = start + grouped[0].length;
        const sep = grouped[1];
        const ends = [];
        for (let i = start; i < groupedEnd; i += 1)
            if (data[i] === sep)
                ends.push(i);
        const candidates = [...ends.slice(1), groupedEnd].reverse();
        for (const end of candidates) {
            const n = digits(data.slice(start, end)).length;
            if (n >= 6 && n <= 17 && rightOk(data, end))
                return end;
        }
    }
    ACCOUNT_PLAIN.lastIndex = start;
    const plain = ACCOUNT_PLAIN.exec(data);
    if (plain !== null && rightOk(data, start + plain[0].length))
        return start + plain[0].length;
    return null;
}
/** Other standalone 6-17 digit numbers on the line (record) of a routing number. */
function routingLineSpans(data, routing) {
    const own = new Set(routing.map((s) => s[0]));
    const spans = [];
    for (const [lo, hi] of merged(routing.map(([s, e]) => lineBounds(data, s, e)))) {
        const base = Math.max(0, lo - 1); // the lookbehind sees the byte before the line
        const window = data.slice(base, hi);
        let pos = lo;
        let m;
        while ((m = searchFrom(LINE_NUMBER, window, pos - base)) !== null) {
            const start = base + m.index;
            const end = own.has(start) ? null : lineAccountEnd(data, start, hi);
            if (end !== null)
                spans.push([start, end, ACCOUNT]);
            pos = end ?? start + m[0].length;
        }
    }
    return spans;
}
function lineAccountEnd(data, start, hi) {
    if (!leftOk(data, start))
        return null;
    const end = accountValueEnd(data, start);
    if (end === null || end > hi || DATE.test(data.slice(start, end))
        || TEST_ACCOUNTS.has(digits(data.slice(start, end))))
        return null;
    return end;
}
function merged(windows) {
    const out = [];
    for (const [lo, hi] of [...windows].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        const last = out[out.length - 1];
        if (last && lo <= last[1])
            last[1] = Math.max(last[1], hi);
        else
            out.push([lo, hi]);
    }
    return out;
}
function lineBounds(data, start, end) {
    const lo = Math.max(0, start - LINE_REACH);
    const hi = Math.min(data.length, end + LINE_REACH);
    const newline = rfind(data, "\n", lo, start);
    const escaped = rfind(data, "\\n", lo, start);
    const begin = Math.max(newline >= 0 ? newline + 1 : lo, escaped >= 0 ? escaped + 2 : lo);
    const after = LINE_END.exec(data.slice(end, hi));
    return [begin, after ? end + after.index : hi];
}
// --------------------------------------------------------------------------- checks
function isCard(value) {
    if (TEST_CARDS.has(value) || new Set(value).size <= 3)
        return false;
    return cardBrand(value) !== null && luhnOk(value);
}
function cardBrand(value) {
    for (const [brand, ranges, lengths] of BRANDS) {
        if (!lengths.has(value.length))
            continue;
        if (ranges.some(([lo, hi]) => {
            const head = Number(value.slice(0, String(lo).length));
            return lo <= head && head <= hi;
        }))
            return brand;
    }
    return null;
}
function luhnOk(value) {
    let total = 0;
    for (let i = 0; i < value.length; i += 1) {
        let d = value.charCodeAt(value.length - 1 - i) - 48;
        if (i % 2)
            d = d > 4 ? d * 2 - 9 : d * 2;
        total += d;
    }
    return total % 10 === 0;
}
function isRouting(value) {
    if (value.length !== 9 || TEST_ROUTING.has(value)
        || !ROUTING_PREFIXES.has(Number(value.slice(0, 2))))
        return false;
    const d = [...value].map((c) => c.charCodeAt(0) - 48);
    const total = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    return total % 10 === 0 && new Set(value).size > 2;
}
function isIban(value) {
    if (IBAN_LENGTHS[value.slice(0, 2)] !== value.length || TEST_IBANS.has(value))
        return false;
    const moved = value.slice(4) + value.slice(0, 4);
    let rest = 0;
    for (const c of moved) {
        for (const d of String(parseInt(c, 36)))
            rest = (rest * 10 + d.charCodeAt(0) - 48) % 97;
    }
    return rest === 1;
}
function isSsn(value) {
    if (value.length !== 9 || EXAMPLE_SSNS.has(value))
        return false;
    const area = value.slice(0, 3);
    return area !== "000" && area !== "666" && area[0] !== "9" && value.slice(3, 5) !== "00"
        && value.slice(5) !== "0000";
}
/** Not part of a longer token on either side. */
function standalone(data, start, end) {
    return leftOk(data, start) && rightOk(data, end);
}
function leftOk(data, start) {
    if (start === 0)
        return true;
    const prev = data[start - 1];
    if (JSON_ESCAPES.includes(prev) && start >= 2 && data[start - 2] === "\\")
        return true;
    if (wordBefore(data, start))
        return false;
    if (prev === ":"
        && COLON_LABEL.test(asciiLower(data.slice(Math.max(0, start - 21), start - 1)))) {
        return true; // routing:021000021, SSN:536-22-8714 (a label, not file:line)
    }
    return !(JOINERS.includes(prev) && start >= 2
        && (data[start - 2] === "]" || wordBefore(data, start - 1)));
}
function rightOk(data, end) {
    if (end >= data.length)
        return true;
    const next = data[end];
    if (wordAfter(data, end))
        return false;
    return !(JOINERS.includes(next) && end + 1 < data.length
        && (data[end + 1] === "]" || wordAfter(data, end + 1)));
}
/** The character ending at pos is a letter, digit or "_" (non-ASCII decoded). */
function wordBefore(data, pos) {
    if (data.charCodeAt(pos - 1) < 0x80)
        return ALNUM.test(data[pos - 1]);
    let start = pos - 1;
    while (start > 0 && pos - start < 4 && isContinuation(data.charCodeAt(start)))
        start -= 1;
    const chars = decodeIgnore(data.slice(start, pos));
    return chars.length > 0 && UNICODE_ALNUM.test(chars[chars.length - 1]);
}
/** The character starting at pos is a letter, digit or "_" (non-ASCII decoded). */
function wordAfter(data, pos) {
    if (data.charCodeAt(pos) < 0x80)
        return ALNUM.test(data[pos]);
    const chars = decodeIgnore(data.slice(pos, pos + 4));
    return chars.length > 0 && UNICODE_ALNUM.test(chars[0]);
}
function isContinuation(byte) {
    return byte >= 0x80 && byte < 0xc0;
}
/** A context word starting within CONTEXT_WINDOW bytes; the search runs past the window so
 * a word cut at its edge ("abandon" as "aba") is read whole. */
function near(pattern, low, start, end) {
    const lo = Math.max(0, start - CONTEXT_WINDOW);
    const hi = Math.min(low.length, end + CONTEXT_WINDOW);
    const m = searchWithin(pattern, low, lo, Math.min(low.length, hi + MAX_WORD), 2);
    return m !== null && m < hi;
}
/** data after its field key as "key: "; a key over KEY_MAX bytes is reduced to the words
 * the rules read (context, labels, non-bank qualifiers), in order. */
function withContext(data, context) {
    let key = context;
    if (key.length > KEY_MAX)
        key = keyContext(asciiLower(key));
    const prefix = key + ": ";
    return [prefix + data, prefix.length];
}
/** low with each redaction marker blanked (same length), so a marker's words are never
 * context for a number next to it. */
function blankMarkers(low) {
    if (!low.includes(MARKER_LOW))
        return low;
    return low.replace(MARKER_RE, (m) => " ".repeat(m.length));
}
/** What a long lowercased key proves: routing/SSN context words, and an account label only
 * when the key holds one, with no non-bank qualifier. */
function keyContext(low) {
    const words = [];
    if (searchFrom(ROUTING_CONTEXT, low, 0))
        words.push("routing");
    if (searchFrom(SSN_CONTEXT, low, 0))
        words.push("ssn");
    if (KEY_ACCOUNT_LABEL.test(low) && searchFrom(ACCOUNT_NEGATIVE, low, 0) === null) {
        words.push("account number");
    }
    return words.join(" ");
}
// --------------------------------------------------------------------------- helpers
function digits(value) {
    return value.replace(/[^0-9]/g, "");
}
function nonOverlapping(spans) {
    const kept = [];
    for (const span of [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
        if (kept.length === 0 || span[0] >= kept[kept.length - 1][1])
            kept.push(span);
    }
    return kept;
}
/** pattern (global) searched from pos, as Python's pattern.search(text, pos). */
function searchFrom(pattern, text, pos) {
    pattern.lastIndex = pos;
    return pattern.exec(text);
}
/** Start of pattern's first match in text[lo:hi) as Python's search(text, lo, hi): the
 * text ends at hi, and lookbehinds see up to `behind` bytes before lo. */
function searchWithin(pattern, text, lo, hi, behind) {
    const base = Math.max(0, lo - behind);
    const m = searchFrom(pattern, text.slice(base, hi), lo - base);
    return m === null ? null : base + m.index;
}
/** Python's str.rfind(sub, lo, hi): the last start i with text[i:i+len(sub)] in [lo, hi). */
function rfind(text, sub, lo, hi) {
    if (hi - sub.length < lo)
        return -1;
    const i = text.slice(lo, hi).lastIndexOf(sub); // a slice: never scans before lo
    return i === -1 ? -1 : lo + i;
}
function range(lo, hi) {
    return Array.from({ length: hi - lo }, (_, i) => lo + i);
}
//# sourceMappingURL=financial-redaction.js.map