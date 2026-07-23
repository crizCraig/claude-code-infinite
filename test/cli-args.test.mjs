import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrintInvocation,
  parseWrapperArgs,
} from "../dist/cli-args.js";

test("ccc wrapper flags are consumed only before --", () => {
  assert.deepEqual(
    parseWrapperArgs([
      "--debug",
      "staging",
      "--",
      "--debug",
      "--ab-speculative",
      "--ab-buffered",
    ]),
    {
      claudeArgs: [
        "staging",
        "--",
        "--debug",
        "--ab-speculative",
        "--ab-buffered",
      ],
      debug: true,
      // Post-separator --ab-buffered is a literal Claude arg, not an override.
      speculativeAb: false,
    }
  );
});

test("speculative A/B is explicit opt-in and the last pre-separator mode wins", () => {
  assert.equal(parseWrapperArgs([]).speculativeAb, false);
  assert.equal(parseWrapperArgs(["--ab-buffered"]).speculativeAb, false);
  assert.equal(
    parseWrapperArgs(["--ab-buffered", "--ab-speculative"]).speculativeAb,
    true
  );
  assert.equal(
    parseWrapperArgs(["--ab-speculative", "--ab-buffered"]).speculativeAb,
    false
  );
  assert.deepEqual(parseWrapperArgs(["--ab-speculative", "-p", "hello"]), {
    claudeArgs: ["-p", "hello"],
    debug: false,
    speculativeAb: true,
  });
});

test("Claude print flags are recognized only before --", () => {
  assert.equal(isPrintInvocation(["-p", "hello"]), true);
  assert.equal(isPrintInvocation(["--print", "hello"]), true);
  assert.equal(isPrintInvocation(["-p", "--", "--print"]), true);
  assert.equal(isPrintInvocation(["--", "-p"]), false);
  assert.equal(isPrintInvocation(["--", "--print"]), false);
  assert.equal(isPrintInvocation(["hello", "--", "--print"]), false);
});
