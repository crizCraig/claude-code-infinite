import test from "node:test";
import assert from "node:assert/strict";
import { checkCompressedHistory } from "../dist/memtree.js";

const usage = { prompt_tokens_details: { cached_tokens: 10_000 } };

function sentConversation(currentTurn) {
  return [
    { role: "user", content: "Remember the deployment decisions" },
    {
      role: "assistant",
      content: "Earlier decisions and evidence. ".repeat(150),
    },
    { role: "user", content: currentTurn },
  ];
}

test("checkCompressedHistory uses a valid server flatten for retained history", () => {
  const currentTurn = "What should we deploy next?";
  const sent = sentConversation(currentTurn);
  const result = {
    messages: [
      { role: "user", content: "Retained historical memory. ".repeat(180) },
      { role: "user", content: currentTurn },
    ],
    flattened_messages: [{
      role: "user",
      content: currentTurn,
    }],
    usage,
  };

  const check = checkCompressedHistory(result, sent);

  assert.equal(check.usable, false);
});

test("checkCompressedHistory accepts retained text in a valid server flatten", () => {
  const currentTurn = "What should we deploy next?";
  const sent = sentConversation(currentTurn);
  const retainedHistory = "Retained historical memory. ".repeat(100);
  const result = {
    messages: [
      { role: "user", content: retainedHistory },
      { role: "user", content: currentTurn },
    ],
    flattened_messages: [{
      role: "user",
      content:
        retainedHistory +
        "\nCurrent question: " +
        currentTurn,
    }],
    usage,
  };

  const check = checkCompressedHistory(result, sent);

  assert.equal(check.usable, true);
  assert.equal(check.retainedChars, result.flattened_messages[0].content.length);
});

test("checkCompressedHistory charges repeated current-turn echoes in a flatten", () => {
  const currentTurn = "Repeat this exact current question. ".repeat(140);
  const sent = sentConversation(currentTurn);
  const result = {
    messages: [{ role: "user", content: "Retained historical memory. ".repeat(100) }],
    flattened_messages: [{
      role: "user",
      content: `First echo:\n${currentTurn}\nSecond echo:\n${currentTurn}`,
    }],
    usage,
  };

  const check = checkCompressedHistory(result, sent);

  assert.equal(check.usable, false);
});

test("checkCompressedHistory recognizes rendered nested tool-result text", () => {
  const toolText = "The tool output contains only the current lookup. ".repeat(150);
  for (const toolContent of [
    toolText,
    [{ type: "text", text: toolText }],
  ]) {
    const sent = [
      { role: "user", content: "Remember all earlier decisions." },
      { role: "assistant", content: "Earlier decisions and evidence. ".repeat(500) },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: toolContent }],
      },
    ];
    const result = {
      messages: [
        { role: "user", content: "Retained historical memory. ".repeat(150) },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: toolContent }],
        },
      ],
      flattened_messages: [{
        role: "user",
        content:
          "The result of your last tool call follows. Continue the task.\n\n" +
          "→ result: " +
          toolText,
      }],
      usage,
    };

    const check = checkCompressedHistory(result, sent);

    assert.equal(check.usable, false);
  }
});

// Canonical single-message renderings from the backend's flatten_messages.py:
// tool blocks use pretty JSON, while top-level text blocks use blank lines.
// Short lines evade the flatten's verbatim probes after this formatting changes.
const logLines = Array.from(
  { length: 180 },
  (_, i) => `item ${String(i).padStart(3, "0")}: status ready`
);
const textBlocks = logLines.map((text) => ({ type: "text", text }));
const toolResults = [logLines.join("\n"), textBlocks].map((content) => ({
  type: "tool_result",
  tool_use_id: "lookup-1",
  content,
}));
const canonicalEchoCases = [
  ...toolResults.map((block, i) => ({
    name: i === 0 ? "multiline tool result" : "nested short text blocks",
    content: [block],
    flattened: JSON.stringify(block, null, 2),
  })),
  {
    name: "top-level short text blocks",
    content: textBlocks,
    flattened: logLines.join("\n\n"),
  },
];

for (const { name, content, flattened } of canonicalEchoCases) {
  test(`checkCompressedHistory rejects canonically rendered current-only ${name}`, () => {
    const sent = sentConversation(content);
    const result = {
      messages: [sent.at(-1)],
      flattened_messages: [{ role: "user", content: flattened }],
      compressed: true,
    };

    const check = checkCompressedHistory(result, sent);

    assert.equal(check.retainedChars, flattened.length);
    assert.equal(check.usable, false);
  });
}
