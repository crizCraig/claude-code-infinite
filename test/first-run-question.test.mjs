import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../dist/diagnostics.js";
import { firstRunAnswer, sanitizeContext, sanitizeEvent } from "../dist/diagnostics-schema.js";
import {
  askFirstRunQuestion, FIRST_RUN_CHOICES, FIRST_RUN_QUESTION, FIRST_RUN_QUESTION_FILE,
  PASTE_QUIET_MS, QuestionInterrupted, QUESTION_TIMEOUT_MS, readFirstRunAnswer, TYPE_AHEAD_MS,
} from "../dist/first-run-question.js";
import { hasNoInstallState, NEW_INSTALL_FILE, takeNewInstall } from "../dist/new-install.js";
import { installBody } from "../dist/install-ping.js";

function fixture(t, overrides = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "ccc-first-question-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const asked = [], sent = [];
  let clock = 0;
  const diagnostics = new Diagnostics({
    configDir, env: {}, baseUrl: "https://example.test", apiKey: "account-key",
    clientName: "cc-infinite", clientVersion: "1.0.38",
    fetchImpl: async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { status: 202 };
    },
  });
  const opts = {
    configDir, newInstall: true, args: [], env: {}, stdinIsTty: true, stdoutIsTty: true, diagnostics,
    now: () => { clock += 1000; return clock; },
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
  { newInstall: false },
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
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "skipped");
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
  const { opts, file, sent } = fixture(t, { ask: async () => raw.replace(/[\r\n]/g, "") });
  await askFirstRunQuestion(opts);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).answer, expected);
  assert.equal(sent[0].body.events[0].answer, expected);
  assert.deepEqual(sanitizeContext({ answer: raw }), {});
  assert.deepEqual(sanitizeEvent("session_start", { answer: raw }, 1), { name: "session_start", t: 1 });
  assert.deepEqual(sanitizeEvent("first_run_answer", { answer: raw, prompt: "secret" }, 1), {
    name: "first_run_answer", answer: expected, t: 1,
  });
});

for (const input of ["1)", "1.", " 1 "]) {
  test(`printed choice syntax ${JSON.stringify(input)} maps to its label`, async (t) => {
    const { opts, file } = fixture(t, { ask: async () => input });
    await askFirstRunQuestion(opts);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).answer, FIRST_RUN_CHOICES[0]);
  });
}

test("an immediately resolved ask is type-ahead, not an answer", async (t) => {
  const { opts, sent, file } = fixture(t, { now: () => performance.now() });
  await askFirstRunQuestion(opts);
  assert.deepEqual(sent, []);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: "skipped" });
});

test("the question aborts its input reader at exactly 45 seconds and never re-asks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const { opts, sent, file } = fixture(t, {
    ask: (_q, abort) => { signal = abort; return new Promise(() => {}); },
  });
  const pending = askFirstRunQuestion(opts);
  t.mock.timers.tick(QUESTION_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(signal.aborted, true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: "skipped" });
  await askFirstRunQuestion({ ...opts, ask: () => assert.fail("must not re-ask") });
  assert.deepEqual(sent, []);
});

function terminal(t, buffered) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  if (buffered) input.write(buffered);
  const controller = new AbortController();
  let clock = 0;
  const result = readFirstRunAnswer(FIRST_RUN_QUESTION, controller.signal, input, output, () => clock);
  t.after(() => { controller.abort(); input.destroy(); output.destroy(); });
  return { input, result, controller, advance: (ms) => { clock += ms; t.mock.timers.tick(ms); } };
}

for (const ms of [0, 399, 400]) {
  test(`input starting at ${ms} ms skips even without Enter`, async (t) => {
    const tty = terminal(t);
    await nextTurn();
    tty.advance(ms);
    tty.input.write("session prompt, not an answer");
    tty.advance(PASTE_QUIET_MS);
    assert.equal(await tty.result, null);
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount("data"), 0);
  });
}

test("already buffered input is discarded even if its delivery is delayed", async (t) => {
  const tty = terminal(t, "a private prompt\nmore prompt\n");
  tty.advance(TYPE_AHEAD_MS + 1);
  await nextTurn();
  tty.advance(PASTE_QUIET_MS);
  assert.equal(await tty.result, null);
  assert.equal(tty.input.readableLength, 0);
});

test("a deliberate answer after 400 ms is accepted and restores stdin", async (t) => {
  const tty = terminal(t);
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS + 1);
  tty.input.write("2\r");
  tty.advance(PASTE_QUIET_MS);
  assert.equal(await tty.result, "2");
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount("data"), 0);
});

for (const chunks of [["one\ntwo\nthree"], ["one\r\n", "two\r\n", "three"],
  ["\x1b[200~one\n", "two\n", "three\x1b[201~"]]) {
  test(`multi-line paste is entirely drained: ${JSON.stringify(chunks)}`, async (t) => {
    const tty = terminal(t);
    await nextTurn();
    tty.advance(TYPE_AHEAD_MS + 1);
    for (const chunk of chunks) {
      tty.input.write(chunk);
      tty.advance(PASTE_QUIET_MS - 1);
    }
    tty.advance(PASTE_QUIET_MS);
    assert.equal(await tty.result, null);
    assert.equal(tty.input.readableLength, 0);
    assert.equal(tty.input.listenerCount("data"), 0);
  });
}

test("non-TTY reader leaves even buffered piped input untouched", async () => {
  const input = new PassThrough();
  input.write("private piped prompt\n");
  const before = input.readableLength;
  assert.equal(await readFirstRunAnswer("question", new AbortController().signal, input,
    new PassThrough()), null);
  assert.equal(input.readableLength, before);
  assert.equal(input.listenerCount("data"), 0);
});

test("a bracketed paste stays owned until its end, including a large slow paste", async (t) => {
  const tty = terminal(t);
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS + 1);
  tty.input.write("\x1b[200~" + "private prompt".repeat(1000) + "\n");
  tty.advance(1000);
  assert.equal(tty.input.isRaw, true);
  tty.input.write("more private prompt\n\x1b[201~");
  tty.advance(PASTE_QUIET_MS);
  assert.equal(await tty.result, null);
  assert.equal(tty.input.readableLength, 0);
});

test("EOF and abort both release the reader without an answer", async (t) => {
  for (const action of ["end", "abort"]) {
    await t.test(action, async (t) => {
      const tty = terminal(t);
      await nextTurn();
      if (action === "end") tty.input.end();
      else tty.controller.abort();
      assert.equal(await tty.result, null);
      assert.equal(tty.input.isRaw, false);
      assert.equal(tty.input.listenerCount("data"), 0);
    });
  }
});

test("Ctrl+C records skipped, restores the terminal, and propagates quit instead of launching", async (t) => {
  const tty = terminal(t);
  const { opts, sent, file } = fixture(t, { ask: () => tty.result });
  const pending = assert.rejects(askFirstRunQuestion(opts), QuestionInterrupted);
  await nextTurn();
  tty.input.write("\x03");
  await pending;
  assert.equal(tty.input.isRaw, false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: "skipped" });
  assert.deepEqual(sent, []);
});

function installFixture(t) {
  const base = mkdtempSync(join(tmpdir(), "ccc-new-install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, configDir: join(base, "config") };
}

test("no config directory or an empty directory is a genuinely new install", (t) => {
  const { configDir } = installFixture(t);
  assert.equal(takeNewInstall(configDir), true);
  mkdirSync(configDir);
  assert.equal(takeNewInstall(configDir), true);
});

for (const state of ["config.json", "install_id", "first_run_pending", "sessions", "logs",
  "memtree-links.json", "first-run-question.json", "unknown-old-state"]) {
  test(`existing ${state} excludes upgrades, including before diagnostics existed`, (t) => {
    const { base, configDir } = installFixture(t);
    mkdirSync(configDir);
    if (state === "sessions") mkdirSync(join(configDir, state));
    else writeFileSync(join(configDir, state), state === "config.json"
      ? JSON.stringify({ polychatApiKey: "saved-key" }) : "old state");
    assert.equal(hasNoInstallState(configDir), false);
    assert.equal(takeNewInstall(configDir), false);
    installBody({}, base, configDir); // npm upgrade mustn't turn old state into a new install
    assert.equal(takeNewInstall(configDir), false);
    assert.equal(existsSync(join(configDir, NEW_INSTALL_FILE)), false);
  });
}

test("fresh postinstall proof qualifies only its first launch, before new key/state writes", (t) => {
  const { base, configDir } = installFixture(t);
  installBody({}, base, configDir);
  const newInstall = takeNewInstall(configDir);
  assert.equal(newInstall, true);
  writeFileSync(join(configDir, "config.json"), '{"polychatApiKey":"new-key"}');
  assert.equal(newInstall, true, "startup snapshot survives this launch saving its first key");
  assert.equal(takeNewInstall(configDir), false);
});

test("old pending markers and mismatched new proof cannot qualify an upgrade", (t) => {
  const { configDir } = installFixture(t);
  mkdirSync(configDir);
  writeFileSync(join(configDir, "install_id"), "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
  writeFileSync(join(configDir, "first_run_pending"), "\n");
  assert.equal(takeNewInstall(configDir), false);
  writeFileSync(join(configDir, NEW_INSTALL_FILE), "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
  assert.equal(takeNewInstall(configDir), false);
});

test("a saved key or sessions alongside fresh postinstall proof still excludes the question", (t) => {
  for (const entry of ["config.json", "sessions"]) {
    const { base, configDir } = installFixture(t);
    installBody({}, base, configDir);
    writeFileSync(join(configDir, entry), "old state");
    assert.equal(takeNewInstall(configDir), false);
    assert.equal(existsSync(join(configDir, NEW_INSTALL_FILE)), false);
  }
});
