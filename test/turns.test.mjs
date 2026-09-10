import test from "node:test";
import assert from "node:assert/strict";
import {
  isNonToolUserMessage,
  isLocalBashCommandTurn,
  lastNonSystemMessage,
  hasEarlierNonToolUserMessage,
  contextLimitForModel,
} from "../dist/turns.js";
import { serverFlattenedMessages } from "../dist/memtree.js";

const user = (text) => ({ role: "user", content: text });
const userBlocks = (blocks) => ({ role: "user", content: blocks });
const assistant = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolResultWrapper = () =>
  userBlocks([
    { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
    { type: "text", text: "<system-reminder>ambient note</system-reminder>" },
  ]);
const reminderOnly = () =>
  user("<system-reminder>synthetic reminder</system-reminder>");

test("first user turn: single real user message has no earlier user input", () => {
  assert.equal(hasEarlierNonToolUserMessage([user("hi")]), false);
});

test("followup user turn: earlier real user input detected", () => {
  const messages = [user("first"), assistant("reply"), user("second")];
  assert.equal(hasEarlierNonToolUserMessage(messages), true);
});

test("trailing ambient system context does not hide the typed user turn", () => {
  const ambient = {
    role: "system",
    content: "The following agent types are no longer available... ambient context",
  };
  const first = [user("typed prompt"), ambient];
  assert.equal(lastNonSystemMessage(first), first[0]);
  assert.equal(hasEarlierNonToolUserMessage(first), false);

  const followup = [user("old"), assistant("reply"), user("typed prompt"), ambient];
  assert.equal(lastNonSystemMessage(followup), followup[2]);
  assert.equal(hasEarlierNonToolUserMessage(followup), true);
});

test("tool_result wrappers do not count as earlier user input", () => {
  const messages = [toolResultWrapper(), assistant("used tool"), user("first real input")];
  assert.equal(hasEarlierNonToolUserMessage(messages), false);
});

test("system-reminder-only messages do not count as earlier user input", () => {
  const messages = [reminderOnly(), assistant("noted"), user("first real input")];
  assert.equal(hasEarlierNonToolUserMessage(messages), false);
});

test("the last message itself is excluded from the earlier scan", () => {
  assert.equal(hasEarlierNonToolUserMessage([user("only")]), false);
  // ...even in a tool-turn shape where the last message is a wrapper
  const messages = [user("real"), assistant("run"), toolResultWrapper()];
  assert.equal(hasEarlierNonToolUserMessage(messages), true);
});

test("recap-fork style plain text counts as a real user turn (2026-07-03 decision)", () => {
  assert.equal(isNonToolUserMessage(user("recap of what happened while away")), true);
});

test("empty history", () => {
  assert.equal(hasEarlierNonToolUserMessage([]), false);
});

test("local bang commands are recognized from Claude Code's replay wrappers", () => {
  const local = [
    user("earlier"),
    assistant("reply"),
    user("<bash-input>pwd</bash-input>"),
    user(
      "<bash-stdout>/tmp/project</bash-stdout>" +
        "<bash-stderr></bash-stderr>"
    ),
    { role: "system", content: "ambient context" },
  ];
  assert.equal(isLocalBashCommandTurn(local), true);
  assert.equal(
    isLocalBashCommandTurn([
      userBlocks([{ type: "text", text: "<bash-input>pwd</bash-input>" }]),
      userBlocks([
        {
          type: "text",
          text:
            "<bash-stdout>/tmp/project</bash-stdout>" +
            "<bash-stderr></bash-stderr>",
        },
      ]),
    ]),
    true
  );
  assert.equal(
    isLocalBashCommandTurn([
      user("earlier"),
      assistant("reply"),
      user("ordinary followup"),
    ]),
    false
  );
  assert.equal(
    isLocalBashCommandTurn([
      user("<bash-input>pwd</bash-input>"),
      user("unwrapped output"),
    ]),
    false
  );
});

test("current native models use 1M without a suffix or beta header", () => {
  for (const model of [
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
  ]) {
    assert.equal(contextLimitForModel(model), 1_000_000, model);
  }
});

test("point releases of native-1M models keep the 1M window", () => {
  // Fable 5.1 shipped as "claude-fable-5-1": before this it fell through to
  // 200k and the server clamped its 500k budget to the 200k window.
  for (const model of [
    "claude-fable-5-1",
    "claude-fable-5-1-20260901",
    "claude-fable-5-1[1m]",
    "claude-opus-5-1",
    "CLAUDE-FABLE-5-1",
  ]) {
    assert.equal(contextLimitForModel(model), 1_000_000, model);
  }
  // A different family is not a variant of a native-1M model.
  assert.equal(contextLimitForModel("claude-fable-4"), 200_000);
  assert.equal(contextLimitForModel("claude-opus-4-6-1"), 200_000);
});

test("native 1M inference can be disabled without affecting explicit 1M signals", () => {
  assert.equal(
    contextLimitForModel("claude-opus-4-8", undefined, false),
    200_000
  );
  assert.equal(
    contextLimitForModel("claude-opus-4-8[1m]", undefined, false),
    1_000_000
  );
  assert.equal(
    contextLimitForModel(
      "claude-opus-4-6",
      "context-1m-2025-08-07",
      false
    ),
    1_000_000
  );
});

test("legacy models remain 200k unless extended context is selected", () => {
  assert.equal(contextLimitForModel("claude-opus-4-6"), 200_000);
  assert.equal(contextLimitForModel("claude-haiku-4-5"), 200_000);
});

// The flatten FORMAT (headers, closed record, live tail, escaping,
// redacted_thinking exclusion) is implemented and tested server-side only
// (polychat/memory/flatten_messages.py). The client's job is to accept the
// server's flatten verbatim when it is well-formed and reject anything else
// into full-history degrade — that contract is what these tests pin.

test("serverFlattenedMessages accepts exactly one string-content user message", () => {
  const flat = serverFlattenedMessages({
    messages: [{ role: "user", content: "ignored structured form" }],
    flattened_messages: [{ role: "user", content: "[USER]\nhello" }],
  });
  assert.deepEqual(flat, [{ role: "user", content: "[USER]\nhello" }]);
});

test("serverFlattenedMessages returns a fresh array, not the result's own", () => {
  const result = {
    messages: [],
    flattened_messages: [{ role: "user", content: "conversation" }],
  };
  const flat = serverFlattenedMessages(result);
  assert.notEqual(flat, result.flattened_messages);
  assert.notEqual(flat[0], result.flattened_messages[0]);
});

test("serverFlattenedMessages rejects pre-flatten and malformed responses", () => {
  const base = { messages: [{ role: "user", content: "hi" }] };
  // Pre-flatten server: field absent entirely.
  assert.equal(serverFlattenedMessages({ ...base }), null);
  // Wrong shapes: never "repair" locally — the client has no flatten of its
  // own, so every one of these must degrade to forwarding real history.
  for (const flattened_messages of [
    "not an array",
    [],
    [
      { role: "user", content: "two" },
      { role: "user", content: "messages" },
    ],
    [{ role: "assistant", content: "wrong role" }],
    [{ role: "user", content: [{ type: "text", text: "block content" }] }],
    [{ role: "user", content: "" }],
    [null],
  ]) {
    assert.equal(
      serverFlattenedMessages({ ...base, flattened_messages }),
      null,
      `should reject ${JSON.stringify(flattened_messages)}`
    );
  }
});
