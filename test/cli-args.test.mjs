import test from "node:test";
import assert from "node:assert/strict";
import { isPrintInvocation, parseWrapperArgs } from "../dist/cli-args.js";

test("ccc wrapper flags are consumed only before --", () => {
  assert.deepEqual(
    parseWrapperArgs(["--debug", "staging", "--", "--debug"]),
    {
      claudeArgs: ["staging", "--", "--debug"],
      debug: true,
    }
  );
});

test("unrecognized flags pass through to Claude untouched", () => {
  assert.deepEqual(parseWrapperArgs(["-p", "hello"]), {
    claudeArgs: ["-p", "hello"],
    debug: false,
  });
  assert.deepEqual(parseWrapperArgs([]), { claudeArgs: [], debug: false });
});

test("Claude print flags are recognized only before --", () => {
  assert.equal(isPrintInvocation(["-p", "hello"]), true);
  assert.equal(isPrintInvocation(["--print", "hello"]), true);
  assert.equal(isPrintInvocation(["-p", "--", "--print"]), true);
  assert.equal(isPrintInvocation(["--", "-p"]), false);
  assert.equal(isPrintInvocation(["--", "--print"]), false);
  assert.equal(isPrintInvocation(["hello", "--", "--print"]), false);
});
