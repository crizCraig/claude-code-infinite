import test from "node:test";
import assert from "node:assert/strict";
import { blockTimes, bracketedSpan, formatTime, formatTimeSpan, mergeSpans, setDisplayTimeZone } from "../dist/memtree-times.js";

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

test("an hour apart when clocks go back is still a span, each end labelled when the zone's name changes", () => {
  assert.equal(formatTimeSpan(["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"], PT), "2026-11-01 01:30 PDT–01:30 PST");
  // Twenty minutes apart, the later one at an earlier clock time: the names keep the order clear.
  assert.equal(formatTimeSpan(["2026-11-01T08:50:00Z", "2026-11-01T09:10:00Z"], PT), "2026-11-01 01:50 PDT–01:10 PST");
  assert.equal(formatTime("2026-11-01T08:50:00Z", PT), "2026-11-01 01:50 PDT");
  assert.equal(formatTime("2026-11-01T09:10:00Z", PT), "2026-11-01 01:10 PST");
  assert.equal(formatTime("2026-11-01T12:00:00Z", PT), "2026-11-01 04:00 PT", "away from the change: generic");
  assert.equal(formatTimeSpan(["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"], "Europe/Berlin"),
    "2026-10-25 02:30 GMT+2–02:30 GMT+1");
  assert.equal(formatTimeSpan(["2026-09-30T21:40:00Z", "2026-09-30T21:02:00Z"], PT), "2026-09-30 14:02–14:40 PT", "reversed: earliest first");
  for (const junk of [["1", "2"], ["2026-09-30T21:02:00", "2026-09-30T21:40:00"], ["2026-09-30", "2026-10-01"]]) {
    assert.equal(formatTimeSpan(junk, PT), undefined, "times need a zone");
  }
});

test("an override sets the zone shown", () => {
  try {
    setDisplayTimeZone("Asia/Tokyo");
    assert.equal(formatTime("2026-09-30T21:02:00Z"), "2026-10-01 06:02 GMT+9");
  } finally {
    setDisplayTimeZone(undefined);
  }
});

// Windows ICU reads the zone from the OS and ignores a TZ set at runtime.
test("the default zone is this process's (TZ), labelled", { skip: process.platform === "win32" }, () => {
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

test("line times: parse, the time a line belongs to, and the span of a range", async () => {
  const { lineTimes, timeAt, entriesIn, linesSpan, ClockFormat, MissingTimeNote } = await import("../dist/memtree-times.js");
  const t = (m) => `2026-10-16T15:${String(m).padStart(2, "0")}:00.000Z`;
  const parsed = lineTimes({ "0": [[1, t(1)], [6, null], [10, t(4)]], "1": [[3, t(1)], [2, t(2)]], x: [[1, t(1)]], "2": [[0, t(1)]] });
  assert.deepEqual([...parsed.keys()], [0], "unordered, junk keys and line 0 dropped");
  const e = parsed.get(0);
  assert.deepEqual(e[1], [6, undefined]);
  assert.equal(timeAt(e, 5), t(1));
  assert.equal(timeAt(e, 7), undefined);
  assert.equal(timeAt([[3, t(1)]], 2), undefined);
  assert.deepEqual(entriesIn(e, 2, 6), [[1, t(1)], [6, undefined]]);
  assert.deepEqual(linesSpan(e, 2, 12), [t(1), t(4)]);
  assert.equal(linesSpan(e, 6, 9), undefined);
  const clock = new ClockFormat(PT);
  assert.equal(clock.format("2026-10-16T15:38:00Z"), "2026-10-16 08:38");
  assert.equal(clock.format("2026-10-16T16:02:00Z"), "09:02");
  assert.equal(clock.format(undefined), undefined);
  assert.equal(clock.format("2026-10-17T16:02:00Z"), "2026-10-17 09:02", "the date again when it changes");
  const missing = new MissingTimeNote();
  assert.equal(missing.next(), "time not recorded");
  assert.equal(missing.next(), "");
});
