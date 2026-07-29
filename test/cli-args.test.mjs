import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrintInvocation,
  parseWrapperArgs,
  resolveAbRouting,
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
      // Post-separator A/B flags are literal Claude args: no override, and no
      // implicit A/B routing opt-in either.
      speculativeAb: false,
      abDeliveryRequested: false,
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
    abDeliveryRequested: true,
  });
});

test("either explicit A/B delivery flag requests A/B routing", () => {
  // No flag: no request, so routing stays gated on CCC_AB_ROUTING=1.
  assert.equal(parseWrapperArgs([]).abDeliveryRequested, false);
  assert.equal(parseWrapperArgs(["-p", "hi"]).abDeliveryRequested, false);
  // --ab-buffered matches the default delivery mode but is still an explicit
  // opt-in to A/B routing itself.
  assert.equal(parseWrapperArgs(["--ab-buffered"]).abDeliveryRequested, true);
  assert.equal(parseWrapperArgs(["--ab-speculative"]).abDeliveryRequested, true);
  assert.equal(
    parseWrapperArgs(["--ab-speculative", "--ab-buffered"]).abDeliveryRequested,
    true
  );
});

test("A/B routing enables via env or an explicit delivery flag", () => {
  // Default off: no env switch and no flag.
  assert.deepEqual(resolveAbRouting(undefined, false), {
    enabled: false,
    warnFlagIgnored: false,
  });
  assert.deepEqual(resolveAbRouting("0", false), {
    enabled: false,
    warnFlagIgnored: false,
  });
  // CCC_AB_ROUTING=1 enables regardless of flags.
  assert.deepEqual(resolveAbRouting("1", false), {
    enabled: true,
    warnFlagIgnored: false,
  });
  assert.deepEqual(resolveAbRouting("1", true), {
    enabled: true,
    warnFlagIgnored: false,
  });
  // An explicit delivery flag is an opt-in on its own — this was the silent
  // no-op: the flag parsed and stripped but routing never enabled.
  assert.deepEqual(resolveAbRouting(undefined, true), {
    enabled: true,
    warnFlagIgnored: false,
  });
  // Unrecognized env values are treated as unset, not as an explicit disable.
  assert.deepEqual(resolveAbRouting("yes", true), {
    enabled: true,
    warnFlagIgnored: false,
  });
  assert.deepEqual(resolveAbRouting("yes", false), {
    enabled: false,
    warnFlagIgnored: false,
  });
  // Explicit CCC_AB_ROUTING=0 wins over the flag, and the caller must warn
  // rather than ignore it silently.
  assert.deepEqual(resolveAbRouting("0", true), {
    enabled: false,
    warnFlagIgnored: true,
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
