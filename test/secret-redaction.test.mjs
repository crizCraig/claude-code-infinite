// The TypeScript twin of polychat's secret and financial redaction must match polychat byte
// for byte on the shared golden vectors (test/fixtures/secret_redaction_vectors.json, a copy
// of polychat/secret_redaction_vectors.json: change both together).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { redact, redactValue } from "../dist/secret-redaction.js";
import { financialSpans } from "../dist/financial-redaction.js";
import { fromBytes, toBytes } from "../dist/utf8-bytes.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/secret_redaction_vectors.json",
  import.meta.url), "utf8"));

test("secret vectors match polychat with the financial rules off and on", () => {
  assert.ok(golden.vectors.length >= 60);
  for (const financial of [false, true]) {
    golden.vectors.forEach((v, i) => {
      const out = redact(v.input, { financial });
      assert.equal(out.text, v.output, `vector ${i} financial=${financial}`);
      assert.deepEqual(out.counts, v.counts, `vector ${i} counts`);
    });
  }
});

test("structured value vectors match polychat (secret-named keys, media payloads)", () => {
  for (const financial of [false, true]) {
    golden.value_vectors.forEach((v, i) => {
      const counts = {};
      const out = redactValue(v.input, counts, { financial });
      assert.deepEqual(out, v.output, `value vector ${i} financial=${financial}`);
      assert.deepEqual(counts, v.counts, `value vector ${i} counts`);
      assert.deepEqual(redactValue(out, {}, { financial }), out, `value vector ${i} stable`);
    });
  }
});

test("financial vectors match polychat with MEMTREE_FINANCIAL_REDACTION on", () => {
  assert.ok(golden.financial_vectors.length >= 150);
  golden.financial_vectors.forEach((v, i) => {
    const context = v.context ?? "";
    const out = redact(v.input, { financial: true, context });
    assert.equal(out.text, v.output, `financial vector ${i}`);
    assert.deepEqual(out.counts, v.counts, `financial vector ${i} counts`);
    assert.deepEqual(redact(v.output, { financial: true, context }).counts, {},
      `financial vector ${i} stable`);
  });
  golden.financial_value_vectors.forEach((v, i) => {
    const counts = {};
    assert.deepEqual(redactValue(v.input, counts), v.output, `financial value vector ${i}`);
    assert.deepEqual(counts, v.counts, `financial value vector ${i} counts`);
  });
});

test("financial rules are off only when asked; the default matches the server's target", () => {
  const notes = "routing: 021000021\naccount: 3829105567";
  assert.deepEqual(redact(notes, { financial: false }), { text: notes, counts: {} });
  assert.deepEqual(redact(notes).counts, { bank_routing: 1, bank_account: 1 });
  const value = { routing_number: "021000021" };
  assert.equal(redactValue(value, {}, { financial: false }), value);
});

test("byte strings round-trip any text, lone surrogates included", () => {
  for (const text of ["plain", "café 中文 \u{1F600}", "x\ud800y", "\udc00",
    "a\ud83d", "😀\ud800", ""]) {
    assert.equal(fromBytes(toBytes(text)), text);
  }
  assert.equal(toBytes("\u{1F600}").length, 4);
  assert.equal(toBytes("x\ud800").length, 4);
});

test("secret-free values come back as the same objects (payloads and hashes unchanged)", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png",
    data: "iVBORw0KGgo" + card("453201", 16).repeat(500) } };
  const messages = [
    { role: "system", content: "You are Claude Code." },
    { role: "user", content: [{ type: "text", text: "fix the bug in api_key handling" }, image] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash",
      input: { command: "grep -rn password_hash src/ # pid 48213 at 1730000000123" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
      content: "src/a.py:1: password_hash = hash_pw(pw)\n"
        + "uuid 123e4567-e89b-12d3-a456-426614174000" }] },
  ];
  const before = JSON.stringify(messages);
  const counts = {};
  assert.equal(redactValue(messages, counts), messages);
  assert.deepEqual(counts, {});
  assert.equal(JSON.stringify(messages), before);
});

test("a real-shaped session (all of src/ and test/) has no financial hits", () => {
  const messages = [{ role: "system", content: "You are Claude Code." }];
  for (const dir of ["../src/", "../test/"]) {
    const base = new URL(dir, import.meta.url);
    readdirSync(base)
      .filter((f) => /\.(ts|mjs)$/.test(f) && !/^(secret|financial)-redaction/.test(f))
      .forEach((f, i) => {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${dir}${i}`,
          name: "Read", input: { file_path: `/repo/${dir.slice(3)}${f}` } }] });
        messages.push({ role: "user", content: [{ type: "tool_result",
          tool_use_id: `t${dir}${i}`, content: readFileSync(new URL(f, base), "utf8") }] });
      });
  }
  const counts = {};
  const out = redactValue(messages, counts);
  assert.ok(JSON.stringify(messages).length > 1e6);
  // Test fixtures hold fake keys on purpose; financial kinds must be absent.
  for (const kind of ["card_number", "bank_routing", "iban", "bank_account", "ssn"]) {
    assert.equal(counts[kind], undefined, `${kind}: ${JSON.stringify(counts)}`);
  }
  if (Object.keys(counts).length === 0) assert.equal(out, messages);
});

test("multi-MB bodies redact quickly and adversarial inputs stay linear", () => {
  const files = ["src/proxy.ts", "src/memtree.ts", "README.md"].map((f) =>
    readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  const body = files.repeat(Math.ceil(4e6 / files.length));
  const start = performance.now();
  redact(body);
  const ms = performance.now() - start;
  console.log(`# redact ${(body.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 8000, `${ms} ms`);
  const hostile = [["sk-", 2e5], ["a:", 2e5], ["password=", 1e5], ["key", 2e5],
    ["Bearer ", 1e5], ["-----BEGIN PRIVATE KEY-----", 2e4], ["1", 6e5], ["1 ", 3e5],
    ["1-", 3e5], ["account: ", 7e4], ["DE89", 1.5e5], ["routing 021000021 ", 3e4],
    ["1234 5678 ", 6e4], ["AB12 CDEF ", 6e4], ["acct 123456 ", 5e4], ["\\n1234567", 7e4],
    ["4532 0173 ", 6e4], ["DE89 ", 1.2e5], ["é4532", 1e5]];
  for (const [unit, reps] of hostile) {
    const half = time(() => redact(unit.repeat(reps / 2)));
    const full = time(() => redact(unit.repeat(reps)));
    assert.ok(full < 3000, `${JSON.stringify(unit)}: ${full.toFixed(0)} ms`);
    assert.ok(full < 4 * half + 200, `${JSON.stringify(unit)} grows faster than linear: `
      + `${half.toFixed(0)} -> ${full.toFixed(0)} ms`);
  }
});

test("hundreds of thousands of spans in one text do not overflow the stack (review r1)", () => {
  for (const text of [("routing 021000021 " + "12345678 ".repeat(20)).repeat(8000),
    "account: 3829105567\n".repeat(128000), "routing 021000021\n".repeat(128000)]) {
    const out = redact(text);
    assert.ok(Object.values(out.counts).reduce((a, b) => a + b, 0) >= 128000);
  }
});

test("an empty or non-string media_type falls back to mime_type (Python truthiness)", () => {
  const data = "QUJDREVGR0g0NTMy\n" + card("453201", 16);
  for (const mediaType of [{}, [], 0, "", null, false]) {
    const part = { type: "image", media_type: mediaType, mime_type: "image/png", data };
    assert.equal(redactValue(part), part, JSON.stringify(mediaType));
  }
  const text = { type: "image", media_type: [], mime_type: "text/plain", data };
  assert.ok(redactValue(text).data.endsWith("[REDACTED:card_number]"));
  const truthy = { type: "image", media_type: { a: 1 }, data };
  assert.ok(redactValue(truthy).data.endsWith("[REDACTED:card_number]"));
});

test("financialSpans finds nothing in text without two digits in a row", () => {
  assert.deepEqual(financialSpans("routing a1b2c3 account: x"), []);
});

/** prefix padded to length with a valid Luhn check digit (no real-looking number in source). */
function card(prefix, length) {
  const body = (prefix + "7391528406".repeat(2)).slice(0, length - 1);
  for (let d = 0; d < 10; d += 1) {
    const digits = body + d;
    let total = 0;
    [...digits].reverse().forEach((c, i) => {
      const n = Number(c) * (i % 2 ? 2 : 1);
      total += n > 9 ? n - 9 : n;
    });
    if (total % 10 === 0) return digits;
  }
  throw new Error("unreachable");
}

function time(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}
