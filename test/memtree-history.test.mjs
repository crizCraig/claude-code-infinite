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
  const result = {
    messages: [{ role: "user", content: "placeholder" }],
    flattened_messages: [{
      role: "user",
      content:
        "Retained historical memory. ".repeat(100) +
        "\nCurrent question: " +
        currentTurn,
    }],
    usage,
  };

  const check = checkCompressedHistory(result, sent);

  assert.equal(check.usable, true);
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
