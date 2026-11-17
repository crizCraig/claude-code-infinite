import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../dist/diagnostics.js";
import { firstRunAnswer, sanitizeContext, sanitizeEvent } from "../dist/diagnostics-schema.js";
import {
  askFirstRunQuestion, FIRST_RUN_CHOICES, FIRST_RUN_QUESTION, FIRST_RUN_QUESTION_FILE,
} from "../dist/first-run-question.js";

function fixture(t, overrides = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "ccc-first-question-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const asked = [], sent = [];
  const diagnostics = new Diagnostics({
    configDir, env: {}, baseUrl: "https://example.test", apiKey: "account-key",
    clientName: "cc-infinite", clientVersion: "1.0.38",
    fetchImpl: async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { status: 202 };
    },
  });
  const opts = {
    configDir, args: [], env: {}, stdinIsTty: true, stdoutIsTty: true, diagnostics,
    ask: async (q) => { asked.push(q); return "2"; }, ...overrides,
  };
  return { opts, asked, sent, file: join(configDir, FIRST_RUN_QUESTION_FILE) };
}

test("one answer is persisted and sent once on the authenticated diagnostics path", async (t) => {
  const { opts, asked, sent, file } = fixture(t);
  await askFirstRunQuestion(opts);
  await askFirstRunQuestion(opts);
  await opts.diagnostics.flush();
  assert.deepEqual(asked, [FIRST_RUN_QUESTION]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    status: "answered", answer: "Agents that run for hours",
  });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://example.test/v1/ccc/diagnostics");
  assert.equal(sent[0].headers.authorization, "Bearer account-key");
  assert.deepEqual(sent[0].body.events.map(({ t, ...e }) => e), [
    { name: "first_run_answer", answer: "Agents that run for hours" },
  ]);
  assert.equal(sent[0].body.context.answer, undefined);
});

for (const [i, answer] of FIRST_RUN_CHOICES.entries()) {
  test(`choice ${i + 1} is stored as its label`, async (t) => {
    const { opts, file } = fixture(t, { ask: async () => ` ${i + 1} ` });
    await askFirstRunQuestion(opts);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).answer, answer);
  });
}

for (const answer of ["", "  ", null, "\x00\x1f\x7f\u009f\u202e"]) {
  test(`skip/EOF ${JSON.stringify(answer)} is permanent and sends nothing`, async (t) => {
    const { opts, sent, file } = fixture(t, { ask: async () => answer });
    await askFirstRunQuestion(opts);
    await askFirstRunQuestion({ ...opts, ask: () => assert.fail("must not re-ask") });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: "skipped" });
    assert.deepEqual(sent, []);
  });
}

const skips = [
  ...["-p", "--print", "--print=x", "-pc", "-cp", "-prsession"].map((flag) => ({ args: [flag] })),
  { args: ["--append-system-prompt", "--", "-cp"] },
  ...["--help", "--version", "doctor", "mcp"].map((flag) => ({ args: [flag] })),
  { stdinIsTty: false }, { stdoutIsTty: false },
  ...[{ CI: "1" }, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { BUILD_NUMBER: "123" },
    { CCC_NO_FIRST_RUN_QUESTION: "1" }, { CCC_NO_FIRST_RUN_QUESTION: "true" }]
    .map((env) => ({ env })),
  { diagnostics: { enabled: false } },
];
for (const override of skips) {
  test(`ineligible run leaves input and marker untouched: ${JSON.stringify(override)}`, async (t) => {
    const { opts, asked, sent, file } = fixture(t, override);
    await askFirstRunQuestion(opts);
    assert.deepEqual(asked, []);
    assert.deepEqual(sent, []);
    assert.equal(existsSync(file), false);
  });
}

test("NO_COLOR and colour runs show the same plain prompt", async (t) => {
  for (const env of [{}, { NO_COLOR: "1" }]) {
    const { opts, asked } = fixture(t, { env });
    await askFirstRunQuestion(opts);
    assert.deepEqual(asked, [FIRST_RUN_QUESTION]);
    assert.doesNotMatch(asked[0], /\x1b/);
  }
});

test("concurrent launches claim the question before awaiting input", async (t) => {
  let resolve;
  const { opts, sent, file } = fixture(t, { ask: () => new Promise((r) => { resolve = r; }) });
  const first = askFirstRunQuestion(opts);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "shown");
  await askFirstRunQuestion({ ...opts, ask: () => assert.fail("another process owns prompt") });
  resolve("building tools");
  await first;
  assert.equal(sent.length, 1);
});

test("filesystem or prompt failure never blocks startup or repeats the question", async (t) => {
  const { opts, asked, sent, file } = fixture(t);
  const notDir = join(opts.configDir, "regular-file");
  writeFileSync(notDir, "");
  await askFirstRunQuestion({ ...opts, configDir: notDir });
  assert.deepEqual(asked, []);
  await askFirstRunQuestion({ ...opts, ask: async () => { throw new Error("terminal closed"); } });
  await askFirstRunQuestion(opts);
  assert.deepEqual(asked, []);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "shown");
  assert.deepEqual(sent, []);
});

test("a dropped send is never retried by a later launch", async (t) => {
  const { opts } = fixture(t);
  let attempts = 0;
  opts.diagnostics = new Diagnostics({
    configDir: opts.configDir, env: {}, baseUrl: "https://example.test", apiKey: "key",
    clientName: "cc-infinite", clientVersion: "1.0.38",
    fetchImpl: async () => { attempts++; throw new Error("offline"); },
  });
  await askFirstRunQuestion(opts);
  await opts.diagnostics.flush();
  await askFirstRunQuestion(opts);
  assert.equal(attempts, 1);
});

test("free text is control-free, capped at 200 Unicode characters, and only allowed on its event", async (t) => {
  const raw = " \x00a\t\r\n\x7f\u009f\u202e\ud800" + "😀".repeat(250);
  const expected = "a" + "😀".repeat(199);
  assert.equal(firstRunAnswer(raw), expected);
  for (const invalid of [undefined, null, [], {}, 2, true]) assert.equal(firstRunAnswer(invalid), undefined);
  const { opts, file, sent } = fixture(t, { ask: async () => raw });
  await askFirstRunQuestion(opts);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).answer, expected);
  assert.equal(sent[0].body.events[0].answer, expected);
  assert.deepEqual(sanitizeContext({ answer: raw }), {});
  assert.deepEqual(sanitizeEvent("session_start", { answer: raw }, 1), { name: "session_start", t: 1 });
  assert.deepEqual(sanitizeEvent("first_run_answer", { answer: raw, prompt: "secret" }, 1), {
    name: "first_run_answer", answer: expected, t: 1,
  });
});
