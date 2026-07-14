// Prototype: replicate polychat's server-side prefix hashing in JS.
// Target equivalence: for the payload the client sends (JSON.stringify of its
// in-memory messages), produce the exact hash_sequence the server computes in
// check_and_trigger_indexing (history_job.py):
//   remove_cache_control -> normalize_simple_user_messages -> pop system msg
//   -> strip_cc_system_reminders -> generate_messages_hash_sequence
// where each prefix hash is sha256 of json.dumps(prefix, separators=(',',':'),
// sort_keys=True) with ensure_ascii=True.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

// ---------- Python-compatible canonical JSON ----------

// Python str.isspace() set (NOT the same as JS trim: excludes ﻿/zwsp,
// includes \x1c-\x1f and \x85).
const PY_WS =
  /[\t\n\x0b\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && PY_WS.test(s[a])) a++;
  while (b > a && PY_WS.test(s[b - 1])) b--;
  return s.slice(a, b);
}

// json.dumps escapes everything outside 0x20-0x7e (ensure_ascii), lowercase
// hex, shortforms for \b\t\n\f\r; astral chars as UTF-16 surrogate pairs
// (which matches per-code-unit iteration here).
function pyString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20 || c > 0x7e)
      out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// Python repr(float) for a JS double: shortest digits, scientific iff decimal
// exponent < -4 or >= 16, exponent always signed and >= 2 digits.
function pyFloatRepr(n) {
  const m = n
    .toExponential()
    .match(/^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/);
  if (!m) throw new Error(`unparseable float ${n}`);
  const [, sign, first, frac = "", expStr] = m;
  const exp = parseInt(expStr, 10);
  const digits = first + frac;
  if (exp >= 16 || exp < -4) {
    const mant = frac ? `${first}.${frac}` : first;
    const esign = exp < 0 ? "-" : "+";
    return `${sign}${mant}e${esign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (exp >= 0) {
    if (digits.length <= exp + 1) {
      return sign + digits.padEnd(exp + 1, "0") + ".0";
    }
    return sign + digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  }
  return sign + "0." + "0".repeat(-exp - 1) + digits;
}

// Equivalence target: python json.dumps(json.loads(JSON.stringify(n))).
// JSON.stringify uses String(n): plain-digit integers parse as Python int
// (identical digits); anything with '.', 'e' parses as float -> repr.
function pyNumber(n) {
  if (!Number.isFinite(n)) throw new Error("non-finite number in messages");
  if (Number.isInteger(n)) {
    const s = String(n);
    if (!/[eE.]/.test(s)) return s;
  }
  return pyFloatRepr(n);
}

// Python sorts dict keys by code point; JS default string compare is by UTF-16
// code unit, which diverges for astral-plane keys.
function codePointCompare(a, b) {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0) - bi[i].codePointAt(0);
    if (d) return d;
  }
  return ai.length - bi.length;
}

export function pyDumps(v) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  const t = typeof v;
  if (t === "number") return pyNumber(v);
  if (t === "string") return pyString(v);
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined) // JSON.stringify drops these
      .sort(codePointCompare);
    return (
      "{" + keys.map((k) => pyString(k) + ":" + pyDumps(v[k])).join(",") + "}"
    );
  }
  throw new Error("unsupported type: " + t);
}

// ---------- Server preprocessing pipeline (history_job.py replica) ----------

function removeCacheControl(data) {
  if (Array.isArray(data)) {
    for (const item of data) removeCacheControl(item);
  } else if (data && typeof data === "object") {
    delete data.cache_control;
    for (const v of Object.values(data)) removeCacheControl(v);
  }
}

function normalizeSimpleUserMessages(messages) {
  return messages.map((m) => {
    if (m && typeof m === "object" && !Array.isArray(m) && m.role === "user" &&
        typeof m.content === "string") {
      return { ...m, content: [{ type: "text", text: m.content }] };
    }
    return m;
  });
}

function sysMsgIndex(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "system") return i;
  }
  return -1;
}

const SYS_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripReminderText(text) {
  return pyStrip(text.replace(SYS_REMINDER_RE, ""));
}

function stripPart(part) {
  if (typeof part === "string") {
    const cleaned = stripReminderText(part);
    return cleaned ? cleaned : null;
  }
  if (part && typeof part === "object" && !Array.isArray(part)) {
    const copy = structuredClone(part);
    if (copy.type === "text") {
      const cleaned = stripReminderText(copy.text ?? "");
      if (!cleaned) return null;
      copy.text = cleaned;
      return copy;
    }
    if (copy.type === "tool_result") {
      const inner = copy.content;
      if (typeof inner === "string") {
        copy.content = stripReminderText(inner); // kept even when ""
      } else if (Array.isArray(inner)) {
        copy.content = inner.map(stripPart).filter((p) => p !== null);
      }
      return copy;
    }
    return copy;
  }
  return part;
}

function stripCcSystemRemindersPy(messages) {
  const result = [];
  for (const msg of messages) {
    const copy = structuredClone(msg);
    const content = copy?.content;
    if (typeof content === "string") {
      const cleaned = stripReminderText(content);
      if (cleaned) {
        copy.content = cleaned;
        result.push(copy);
      }
    } else if (Array.isArray(content)) {
      const parts = content.map(stripPart).filter((p) => p !== null);
      if (parts.length) {
        copy.content = parts;
        result.push(copy);
      }
    } else {
      result.push(copy);
    }
  }
  return result;
}

// The full preprocessing chain from check_and_trigger_indexing, ending at the
// list that gets hashed (messages_for_hash).
export function preprocessForHash(messages) {
  const msgs = structuredClone(messages);
  removeCacheControl(msgs);
  let normalized = normalizeSimpleUserMessages(msgs);
  const sysI = sysMsgIndex(normalized);
  if (sysI !== -1) normalized.splice(sysI, 1);
  return stripCcSystemRemindersPy(normalized);
}

export function serverHashSequence(messages) {
  const forHash = preprocessForHash(messages);

  // generate_messages_hash_sequence: incremental sha256 over the canonical
  // serialization, forked at each message boundary; longest prefix first.
  const running = createHash("sha256").update("[");
  const seq = [];
  forHash.forEach((message, i) => {
    if (i) running.update(",");
    running.update(Buffer.from(pyDumps(message), "utf-8"));
    const fork = running.copy();
    fork.update("]");
    seq.push(fork.digest("hex"));
  });
  seq.reverse();
  return seq;
}

// ---------- Fixture: adversarial payload ----------

const FIXTURE = [
  { role: "system", content: "You are a helper. Date: 2026-07-13" },
  { role: "user", content: "plain string user msg gets normalized" },
  {
    role: "user",
    content: [
      { type: "text", text: "  trailing/leading ws should py-strip \t\n" },
      {
        type: "text",
        text: "before<system-reminder>ephemeral\nstuff</system-reminder>after",
      },
    ],
    cache_control: { type: "ephemeral" },
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01",
        name: "compute",
        input: {
          zebra: 1,
          apple: 0.1,
          "über": 1e-7,
          tiny: 1e-5,
          edge: 0.0001,
          big: 1e30,
          bigint_lossy: 123456789012345678901234567890,
          huge_int: 10000000000000000,
          exp_int: 1e21,
          neg: -3.14,
          denorm: 5e-324,
          nested: { b: [1, 2, { c: null, a: true }], a: "x" },
          "😀key": "astral key sort",
          "￿key": "bmp max key sort",
        },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: [
          { type: "text", text: "unicode: é 中文 😀 \x7f del   ls" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANS" },
          },
          { type: "text", text: "<system-reminder>gone entirely</system-reminder>" },
        ],
      },
    ],
  },
  {
    role: "user",
    content: "<system-reminder>whole message vanishes</system-reminder>",
  },
  { role: "assistant", content: 'quotes " backslash \\ and \b\f controls \x01' },
];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const wirePayload = JSON.stringify(FIXTURE);
  writeFileSync(new URL("./hash_parity_fixture.json", import.meta.url), wirePayload);

  // Hash what the server will see: the payload after its own JSON parse.
  const seq = serverHashSequence(JSON.parse(wirePayload));
  console.log(JSON.stringify(seq, null, 0));
}
