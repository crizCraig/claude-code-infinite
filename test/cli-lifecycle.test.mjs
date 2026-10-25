import test from "node:test";
import assert from "node:assert/strict";
import {
  createSignalShutdownHandler,
  exitCodeForChild,
  exitCodeForSignal,
  childExitMeansHangup,
  ignoreStreamErrors,
  onHangup,
  settleWithin,
  writeStdout,
} from "../dist/cli-lifecycle.js";
import { EventEmitter } from "node:events";

test("signals use conventional shell exit statuses", () => {
  assert.equal(exitCodeForSignal("SIGINT"), 130);
  assert.equal(exitCodeForSignal("SIGTERM"), 143);
});

test("child exit status preserves codes and translates terminating signals", () => {
  assert.equal(exitCodeForChild(0, null), 0);
  assert.equal(exitCodeForChild(7, null), 7);
  assert.equal(exitCodeForChild(null, "SIGINT"), 130);
  assert.equal(exitCodeForChild(null, "SIGTERM"), 143);
  assert.equal(exitCodeForChild(null, null), 1);
  assert.equal(
    exitCodeForChild(9, "SIGTERM"),
    9,
    "numeric child status takes precedence when both values are supplied"
  );
});

test("signal shutdown drains once and makes the second signal a force escape", () => {
  const events = [];
  const handle = createSignalShutdownHandler({
    forward: (signal) => events.push(["forward", signal]),
    shutdown: (code) => events.push(["shutdown", code]),
    forceExit: (code) => events.push(["force-exit", code]),
  });

  handle("SIGINT");
  handle("SIGTERM");
  assert.deepEqual(events, [
    ["forward", "SIGINT"],
    ["shutdown", 130],
    ["forward", "SIGTERM"],
    ["force-exit", 143],
  ]);
});

test("writeStdout resolves only once the stream has taken the text, and on a throwing stream", async () => {
  let finish;
  const written = [];
  const slow = { write(text, done) { written.push(text); finish = done; return false; } };
  let settled = false;
  const pending = writeStdout("hint\n", slow).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["hint\n"]);
  assert.equal(settled, false, "still waiting on the asynchronous write");
  finish();
  await pending;
  assert.equal(settled, true);
  await writeStdout("x", { write() { throw new Error("EPIPE"); } });
});

test("settleWithin waits for the promise but never past its bound", async () => {
  let started = Date.now();
  await settleWithin(new Promise(() => {}), 30);
  assert.ok(Date.now() - started >= 25, "bounded wait");
  started = Date.now();
  await settleWithin(Promise.reject(new Error("x")), 5_000);
  assert.ok(Date.now() - started < 1_000, "a rejection settles at once");
});

// Claude Code's exit for diagnostics: the clamped code as before, plus the raw
// value (Windows NTSTATUS codes such as 0xC0000005 arrive as 3221225477) and
// how long Claude Code ran, so a crash at launch tells apart from a closed window.
test("claude_exit fields: raw code and run time, sanitized by the schema", async () => {
  const { claudeExitFields } = await import("../dist/cli-lifecycle.js");
  const { sanitizeEvent } = await import("../dist/diagnostics-schema.js");
  const ev = (fields) => sanitizeEvent("claude_exit", fields, 1);
  assert.deepEqual(ev(claudeExitFields(3221225477, null, 1000, 1450)),
    { code: 1000, code_raw: 3221225477, uptime_ms: 450, name: "claude_exit", t: 1 });
  assert.deepEqual(ev(claudeExitFields(129, null, 0, 90_000)),
    { code: 129, code_raw: 129, uptime_ms: 90_000, name: "claude_exit", t: 1 });
  assert.deepEqual(ev(claudeExitFields(-1073741819, null, 5, 5)),
    { code: -1000, code_raw: -1073741819, uptime_ms: 0, name: "claude_exit", t: 1 });
  assert.deepEqual(ev(claudeExitFields(null, "SIGTERM", 0, 10)),
    { signal: "SIGTERM", uptime_ms: 10, name: "claude_exit", t: 1 });
  // Beyond a 32-bit status: clamped to its range, like every integer field.
  assert.deepEqual(ev({ code_raw: 2 ** 40 }), { code_raw: 4294967295, name: "claude_exit", t: 1 });
});

test("console_closed: an event with no fields", async () => {
  const { sanitizeEvent } = await import("../dist/diagnostics-schema.js");
  assert.deepEqual(sanitizeEvent("console_closed", { path: "C:\\x" }, 2),
    { name: "console_closed", t: 2 });
});

test("SIGHUP is handled on every platform: a console close on Windows, a hangup elsewhere", () => {
  for (const [platform, kind] of [["win32", "console-close"], ["darwin", "terminal-hangup"],
    ["linux", "terminal-hangup"]]) {
    const proc = new EventEmitter();
    proc.platform = platform;
    const seen = [];
    onHangup(proc, (k) => seen.push(k), true);
    assert.equal(proc.listenerCount("SIGHUP"), 1, platform);
    proc.emit("SIGHUP");
    proc.emit("SIGHUP");
    // A repeated hangup (the shell's, then the terminal's) is one close off Windows; on
    // Windows a second close stays the escape it always was.
    assert.deepEqual(seen, platform === "win32" ? [kind, kind] : [kind], platform);
  }
  assert.equal(exitCodeForSignal("SIGHUP"), 129);
});

test("under nohup (no terminal) ccc leaves SIGHUP alone off Windows", () => {
  for (const platform of ["darwin", "linux"]) {
    const proc = new EventEmitter();
    proc.platform = platform;
    onHangup(proc, () => assert.fail("no handler under nohup"), false);
    assert.equal(proc.listenerCount("SIGHUP"), 0, platform);
  }
});

test("Claude Code ending by the hangup counts as the hangup, off Windows only", () => {
  assert.equal(childExitMeansHangup("darwin", null, "SIGHUP"), true);
  assert.equal(childExitMeansHangup("linux", 129, null), true);
  assert.equal(childExitMeansHangup("linux", 0, null), false);
  assert.equal(childExitMeansHangup("darwin", null, "SIGTERM"), false);
  assert.equal(childExitMeansHangup("win32", null, "SIGHUP"), false);
});

test("after a hangup, a write error on the gone terminal is not thrown", () => {
  const stdout = new EventEmitter();
  assert.throws(() => stdout.emit("error", new Error("EIO")), /EIO/, "unhandled by default");
  ignoreStreamErrors([stdout]);
  assert.doesNotThrow(() => stdout.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" })));
});
