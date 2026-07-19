import test from "node:test";
import assert from "node:assert/strict";
import {
  SseFrameScanner,
  SseEventForwarder,
  SseSpliceWriter,
  bridgeBlockEvents,
  contentBlockStopEvent,
  CORRECTION_BRIDGE_TEXT,
  RECOVERY_BRIDGE_TEXT,
} from "../dist/index.js";

function frame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const messageStart = frame("message_start", {
  type: "message_start",
  message: { id: "msg_b", usage: { input_tokens: 10 } },
});

function textBlock(index, text) {
  return (
    frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index })
  );
}

function thinkingBlock(index, thinking) {
  return (
    frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: "sig" },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index })
  );
}

function toolUseBlock(index, name, id = `tool-${index}`) {
  return (
    frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }) +
    frame("content_block_stop", { type: "content_block_stop", index })
  );
}

const messageTail =
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 2 },
  }) + frame("message_stop", { type: "message_stop" });

test("scanner yields complete frames only, across chunk boundaries and CRLF", () => {
  const scanner = new SseFrameScanner();
  const whole = `event: ping\r\ndata: {"type":"ping"}\r\n\r\n` + textBlock(0, "hi");
  const cut = Math.floor(whole.length / 2) + 3;
  const first = scanner.push(Buffer.from(whole.slice(0, cut)));
  const second = scanner.push(Buffer.from(whole.slice(cut)));
  const frames = [...first, ...second];
  assert.equal(frames.map((f) => f.raw).join(""), whole);
  assert.deepEqual(
    frames.map((f) => f.data?.type),
    ["ping", "content_block_start", "content_block_delta", "content_block_stop"]
  );
  assert.equal(scanner.flush(), "");
  const partial = new SseFrameScanner();
  partial.push(Buffer.from("event: message_stop\ndata: {"));
  assert.equal(partial.flush(), "event: message_stop\ndata: {");
});

test("scanner accepts CR-only and mixed separators and joins data fields", () => {
  const scanner = new SseFrameScanner();
  const crOnly =
    'event: custom\rdata: {"type":"ping",\rdata: "sequence":1}\r\r';
  const mixed =
    'event: message_stop\ndata: {"type":"message_stop"}\r\n\n';
  const frames = scanner.push(Buffer.from(crOnly + mixed));

  assert.equal(frames.map((entry) => entry.raw).join(""), crOnly + mixed);
  assert.deepEqual(
    frames.map(({ event, data }) => ({ event, data })),
    [
      { event: "custom", data: { type: "ping", sequence: 1 } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]
  );
  assert.equal(scanner.flush(), "");
});

test("forwarder forwards events verbatim and tracks block state exactly", () => {
  let written = "";
  const forwarder = new SseEventForwarder({
    write: (bytes) => {
      written += bytes;
      return true;
    },
  });
  const head =
    messageStart +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    });
  forwarder.push(Buffer.from(head));
  assert.equal(written, head);
  assert.deepEqual(forwarder.openBlock, { index: 0, type: "text" });
  assert.equal(forwarder.textChars, 5);
  assert.equal(forwarder.maxIndex, 0);
  assert.equal(forwarder.sawToolUse, false);
  assert.equal(forwarder.sawMessageStop, false);

  forwarder.push(
    Buffer.from(
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
        toolUseBlock(1, "read") +
        messageTail
    )
  );
  assert.equal(forwarder.openBlock, null);
  assert.equal(forwarder.sawToolUse, true);
  assert.equal(forwarder.maxIndex, 1);
  assert.equal(forwarder.sawMessageDelta, true);
  assert.equal(forwarder.sawMessageStop, true);
});

test("forwarder stop() discards later frames in the same chunk (deferred splice seam)", () => {
  let written = "";
  const forwarder = new SseEventForwarder({
    write: (bytes) => {
      written += bytes;
      return true;
    },
    afterEvent: (fwd, data) => {
      if (data?.type === "content_block_stop") fwd.stop();
    },
  });
  const thinkingStop = frame("content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  const nextToolUse = frame("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "t", name: "read", input: {} },
  });
  forwarder.push(Buffer.from(thinkingStop + nextToolUse));
  assert.equal(written, thinkingStop, "tool_use after the stop is discarded");
  assert.equal(forwarder.sawToolUse, false);
  assert.equal(forwarder.isStopped(), true);
  forwarder.push(Buffer.from(messageTail));
  assert.equal(written, thinkingStop);
});

test("forwarder reports backpressure from the write callback", () => {
  const results = [];
  const forwarder = new SseEventForwarder({
    write: () => {
      results.push("write");
      return false;
    },
  });
  assert.equal(forwarder.push(Buffer.from(messageStart)), false);
  assert.deepEqual(results, ["write"]);
});

test("forwarder suppresses a terminal error before signaling recovery", () => {
  let written = "";
  let terminal;
  const forwarder = new SseEventForwarder({
    write: (bytes) => {
      written += bytes;
      return true;
    },
    onTerminalError: (fwd, data) => {
      terminal = { stopped: fwd.isStopped(), data };
    },
  });
  const head =
    messageStart +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    });
  const error = frame("error", {
    type: "error",
    error: { type: "overloaded_error", message: "try again" },
  });

  forwarder.push(Buffer.from(head + error + messageTail));

  assert.equal(written, head);
  assert.deepEqual(terminal, {
    stopped: true,
    data: {
      type: "error",
      error: { type: "overloaded_error", message: "try again" },
    },
  });
  assert.equal(forwarder.sawTerminalError, true);
  assert.equal(forwarder.sawMessageStop, false);
});

test("splice writer drops envelope/thinking/pings and renumbers from startIndex", () => {
  const writer = new SseSpliceWriter({ startIndex: 5 });
  const input =
    messageStart +
    frame("ping", { type: "ping" }) +
    thinkingBlock(0, "internal") +
    textBlock(1, "FULL_TEXT") +
    toolUseBlock(2, "write") +
    messageTail;
  const out = writer.push(Buffer.from(input));
  assert.doesNotMatch(out, /message_start/);
  assert.doesNotMatch(out, /ping/);
  assert.doesNotMatch(out, /thinking/);
  assert.doesNotMatch(out, /signature/);
  assert.equal(
    out,
    // Only block indices are renumbered; tool ids stay B's originals.
    textBlock(5, "FULL_TEXT") + toolUseBlock(6, "write", "tool-2") + messageTail
  );
});

test("splice writer survives frames split across pushes and orphan indices", () => {
  const writer = new SseSpliceWriter({ startIndex: 2 });
  const input = messageStart + textBlock(0, "AB");
  const cut = messageStart.length + 25;
  let out = "";
  out += writer.push(Buffer.from(input.slice(0, cut)));
  out += writer.push(Buffer.from(input.slice(cut)));
  assert.equal(out, textBlock(2, "AB"));
  // A delta whose start was never seen cannot render — dropped, not invented.
  const orphan = writer.push(
    Buffer.from(
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 9,
        delta: { type: "text_delta", text: "orphan" },
      })
    )
  );
  assert.equal(orphan, "");
  const malformed = writer.push(
    Buffer.from(
      frame("content_block_start", {
        type: "content_block_start",
        index: "9",
        content_block: { type: "text", text: "must not escape" },
      }) +
        frame("content_block_delta", {
          type: "content_block_delta",
          index: -1,
          delta: { type: "text_delta", text: "must not escape" },
        })
    )
  );
  assert.equal(malformed, "");
  assert.equal(writer.push(Buffer.from("data: null\n\n")), "");
  assert.equal(writer.push(Buffer.from("data: 42\n\n")), "");
  writer.flush();
});

test("bridge and stop event fabrication match the wire format", () => {
  assert.equal(
    contentBlockStopEvent(3),
    frame("content_block_stop", { type: "content_block_stop", index: 3 })
  );
  const bridge = bridgeBlockEvents(4, CORRECTION_BRIDGE_TEXT);
  assert.match(bridge, /content_block_start/);
  assert.match(bridge, /Correcting course/);
  assert.match(bridge, /"index":4/);
  assert.match(bridge, /content_block_stop/);
  assert.match(RECOVERY_BRIDGE_TEXT, /cut off/);
});
