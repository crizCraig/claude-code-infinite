import test from "node:test";
import assert from "node:assert/strict";
import {
  createSignalShutdownHandler,
  exitCodeForChild,
  exitCodeForSignal,
} from "../dist/cli-lifecycle.js";

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
