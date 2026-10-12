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

test("an index wait answers 503 with a longer retry-after and spends no strikes", () => {
  const failures = new RouteFallbackFailures(128, 1_000);
  for (let now = 0; now < 1_000; now += 100) {
    const error = failures.fail("session/main", { awaitingIndex: true, now });
    assert.equal(error.status, 503);
    assert.equal(error.headers["x-should-retry"], "true");
    assert.equal(error.headers["retry-after"], "30");
    assert.match(error.body.error.message, /indexing/);
  }
  // The strike budget is untouched by the wait.
  assert.equal(failures.fail("session/main", { now: 1_000 }).status, 503);
});

test("an index wait refuses with actionable wording once its deadline passes", () => {
  const failures = new RouteFallbackFailures(128, 1_000);
  assert.equal(failures.fail("lane", { awaitingIndex: true, now: 0 }).status, 503);
  const error = failures.fail("lane", { awaitingIndex: true, now: 1_000 });
  assert.equal(error.status, 400);
  assert.equal(error.headers["x-should-retry"], "false");
  assertActionable(error.body.error.message);
  assert.equal(failures.fail("lane", { awaitingIndex: true, now: 1_001 }).status, 400);
  failures.succeeded("lane");
  assert.equal(failures.fail("lane", { awaitingIndex: true, now: 5_000 }).status, 503,
    "a delivery starts a new wait");
});

test("with no index wait the third failure refuses with actionable wording", () => {
  const failures = new RouteFallbackFailures();
  failures.fail("lane");
  failures.fail("lane");
  assertActionable(failures.fail("lane").body.error.message);
});

function assertActionable(message) {
  assert.match(message, /couldn't fit this request in the model's context window/);
  assert.match(message, /still indexing/);
  assert.match(message, /\/ccc:memtree-compact/);
  assert.match(message, /\/clear/);
}
