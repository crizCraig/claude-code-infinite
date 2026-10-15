// A prompt the user types mid-turn reaches the API as an untagged text block beside
// the next tool result. The server hashes and indexes it as sent
// (polychat plans/2026-10-05_PLAN_versioned_midturn_reminders.md), so the index-only
// path (client strip) and the compress path (raw, stripped by the server with the
// same rule) must send it identically.
import test from "node:test";
import assert from "node:assert/strict";
import { stripCcSystemReminders } from "../dist/turns.js";
import { normalizeMessagesForMemtree } from "../dist/memtree.js";
import { prepareFinalMessages } from "../dist/final-index.js";

const HEADER = "The user sent a new message while you were working:\n";
const FOOTER =
  "\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the " +
  "running turn, often alongside the next tool result, rather than as a separate " +
  "conversation turn. Address the message above as you continue this turn.";
const block = (words, trailing = "") => HEADER + words + FOOTER + trailing;

// Claude Code 2.1.x: one block, or several with a newline after all but the last.
const midTurn = (...words) => ({
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "1 failed" },
    ...words.map((w, i) => ({ type: "text", text: block(w, i < words.length - 1 ? "\n" : "") })),
  ],
});

test("an untagged mid-turn block passes every client path byte-identical", async () => {
  const words = "don't deploy yet\n\n<system-reminder>pasted</system-reminder> keep";
  const message = midTurn("use Grok 4.7 too");
  const sent = JSON.stringify(message);
  assert.equal(JSON.stringify(stripCcSystemReminders([message])), `[${sent}]`);
  assert.equal(JSON.stringify(normalizeMessagesForMemtree([message])), `[${sent}]`);
  const prepared = await prepareFinalMessages([message], new AbortController().signal);
  assert.equal(prepared.serialized, `[${sent}]`);
  // Words holding a reminder lose only the reminder, exactly as the server strips.
  const [stripped] = stripCcSystemReminders([midTurn(words)]);
  assert.equal(stripped.content[1].text, block("don't deploy yet\n\n keep"));
});

test("index-only and compress paths agree on consecutive mid-turn blocks", () => {
  const raw = midTurn("first", "second");
  // Index-only: the client strips, then the server strips again (idempotent).
  const indexed = stripCcSystemReminders(stripCcSystemReminders([raw]));
  // Compress: the server strips the raw message with the same rule once.
  const compressed = stripCcSystemReminders(normalizeMessagesForMemtree([raw]));
  assert.deepEqual(indexed, compressed);
  assert.equal(indexed[0].content[1].text, block("first"), "the trailing newline trims");
  assert.equal(indexed[0].content[2].text, block("second"));
});

test("a mid-turn block inside reminder tags is dropped on both paths alike", () => {
  const raw = midTurn("x");
  raw.content[1].text = `<system-reminder>\n${block("tagged")}\n</system-reminder>`;
  const indexed = stripCcSystemReminders([raw]);
  assert.deepEqual(indexed, stripCcSystemReminders(normalizeMessagesForMemtree([raw])));
  assert.deepEqual(indexed[0].content.map((p) => p.type), ["tool_result"]);
});
