import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicUpstreamFromEnv,
  compactTargetFromEnv,
  isPrintInvocation,
  mayBePrintInvocation,
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

test("mayBePrintInvocation also counts combined short flags with p (no browser opened)", () => {
  for (const args of [["-p"], ["--print"], ["--print=true"], ["-pc", "hi"], ["-cp"], ["-dpc"]]) {
    assert.equal(mayBePrintInvocation(args), true, args.join(" "));
  }
  for (const args of [[], ["-c"], ["--resume", "abc"], ["-r", "abc"], ["--", "-pc"], ["--permission-mode", "plan"]]) {
    assert.equal(mayBePrintInvocation(args), false, args.join(" "));
  }
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

test("--version / -v alone (optionally after local/staging) is a version request", async () => {
  const { isVersionRequest } = await import("../dist/cli-args.js");
  for (const args of [["--version"], ["-v"], ["staging", "--version"], ["local", "-v"]]) {
    assert.equal(isVersionRequest(args), true, args.join(" "));
  }
  for (const args of [[], ["-p", "--version"], ["--version", "-p", "x"], ["--", "--version"]]) {
    assert.equal(isVersionRequest(args), false, args.join(" "));
  }
});

test("CCC_ANTHROPIC_UPSTREAM takes only a loopback origin", () => {
  assert.deepEqual(anthropicUpstreamFromEnv(undefined), { value: undefined });
  assert.deepEqual(anthropicUpstreamFromEnv("  "), { value: undefined });
  assert.equal(anthropicUpstreamFromEnv("http://127.0.0.1:8123").value, "http://127.0.0.1:8123");
  assert.equal(anthropicUpstreamFromEnv("http://localhost:9/").value, "http://localhost:9");
  for (const refused of [
    "https://api.example.com", "http://10.0.0.5:80", "ftp://127.0.0.1:21",
    "http://127.0.0.1.example.com", "http://user:pw@127.0.0.1:1", "http://127.0.0.1:1/v1", "nope",
    "http://[::1]:8123",
  ]) {
    const { value, warning } = anthropicUpstreamFromEnv(refused);
    assert.equal(value, undefined, refused);
    assert.match(warning, /ignoring CCC_ANTHROPIC_UPSTREAM/, refused);
    assert.doesNotMatch(warning, /pw@|example|nope/, "the refused value is never echoed");
  }
});
