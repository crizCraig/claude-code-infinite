import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeTranscriptUsage, defaultProjectsDir, findTranscript } from "../dist/transcript-usage.js";
import { MemtreeClient } from "../dist/memtree.js";

const SESSION = "0f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

function transcriptDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-transcript-"));
  const project = path.join(root, "-Users-me-src-app");
  fs.mkdirSync(project);
  return { root, file: path.join(project, `${SESSION}.jsonl`) };
}
const entry = (id, content, usage, extra = {}) =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", content, usage }, ...extra }) + "\n";
const usage = (out, think, input = 1) => ({
  input_tokens: input, output_tokens: out, output_tokens_details: { thinking_tokens: think },
  cache_read_input_tokens: 100, cache_creation_input_tokens: 5,
});

test("each assistant message gets its response's usage, by tool id or text", () => {
  const { root, file } = transcriptDir();
  // Claude Code writes one entry per content block; the last carries final usage.
  fs.writeFileSync(file,
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n" +
    entry("msg_a", [{ type: "thinking", thinking: "" }], usage(10, 8)) +
    entry("msg_a", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], usage(40, 8)) +
    entry("msg_b", [{ type: "text", text: "Done. All tests " }], usage(5, 0)) +
    entry("msg_b", [{ type: "text", text: "pass." }], usage(60, 12)) +
    "not json\n");
  const source = new ClaudeTranscriptUsage(root);
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "Done. All tests pass." }] },
    { role: "assistant", content: [{ type: "text", text: "never answered by the transcript" }] },
  ];
  const got = source.usageFor(SESSION, messages);
  assert.deepEqual(Object.keys(got), ["2", "4"]);
  assert.deepEqual(got["2"], {
    output_tokens: 40, thinking_tokens: 8, input_tokens: 1,
    cache_read_input_tokens: 100, cache_creation_input_tokens: 5,
  });
  assert.equal(got["4"].output_tokens, 60);
  assert.equal(got["4"].thinking_tokens, 12);

  // Appended lines are picked up on the next call, including a line split
  // across two writes.
  const next = entry("msg_c", [{ type: "tool_use", id: "toolu_2", name: "Read", input: {} }], usage(30, 20));
  fs.appendFileSync(file, next.slice(0, 20));
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: {} }] });
  assert.equal(source.usageFor(SESSION, messages)["6"], undefined, "half a line is not parsed yet");
  fs.appendFileSync(file, next.slice(20));
  assert.equal(source.usageFor(SESSION, messages)["6"].thinking_tokens, 20);
});

test("no transcript, bad session ids and unreadable files give no usage", () => {
  const { root } = transcriptDir();
  const source = new ClaudeTranscriptUsage(root);
  const messages = [{ role: "assistant", content: "x" }];
  assert.deepEqual(source.usageFor(SESSION, messages), {});
  assert.deepEqual(source.usageFor("../../etc/passwd", messages), {});
  assert.deepEqual(new ClaudeTranscriptUsage("/nonexistent/dir").usageFor(SESSION, messages), {});
  assert.equal(findTranscript("/nonexistent/dir", SESSION), undefined);
  assert.equal(defaultProjectsDir({ CLAUDE_CONFIG_DIR: "/cfg" }), path.join("/cfg", "projects"));
});

test("each message gets the time Claude Code wrote it: responses, tool results, typed text", () => {
  const { root, file } = transcriptDir();
  const user = (content, timestamp) =>
    JSON.stringify({ type: "user", message: { role: "user", content }, timestamp }) + "\n";
  fs.writeFileSync(file,
    user("fix the <system-reminder>r1</system-reminder>bug", "2026-09-23T20:00:00.000Z") +
    entry("msg_a", [{ type: "thinking", thinking: "" }], usage(10, 8), { timestamp: "2026-09-23T20:00:05.000Z" }) +
    entry("msg_a", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], usage(40, 8),
      { timestamp: "2026-09-23T20:00:09.000Z" }) +
    user([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }], "2026-09-23T20:01:00.000Z") +
    user("and the docs", "2026-09-23T20:02:00.000Z") +
    entry("msg_b", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: "2026-09-23T22:03:00+02:00" }) +
    user("no time on this one", undefined));
  const source = new ClaudeTranscriptUsage(root);
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
    // Claude Code folds a tool result and the next typed prompt into one message.
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
      { type: "text", text: "<system-reminder>r2</system-reminder>and the docs" },
    ] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    { role: "user", content: "no time on this one" },
    { role: "user", content: "never typed" },
  ];
  assert.deepEqual(source.timesFor(SESSION, messages), {
    1: "2026-09-23T20:00:00.000Z",
    2: "2026-09-23T20:00:09.000Z", // the response's last entry
    3: "2026-09-23T20:02:00.000Z", // the latest of its parts
    4: "2026-09-23T20:03:00.000Z", // normalized to UTC
  });
  assert.deepEqual(new ClaudeTranscriptUsage("/nonexistent/dir").timesFor(SESSION, messages), {});
});

test("repeated text takes the next time in order, not the last one written", () => {
  const { root, file } = transcriptDir();
  const user = (content, timestamp) =>
    JSON.stringify({ type: "user", message: { role: "user", content }, timestamp }) + "\n";
  fs.writeFileSync(file,
    user("yes", "2026-09-23T20:00:00.000Z") +
    entry("msg_a", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: "2026-09-23T20:01:00.000Z" }) +
    user("yes", "2026-09-23T21:00:00.000Z") +
    entry("msg_b", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: "2026-09-23T21:01:00.000Z" }));
  const messages = [
    { role: "user", content: "yes" },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    { role: "user", content: "yes" },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ];
  assert.deepEqual(new ClaudeTranscriptUsage(root).timesFor(SESSION, messages), {
    0: "2026-09-23T20:00:00.000Z",
    1: "2026-09-23T20:01:00.000Z",
    2: "2026-09-23T21:00:00.000Z",
    3: "2026-09-23T21:01:00.000Z",
  });
});

test("a subagent's messages are timed from its own transcript under the session", () => {
  const { root, file } = transcriptDir();
  const user = (content, timestamp) =>
    JSON.stringify({ type: "user", message: { role: "user", content }, timestamp }) + "\n";
  fs.writeFileSync(file, user("main prompt", "2026-09-23T20:00:00.000Z"));
  const agentDir = path.join(path.dirname(file), SESSION, "subagents");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agent-a80911251b4ee7fa1.jsonl"),
    user("map the pipeline", "2026-09-23T20:05:00.000Z"));
  const source = new ClaudeTranscriptUsage(root);
  const agentMessages = [{ role: "user", content: "map the pipeline" }];
  const want = { 0: "2026-09-23T20:05:00.000Z" };
  assert.deepEqual(source.timesFor(SESSION, agentMessages, "a80911251b4ee7fa1"), want);
  assert.deepEqual(source.timesFor(SESSION, agentMessages, "agent-a80911251b4ee7fa1"), want);
  assert.deepEqual(source.timesFor(SESSION, agentMessages), {}, "not in the main transcript");
  assert.deepEqual(source.timesFor(SESSION, [{ role: "user", content: "main prompt" }], "a80911251b4ee7fa1"), {},
    "an agent never reads the main transcript");
  assert.deepEqual(source.timesFor(SESSION, agentMessages, "../x"), {});
  assert.deepEqual(source.timesFor(SESSION, [{ role: "user", content: "main prompt" }]),
    { 0: "2026-09-23T20:00:00.000Z" });
});

const timedUser = (content, timestamp) =>
  JSON.stringify({ type: "user", message: { role: "user", content }, timestamp }) + "\n";
const EARLY = "2026-09-23T20:00:00.000Z";
const LATE = "2026-09-23T21:00:00.000Z";

test("consecutive repeated user messages consume occurrences and omit exhausted matches", () => {
  const { root, file } = transcriptDir();
  fs.writeFileSync(file, timedUser("yes", EARLY) + timedUser("yes", LATE));
  const source = new ClaudeTranscriptUsage(root);
  const messages = Array.from({ length: 3 }, () => ({ role: "user", content: "yes" }));
  assert.deepEqual(source.timesFor(SESSION, messages), { 0: EARLY, 1: LATE });
  assert.deepEqual(source.timesFor(SESSION, messages), { 0: EARLY, 1: LATE },
    "each call matches the whole history afresh");
});

test("merged repeated text consumes both occurrences and takes the latest time", () => {
  const { root, file } = transcriptDir();
  fs.writeFileSync(file, timedUser("yes", EARLY) + timedUser("yes", LATE));
  assert.deepEqual(new ClaudeTranscriptUsage(root).timesFor(SESSION, [
    { role: "user", content: [{ type: "text", text: "yes" }, { type: "text", text: "yes" }] },
    { role: "user", content: "yes" },
  ]), { 0: LATE });
});

test("distinct repeated entries with identical timestamps remain separate occurrences", () => {
  const { root, file } = transcriptDir();
  fs.writeFileSync(file, timedUser("yes", EARLY) + timedUser("yes", EARLY));
  const messages = Array.from({ length: 3 }, () => ({ role: "user", content: "yes" }));
  assert.deepEqual(new ClaudeTranscriptUsage(root).timesFor(SESSION, messages), { 0: EARLY, 1: EARLY });
});

test("text matches never fall back to entries earlier than the previous message", () => {
  const { root, file } = transcriptDir();
  fs.writeFileSync(file, timedUser("old", EARLY) +
    entry("old-answer", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: EARLY }) +
    timedUser("current", LATE));
  assert.deepEqual(new ClaudeTranscriptUsage(root).timesFor(SESSION, [
    { role: "user", content: "current" },
    { role: "user", content: "old" },
    { role: "assistant", content: "Done." },
  ]), { 0: LATE });
});

test("consecutive repeated assistant text consumes response occurrences", () => {
  const { root, file } = transcriptDir();
  fs.writeFileSync(file,
    entry("first", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: EARLY }) +
    entry("second", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: LATE }));
  const messages = Array.from({ length: 3 }, () => ({ role: "assistant", content: "Done." }));
  assert.deepEqual(new ClaudeTranscriptUsage(root).timesFor(SESSION, messages), { 0: EARLY, 1: LATE });
});

test("user timestamp matching checks the entire reminder-stripped text", () => {
  const { root, file } = transcriptDir();
  const prefix = "instructions ".repeat(50);
  fs.writeFileSync(file, timedUser(prefix + "first", EARLY) + timedUser(prefix + "second", LATE));
  const source = new ClaudeTranscriptUsage(root);
  assert.deepEqual(source.timesFor(SESSION, [
    { role: "user", content: prefix + "<system-reminder>extra</system-reminder>second" },
    { role: "user", content: prefix + "never written" },
  ]), { 0: LATE });
});

test("assistant text matching checks the entire response, including accumulated blocks", () => {
  const { root, file } = transcriptDir();
  const prefix = "answer ".repeat(80);
  fs.writeFileSync(file,
    entry("first", [{ type: "text", text: prefix + "first" }], usage(5, 0), { timestamp: EARLY }) +
    entry("second", [{ type: "text", text: prefix }], usage(6, 0), { timestamp: LATE }) +
    entry("second", [{ type: "text", text: "second" }], usage(7, 0), { timestamp: LATE }));
  const source = new ClaudeTranscriptUsage(root);
  assert.deepEqual(source.timesFor(SESSION, [
    { role: "assistant", content: prefix + "second" },
    { role: "assistant", content: prefix + "never written" },
  ]), { 0: LATE });
  assert.deepEqual(source.timesFor(SESSION, [{ role: "assistant", content: prefix }]), {},
    "a stale intermediate text key does not identify the final response");
});


test("matching a response by tool id also consumes its text occurrence", () => {
  const { root, file } = transcriptDir();
  const tool = { type: "tool_use", id: "tool-one", name: "Bash", input: {} };
  fs.writeFileSync(file,
    entry("first", [{ type: "text", text: "Done." }, tool], usage(5, 0), { timestamp: EARLY }) +
    entry("second", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: LATE }));
  assert.deepEqual(new ClaudeTranscriptUsage(root).timesFor(SESSION, [
    { role: "assistant", content: [tool] },
    { role: "assistant", content: "Done." },
    { role: "assistant", content: "Done." },
  ]), { 0: EARLY, 1: LATE });
});

test("full-text usage matching ignores collisions and stale intermediate response keys", () => {
  const { root, file } = transcriptDir();
  const prefix = "answer ".repeat(80);
  fs.writeFileSync(file,
    entry("first", [{ type: "text", text: prefix }], usage(5, 0)) +
    entry("second", [{ type: "text", text: prefix }], usage(6, 0)) +
    entry("second", [{ type: "text", text: "second" }], usage(7, 0)));
  const got = new ClaudeTranscriptUsage(root).usageFor(SESSION, [
    { role: "assistant", content: prefix },
    { role: "assistant", content: prefix + "second" },
    { role: "assistant", content: prefix + "never written" },
  ]);
  assert.deepEqual(Object.keys(got), ["0", "1"]);
  assert.equal(got["0"].output_tokens, 5);
  assert.equal(got["1"].output_tokens, 7);
});

test("background indexing preserves multi-block response times while removing reminders", async (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file,
    timedUser("check the tests", EARLY) +
    entry("answer", [{ type: "text", text: "Done. All tests " }], usage(5, 0),
      { timestamp: EARLY }) +
    entry("answer", [{ type: "text", text: "pass." }], usage(7, 0),
      { timestamp: LATE }));
  const messages = [
    { role: "user", content: "<system-reminder>drop this message</system-reminder>" },
    { role: "user", content: "check the <system-reminder>extra</system-reminder>tests" },
    { role: "assistant", content: [
      { type: "text", text: "Done. All tests " },
      { type: "text", text: "pass." },
    ] },
  ];
  const source = new ClaudeTranscriptUsage(root);
  assert.deepEqual(source.timesFor(SESSION, messages), { 1: EARLY, 2: LATE });
  assert.equal(source.usageFor(SESSION, messages)["2"].output_tokens, 7);
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ messages: [] }));
  });
  const memtree = new MemtreeClient({ baseUrl: "https://memtree.invalid", apiKey: "k" });
  memtree.indexInBackground("multi-block-times", messages, 200_000, SESSION, undefined,
    (retained) => source.timesFor(SESSION, retained));
  await memtree.drainBackground();
  assert.deepEqual(sent.message_times, { 0: EARLY, 1: LATE });
  assert.deepEqual(sent.messages, [
    { role: "user", content: "check the tests" },
    { role: "assistant", content: [
      { type: "text", text: "Done. All tests" },
      { type: "text", text: "pass." },
    ] },
  ]);
});

const TRANSCRIPT_READ_BUDGET = 1024 * 1024;

test("oversized lines are discarded with bounded work and recover only after their newline", (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The valid-looking suffix is still part of the corrupt line, not an entry.
  fs.writeFileSync(file, "x".repeat(4 * TRANSCRIPT_READ_BUDGET) +
    entry("suffix", [{ type: "text", text: "must not match" }], usage(90, 10)) +
    entry("recovered", [{ type: "text", text: "recovered" }], usage(7, 2), { timestamp: LATE }));
  const source = new ClaudeTranscriptUsage(root);
  const messages = [
    { role: "assistant", content: "must not match" },
    { role: "assistant", content: "recovered" },
  ];
  const originalRead = fs.readSync;
  const reads = [];
  t.mock.method(fs, "readSync", (...args) => {
    reads.push({ length: args[3], position: args[4] });
    return originalRead(...args);
  });
  for (let call = 0; call < 4; call++) {
    const before = reads.length;
    const got = call % 2 ? source.timesFor(SESSION, messages) : source.usageFor(SESSION, messages);
    assert.deepEqual(got, {});
    assert.equal(reads.length - before, 1, "each metadata lookup performs only one read, even while skipping");
    assert.equal(reads.at(-1).length, TRANSCRIPT_READ_BUDGET);
    assert.equal(reads.at(-1).position, call * TRANSCRIPT_READ_BUDGET);
    // Inspect retained bytes: an unfinished corrupt line cannot grow with the file.
    const index = source.sessions.get(SESSION);
    assert.ok(index.partial.length <= TRANSCRIPT_READ_BUDGET);
    if (call > 0) assert.equal(index.partial.length, 0, "discarded bytes are not retained");
  }
  const got = source.usageFor(SESSION, messages);
  assert.deepEqual(Object.keys(got), ["1"], "the oversized line's suffix was never parsed");
  assert.equal(got["1"].output_tokens, 7);
  assert.deepEqual(source.timesFor(SESSION, messages), { 1: LATE });
  assert.equal(reads.length, 5, "EOF lookups need no further reads");
});

test("truncating a transcript clears oversized-line discard state", (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, "x".repeat(2 * TRANSCRIPT_READ_BUDGET));
  const source = new ClaudeTranscriptUsage(root);
  const messages = [{ role: "assistant", content: "new transcript" }];
  assert.deepEqual(source.usageFor(SESSION, messages), {});
  assert.deepEqual(source.usageFor(SESSION, messages), {});
  fs.writeFileSync(file, entry("new", [{ type: "text", text: "new transcript" }], usage(8, 3)));
  assert.equal(source.usageFor(SESSION, messages)["0"].output_tokens, 8);
});

test("UTF-8 text survives a character split across bounded transcript reads", (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const line = Buffer.from(entry("unicode", [{ type: "text", text: "😀done" }], usage(6, 1)));
  const characterOffset = line.indexOf(Buffer.from("😀"));
  const paddingLength = TRANSCRIPT_READ_BUDGET - characterOffset - 1;
  fs.writeFileSync(file, Buffer.concat([Buffer.from(" ".repeat(paddingLength - 1) + "\n"), line]));
  const source = new ClaudeTranscriptUsage(root);
  const messages = [{ role: "assistant", content: "😀done" }];
  assert.deepEqual(source.usageFor(SESSION, messages), {}, "first read ends inside the emoji");
  assert.equal(source.usageFor(SESSION, messages)["0"].output_tokens, 6);
});


test("usage omits repeated response text, including a subset containing only one occurrence", (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const text = (value) => ({ type: "text", text: value });
  fs.writeFileSync(file,
    entry("msg_a", [text("Done.")], usage(10, 2)) +
    entry("msg_b", [text("Done.")], usage(200, 30)) +
    entry("msg_c", [text("Unique answer")], usage(70, 4)));
  const source = new ClaudeTranscriptUsage(root);
  const done = { role: "assistant", content: [text("Done.")] };
  const unique = { role: "assistant", content: "Unique answer" };
  assert.deepEqual(source.usageFor(SESSION, [done, done]), {});
  assert.deepEqual(source.usageFor(SESSION, [done]), {}, "a partial history cannot identify which Done response remains");
  assert.deepEqual(source.usageFor(SESSION, [unique, unique]), {}, "one response cannot supply two messages");
  const got = source.usageFor(SESSION, [done, unique]);
  assert.deepEqual(Object.keys(got), ["1"]);
  assert.equal(got[1].output_tokens, 70);
  assert.equal(got[1].thinking_tokens, 4);
});

test("usage reserves tool identities before text matching regardless of input order", (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const text = { type: "text", text: "Done." };
  const tool = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
  fs.writeFileSync(file,
    entry("msg_a", [text, tool("tool_a")], usage(10, 2)) +
    entry("msg_b", [text], usage(200, 30)));
  const source = new ClaudeTranscriptUsage(root);
  const identified = { role: "assistant", content: [text, tool("tool_a")] };
  const plain = { role: "assistant", content: [text] };
  for (const messages of [[identified, plain], [plain, identified]]) {
    const got = source.usageFor(SESSION, messages);
    assert.equal(got[messages.indexOf(identified)].output_tokens, 10);
    assert.equal(got[messages.indexOf(plain)].output_tokens, 200);
  }
  // When only the identified response exists, a separate text block cannot
  // reuse it as though it were a second response.
  fs.writeFileSync(file, entry("msg_a", [text, tool("tool_a")], usage(10, 2)));
  const fresh = new ClaudeTranscriptUsage(root);
  const got = fresh.usageFor(SESSION, [plain, identified]);
  assert.deepEqual(Object.keys(got), ["1"]);
  assert.equal(got[1].output_tokens, 10);
});

test("usage omits conflicting, unknown, and duplicate tool response claims", (t) => {
  const { root, file } = transcriptDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tool = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
  const text = { type: "text", text: "Done." };
  const message = (...parts) => ({ role: "assistant", content: parts });
  fs.writeFileSync(file,
    entry("msg_a", [text, tool("tool_a"), tool("tool_a2")], usage(10, 2)) +
    entry("msg_b", [text, tool("tool_b")], usage(200, 30)));
  const source = new ClaudeTranscriptUsage(root);
  assert.deepEqual(source.usageFor(SESSION, [message(tool("tool_a"), tool("tool_b")), message(text)]), {});
  assert.deepEqual(source.usageFor(SESSION, [message(tool("tool_a")), message(tool("tool_a2"))]), {});
  assert.deepEqual(source.usageFor(SESSION, [message(text, tool("unknown"))]), {});
  assert.deepEqual(source.usageFor(SESSION, [message(tool("tool_a"), tool("unknown"))]), {});
  const got = source.usageFor(SESSION, [message(tool("tool_a"), tool("tool_a2"))]);
  assert.equal(got[0].output_tokens, 10, "multiple tools in the same response are unambiguous");
});
