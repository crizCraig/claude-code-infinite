import test from "node:test";
import assert from "node:assert/strict";
import {
  compactTargetFromEnv,
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
  assert.equal(memtreeLinkPlacementFromEnv("turn"), "turn");
  assert.equal(memtreeLinkPlacementFromEnv("message"), "message");
  assert.equal(memtreeLinkPlacementFromEnv(" Stop "), "stop");
  assert.equal(memtreeLinkPlacementFromEnv("success"), "success");
  assert.equal(memtreeLinkPlacementFromEnv("off"), "off");
  assert.equal(memtreeLinkPlacementFromEnv(undefined), undefined);
  assert.equal(memtreeLinkPlacementFromEnv(""), undefined);
  assert.equal(memtreeLinkPlacementFromEnv("recap"), undefined);
});

test("CCC_COMPACT_TARGET: a token count, off, or ignored with a warning", () => {
  const parse = (t) => {
    const m = /^(\d+)(k)?$/i.exec(t.trim());
    return m ? Number(m[1]) * (m[2] ? 1000 : 1) : undefined;
  };
  assert.deepEqual(compactTargetFromEnv(undefined, parse, 20_000), { value: undefined });
  assert.deepEqual(compactTargetFromEnv("", parse, 20_000), { value: undefined });
  assert.deepEqual(compactTargetFromEnv("500k", parse, 20_000), { value: 500_000 });
  assert.deepEqual(compactTargetFromEnv("off", parse, 20_000), { value: null });
  assert.deepEqual(compactTargetFromEnv(" OFF ", parse, 20_000), { value: null });
  const small = compactTargetFromEnv("5k", parse, 20_000);
  assert.equal(small.value, undefined);
  assert.match(small.warning, /ignoring CCC_COMPACT_TARGET=5k/);
  assert.equal(compactTargetFromEnv("lots", parse, 20_000).value, undefined);
});
