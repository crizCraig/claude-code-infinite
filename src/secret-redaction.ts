// Secret redaction for everything ccc sends to Polychat (twin of polychat/secret_redaction.py).
//
// redact(text) replaces API keys, tokens, passwords and private keys with
// "[REDACTED:<kind>]" and returns counts by kind. Local, free, no network. The output must
// match the Python detector byte for byte: both are checked against the shared golden vectors
// (test/fixtures/secret_redaction_vectors.json, copied from polychat). Change both together.
//
// Every pattern is ASCII-only with bounded quantifiers. Text without a secret comes back as
// the same string, so secret-free payloads (and their hashes) are unchanged.

export const REDACTION_VERSION = 1;
export const REDACTED_PREFIX = "[REDACTED:";

export type RedactionCounts = Record<string, number>;
type Span = [start: number, end: number, kind: string];

const TOK = "A-Za-z0-9_\\-";
const END = `(?![${TOK}])`;
const MIN_RUN = 16;

// Provider tokens matched at the start of a run of 16+ token chars: [kind, prefixes, regex].
const RUN_TOKENS: Array<[string, string[], RegExp]> = [
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
  ["jwt", ["eyJ"], new RegExp(
    `eyJ[${TOK}]{8,4000}\\.eyJ[${TOK}]{8,8000}\\.[${TOK}]{8,2000}`, "y")],
];
const RUN_RE = new RegExp(`[${TOK}]{${MIN_RUN},}`, "g");
const SCAN_TOKENS: Array<[string, string, RegExp]> = [
  ["stripe_webhook_secret", "whsec_", /whsec_[A-Za-z0-9+/=]{24,255}/g],
  ["slack_webhook", "hooks.slack.com",
    /hooks\.slack\.com\/services\/T[A-Za-z0-9_]{6,20}\/B[A-Za-z0-9_]{6,20}\/[A-Za-z0-9_]{16,64}/g],
  ["sendgrid_key", "SG.", new RegExp(`SG\\.[${TOK}]{16,32}\\.[${TOK}]{16,64}${END}`, "g")],
];
const SK_KINDS: Array<[string, string]> = [
  ["sk-ant-", "anthropic_key"], ["sk-or-", "openrouter_key"], ["sk-nano-", "nanogpt_key"],
];

const URL_PASSWORD = new RegExp(
  "://[^\\x00-\\x20\\x7f-\\uffff:/@\"'<>\\\\]{0,128}:"
  + "([^\\x00-\\x20\\x7f-\\uffff/@\"'<>\\\\]{1,256})@(?=[A-Za-z0-9\\[])", "g");
const BEARERS = ["Bearer", "bearer", "BEARER"].map(
  (w) => new RegExp(`${w}[ \\t]{1,4}([A-Za-z0-9._~+/=\\-]{16,2000})`, "g"));
const BASIC_AUTHS = ["Authorization", "authorization"].map((w) => new RegExp(
  `${w}["']?[ \\t]{0,3}[:=][ \\t]{0,3}["']?[Bb]asic[ \\t]{1,4}([A-Za-z0-9+/=]{8,1000})`, "g"));

// Name keywords, ASCII case-insensitive without the "i" flag (it folds some non-ASCII chars).
const NAME_HIT = new RegExp(["pass", "pwd", "secret", "token", "key", "auth", "credential"]
  .map((w) => [...w].map((c) => `[${c.toUpperCase()}${c}]`).join("")).join("|"), "g");
const ASSIGN_TAIL = new RegExp(
  "([A-Za-z0-9_\\-]{0,40})[\"']?[ \\t]{0,3}(?::=|=>|[:=])[ \\t]{0,3}"
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
const TOK_CHAR = /[A-Za-z0-9_-]/;

/** Text with secrets replaced, and counts by kind. Secret-free text is returned as is. */
export function redact(text: string): { text: string; counts: RedactionCounts } {
  if (typeof text !== "string" || text.length === 0) return { text, counts: {} };
  const counts: RedactionCounts = {};
  let out = apply(text, pemSpans(text), counts);
  out = apply(out, tokenSpans(out), counts);
  if (out.includes("://")) out = apply(out, urlSpans(out), counts);
  out = apply(out, headerSpans(out), counts);
  out = apply(out, assignmentSpans(out), counts);
  return Object.keys(counts).length ? { text: out, counts } : { text, counts };
}

/**
 * Redact every string in a JSON-like value; image/document parts are kept as they are.
 * Returns the same object when nothing was redacted (so unchanged payloads stay identical).
 */
export function redactValue<T>(value: T, counts: RedactionCounts = {}): T {
  if (typeof value === "string") {
    const result = redact(value);
    for (const [k, n] of Object.entries(result.counts)) counts[k] = (counts[k] ?? 0) + n;
    return result.text as T;
  }
  if (Array.isArray(value)) return mapIfChanged(value, (v) => redactValue(v, counts)) as T;
  if (value && typeof value === "object") {
    if (isBinaryPart(value as Record<string, unknown>)) return value;
    return mapObjectIfChanged(value as Record<string, unknown>, counts) as T;
  }
  return value;
}

/** CCC_REDACT_POLYCHAT=on: redact everything ccc sends to Polychat (opt-in for now). */
export function polychatRedactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true|yes)$/i.test(env.CCC_REDACT_POLYCHAT ?? "");
}

/** A pre-serialized JSON value, redacted; the same string when it holds no secret. */
export function redactSerializedJson(serialized: string, counts: RedactionCounts): string {
  const parsed: unknown = JSON.parse(serialized);
  const redacted = redactValue(parsed, counts);
  if (redacted === parsed) return serialized;
  return JSON.stringify(redacted);
}

export function formatCounts(counts: RedactionCounts): string {
  const keys = Object.keys(counts).sort();
  return keys.length ? keys.map((k) => `${k}=${counts[k]}`).join(", ") : "none";
}

function marker(kind: string): string {
  return `${REDACTED_PREFIX}${kind}]`;
}

// --------------------------------------------------------------------------- passes

function pemSpans(text: string): Span[] {
  if (!text.includes("PRIVATE KEY")) return [];
  const spans: Span[] = [];
  PEM_BEGIN.lastIndex = 0;
  let begin: RegExpExecArray | null;
  while ((begin = PEM_BEGIN.exec(text)) !== null) {
    const bodyStart = begin.index + begin[0].length;
    const window = text.slice(bodyStart, Math.min(text.length, bodyStart + PEM_MAX));
    const end = PEM_END.exec(window);
    let stop: number;
    let body: string;
    if (end) {
      stop = bodyStart + end.index + end[0].length;
      body = window.slice(0, end.index);
    } else {
      PEM_BODY.lastIndex = bodyStart;
      stop = bodyStart + (PEM_BODY.exec(text)?.[0].length ?? 0);
      body = text.slice(bodyStart, stop);
    }
    const real = base64Chars(body) >= PEM_MIN_BODY;
    if (real) spans.push([begin.index, stop, "private_key"]);
    PEM_BEGIN.lastIndex = real ? stop : bodyStart;
  }
  return spans;
}

function tokenSpans(text: string): Span[] {
  const spans: Span[] = [];
  RUN_RE.lastIndex = 0;
  let run: RegExpExecArray | null;
  while ((run = RUN_RE.exec(text)) !== null) {
    const span = runTokenSpan(text, run.index);
    if (span) spans.push(span);
  }
  for (const [kind, trigger, pattern] of SCAN_TOKENS) {
    if (!text.includes(trigger)) continue;
    for (const m of text.matchAll(pattern)) {
      if (!insideToken(text, m.index) && plausibleToken(m[0])) {
        spans.push([m.index, m.index + m[0].length, kind]);
      }
    }
  }
  return nonOverlapping(spans);
}

function runTokenSpan(text: string, start: number): Span | null {
  for (const [kind, prefixes, pattern] of RUN_TOKENS) {
    if (!prefixes.some((p) => text.startsWith(p, start))) continue;
    pattern.lastIndex = start;
    const m = pattern.exec(text);
    if (m && plausibleToken(m[0])) return [start, start + m[0].length, tokenKind(kind, m[0])];
  }
  return null;
}

function urlSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(URL_PASSWORD)) {
    const start = m.index + m[0].length - 1 - m[1].length;
    if (plausiblePassword(m[1])) spans.push([start, start + m[1].length, "url_password"]);
  }
  return spans;
}

function headerSpans(text: string): Span[] {
  const spans: Span[] = [];
  const groups: Array<[string, RegExp[], (v: string) => boolean, string]> = [
    ["basic_auth", BASIC_AUTHS, () => true, "uthorization"],
    ["bearer_token", BEARERS, plausibleToken, "earer"],
  ];
  for (const [kind, patterns, accept, trigger] of groups) {
    if (!text.includes(trigger) && !text.includes(trigger.toUpperCase())) continue;
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        if (insideToken(text, m.index) || !accept(m[1])) continue;
        const start = m.index + m[0].length - m[1].length;
        spans.push([start, start + m[1].length, kind]);
      }
    }
  }
  return nonOverlapping(spans);
}

function assignmentSpans(text: string): Span[] {
  const spans: Span[] = [];
  let skipTo = 0;
  for (const hit of nameHits(text)) {
    if (hit < skipTo) continue;
    ASSIGN_TAIL.lastIndex = hit;
    const m = ASSIGN_TAIL.exec(text);
    if (!m) continue;
    skipTo = hit + m[1].length;
    const span = assignmentSpan(text, hit, m);
    if (span) {
      spans.push(span);
      skipTo = span[1];
    }
  }
  return spans;
}

function nameHits(text: string): number[] {
  const hits = new Set<number>();
  // Overlapping hits ("passwd" inside "pass..."): restart one char after each match start.
  NAME_HIT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_HIT.exec(text)) !== null) {
    hits.add(m.index);
    NAME_HIT.lastIndex = m.index + 1;
  }
  return [...hits].sort((a, b) => a - b);
}

function assignmentSpan(text: string, hit: number, m: RegExpExecArray): Span | null {
  const name = text.slice(identStart(text, hit), hit) + m[1];
  const kind = secretNameKind(name);
  if (kind === null) return null;
  const quote = m[2];
  const raw = m[3];
  const valueStart = m.index + m[0].length - raw.length;
  const stop = VALUE_STOP.exec(raw);
  const value = stop ? raw.slice(0, stop.index) : raw;
  if (!quote && stop && "([{".includes(raw[value.length])) return null;
  const ok = kind === "password" ? plausiblePassword(value) : plausibleSecret(value);
  return ok ? [valueStart, valueStart + value.length, kind] : null;
}

function apply(text: string, spans: Span[], counts: RedactionCounts): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort(compareSpans);
  const out: string[] = [];
  let pos = 0;
  for (const [start, end, kind] of sorted) {
    if (start < pos) continue;
    out.push(text.slice(pos, start));
    // Keep the span's line breaks so line addresses never move.
    out.push(marker(kind) + "\n".repeat(countNewlines(text, start, end)));
    counts[kind] = (counts[kind] ?? 0) + 1;
    pos = end;
  }
  out.push(text.slice(pos));
  return out.join("");
}

function nonOverlapping(spans: Span[]): Span[] {
  const kept: Span[] = [];
  for (const span of [...spans].sort(compareSpans)) {
    if (kept.length === 0 || span[0] >= kept[kept.length - 1][1]) kept.push(span);
  }
  return kept;
}

function compareSpans(a: Span, b: Span): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

function tokenKind(kind: string, token: string): string {
  if (kind !== "openai_key") return kind;
  for (const [prefix, skKind] of SK_KINDS) if (token.startsWith(prefix)) return skKind;
  return kind;
}

function identStart(text: string, pos: number): number {
  let start = pos;
  const floor = Math.max(0, pos - 64);
  while (start > floor && TOK_CHAR.test(text[start - 1])) start -= 1;
  return start;
}

function insideToken(text: string, pos: number): boolean {
  return pos > 0 && TOK_CHAR.test(text[pos - 1]);
}

function secretNameKind(name: string): string | null {
  const low = asciiLower(name);
  if (NON_SECRET_NAME_ENDS.some((e) => low.endsWith(e))) return null;
  if (["passw", "passphrase", "pwd"].some((w) => low.includes(w)) || low === "pass"
      || low.endsWith("_pass") || low.endsWith("-pass")) return "password";
  if (low.includes("secret") || low.includes("token") || low.includes("credential")) {
    return "secret";
  }
  if (low.includes("auth") && !low.includes("author")) return "secret";
  if (KEY_QUALIFIED.test(low) || (/[A-Z]/.test(name) && !/[a-z]/.test(name)
      && name.endsWith("KEY"))) return "secret";
  return null;
}

// --------------------------------------------------------------------------- value checks

function plausibleToken(value: string): boolean {
  if (value.startsWith(REDACTED_PREFIX)) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function plausiblePassword(value: string): boolean {
  if (isPlaceholder(value) || value.length < 6 || entropy(value) < MIN_PASSWORD_ENTROPY) {
    return false;
  }
  if (DOTTED_IDENT.test(value) || WORDS_IDENT.test(value)) return false;
  if (value.length >= 12) return true;
  return charClasses(value) >= 2 && !/^[0-9]+$/.test(value);
}

function plausibleSecret(value: string): boolean {
  if (isPlaceholder(value) || value.length < 16) return false;
  if (DOTTED_IDENT.test(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return HEX.test(value) || entropy(value) >= 3.0;
}

function isPlaceholder(value: string): boolean {
  if (!value || "$<{%*#@[".includes(value[0]) || value.startsWith(REDACTED_PREFIX)) return true;
  const low = asciiLower(value);
  if (PLACEHOLDER_WORDS.has(low) || value.includes("...") || low.includes("xxxx")) return true;
  return new Set(value).size <= 2;
}

function isBinaryPart(part: Record<string, unknown>): boolean {
  const kind = part.type;
  if (["image", "image_url", "input_image", "document", "file"].includes(kind as string)) {
    return true;
  }
  const source = part.source as Record<string, unknown> | undefined;
  return "image_url" in part
    || (!!source && typeof source === "object" && source.type === "base64");
}

function charClasses(value: string): number {
  return Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value))
    + Number(/[0-9]/.test(value)) + Number(/[^A-Za-z0-9]/.test(value));
}

// Python's sum() of floats is Neumaier-compensated (3.12+); match it so thresholds agree.
function entropy(value: string): number {
  const n = value.length;
  const freq = new Map<string, number>();
  for (const c of value) freq.set(c, (freq.get(c) ?? 0) + 1);
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

function base64Chars(body: string): number {
  let n = 0;
  for (let i = 0; i < body.length; i += 1) if (/[A-Za-z0-9+/=]/.test(body[i])) n += 1;
  return n;
}

function countNewlines(text: string, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function mapIfChanged<T>(items: T[], fn: (v: T) => T): T[] {
  let out: T[] | null = null;
  items.forEach((item, i) => {
    const next = fn(item);
    if (next !== item && out === null) out = items.slice(0, i);
    if (out !== null) out.push(next);
  });
  return out ?? items;
}

function mapObjectIfChanged(obj: Record<string, unknown>,
                            counts: RedactionCounts): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(obj)) {
    const next = redactValue(item, counts);
    if (next !== item && out === null) out = { ...obj };
    if (out !== null) out[key] = next;
  }
  return out ?? obj;
}
