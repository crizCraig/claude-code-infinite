import test from "node:test";
import assert from "node:assert/strict";
import { exitResumeHint, resumeHintText } from "../dist/resume-hint.js";

const ID = "0f3c9a52-7d1e-4b8a-9c2f-5e6d7a8b9c0d";

test("the resume hint names ccc and the session, plain without colour", () => {
  assert.equal(
    resumeHintText({ sessionId: ID, color: false }),
    `\nResume with MemTree:\nccc --resume ${ID}\n`
  );
});

test("the resume hint keeps the environment prefix ccc was started with", () => {
  assert.equal(
    resumeHintText({ sessionId: ID, envPrefix: "staging", color: false }),
    `\nResume with MemTree:\nccc staging --resume ${ID}\n`
  );
  assert.equal(
    resumeHintText({ sessionId: ID, envPrefix: "local", color: false }),
    `\nResume with MemTree:\nccc local --resume ${ID}\n`
  );
});

test("the coloured resume hint uses the banner's colours around the same text", () => {
  const text = resumeHintText({ sessionId: ID, envPrefix: "staging", color: true });
  assert.equal(
    text,
    "\n\x1b[38;5;48mResume with MemTree:\x1b[0m\n" +
      `\x1b[1;38;5;209mccc staging --resume ${ID}\x1b[0m\n`
  );
  assert.equal(text.replace(/\x1b\[[0-9;]*m/g, ""),
    resumeHintText({ sessionId: ID, envPrefix: "staging", color: false }));
});

test("no hint without a usable session id", () => {
  assert.equal(resumeHintText({ sessionId: undefined, color: false }), undefined);
  assert.equal(resumeHintText({ sessionId: "", color: false }), undefined);
  // Never echo terminal control sequences or shell metacharacters.
  assert.equal(resumeHintText({ sessionId: "a\x1b]0;x\x07", color: false }), undefined);
  assert.equal(resumeHintText({ sessionId: "a; rm -rf ~", color: false }), undefined);
});

test("after Claude Code exits: interactive sessions with a known id, with ccc's environment", () => {
  assert.equal(
    exitResumeHint({ interactive: true, sessionId: ID, mode: "production", color: false }),
    `\nResume with MemTree:\nccc --resume ${ID}\n`
  );
  assert.equal(
    exitResumeHint({ interactive: true, sessionId: ID, mode: "staging", color: false }),
    `\nResume with MemTree:\nccc staging --resume ${ID}\n`
  );
  // `-p` and other non-interactive runs keep their output vanilla.
  assert.equal(
    exitResumeHint({ interactive: false, sessionId: ID, mode: "production", color: false }),
    undefined
  );
  assert.equal(
    exitResumeHint({ interactive: true, sessionId: undefined, mode: "staging", color: true }),
    undefined
  );
});
