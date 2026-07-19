import test from "node:test";
import assert from "node:assert/strict";
import {
  isNonToolUserMessage,
  isLocalBashCommandTurn,
  lastNonSystemMessage,
  hasEarlierNonToolUserMessage,
} from "../dist/turns.js";

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
