import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeChildEnv,
  claudeNativeOneMillionContextEnabled,
} from "../dist/claude-env.js";

test("ccc disables Claude Code auto-compaction without mutating the parent env", () => {
  const parent = {
    PATH: "/bin",
    DISABLE_AUTO_COMPACT: "0",
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "100000",
  };

  const child = claudeChildEnv(parent, "http://127.0.0.1:4321");

  assert.deepEqual(parent, {
    PATH: "/bin",
    DISABLE_AUTO_COMPACT: "0",
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "100000",
  });
  assert.equal(child.PATH, "/bin");
  assert.equal(child.ANTHROPIC_BASE_URL, "http://127.0.0.1:4321");
  assert.equal(child._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "1");
  assert.equal(child.DISABLE_AUTO_COMPACT, "1");
  assert.equal(child.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD, "1000000000");
  assert.equal(child.CCC_AUTO_COMPACT, undefined);
});

test("CCC_AUTO_COMPACT=1 restores Claude Code's native auto-compact setting", () => {
  const child = claudeChildEnv(
    {
      CCC_AUTO_COMPACT: "1",
      DISABLE_AUTO_COMPACT: "1",
    },
    "http://127.0.0.1:9876"
  );

  assert.equal(child.ANTHROPIC_BASE_URL, "http://127.0.0.1:9876");
  assert.equal(child.DISABLE_AUTO_COMPACT, undefined);
  assert.equal(child.CCC_AUTO_COMPACT, undefined);
});

test("only the documented exact opt-in re-enables native auto-compaction", () => {
  for (const value of ["0", "true", "yes", ""]) {
    const child = claudeChildEnv(
      { CCC_AUTO_COMPACT: value },
      "http://127.0.0.1:1234"
    );
    assert.equal(child.DISABLE_AUTO_COMPACT, "1", `value=${JSON.stringify(value)}`);
  }
});

test("ccc suppresses Claude's fixed 100k resume-summary recommendation", () => {
  const child = claudeChildEnv({}, "http://127.0.0.1:1234");

  assert.equal(child.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD, "1000000000");
  assert.equal(
    child.DISABLE_COMPACT,
    undefined,
    "manual /compact remains available"
  );
});

test("ccc overrides custom-base-url classification for its trusted localhost relay", () => {
  const parent = {
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "0",
  };

  const child = claudeChildEnv(parent, "http://127.0.0.1:4567");

  assert.equal(parent._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "0");
  assert.equal(child._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "1");
});

test("the documented Claude Code switch still disables native 1M context", () => {
  for (const value of ["1", "true", "YES", "on"]) {
    assert.equal(
      claudeNativeOneMillionContextEnabled({
        CLAUDE_CODE_DISABLE_1M_CONTEXT: value,
      }),
      false,
      `value=${JSON.stringify(value)}`
    );
  }

  for (const value of [undefined, "", "0", "false", "no", "off"]) {
    assert.equal(
      claudeNativeOneMillionContextEnabled({
        CLAUDE_CODE_DISABLE_1M_CONTEXT: value,
      }),
      true,
      `value=${JSON.stringify(value)}`
    );
  }
});
