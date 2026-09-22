import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrintInvocation,
  memtreeLinkPlacementFromEnv,
  parseWrapperArgs,
} from "../dist/cli-args.js";

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

test("CCC_MEMTREE_LINK picks a known placement, anything else means default", () => {
  assert.equal(memtreeLinkPlacementFromEnv("message"), "message");
  assert.equal(memtreeLinkPlacementFromEnv(" Stop "), "stop");
  assert.equal(memtreeLinkPlacementFromEnv("success"), "success");
  assert.equal(memtreeLinkPlacementFromEnv("off"), "off");
  assert.equal(memtreeLinkPlacementFromEnv(undefined), undefined);
  assert.equal(memtreeLinkPlacementFromEnv(""), undefined);
  assert.equal(memtreeLinkPlacementFromEnv("recap"), undefined);
});
