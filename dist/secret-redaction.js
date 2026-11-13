// Secret and financial-detail redaction: the TypeScript twin of polychat's
// polychat/secret_redaction.py (+ financial_redaction.py).
//
// redact(text) replaces API keys, tokens, passwords, private keys and (financial: true, the
// default) card, bank, IBAN and SSN numbers with "[REDACTED:<kind>]" and returns counts by
// kind. Local, free, no network. The output must match the Python detector byte for byte:
// both are checked against the shared golden vectors (test/fixtures/
// secret_redaction_vectors.json, copied from polychat). Change both together.
//
// Not wired into uploads yet: ccc sends conversations to Polychat as they are and Polychat
// redacts what it stores and shows (docs/secret_redaction.md in polychat). This module keeps
// the client able to redact identically once it does (plan item 28 decides where).
//
// Like the Python detector it works on the text's UTF-8 bytes (utf8-bytes.ts), so offsets
// and byte windows agree. Every pattern is bounded. Text without a secret comes back as the
// same string, so secret-free payloads (and their hashes) are unchanged.
import { spansWithContext } from "./financial-redaction.js";
import { asciiLower, fromBytes, toBytes } from "./utf8-bytes.js";
// 1: secrets. 2: secrets and financial details (polychat MEMTREE_FINANCIAL_REDACTION on).
export const REDACTION_VERSION = 2;
export const REDACTED_PREFIX = "[REDACTED:";
const FINANCIAL_ROUNDS = 3;
const TOK = "A-Za-z0-9_\\-";
const TOK_CHAR = /[A-Za-z0-9_-]/;
const END = `(?![${TOK}])`;
const MIN_RUN = 16;
// Provider tokens matched at the start of a run of 16+ token chars: [kind, prefixes, regex].
const RUN_TOKENS = [
    ["openai_key", ["sk-"], new RegExp(`sk-[${TOK}]{20,400}`, "y")],
    ["groq_key", ["gsk_"], new RegExp(`gsk_[A-Za-z0-9]{30,200}${END}`, "y")],
    ["xai_key", ["xai-"], new RegExp(`xai-[A-Za-z0-9]{40,200}${END}`, "y")],
    ["huggingface_token", ["hf_"], new RegExp(`hf_[A-Za-z0-9]{30,200}${END}`, "y")],
    ["replicate_token", ["r8_"], new RegExp(`r8_[A-Za-z0-9]{30,200}${END}`, "y")],
    ["perplexity_key", ["pplx-"], new RegExp(`pplx-[A-Za-z0-9]{40,200}${END}`, "y")],
    ["voyage_key", ["pa-"], new RegExp(`pa-[${TOK}]{40,200}${END}`, "y")],
    ["google_api_key", ["AIza"], new RegExp(`AIza[0-9A-Za-z_\\-]{35}${END}`, "y")],
    ["github_token", ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
        new RegExp(`gh[pousr]_[A-Za-z0-9]{36,255}${END}`, "y")],
    ["github_token", ["github_pat_"], new RegExp(`github_pat_[A-Za-z0-9_]{40,255}${END}`, "y")],
    ["gitlab_token", ["glpat-"], new RegExp(`glpat-[${TOK}]{20,100}${END}`, "y")],
    ["stripe_key", ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
        new RegExp(`[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}${END}`, "y")],
    ["slack_token", ["xox"], new RegExp(`xox[abposr]-[A-Za-z0-9\\-]{10,255}${END}`, "y")],
    ["aws_access_key_id", ["AKIA", "ASIA"], new RegExp(`A[KS]IA[A-Z0-9]{16}${END}`, "y")],
    ["jwt", ["eyJ"], new RegExp(`eyJ[${TOK}]{8,4000}\\.eyJ[${TOK}]{8,8000}\\.[${TOK}]{8,2000}`, "y")],
];
const RUN_RE = new RegExp(`[${TOK}]{${MIN_RUN},}`, "g");
const B64 = /[A-Za-z0-9+/=]/;
// Tokens with non-token chars early on: [kind, trigger, pattern, chars that continue its run].
const SCAN_TOKENS = [
    ["stripe_webhook_secret", "whsec_", /whsec_[A-Za-z0-9+/=]{24,255}/g, B64],
    ["slack_webhook", "hooks.slack.com",
        /hooks\.slack\.com\/services\/T[A-Za-z0-9_]{6,20}\/B[A-Za-z0-9_]{6,20}\/[A-Za-z0-9_]{16,64}/g,
        /[A-Za-z0-9_]/],
    ["sendgrid_key", "SG.", new RegExp(`SG\\.[${TOK}]{16,32}\\.[${TOK}]{16,64}${END}`, "g"),
        TOK_CHAR],
];
const SK_KINDS = [
    ["sk-ant-", "anthropic_key"], ["sk-or-", "openrouter_key"], ["sk-nano-", "nanogpt_key"],
];
// Byte-string classes: \x7f-\xff is every non-ASCII byte.
const URL_PASSWORD = new RegExp("://[^\\x00-\\x20\\x7f-\\xff:/@\"'<>\\\\]{0,128}:"
    + "([^\\x00-\\x20\\x7f-\\xff/@\"'<>\\\\]{1,256})@(?=[A-Za-z0-9\\[])", "g");
const BEARERS = ["Bearer", "bearer", "BEARER"].map((w) => new RegExp(`${w}[ \\t]{1,4}([A-Za-z0-9._~+/=\\-]{16,2000})`, "g"));
const BASIC_AUTHS = ["Authorization", "authorization"].map((w) => new RegExp(`${w}["']?[ \\t]{0,3}[:=][ \\t]{0,3}["']?[Bb]asic[ \\t]{1,4}([A-Za-z0-9+/=]{8,1000})`, "g"));
// Name roots, found in an ASCII-lowercased copy (overlapping hits kept).
const NAME_HIT = /pass|pwd|secret|token|key|auth|credential/g;
const ASSIGN_TAIL = new RegExp("([A-Za-z0-9_\\-]{0,40})[\"']?[ \\t]{0,3}(?::=|=>|[:=])[ \\t]{0,3}"
    + "([\"'`]?)([\\x21-\\x7e]{1,300})", "y");
const VALUE_STOP = /["'`<>,;&()[\]{}\\]/;
const KEY_QUALIFIED = /(?:api|access|secret|private|signing|encryption|master|account|service|auth|client|license|admin|app)[_-]?key/;
const NON_SECRET_NAME_ENDS = [
    "hash", "_id", "_len", "_length", "_count", "_type", "_name", "_path", "_file", "_url",
    "_uri", "_endpoint", "_env", "_var", "_header", "_prefix", "_field", "_min", "_max",
    "_size", "_limit", "_ttl", "_expiry", "_at", "_secs", "_seconds", "_version", "_dir",
];
const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]{1,12} ){0,3}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END (?:[A-Z0-9]{1,12} ){0,3}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_BODY = /(?:\r?\n|\\n)?(?:[A-Za-z0-9+/=]{1,200}(?:\r?\n|\\n)?){0,400}/y;
const PEM_MAX = 20000;
const PEM_MIN_BODY = 64;
// Each newline with the one byte before it when that byte decides whether it is a line
// break for polychat's splitter (?<!\\)\r?\n: kept exactly so line addresses never move.
const LINE_BREAK = /[\\\r]?\n/g;
const PLACEHOLDER_WORDS = new Set([
    "none", "null", "nil", "true", "false", "undefined", "required", "optional", "string",
    "str", "int", "bool", "env", "changeme", "password", "secret", "token", "example",
    "redacted", "your_api_key", "xxx", "todo", "dummy", "test", "default",
]);
const HEX = /^[0-9a-fA-F]+$/;
// YOUR_PASSWORD_HERE, db_password, my-db-pass: names and placeholders, not passwords.
const WORDS_IDENT = /^(?:[A-Z]+(?:[_-][A-Z]+)+|[a-z]+(?:[_-][a-z]+)+)$/;
const DOTTED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MIN_PASSWORD_ENTROPY = 2.0;
// Structured fields ({"password": "..."}): an identifier key and one printable-ASCII word.
const FIELD_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const FIELD_VALUE = /^[\x21-\x7e]{1,300}$/;
const BINARY_PAYLOAD_KEYS = new Set(["data", "file_data"]);
const DATA_URI_KEYS = new Set(["url", "image_url", "file_data", "data"]);
const BASE64_TEXT = /^[A-Za-z0-9+/=\r\n]{16,}$/;
const BASE64_DATA_URI = /^data:[A-Za-z0-9.+-]{1,64}\/[A-Za-z0-9.+-]{1,128}(?:;[A-Za-z0-9.+-]{1,64}=[A-Za-z0-9.+-]{1,128}){0,4};base64,/;
const MEDIA_TYPES = new Set(["image", "image_url", "input_image", "document", "file"]);
/** Text with secrets replaced, and counts by kind. Secret-free text is returned as is. */
export function redact(text, options = {}) {
    if (typeof text !== "string" || text.length === 0)
        return { text, counts: {} };
    const counts = {};
    const out = redactBytes(toBytes(text), counts, options.financial ?? true, toBytes(options.context ?? ""));
    return Object.keys(counts).length ? { text: fromBytes(out), counts } : { text, counts: {} };
}
/**
 * Redact every string in a JSON-like value. A string under a secret-named key
 * ({"password": "..."}) is checked as that name's assigned value; every key is the
 * financial rules' context. Only base64 media payloads are kept as they are. Returns the
 * same object when nothing was redacted (so unchanged payloads stay identical).
 */
export function redactValue(value, counts = {}, options = {}) {
    return walk(value, counts, null, false, options.financial ?? true);
}
export function formatCounts(counts) {
    const keys = Object.keys(counts).sort();
    return keys.length ? keys.map((k) => `${k}=${counts[k]}`).join(", ") : "none";
}
function marker(kind) {
    return `${REDACTED_PREFIX}${kind}]`;
}
function redactBytes(data, counts, financial, context) {
    let out = apply(data, pemSpans(data), counts);
    out = apply(out, tokenSpans(out), counts);
    if (out.includes("://"))
        out = apply(out, urlSpans(out), counts);
    out = apply(out, headerSpans(out), counts);
    out = apply(out, assignmentSpans(out), counts);
    if (!financial)
        return out;
    // A marker shorter than its value moves context words closer: repeat until stable.
    for (let round = 0; round < FINANCIAL_ROUNDS; round += 1) {
        const spans = spansWithContext(out, context);
        if (spans.length === 0)
            break;
        out = apply(out, spans, counts);
    }
    return out;
}
// --------------------------------------------------------------------------- values
function walk(value, counts, key, media, financial) {
    if (typeof value === "string") {
        const result = redactField(key, value, financial);
        for (const [k, n] of Object.entries(result.counts))
            counts[k] = (counts[k] ?? 0) + n;
        return result.text;
    }
    if (Array.isArray(value)) {
        return mapIfChanged(value, (v) => walk(v, counts, key, media, financial));
    }
    if (isRecord(value)) {
        const inner = media || isBinaryPart(value);
        let out = null;
        for (const [k, item] of Object.entries(value)) {
            const next = isBinaryPayload(value, k, item, inner)
                ? item : walk(item, counts, k, inner, financial);
            if (next !== item && out === null)
                out = { ...value };
            if (out !== null)
                out[k] = next;
        }
        return out ?? value;
    }
    return value;
}
/** A string value, redacted whole when its key names a secret and it looks like one. */
function redactField(key, text, financial) {
    const kind = key ? fieldSecretKind(key, text) : null;
    if (kind !== null)
        return { text: marker(kind), counts: { [kind]: 1 } };
    return redact(text, { financial, context: key ?? "" });
}
function fieldSecretKind(key, value) {
    if (!FIELD_NAME.test(key) || !FIELD_VALUE.test(value))
        return null;
    const kind = secretNameKind(key);
    if (kind === null)
        return null;
    const ok = kind === "password" ? plausiblePassword(value) : plausibleSecret(value);
    return ok ? kind : null;
}
/** parent[key] is a base64 media payload inside a media part. */
function isBinaryPayload(parent, key, value, media) {
    if (!media || typeof value !== "string")
        return false;
    if (DATA_URI_KEYS.has(key) && value.startsWith("data:")) {
        const head = BASE64_DATA_URI.exec(value);
        return head !== null && BASE64_TEXT.test(value.slice(head[0].length));
    }
    const kind = pyTruthy(parent.media_type) ? parent.media_type : parent.mime_type;
    const declared = parent.type === "base64"
        || (typeof kind === "string" && !kind.startsWith("text/"));
    return declared && BINARY_PAYLOAD_KEYS.has(key) && BASE64_TEXT.test(value);
}
function isBinaryPart(part) {
    if (MEDIA_TYPES.has(part.type))
        return true;
    const source = part.source;
    return "image_url" in part || (isRecord(source) && source.type === "base64");
}
// --------------------------------------------------------------------------- passes
function pemSpans(data) {
    if (!data.includes("PRIVATE KEY"))
        return [];
    const spans = [];
    PEM_BEGIN.lastIndex = 0;
    let begin;
    while ((begin = PEM_BEGIN.exec(data)) !== null) {
        const bodyStart = begin.index + begin[0].length;
        const window = data.slice(bodyStart, Math.min(data.length, bodyStart + PEM_MAX));
        const end = PEM_END.exec(window);
        let stop;
        let body;
        if (end) {
            stop = bodyStart + end.index + end[0].length;
            body = window.slice(0, end.index);
        }
        else {
            PEM_BODY.lastIndex = bodyStart;
            stop = bodyStart + (PEM_BODY.exec(data)?.[0].length ?? 0);
            body = data.slice(bodyStart, stop);
        }
        const real = base64Chars(body) >= PEM_MIN_BODY; // a bare header or "..." is a mention
        if (real)
            spans.push([begin.index, stop, "private_key"]);
        PEM_BEGIN.lastIndex = real ? stop : bodyStart;
    }
    return spans;
}
function tokenSpans(data) {
    const spans = [];
    for (const run of data.matchAll(RUN_RE)) {
        const span = runTokenSpan(data, run.index);
        if (span)
            spans.push(span);
    }
    for (const [kind, trigger, pattern, chars] of SCAN_TOKENS) {
        if (!data.includes(trigger))
            continue;
        for (const m of data.matchAll(pattern)) {
            if (!insideToken(data, m.index) && plausibleToken(m[0])) {
                spans.push([m.index, runEnd(data, m.index + m[0].length, chars), kind]);
            }
        }
    }
    return nonOverlapping(spans);
}
function runTokenSpan(data, start) {
    for (const [kind, prefixes, pattern] of RUN_TOKENS) {
        if (!prefixes.some((p) => data.startsWith(p, start)))
            continue;
        pattern.lastIndex = start;
        const m = pattern.exec(data);
        if (m && plausibleToken(m[0])) {
            // The whole run: a capped match must not leave a tail that a second pass reads as a
            // fresh token.
            return [start, runEnd(data, start + m[0].length, TOK_CHAR), tokenKind(kind, m[0])];
        }
    }
    return null;
}
/** end moved past any further chars matching `chars` (the rest of a token run). */
function runEnd(data, end, chars) {
    let pos = end;
    while (pos < data.length && chars.test(data[pos]))
        pos += 1;
    return pos;
}
function urlSpans(data) {
    const spans = [];
    for (const m of data.matchAll(URL_PASSWORD)) {
        const start = m.index + m[0].length - 1 - m[1].length;
        if (plausiblePassword(m[1]))
            spans.push([start, start + m[1].length, "url_password"]);
    }
    return spans;
}
function headerSpans(data) {
    const spans = [];
    const groups = [
        ["basic_auth", BASIC_AUTHS, () => true, "uthorization"],
        ["bearer_token", BEARERS, plausibleToken, "earer"],
    ];
    for (const [kind, patterns, accept, trigger] of groups) {
        if (!data.includes(trigger) && !data.includes(trigger.toUpperCase()))
            continue;
        for (const pattern of patterns) {
            for (const m of data.matchAll(pattern)) {
                if (insideToken(data, m.index) || !accept(m[1]))
                    continue;
                const start = m.index + m[0].length - m[1].length;
                spans.push([start, start + m[1].length, kind]);
            }
        }
    }
    return nonOverlapping(spans);
}
function assignmentSpans(data) {
    const spans = [];
    let skipTo = 0;
    for (const hit of nameHits(data)) {
        if (hit < skipTo)
            continue;
        ASSIGN_TAIL.lastIndex = hit;
        const m = ASSIGN_TAIL.exec(data);
        if (!m)
            continue;
        skipTo = hit + m[1].length;
        const span = assignmentSpan(data, hit, m);
        if (span) {
            spans.push(span);
            skipTo = span[1];
        }
    }
    return spans;
}
function nameHits(data) {
    const low = asciiLower(data);
    const hits = new Set();
    // Overlapping hits ("passwd" inside "pass..."): restart one char after each match start.
    NAME_HIT.lastIndex = 0;
    let m;
    while ((m = NAME_HIT.exec(low)) !== null) {
        hits.add(m.index);
        NAME_HIT.lastIndex = m.index + 1;
    }
    return [...hits].sort((a, b) => a - b);
}
function assignmentSpan(data, hit, m) {
    const kind = secretNameKind(data.slice(identStart(data, hit), hit) + m[1]);
    if (kind === null)
        return null;
    const raw = m[3];
    const valueStart = m.index + m[0].length - raw.length;
    const stop = VALUE_STOP.exec(raw);
    const value = stop ? raw.slice(0, stop.index) : raw;
    if (!m[2] && stop && "([{".includes(raw[value.length]))
        return null; // f(x): code
    const ok = kind === "password" ? plausiblePassword(value) : plausibleSecret(value);
    return ok ? [valueStart, valueStart + value.length, kind] : null;
}
function apply(data, spans, counts) {
    if (spans.length === 0)
        return data;
    const out = [];
    let pos = 0;
    for (const [start, end, kind] of [...spans].sort(compareSpans)) {
        if (start < pos)
            continue;
        out.push(data.slice(pos, start));
        // Keep the span's line breaks exactly so line addresses never move.
        out.push(marker(kind) + (data.slice(start, end).match(LINE_BREAK) ?? []).join(""));
        counts[kind] = (counts[kind] ?? 0) + 1;
        pos = end;
    }
    out.push(data.slice(pos));
    return out.join("");
}
function nonOverlapping(spans) {
    const kept = [];
    for (const span of [...spans].sort(compareSpans)) {
        if (kept.length === 0 || span[0] >= kept[kept.length - 1][1])
            kept.push(span);
    }
    return kept;
}
function compareSpans(a, b) {
    return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}
function tokenKind(kind, token) {
    if (kind !== "openai_key")
        return kind;
    for (const [prefix, skKind] of SK_KINDS)
        if (token.startsWith(prefix))
            return skKind;
    return kind;
}
function identStart(data, pos) {
    let start = pos;
    const floor = Math.max(0, pos - 64);
    while (start > floor && TOK_CHAR.test(data[start - 1]))
        start -= 1;
    return start;
}
function insideToken(data, pos) {
    return pos > 0 && TOK_CHAR.test(data[pos - 1]);
}
function secretNameKind(name) {
    const low = asciiLower(name);
    if (NON_SECRET_NAME_ENDS.some((e) => low.endsWith(e)))
        return null;
    if (["passw", "passphrase", "pwd"].some((w) => low.includes(w)) || low === "pass"
        || low.endsWith("_pass") || low.endsWith("-pass"))
        return "password";
    if (low.includes("secret") || low.includes("token") || low.includes("credential")) {
        return "secret";
    }
    if (low.includes("auth") && !low.includes("author"))
        return "secret";
    if (KEY_QUALIFIED.test(low) || (/[A-Z]/.test(name) && !/[a-z]/.test(name)
        && name.endsWith("KEY")))
        return "secret";
    return null;
}
// --------------------------------------------------------------------------- value checks
function plausibleToken(value) {
    if (value.startsWith(REDACTED_PREFIX))
        return false;
    return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}
function plausiblePassword(value) {
    if (isPlaceholder(value) || value.length < 6 || entropy(value) < MIN_PASSWORD_ENTROPY) {
        return false;
    }
    if (DOTTED_IDENT.test(value) || WORDS_IDENT.test(value))
        return false;
    if (value.length >= 12)
        return true;
    return charClasses(value) >= 2 && !/^[0-9]+$/.test(value);
}
function plausibleSecret(value) {
    if (isPlaceholder(value) || value.length < 16)
        return false;
    if (DOTTED_IDENT.test(value))
        return false;
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value))
        return false;
    return HEX.test(value) || entropy(value) >= 3.0;
}
function isPlaceholder(value) {
    if (!value || "$<{%*#@[".includes(value[0]) || value.startsWith(REDACTED_PREFIX))
        return true;
    const low = asciiLower(value);
    if (PLACEHOLDER_WORDS.has(low) || value.includes("...") || low.includes("xxxx"))
        return true;
    return new Set(value).size <= 2;
}
function charClasses(value) {
    return Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value))
        + Number(/[0-9]/.test(value)) + Number(/[^A-Za-z0-9]/.test(value));
}
// Python's sum() of floats is Neumaier-compensated (3.12+); match it so thresholds agree.
function entropy(value) {
    const n = value.length;
    const freq = new Map();
    for (const c of value)
        freq.set(c, (freq.get(c) ?? 0) + 1);
    let sum = 0;
    let comp = 0;
    for (const count of freq.values()) {
        const term = (count / n) * Math.log2(count / n);
        const t = sum + term;
        comp += Math.abs(sum) >= Math.abs(term) ? (sum - t) + term : (term - t) + sum;
        sum = t;
    }
    return -(sum + comp);
}
function base64Chars(body) {
    let n = 0;
    for (let i = 0; i < body.length; i += 1)
        if (B64.test(body[i]))
            n += 1;
    return n;
}
/** Python's bool(value) for JSON values: null, false, 0, "", [] and {} are false. */
function pyTruthy(value) {
    if (Array.isArray(value))
        return value.length > 0;
    if (isRecord(value))
        return Object.keys(value).length > 0;
    return Boolean(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mapIfChanged(items, fn) {
    let out = null;
    items.forEach((item, i) => {
        const next = fn(item);
        if (next !== item && out === null)
            out = items.slice(0, i);
        if (out !== null)
            out.push(next);
    });
    return out ?? items;
}
//# sourceMappingURL=secret-redaction.js.map