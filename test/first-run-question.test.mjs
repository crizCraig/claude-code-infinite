import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../dist/diagnostics.js";
import { sanitizeContext, sanitizeEvent } from "../dist/diagnostics-schema.js";
import {
  askFirstRunQuestion, FIRST_RUN_QUESTION, FIRST_RUN_QUESTION_FILE,
  PASTE_QUIET_MS, QuestionInterrupted, QUESTION_TIMEOUT_MS, readFirstRunAnswer, TYPE_AHEAD_MS,
} from "../dist/first-run-question.js";
import { hasNoInstallState, NEW_INSTALL_FILE, takeNewInstall } from "../dist/new-install.js";
import { installBody } from "../dist/install-ping.js";

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
    configDir, newInstall: true, keyCheck: { paid: true }, args: [], env: {}, stdinIsTty: true, stdoutIsTty: true, diagnostics,
    ask: async (q) => { asked.push(q); return "long_agents"; }, ...overrides,
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
    status: "answered", answer: "long_agents",
  });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://example.test/v1/ccc/diagnostics");
  assert.equal(sent[0].headers.authorization, "Bearer account-key");
  assert.deepEqual(sent[0].body.events.map(({ t, ...e }) => e), [
    { name: "first_run_answer", answer: "long_agents" },
  ]);
  assert.equal(sent[0].body.context.answer, undefined);
});

for (const answer of ["skipped", "private prompt", null]) {
  test(`skip/EOF ${JSON.stringify(answer)} is permanent and sends nothing`, async (t) => {
    const { opts, sent, file } = fixture(t, { ask: async () => answer });
    await askFirstRunQuestion(opts);
    await askFirstRunQuestion({ ...opts, ask: () => assert.fail("must not re-ask") });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: "skipped" });
    assert.deepEqual(sent, []);
  });
}

const skips = [
  { newInstall: false }, { keyCheck: "invalid" },
  ...["-p", "--print", "--print=x", "-pc", "-cp", "-prsession"].map((flag) => ({ args: [flag] })),
  { args: ["--append-system-prompt", "--", "-cp"] },
  ...["--help", "--version", "doctor", "mcp"].map((flag) => ({ args: [flag] })),
  ...[
    ["--append-system-prompt", "--", "--help"], ["--", "--version"], ["config"],
    ["auth", "status", "--json"], ["new-future-command"], ["--model", "sonnet", "doctor"],
  ].map(args => ({ args })),
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

test("standalone continue and resume flags can show the question", async t => {
  for (const flag of ["--continue", "-c", "--resume", "-r"]) {
    const { opts, asked } = fixture(t, { args: [flag] });
    await askFirstRunQuestion(opts);
    assert.deepEqual(asked, [FIRST_RUN_QUESTION]);
  }
});

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
  resolve("remember");
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

const choices = ["long_sessions", "long_agents", "remember", "save_usage", "curious", "other"];

test("the answer field accepts only exact first-run enum values and only on its event", () => {
  for (const answer of [...choices, "skipped"]) {
    assert.deepEqual(sanitizeEvent("first_run_answer", { answer, text: "private" }, 1), {
      name: "first_run_answer", t: 1, answer,
    });
    assert.deepEqual(sanitizeContext({ answer }), {});
    assert.deepEqual(sanitizeEvent("session_start", { answer }, 1), { name: "session_start", t: 1 });
  }
  for (const answer of ["private prompt", "Long coding sessions", " other", "OTHER", null, {}, 6]) {
    assert.deepEqual(sanitizeEvent("first_run_answer", { answer }, 1), { name: "first_run_answer", t: 1 });
  }
});

function terminal(t, buffered, display = (flushed) => flushed()) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  let screen = "";
  output.write = (chunk, flushed) => {
    screen += chunk;
    if (flushed) display(flushed);
    return true;
  };
  if (buffered) input.write(buffered);
  const controller = new AbortController();
  const forwarded = [];
  const relay = {
    fd: 10, close() {},
    forward(prefix) {
      forwarded.push(prefix);
      input.on("data", chunk => forwarded.push(chunk));
      input.resume();
    },
  };
  const result = readFirstRunAnswer(FIRST_RUN_QUESTION, controller.signal, input, output, { prepare: async () => relay });
  t.after(() => { controller.abort(); input.destroy(); output.destroy(); });
  function advance(ms) { t.mock.timers.tick(ms); }
  function key(value) { input.write(value); advance(PASTE_QUIET_MS + 1); }
  return { input, result, controller, advance, key, relay, forwarded, screen: () => screen };
}

for (const [i, label] of choices.entries()) {
  test(`a single ${i + 1} picks ${label} without Enter`, async (t) => {
    const tty = terminal(t);
    await nextTurn();
    tty.advance(TYPE_AHEAD_MS + 1);
    tty.key(String(i + 1));
    tty.controller.abort(); // a pick must already have finished
    assert.equal(await tty.result, label);
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount("data"), 0);
  });
}

for (const [name, bytes] of [
  ["Enter", Buffer.from("\r")], ["digit", Buffer.from("3")],
  ["Ctrl+C", Buffer.from([3])], ["partial UTF-8", Buffer.from([0xf0, 0x9f])],
]) {
  test(`queued ${name} reaches Claude without showing the question`, async (t) => {
    const tty = terminal(t, bytes);
    await nextTurn();
    assert.equal(await tty.result, tty.relay);
    assert.deepEqual(Buffer.concat(tty.forwarded), bytes);
    tty.advance(QUESTION_TIMEOUT_MS);
    assert.ok(!tty.screen().includes(FIRST_RUN_QUESTION));
  });
}

test("typing during the guard bypasses the question and preserves subsequent reads", async t => {
  const tty = terminal(t);
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS - 1);
  tty.input.write("review ");
  tty.advance(1000);
  tty.input.write("file 3\r");
  assert.equal(await tty.result, tty.relay);
  assert.ok(!tty.screen().includes(FIRST_RUN_QUESTION));
  assert.equal(Buffer.concat(tty.forwarded).toString(), "review file 3\r");
});

test("a digit typed while menu output is queued belongs to Claude", async t => {
  let flush;
  const tty = terminal(t, undefined, callback => { flush = callback; });
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS);
  tty.input.write("6");
  flush();
  assert.equal(await tty.result, tty.relay);
  assert.equal(Buffer.concat(tty.forwarded).toString(), "6");
  assert.ok(!tty.screen().includes(FIRST_RUN_QUESTION));
});

test("a pending digit followed by text is handed off with the text", async t => {
  const tty = terminal(t);
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS);
  tty.input.write("3");
  tty.input.write(" files\r");
  assert.equal(await tty.result, tty.relay);
  assert.equal(Buffer.concat(tty.forwarded).toString(), "3 files\r");
});

test("a deliberate Enter skips the displayed menu", async t => {
  const tty = terminal(t);
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS);
  tty.input.write("\r");
  assert.equal(await tty.result, "skipped");
  assert.equal(tty.input.isRaw, false);
});

test("the menu times out after 45 seconds", async (t) => {
  const tty = terminal(t);
  await nextTurn();
  tty.advance(TYPE_AHEAD_MS);
  tty.advance(QUESTION_TIMEOUT_MS - 1);
  assert.ok(tty.input.isRaw);
  tty.advance(1);
  assert.equal(tty.input.isRaw, false);
  assert.equal(await tty.result, "skipped");
});

test("non-TTY reader leaves even buffered piped input untouched", async () => {
  const input = new PassThrough();
  input.write("private piped prompt\n");
  const before = input.readableLength;
  assert.equal(await readFirstRunAnswer("question", new AbortController().signal, input,
    new PassThrough()), "skipped");
  assert.equal(input.readableLength, before);
  assert.equal(input.listenerCount("data"), 0);
});

test("EOF and abort both release the reader without an answer", async (t) => {
  for (const action of ["end", "abort"]) {
    await t.test(action, async (t) => {
      const tty = terminal(t);
      await nextTurn();
      if (action === "end") tty.input.end();
      else tty.controller.abort();
      assert.equal(await tty.result, "skipped");
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
  tty.advance(TYPE_AHEAD_MS);
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
