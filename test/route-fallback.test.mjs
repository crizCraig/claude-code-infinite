import test from "node:test";
import assert from "node:assert/strict";
import { fitsFallbackBudget, RouteFallbackFailures } from "../dist/route-fallback.js";

test("fallback: soft budget is advisory, input plus output must fit the native window", () => {
  assert.equal(fitsFallbackBudget(80, 20, 100, 200), true);
  assert.equal(fitsFallbackBudget(101, 0, 100, 200), true, "soft-budget fallback fits the window");
  assert.equal(fitsFallbackBudget(80, 20, 200, 99), false, "must fit the window with its output");
  // 2026-10-03 benchmark: the server leaves 777k input under its 800k budget alone,
  // so ccc must not refuse it for the 128k output reservation on a 1M window.
  assert.equal(fitsFallbackBudget(776_924, 128_000, 800_000, 1_000_000), true);
  assert.equal(fitsFallbackBudget(800_001, 0, 800_000, 1_000_000), true);
  for (const bad of [NaN, Infinity, -1]) {
    assert.equal(fitsFallbackBudget(bad, 20, 100, 200), false);
    assert.equal(fitsFallbackBudget(80, bad, 100, 200), false);
  }
});

test("failure episode permits only two retryable responses until a successful forward", () => {
  const failures = new RouteFallbackFailures();
  for (const expected of [503, 503, 400, 400]) {
    const error = failures.fail("session/main");
    assert.equal(error.status, expected);
    assert.equal(error.headers["x-should-retry"], expected === 503 ? "true" : "false");
    assert.equal(error.headers["retry-after"], expected === 503 ? "1" : undefined);
  }
  assert.equal(failures.fail("session/agent").status, 503);
  failures.succeeded("session/main");
  assert.equal(failures.fail("session/main").status, 503);
});

test("failure state remains bounded without reopening failed lanes after eviction", () => {
  const failures = new RouteFallbackFailures(2);
  failures.fail("a");
  failures.fail("b");
  assert.equal(failures.fail("c").status, 400);
  assert.equal(failures.fail("a").status, 503);
  assert.equal(failures.fail("a").status, 400);
  failures.succeeded("a");
  assert.equal(failures.fail("c").status, 503);
});
