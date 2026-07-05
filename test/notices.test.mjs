import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTICE_OPEN,
  NOTICE_CLOSE,
  wrapNotice,
  stripNoticeBlocks,
  SseNoticeRewriter,
  fabricatedPrelude,
  appendNoticeToJsonBody,
} from "../dist/notices.js";

const notice = wrapNotice("✨ test notice");

test("stripNoticeBlocks removes a dedicated notice block, other blocks untouched", () => {
  const thinking = { type: "thinking", thinking: "hmm", signature: "sig123" };
  const text = { type: "text", text: "real answer" };
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: notice }, thinking, text] },
    { role: "user", content: "next" },
  ];
  const { messages: out, stripped } = stripNoticeBlocks(messages);
  assert.equal(stripped, true);
  assert.equal(out.length, 3);
  // surviving blocks are the same objects — byte-identical on re-serialization
  assert.equal(out[1].content[0], thinking);
  assert.equal(out[1].content[1], text);
});

test("stripNoticeBlocks drops a notice-only assistant message", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: notice }] },
    { role: "user", content: "next" },
  ];
  const { messages: out, stripped } = stripNoticeBlocks(messages);
  assert.equal(stripped, true);
  assert.deepEqual(out.map((m) => m.role), ["user", "user"]);
});

test("stripNoticeBlocks returns the same array when nothing matches", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "plain" }] },
  ];
  const result = stripNoticeBlocks(messages);
  assert.equal(result.stripped, false);
  assert.equal(result.messages, messages); // identity: body stays byte-verbatim
});

test("stripNoticeBlocks ignores non-assistant messages and non-envelope text", () => {
  const messages = [
    { role: "user", content: `quoting ${NOTICE_OPEN}xyz${NOTICE_CLOSE}` },
    { role: "assistant", content: [{ type: "text", text: `prefix ${notice}` }] },
  ];
  const result = stripNoticeBlocks(messages);
  assert.equal(result.stripped, false);
});

function parseEvents(sse) {
  return sse
    .split("\n\n")
    .filter((frame) => frame.includes("data:"))
    .map((frame) => {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse(dataLine.slice(5));
    });
}

const upstreamStream =
  `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_real", usage: { input_tokens: 42 } },
  })}\n\n` +
  `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  })}\n\n` +
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "…" },
  })}\n\n` +
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
  `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  })}\n\n` +
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n` +
  `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7 },
  })}\n\n` +
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

test("prelude + renumber: drops upstream message_start, shifts indexes by 1", () => {
  const rewriter = new SseNoticeRewriter({ renumberBy: 1 });
  const out =
    fabricatedPrelude("claude-x", "✨ wait") +
    rewriter.push(Buffer.from(upstreamStream)) +
    rewriter.flush();
  const events = parseEvents(out);
  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "message_start").length, 1);
  assert.equal(events[0].type, "message_start");
  // fabricated notice block occupies index 0
  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts.map((e) => e.index), [0, 1, 2]);
  assert.equal(starts[0].content_block.type, "text");
  assert.equal(starts[1].content_block.type, "thinking"); // upstream 0 → 1
  // message_delta / message_stop pass through
  assert.ok(types.includes("message_delta"));
  assert.ok(types.includes("message_stop"));
});

test("end-of-turn notice injected before message_delta with next free index", () => {
  const rewriter = new SseNoticeRewriter({ endOfTurnNotice: "⚠ degraded" });
  const out = rewriter.push(Buffer.from(upstreamStream)) + rewriter.flush();
  const events = parseEvents(out);
  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts.map((e) => e.index), [0, 1, 2]);
  const noticeDelta = events.find(
    (e) => e.type === "content_block_delta" && e.index === 2
  );
  assert.ok(noticeDelta.delta.text.startsWith(NOTICE_OPEN));
  assert.ok(noticeDelta.delta.text.endsWith(NOTICE_CLOSE));
  // notice block comes before message_delta
  const deltaPos = events.findIndex((e) => e.type === "message_delta");
  const noticeStopPos = events.findIndex(
    (e) => e.type === "content_block_stop" && e.index === 2
  );
  assert.ok(noticeStopPos < deltaPos);
  // injected exactly once (message_stop follows message_delta)
  assert.equal(events.filter((e) => e.type === "content_block_start" && e.index === 2).length, 1);
});

test("rewriter is chunk-boundary safe (byte-by-byte feed)", () => {
  const rewriter = new SseNoticeRewriter({ renumberBy: 1 });
  const raw = Buffer.from(upstreamStream);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    out += rewriter.push(raw.subarray(i, i + 1));
  }
  out += rewriter.flush();
  const events = parseEvents(out);
  assert.equal(events.filter((e) => e.type === "message_start").length, 0);
  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts.map((e) => e.index), [1, 2]);
});

test("appendNoticeToJsonBody appends a marked text block", () => {
  const body = Buffer.from(
    JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "answer" }],
    })
  );
  const out = JSON.parse(appendNoticeToJsonBody(body, "⚠ degraded").toString());
  assert.equal(out.content.length, 2);
  assert.equal(out.content[1].type, "text");
  assert.ok(out.content[1].text.startsWith(NOTICE_OPEN));
  // non-message shapes are left alone
  assert.equal(appendNoticeToJsonBody(Buffer.from('{"type":"error"}'), "x"), null);
  assert.equal(appendNoticeToJsonBody(Buffer.from("not json"), "x"), null);
});
