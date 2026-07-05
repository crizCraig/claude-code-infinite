import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wrapNotice } from "../dist/notices.js";
import {
  scrubLineInPlace,
  startTranscriptScrubber,
  sweepTranscripts,
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

test("sweep rewrites files: drops notice-only lines, padding, and empty shells", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  try {
    const file = path.join(dir, "session-c.jsonl");
    const keep = assistantLine([{ type: "text", text: "keep me" }]);
    const noticeOnly = assistantLine([{ type: "text", text: notice }]);
    // an already-in-place-patched shell: empty content + space padding
    const padded = assistantLine([]) + "   ";
    await fsp.writeFile(file, [keep, noticeOnly, padded].join("\n") + "\n");

    const cleaned = await sweepTranscripts(dir, {});
    assert.equal(cleaned, 1);
    const content = await fsp.readFile(file, "utf-8");
    assert.ok(!content.includes("cc-infinite-notice"));
    const lines = content.split("\n").filter((l) => l.length);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message.content[0].text, "keep me");
    assert.ok(content.endsWith("\n"));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("sweep with skipRecentMs leaves recently-modified files alone (live-session guard)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  try {
    const live = path.join(dir, "live.jsonl");
    const quiet = path.join(dir, "quiet.jsonl");
    const dirty = assistantLine([{ type: "text", text: notice }]) + "\n";
    await fsp.writeFile(live, dirty); // fresh mtime — a concurrent session may hold an append handle
    await fsp.writeFile(quiet, dirty);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fsp.utimes(quiet, old, old);

    assert.equal(await sweepTranscripts(dir, { skipRecentMs: 5 * 60 * 1000 }), 1);
    assert.ok((await fsp.readFile(live, "utf-8")).includes("cc-infinite-notice")); // skipped
    assert.ok(!(await fsp.readFile(quiet, "utf-8")).includes("cc-infinite-notice")); // swept
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("sweep skips clean files and missing dirs", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-scrub-"));
  try {
    const file = path.join(dir, "clean.jsonl");
    const original = assistantLine([{ type: "text", text: "hello" }]) + "\n";
    await fsp.writeFile(file, original);
    const before = fs.statSync(file).mtimeMs;
    assert.equal(await sweepTranscripts(dir, {}), 0);
    assert.equal(fs.statSync(file).mtimeMs, before); // untouched
    assert.equal(await sweepTranscripts(path.join(dir, "nope"), {}), 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
