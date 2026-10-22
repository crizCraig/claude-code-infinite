import test from "node:test";
import assert from "node:assert/strict";
import { blockTimes, bracketedSpan, formatTime, formatTimeSpan, mergeSpans } from "../dist/memtree-times.js";

const PT = "America/Los_Angeles";

test("time spans: one date on the same day, both across midnight, one time in the same minute", () => {
  assert.equal(formatTimeSpan(["2026-09-30T21:02:00.000Z", "2026-09-30T21:40:59.000Z"], PT), "2026-09-30 14:02–14:40 PT");
  assert.equal(formatTimeSpan(["2026-10-01T06:50:00.000Z", "2026-10-01T07:10:00.000Z"], PT), "2026-09-30 23:50–2026-10-01 00:10 PT");
  assert.equal(formatTimeSpan(["2026-09-30T21:02:00.000Z", "2026-09-30T21:02:40.000Z"], PT), "2026-09-30 14:02 PT");
  assert.equal(formatTimeSpan(["2026-09-30T21:02:00.000Z", "2026-09-30T21:40:00.000Z"], "UTC"), "2026-09-30 21:02–21:40 UTC");
  assert.equal(formatTimeSpan(["2026-09-30T21:02:00.000Z", "2026-09-30T21:40:00.000Z"], "Etc/UTC"), "2026-09-30 21:02–21:40 UTC");
  assert.equal(formatTimeSpan(["2026-09-30T00:02:00.000Z", "2026-09-30T00:40:00.000Z"], "UTC"), "2026-09-30 00:02–00:40 UTC");
  assert.equal(formatTimeSpan(["2026-09-30T21:02:00.000Z", "2026-09-30T21:40:00.000Z"], "Europe/Berlin"), "2026-09-30 23:02–23:40 GMT+2");
  assert.equal(formatTimeSpan(["2026-09-30T21:02:00.000Z", "2026-09-30T21:40:00.000Z"], "No/Such_Zone"), "2026-09-30 21:02–21:40 UTC");
});

test("time spans: unknown or malformed spans show nothing", () => {
  for (const bad of [undefined, null, [], ["2026-09-30T21:02:00Z"], ["x", "y"], [1, 2], "2026-09-30", {}]) {
    assert.equal(formatTimeSpan(bad, PT), undefined, JSON.stringify(bad));
    assert.equal(bracketedSpan(bad, PT), "");
  }
  assert.equal(bracketedSpan(["2026-09-30T21:02:00Z", "2026-09-30T21:40:00Z"], PT), " [2026-09-30 14:02–14:40 PT]");
  assert.equal(formatTime("2026-09-30T21:02:00+00:00", PT), "2026-09-30 14:02 PT");
  assert.equal(formatTime(undefined, PT), undefined);
});

test("the default zone is this process's (TZ), labelled", () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    assert.equal(formatTime("2026-09-30T21:02:00Z"), "2026-09-30 17:02 ET");
    process.env.TZ = "UTC";
    assert.equal(formatTime("2026-09-30T21:02:00Z"), "2026-09-30 21:02 UTC");
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test("block times parse and merge", () => {
  const times = blockTimes({ "0": ["2026-09-30T21:02:00.000Z", "2026-09-30T21:10:00.000Z"], x: ["a", "b"], "2": ["bad", "x"], "3": null });
  assert.deepEqual([...times.keys()], [0]);
  assert.equal(blockTimes(null).size, 0);
  assert.deepEqual(mergeSpans(["2026-09-30T21:02:00.000Z", "2026-09-30T21:10:00.000Z"], ["2026-09-30T20:00:00.000Z", "2026-09-30T21:05:00.000Z"]),
    ["2026-09-30T20:00:00.000Z", "2026-09-30T21:10:00.000Z"]);
});
