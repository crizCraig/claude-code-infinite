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
const assistantLine = (blocks, extra = {}) =>
  JSON.stringify({
    parentUuid: null,
    type: "assistant",
    message: { id: "msg_01", role: "assistant", content: blocks },
    uuid: "u1",
    ...extra,
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

test("scrubLineInPlace: unclosed marker (open tag, no close) → null", () => {
  const line = Buffer.from(
    assistantLine([{ type: "text", text: `mentions ${NOTICE_OPEN} unclosed` }])
  );
  assert.equal(scrubLineInPlace(line), null);
});

test("watcher scrubs appended lines in place without disturbing later appends", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const file = path.join(dir, "session-a.jsonl");
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    const line1 = assistantLine([{ type: "text", text: notice }]) + "\n";
    const line2 = assistantLine([{ type: "text", text: "kept content" }]) + "\n";
    await fsp.appendFile(file, line1);
    await fsp.appendFile(file, line2);

    // Wait for the watcher to patch the file.
    const deadline = Date.now() + 5000;
    let content = "";
    while (Date.now() < deadline) {
      content = await fsp.readFile(file, "utf-8");
      if (!content.includes("cc-infinite-notice")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!content.includes("cc-infinite-notice"), "notice scrubbed");
    // file length unchanged (in-place, padded)
    assert.equal(Buffer.byteLength(content), Buffer.byteLength(line1 + line2));
    // both lines still parse; second untouched
    const lines = content.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]).message.content, []);
    assert.equal(JSON.parse(lines[1]).message.content[0].text, "kept content");
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("watcher scans a brand-new file from byte 0 (fork case)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  const scrubber = startTranscriptScrubber(dir, {});
  try {
    // Simulate a fork: a new .jsonl appears with history (notice included).
    const forked = path.join(dir, "session-forked.jsonl");
    const content =
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n" +
      assistantLine([{ type: "text", text: notice }]) + "\n";
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

test("watcher leaves an incomplete (unterminated) tail line alone", async () => {
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

    await scrubber.flush();
    const got = await fsp.readFile(file, "utf-8");
    assert.ok(!got.includes("cc-infinite-notice"), "flushed before shutdown");
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(content)); // in-place, padded
  } finally {
    scrubber.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
