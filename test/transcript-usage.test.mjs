import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeTranscriptUsage, defaultProjectsDir, findTranscript } from "../dist/transcript-usage.js";

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
    entry("msg_b", [{ type: "text", text: "Done." }], usage(5, 0), { timestamp: "2026-09-23T20:03:00+02:00" }) +
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
    4: "2026-09-23T18:03:00.000Z", // normalized to UTC
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
