import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NOTICE_OPEN, wrapNotice } from "../dist/notices.js";
import {
  scrubLineInPlace,
  startTranscriptScrubber,
  projectTranscriptDir,
} from "../dist/scrub.js";

const notice = wrapNotice("✨ Something special is happening — please wait…");

// CC transcript shape: one line per assistant content block.
const assistantLine = (blocks, { message: messageExtra = {}, ...extra } = {}) =>
  JSON.stringify({
    parentUuid: null,
    type: "assistant",
    message: {
      id: "msg_01",
      role: "assistant",
      content: blocks,
      ...messageExtra,
    },
    uuid: "u1",
    ...extra,
  });

const turnDurationLine = (parentUuid = "u1") =>
  JSON.stringify({
    parentUuid,
    type: "system",
    subtype: "turn_duration",
    durationMs: 1234,
    uuid: "duration-1",
  });

const userLine = (content, promptId) =>
  JSON.stringify({
    parentUuid: null,
    promptId,
    type: "user",
    message: { role: "user", content },
    uuid: `user-${promptId}`,
  });

test("projectTranscriptDir munges the cwd like Claude Code", () => {
  const dir = projectTranscriptDir("/Users/craigquiter/src/claude-code-infinite");
  assert.ok(
    dir.endsWith(path.join(".claude", "projects", "-Users-craigquiter-src-claude-code-infinite"))
  );
});

test("scrubLineInPlace: length-preserving, marker removed, JSON intact", () => {
  const line = Buffer.from(assistantLine([{ type: "text", text: notice }]));
  const patched = scrubLineInPlace(line);
  assert.ok(patched);
  assert.equal(patched.length, line.length);
  assert.ok(!patched.includes("cc-infinite-notice"));
  const obj = JSON.parse(patched.toString("utf-8"));
  assert.deepEqual(obj.message.content, []);
  // padding is trailing spaces only
  assert.match(patched.toString("utf-8"), /}[ ]*$/);
});

test("scrubLineInPlace: notice merged into a bigger text block is excised", () => {
  const line = Buffer.from(
    assistantLine([{ type: "text", text: `${notice}real streamed text` }])
  );
  const patched = scrubLineInPlace(line);
  assert.ok(patched);
  const obj = JSON.parse(patched.toString("utf-8"));
  assert.deepEqual(obj.message.content, [{ type: "text", text: "real streamed text" }]);
});

test("scrubLineInPlace: tool input marker data is never traversed or corrupted", () => {
  const literal = wrapNotice("literal user data");
  const line = Buffer.from(assistantLine([
    { type: "tool_use", id: "tool-1", name: "Write", input: { text: `preserve ${literal}` } },
    { type: "text", text: notice },
  ]));
  const patched = scrubLineInPlace(line);
  assert.ok(patched, "known legacy text notice is still cleaned");
  const content = JSON.parse(patched.toString("utf-8")).message.content;
  assert.deepEqual(content, [
    { type: "tool_use", id: "tool-1", name: "Write", input: { text: `preserve ${literal}` } },
  ]);

  const quoteOnly = Buffer.from(assistantLine([
    { type: "text", text: `assistant quoted ${literal}` },
  ]));
  assert.equal(scrubLineInPlace(quoteOnly), null, "arbitrary assistant quotes survive");
});

test("scrubLineInPlace: no marker → null (leave file untouched)", () => {
  assert.equal(scrubLineInPlace(Buffer.from(assistantLine([{ type: "text", text: "hi" }]))), null);
  assert.equal(scrubLineInPlace(Buffer.from("not json at all")), null);
});

test("scrubLineInPlace: user line quoting the marker → null (assistant-only)", () => {
  const userLine = JSON.stringify({
    parentUuid: null,
    type: "user",
    message: { role: "user", content: `quoting ${notice}` },
    uuid: "u2",
  });
  assert.equal(scrubLineInPlace(Buffer.from(userLine)), null);
});

test("scrubLineInPlace: legacy contaminated away_summary is cleaned in place", () => {
  const raw = JSON.stringify({
    parentUuid: "u1",
    type: "system",
    subtype: "away_summary",
    content: `${notice}Real recap text. (disable recaps in /config)`,
    uuid: "summary-1",
  });
  const line = Buffer.from(raw);
  const patched = scrubLineInPlace(line);
  assert.ok(patched);
  assert.equal(patched.length, line.length);
  const parsed = JSON.parse(patched.toString("utf-8"));
  assert.equal(parsed.content, "Real recap text. (disable recaps in /config)");

  const ordinarySystem = Buffer.from(JSON.stringify({
    type: "system",
    subtype: "other",
    content: `quoted ${notice}`,
  }));
  assert.equal(scrubLineInPlace(ordinarySystem), null);

  const quotedAwaySummary = Buffer.from(JSON.stringify({
    type: "system",
    subtype: "away_summary",
    content: `The user discussed ${wrapNotice("literal marker quote")}`,
  }));
  assert.equal(
    scrubLineInPlace(quotedAwaySummary),
    null,
    "arbitrary marker quotes in a recap are not legacy ccc notices"
  );
});

test("scrubLineInPlace: unclosed marker (open tag, no close) → null", () => {
  const line = Buffer.from(
    assistantLine([{ type: "text", text: `mentions ${NOTICE_OPEN} unclosed` }])
  );
  assert.equal(scrubLineInPlace(line), null);
});

test("watcher keeps a live notice through final render, then scrubs at turn completion", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const file = path.join(dir, "session-a.jsonl");
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    // Actual CC shape: the dedicated notice block and real text are separate
    // assistant records with the same Anthropic message id. Both records can
    // already say end_turn before CC appends its turn_duration record.
    const line1 =
      assistantLine([{ type: "text", text: notice }], {
        message: { stop_reason: "end_turn" },
      }) + "\n";
    const line2 =
      assistantLine([{ type: "text", text: "kept content" }], {
        message: { stop_reason: "end_turn" },
      }) + "\n";
    const completed = turnDurationLine() + "\n";
    await fsp.appendFile(file, line1);
    await fsp.appendFile(file, line2);

    // Deterministically run the normal scan. Neither a later assistant block
    // nor stop_reason=end_turn is enough: the UI's turn is still active.
    await scrubber.idle();
    let content = await fsp.readFile(file, "utf-8");
    assert.ok(content.includes("cc-infinite-notice"), "notice remains during active turn");

    await fsp.appendFile(file, completed);
    await scrubber.idle();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      content = await fsp.readFile(file, "utf-8");
      if (!content.includes("cc-infinite-notice")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!content.includes("cc-infinite-notice"), "notice scrubbed");
    // file length unchanged (in-place, padded)
    assert.equal(Buffer.byteLength(content), Buffer.byteLength(line1 + line2 + completed));
    // all lines still parse; real assistant content and completion untouched
    const lines = content.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[0]).message.content, []);
    assert.equal(JSON.parse(lines[1]).message.content[0].text, "kept content");
    assert.equal(JSON.parse(lines[2]).subtype, "turn_duration");
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("watcher scans a brand-new file from byte 0 (fork case)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    // Simulate a fork whose copied history omitted turn_duration. The later,
    // different prompt id proves the notice belongs to a prior turn.
    const forked = path.join(dir, "session-forked.jsonl");
    const content =
      userLine("hi", "prompt-old") + "\n" +
      assistantLine([{ type: "text", text: notice }]) + "\n" +
      userLine("forked followup", "prompt-fork") + "\n";
    await fsp.writeFile(forked, content);

    const deadline = Date.now() + 5000;
    let got = "";
    while (Date.now() < deadline) {
      got = await fsp.readFile(forked, "utf-8");
      if (!got.includes("cc-infinite-notice")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!got.includes("cc-infinite-notice"), "fork-copied notice scrubbed");
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(content));
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("starting or flushing a concurrent scrubber cannot consume another live notice", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const file = path.join(dir, "session-live.jsonl");
  const first = startTranscriptScrubber(dir, {});
  let second;
  try {
    await fsp.writeFile(
      file,
      userLine("active turn", "prompt-live") + "\n" +
        assistantLine([{ type: "text", text: notice }]) + "\n"
    );
    await first.idle();
    assert.ok(
      (await fsp.readFile(file, "utf-8")).includes("cc-infinite-notice"),
      "first scrubber defers its live notice"
    );

    // A second ccc startup must not classify the first one's baseline as stale.
    second = startTranscriptScrubber(dir, {});
    await second.idle();
    assert.ok(
      (await fsp.readFile(file, "utf-8")).includes("cc-infinite-notice"),
      "concurrent startup preserves the live notice"
    );

    // Nor may one child exiting force-clean every transcript in the project.
    await first.flush();
    assert.ok(
      (await fsp.readFile(file, "utf-8")).includes("cc-infinite-notice"),
      "concurrent flush preserves the other live turn"
    );

    await fsp.appendFile(file, turnDurationLine() + "\n");
    await first.idle();
    await second.idle();
    assert.ok(
      !(await fsp.readFile(file, "utf-8")).includes("cc-infinite-notice"),
      "normal completion still scrubs with concurrent watchers"
    );
  } finally {
    second?.close();
    first.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("simultaneous scrubber exits hand off force-cleanup for notices without duration", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const fileA = path.join(dir, "session-exit-a.jsonl");
  const fileB = path.join(dir, "session-exit-b.jsonl");
  const first = startTranscriptScrubber(dir, {});
  const second = startTranscriptScrubber(dir, {});
  try {
    await fsp.writeFile(
      fileA,
      userLine("turn a", "prompt-a") + "\n" +
        assistantLine([{ type: "text", text: notice }]) + "\n"
    );
    await fsp.writeFile(
      fileB,
      userLine("turn b", "prompt-b") + "\n" +
        assistantLine([{ type: "text", text: notice }]) + "\n"
    );
    await Promise.all([first.idle(), second.idle()]);
    assert.ok((await fsp.readFile(fileA, "utf-8")).includes("cc-infinite-notice"));
    assert.ok((await fsp.readFile(fileB, "utf-8")).includes("cc-infinite-notice"));

    // Both children have exited and neither transcript got turn_duration.
    // The atomic active→exiting handoff guarantees one flush owns cleanup.
    await Promise.all([first.flush(), second.flush()]);
    assert.ok(!(await fsp.readFile(fileA, "utf-8")).includes("cc-infinite-notice"));
    assert.ok(!(await fsp.readFile(fileB, "utf-8")).includes("cc-infinite-notice"));
  } finally {
    second.close();
    first.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("watcher scans pre-existing files from byte 0 at startup (killed-session leftovers)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  // A leftover notice from a killed prior session — the watcher never saw it
  // land, so the startup scan must scrub it.
  const file = path.join(dir, "session-leftover.jsonl");
  const content =
    assistantLine([{ type: "text", text: notice }]) + "\n" +
    assistantLine([{ type: "text", text: "kept content" }]) + "\n";
  await fsp.writeFile(file, content);

  const scrubber = startTranscriptScrubber(dir, {});
  try {
    await scrubber.idle();
    const got = await fsp.readFile(file, "utf-8");
    assert.ok(!got.includes("cc-infinite-notice"), "pre-existing notice scrubbed");
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(content)); // in-place, padded
    const lines = got.split("\n").filter((l) => l.trim());
    assert.deepEqual(JSON.parse(lines[0]).message.content, []);
    assert.equal(JSON.parse(lines[1]).message.content[0].text, "kept content");
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("startup cleanup does not consume a line completed after the captured EOF", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const file = path.join(dir, "session-startup-race.jsonl");
  const partial = assistantLine([{ type: "text", text: notice }]);
  await fsp.writeFile(file, partial); // no newline at the startup boundary

  const scrubber = startTranscriptScrubber(dir, {});
  try {
    // Even if the startup fd.stat observes this append, its force-clean
    // boundary was captured before startTranscriptScrubber returned.
    await fsp.appendFile(file, "\n");
    await scrubber.idle();
    let got = await fsp.readFile(file, "utf-8");
    assert.ok(got.includes("cc-infinite-notice"), "post-start completion is treated as live");

    await fsp.appendFile(file, turnDurationLine() + "\n");
    await scrubber.idle();
    got = await fsp.readFile(file, "utf-8");
    assert.ok(!got.includes("cc-infinite-notice"), "live line scrubbed after turn completion");
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("same-inode truncate and larger rewrite resets the scan cursor", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const file = path.join(dir, "session-rewritten.jsonl");
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    const oldContent =
      assistantLine([{ type: "text", text: "old".repeat(300) }]) + "\n";
    await fsp.writeFile(file, oldContent);
    await scrubber.idle();

    const newContent =
      userLine("new transcript", "prompt-new") + "\n" +
      assistantLine([{ type: "text", text: notice }]) + "\n" +
      turnDurationLine() + "\n" +
      assistantLine([{ type: "text", text: "new".repeat(600) }]) + "\n";
    assert.ok(Buffer.byteLength(newContent) >= Buffer.byteLength(oldContent));

    // writeFile truncates and rewrites the existing inode on this platform;
    // size alone therefore cannot tell that the old cursor is invalid.
    await fsp.writeFile(file, newContent);
    await scrubber.idle();
    const got = await fsp.readFile(file, "utf-8");
    assert.ok(!got.includes("cc-infinite-notice"), "rewritten history rescanned from byte zero");
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(newContent));
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("watcher scans large files in bounded windows (lines straddle chunk boundaries)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const file = path.join(dir, "session-big.jsonl");
  // > 1 MiB of ~1 KiB lines so several lines straddle the 1 MiB scan window,
  // a notice near the end, and an incomplete tail line that must survive.
  const filler = assistantLine([{ type: "text", text: "x".repeat(1024) }]) + "\n";
  const tail = assistantLine([{ type: "text", text: "tail kept" }]); // no \n yet
  const content =
    filler.repeat(1200) + assistantLine([{ type: "text", text: notice }]) + "\n" + tail;
  await fsp.writeFile(file, content);

  const scrubber = startTranscriptScrubber(dir, {});
  try {
    await scrubber.idle();
    const got = await fsp.readFile(file, "utf-8");
    assert.ok(!got.includes("cc-infinite-notice"), "notice scrubbed past the first window");
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(content)); // in-place, padded
    assert.equal(got.slice(got.lastIndexOf("\n") + 1), tail); // incomplete tail untouched
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("watcher leaves an incomplete tail and a completed live notice alone until turn completion", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    const file = path.join(dir, "session-b.jsonl");
    const partial = assistantLine([{ type: "text", text: notice }]); // no \n yet
    await fsp.appendFile(file, partial);
    await new Promise((r) => setTimeout(r, 300));
    let content = await fsp.readFile(file, "utf-8");
    assert.ok(content.includes("cc-infinite-notice"), "incomplete line untouched");

    // Completing the line makes it eligible.
    await fsp.appendFile(file, "\n");
    await scrubber.idle();
    content = await fsp.readFile(file, "utf-8");
    assert.ok(content.includes("cc-infinite-notice"), "live notice waits for completion");

    await fsp.appendFile(file, turnDurationLine() + "\n");
    await scrubber.idle();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      content = await fsp.readFile(file, "utf-8");
      if (!content.includes("cc-infinite-notice")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!content.includes("cc-infinite-notice"), "scrubbed once newline-terminated");
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("flush scrubs a just-appended notice without waiting for fs events", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    await scrubber.idle(); // startup scan of the (empty) dir
    // Exit-time shape: the final turn's notice lands right before shutdown.
    const file = path.join(dir, "session-final.jsonl");
    const content = assistantLine([{ type: "text", text: notice }]) + "\n";
    await fsp.writeFile(file, content);

    await scrubber.idle();
    const beforeFlush = await fsp.readFile(file, "utf-8");
    assert.ok(beforeFlush.includes("cc-infinite-notice"), "active notice is deferred");

    await scrubber.flush();
    const got = await fsp.readFile(file, "utf-8");
    assert.ok(!got.includes("cc-infinite-notice"), "flushed before shutdown");
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(content)); // in-place, padded
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
