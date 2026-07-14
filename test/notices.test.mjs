import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPRESSED_NOTICE,
  MODEL_HIDDEN_NOTICE,
  NOTICE_OPEN,
  NOTICE_CLOSE,
  compressedNoticeText,
  sanitizeNoticeDetail,
  wrapNotice,
  stripNoticeBlocks,
  stripNoticeSystem,
  SseNoticeRewriter,
  fabricatedPrelude,
  insertNoticeBeforeResponseContent,
  appendNoticeToJsonBody,
} from "../dist/notices.js";

const notice = wrapNotice("✨ test notice");
const legacyNotice = wrapNotice(
  "MemTree working - conversation consolidated - <model does not see this message>"
);

test("compressedNoticeText includes latency and only valid reducing totals", () => {
  assert.equal(
    compressedNoticeText({
      latencyMs: 8_837,
      originalTokens: 330_272,
      consolidatedTokens: 94_594,
    }),
    "✓ MemTree · conversation optimized in 8.8s · " +
      "~330.3k → 94.6k tokens"
  );
  assert.equal(
    compressedNoticeText({ latencyMs: 42 }),
    `${COMPRESSED_NOTICE} in 42ms`
  );
  assert.equal(
    compressedNoticeText({
      latencyMs: 1_000,
      originalTokens: 100,
      consolidatedTokens: 100,
    }),
    `${COMPRESSED_NOTICE} in 1s`,
    "non-reducing or mismatched totals are omitted"
  );
  assert.ok(
    !compressedNoticeText({ latencyMs: 42 }).includes(MODEL_HIDDEN_NOTICE)
  );
});

test("sanitizeNoticeDetail strips terminal controls, normalizes, and caps", () => {
  assert.equal(
    sanitizeNoticeDetail("  pay\u001b[2J\r\n now\u0000  "),
    "pay [2J now"
  );
  assert.equal(sanitizeNoticeDetail("abcdef", 4), "abcd");
});

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

test("stripNoticeBlocks preserves user quotes and incomplete spans", () => {
  const messages = [
    { role: "user", content: `quoting ${NOTICE_OPEN}xyz${NOTICE_CLOSE}` },
    { role: "assistant", content: [{ type: "text", text: `mentions ${NOTICE_OPEN} unclosed` }] },
  ];
  const result = stripNoticeBlocks(messages);
  assert.equal(result.stripped, false);
  assert.equal(result.messages, messages);
});

test("stripNoticeBlocks cleans role=system legacy content but preserves user identity", () => {
  const user = { role: "user", content: `quote ${notice}` };
  const messages = [
    user,
    { role: "system", content: `${legacyNotice}recap text` },
  ];
  const result = stripNoticeBlocks(messages);
  assert.equal(result.stripped, true);
  assert.equal(result.messages[0], user);
  assert.deepEqual(result.messages[1], { role: "system", content: "recap text" });
});

test("stripNoticeSystem removes known legacy copy but preserves arbitrary quotes", () => {
  assert.deepEqual(stripNoticeSystem(`${legacyNotice}real system`), {
    system: "real system",
    stripped: true,
  });
  assert.deepEqual(stripNoticeSystem(`project quote ${notice}`), {
    system: `project quote ${notice}`,
    stripped: false,
  });
  const incomplete = `system ${NOTICE_OPEN} incomplete`;
  assert.deepEqual(stripNoticeSystem(incomplete), {
    system: incomplete,
    stripped: false,
  });
});

test("stripNoticeBlocks excises a notice CC merged into a real text block", () => {
  const thinking = { type: "thinking", thinking: "hmm", signature: "sig123" };
  const messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [thinking, { type: "text", text: `answer text${notice}` }],
    },
    { role: "user", content: "next" },
  ];
  const { messages: out, stripped } = stripNoticeBlocks(messages);
  assert.equal(stripped, true);
  assert.equal(out.length, 3);
  assert.equal(out[1].content[0], thinking); // untouched block keeps its object
  assert.deepEqual(out[1].content[1], { type: "text", text: "answer text" });
});

function parseEvents(sse) {
  return sse
    .replaceAll("\r\n", "\n")
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

test("compression notice is inserted after thinking and before response content", () => {
  const rewriter = new SseNoticeRewriter({
    beforeResponseNotice: COMPRESSED_NOTICE,
  });
  const out = rewriter.push(Buffer.from(upstreamStream)) + rewriter.flush();
  const events = parseEvents(out);

  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts.map((e) => e.index), [0, 1, 2]);
  assert.deepEqual(starts.map((e) => e.content_block.type), [
    "thinking",
    "text",
    "text",
  ]);
  const noticeDelta = events.find(
    (e) => e.type === "content_block_delta" && e.index === 1
  );
  assert.ok(noticeDelta.delta.text.includes(COMPRESSED_NOTICE));

  // The real message_start (including input usage) is preserved, and the real
  // answer remains the last content block for print/SDK result consumers.
  const messageStart = events.find((e) => e.type === "message_start");
  assert.equal(messageStart.message.id, "msg_real");
  assert.equal(messageStart.message.usage.input_tokens, 42);
  assert.equal(starts.at(-1).index, 2);
});

test("slow prelude and compression notice use distinct indexes", () => {
  const rewriter = new SseNoticeRewriter({
    renumberBy: 1,
    beforeResponseNotice: COMPRESSED_NOTICE,
  });
  const out =
    fabricatedPrelude("claude-x", "✨ wait") +
    rewriter.push(Buffer.from(upstreamStream)) +
    rewriter.flush();
  const events = parseEvents(out);
  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts.map((e) => e.index), [0, 1, 2, 3]);
  assert.equal(
    events.filter((e) => e.type === "message_start").length,
    1,
    "fabricated prelude remains the only message_start"
  );
  const compressionDelta = events.find(
    (e) =>
      e.type === "content_block_delta" &&
      e.index === 2 &&
      e.delta.text?.includes(COMPRESSED_NOTICE)
  );
  assert.ok(compressionDelta);
});

test("thinking-only streams receive the compression notice before completion", () => {
  const thinkingOnlyStream =
    upstreamStream
      .split("\n\n")
      .filter((frame) => !frame.includes('"index":1'))
      .join("\n\n") + "\n\n";

  for (const withSlowPrelude of [false, true]) {
    const rewriter = new SseNoticeRewriter({
      renumberBy: withSlowPrelude ? 1 : undefined,
      beforeResponseNotice: COMPRESSED_NOTICE,
    });
    const out =
      (withSlowPrelude ? fabricatedPrelude("claude-x", "✨ wait") : "") +
      rewriter.push(Buffer.from(thinkingOnlyStream)) +
      rewriter.flush();
    const events = parseEvents(out);
    const starts = events.filter((e) => e.type === "content_block_start");
    assert.deepEqual(
      starts.map((e) => e.index),
      withSlowPrelude ? [0, 1, 2] : [0, 1]
    );
    const noticeIndex = withSlowPrelude ? 2 : 1;
    assert.ok(
      events.some(
        (e) =>
          e.type === "content_block_delta" &&
          e.index === noticeIndex &&
          e.delta.text?.includes(COMPRESSED_NOTICE)
      )
    );
    const noticeStop = events.findIndex(
      (e) => e.type === "content_block_stop" && e.index === noticeIndex
    );
    const messageDelta = events.findIndex((e) => e.type === "message_delta");
    assert.ok(noticeStop < messageDelta);
  }
});

test("CRLF-framed SSE is rewritten safely across byte boundaries", () => {
  const rewriter = new SseNoticeRewriter({
    renumberBy: 1,
    beforeResponseNotice: COMPRESSED_NOTICE,
  });
  const raw = Buffer.from(upstreamStream.replaceAll("\n", "\r\n"));
  let out = fabricatedPrelude("claude-x", "✨ wait");
  for (let i = 0; i < raw.length; i++) {
    out += rewriter.push(raw.subarray(i, i + 1));
  }
  out += rewriter.flush();

  const events = parseEvents(out);
  assert.equal(events.filter((e) => e.type === "message_start").length, 1);
  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts.map((e) => e.index), [0, 1, 2, 3]);
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

test("insertNoticeBeforeResponseContent preserves leading thinking and final answer", () => {
  const body = Buffer.from(
    JSON.stringify({
      type: "message",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    })
  );
  const out = JSON.parse(
    insertNoticeBeforeResponseContent(body, COMPRESSED_NOTICE).toString()
  );
  assert.deepEqual(out.content.map((part) => part.type), [
    "thinking",
    "text",
    "text",
  ]);
  assert.ok(out.content[1].text.includes(COMPRESSED_NOTICE));
  assert.equal(out.content.at(-1).text, "answer");
});
