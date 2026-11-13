import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOW_UPLOAD_BUDGET_FACTOR, SLOW_UPLOAD_MEMORY_MS, SLOW_UPLOAD_MIN_BYTES, SlowUploads,
} from "../dist/slow-upload.js";

const BIG = 50_572_609; // 2026-11-12's refused bodies

test("a large upload's timeout doubles the session's next budget until a success", () => {
  let now = 0;
  const uploads = new SlowUploads(() => now);
  assert.equal(uploads.budgetMs("s", BIG, 138_617), 138_617);
  uploads.settled("s", BIG, "timeout");
  assert.equal(uploads.budgetMs("s", BIG, 138_617), 138_617 * SLOW_UPLOAD_BUDGET_FACTOR);
  assert.equal(uploads.budgetMs("other", BIG, 1_000), 1_000, "per session");
  assert.equal(uploads.budgetMs("s", SLOW_UPLOAD_MIN_BYTES - 1, 1_000), 1_000, "small bodies");
  uploads.settled("s", BIG, "ok");
  assert.equal(uploads.budgetMs("s", BIG, 1_000), 1_000);
  uploads.settled("s", BIG, "timeout");
  now = SLOW_UPLOAD_MEMORY_MS;
  assert.equal(uploads.extended("s", BIG), false, "forgotten after a while");
});

test("small uploads, other failures and unknown sessions raise nothing", () => {
  const uploads = new SlowUploads(() => 0);
  uploads.settled("s", 1_000, "timeout");
  uploads.settled("t", BIG, "other");
  uploads.settled(undefined, BIG, "timeout");
  assert.equal(uploads.extended("s", BIG), false);
  assert.equal(uploads.extended("t", BIG), false);
  assert.equal(uploads.extended(undefined, BIG), false);
});
