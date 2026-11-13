// The final refusal says what is happening, from the request's log record (refusal-reason.ts).
// The records below are the shapes requests.jsonl recorded for real refusals: session
// e32c1f3e on 2026-11-12 23:35-23:51Z (a ~50 MB body timing out at 138.6 s, half of them
// after a prefix mismatch), and earlier ones whose compress failed or was refused.
import test from "node:test";
import assert from "node:assert/strict";
import {
  INDEX_TOKENS_PER_MINUTE, durationText, refusalCause, refusalMessage, tokensText,
} from "../dist/refusal-reason.js";
import { RouteFallbackFailures, FINAL_REFUSAL_MESSAGE } from "../dist/route-fallback.js";
import { memoryReadySeconds, unindexedTokenCount } from "../dist/memtree.js";

const LINK = "https://memtree.ai/m/a8f362de";

/** 2026-11-12T23:35:16Z: reason budget, 50.6 MB, compress timed out at 138.6 s. */
const BUDGET_TIMEOUT = {
  turnType: "followup-refused", requestBytes: 50572609,
  compaction: { mode: "auto", reason: "budget", estimatedTokens: 802854 },
  compress: { ms: 138617, ok: false, timedOut: true, uploadTimeout: true },
  refusal: { attempt: 3, status: 400, inputTokens: 1400455, indexBehind: false,
    budgetTokens: 960000, modelContextLimit: 1000000 },
};
/** 2026-11-12T23:41:33Z: Claude Code's tool count flipped 27 -> 73, prefix mismatch, timeout. */
const PREFIX_TIMEOUT = {
  turnType: "followup-refused", requestBytes: 50559997,
  compaction: { mode: "auto", reason: "prefix-mismatch", prefixMiss: "prefix" },
  compress: { ms: 138613, ok: false, timedOut: true, uploadTimeout: true },
  refusal: { attempt: 3, status: 400, inputTokens: 20231969, indexBehind: false,
    budgetTokens: 960000, modelContextLimit: 1000000 },
};
/** 2026-11-10T04:24:06Z: MemTree refused the request (a 413 that waiting cannot fix). */
const REFUSED_413 = {
  turnType: "followup-refused", requestBytes: 25460743,
  compaction: { mode: "auto", reason: "budget" },
  compress: { ms: 97341, ok: false, timedOut: false, refused: true },
  refusal: { attempt: 3, status: 400, inputTokens: 3024529, indexBehind: false,
    budgetTokens: 960000, modelContextLimit: 1000000 },
};

function facts(rec, extra = {}) {
  return { inputTokens: rec.refusal.inputTokens, modelContextLimit: rec.refusal.modelContextLimit,
    ...extra };
}

test("indexing behind: the server's ETA and the un-indexed tokens", () => {
  const rec = { ...BUDGET_TIMEOUT, compress: { ms: 900, ok: true, timedOut: false },
    indexBehind: true, indexLag: { etaSeconds: 170, unindexedTokens: 1_200_000 } };
  const cause = refusalCause(rec, facts(rec));
  assert.deepEqual(cause, { kind: "indexing", secondsLeft: 170, unindexedTokens: 1_200_000 });
  assert.equal(refusalMessage(cause, LINK),
    `MemTree is still indexing ~1.2M new tokens (~3 min). Retry then. Session: ${LINK}`);
});

test("indexing behind: a 413's stated time left wins over the answer's ETA", () => {
  const rec = { ...REFUSED_413, indexBehind: true, indexWait: { secondsLeft: 240 },
    indexLag: { etaSeconds: 60 } };
  const cause = refusalCause(rec, facts(rec, { indexSecondsLeft: 600 }));
  assert.equal(cause.secondsLeft, 600);
  assert.match(refusalMessage(cause), /^MemTree is still indexing this session's newest messages \(~10 min\)\. Retry then\. Session link: \/ccc:memtree-view\.$/);
});

test("indexing behind with no server estimate: un-indexed tokens at the indexing rate", () => {
  const rec = { ...REFUSED_413, indexBehind: true, indexLag: { unindexedTokens: 400_000 } };
  const cause = refusalCause(rec, facts(rec));
  assert.equal(cause.secondsLeft, undefined);
  const minutes = Math.ceil(400_000 / INDEX_TOKENS_PER_MINUTE);
  assert.equal(refusalMessage(cause, LINK),
    `MemTree is still indexing ~400k new tokens (~${minutes} min). Retry then. Session: ${LINK}`);
});

test("indexing behind with nothing to estimate from: retry in a few minutes", () => {
  const rec = { ...REFUSED_413, indexBehind: true };
  assert.equal(refusalMessage(refusalCause(rec, facts(rec)), LINK),
    `MemTree is still indexing this session's newest messages. Retry in a few minutes. Session: ${LINK}`);
});

test("upload timeout (2026-11-12, reason budget): size, time, the next try's budget", () => {
  const cause = refusalCause(BUDGET_TIMEOUT, facts(BUDGET_TIMEOUT, { nextCompressBudgetMs: 277_234 }));
  assert.deepEqual(cause, { kind: "upload-timeout", bytes: 50572609, ms: 138617,
    nextBudgetMs: 277_234 });
  assert.equal(refusalMessage(cause, LINK),
    "MemTree timed out after 139 s on this 51 MB request (likely a slow upload). Retry: the " +
    "next try waits up to 277 s. CCC_COMPRESS_TIMEOUT_MS (ms) raises the base wait. " +
    `Session: ${LINK}`);
});

test("upload timeout after a prefix mismatch is still the upload; no longer budget left", () => {
  const cause = refusalCause(PREFIX_TIMEOUT, facts(PREFIX_TIMEOUT));
  assert.equal(cause.kind, "upload-timeout");
  const message = refusalMessage(cause, LINK);
  assert.match(message, /^MemTree timed out after 139 s on this 51 MB request \(likely a slow upload\)\. Retry, ideally on a faster connection\. CCC_COMPRESS_TIMEOUT_MS/);
  assert.doesNotMatch(message, /couldn't fit|memtree-compact|\/clear/);
});

test("prefix mismatch whose compress failed: MemTree is rebuilding the compressed history", () => {
  const rec = { ...PREFIX_TIMEOUT, compress: { ms: 2_100, ok: false, timedOut: false, status: 502 } };
  const cause = refusalCause(rec, facts(rec));
  assert.deepEqual(cause, { kind: "rebuilding" });
  assert.equal(refusalMessage(cause, LINK),
    "MemTree is rebuilding this session's compressed history (Claude Code resent earlier " +
    `messages changed). Retry in a minute. Session: ${LINK}`);
  const timed = refusalCause(rec, facts(rec, { indexSecondsLeft: 90 }));
  assert.equal(refusalMessage(timed, LINK),
    "MemTree is rebuilding this session's compressed history (Claude Code resent earlier " +
    `messages changed) (~2 min). Retry then. Session: ${LINK}`);
});

test("a compress that failed with an error: retry, then compact", () => {
  const rec = { ...BUDGET_TIMEOUT, compress: { ms: 139, ok: false, timedOut: false, status: 500 } };
  assert.equal(refusalMessage(refusalCause(rec, facts(rec)), LINK),
    "MemTree couldn't compress this turn (HTTP 500). Retry in a minute; if it keeps failing, " +
    `run /ccc:memtree-compact or /clear. Session: ${LINK}`);
});

test("over budget with indexing done (MemTree refused, or compressed and still too big)", () => {
  const cause = refusalCause(REFUSED_413, facts(REFUSED_413));
  assert.deepEqual(cause, { kind: "over-budget", inputTokens: 3024529, contextTokens: 1000000 });
  assert.equal(refusalMessage(cause, LINK),
    "MemTree couldn't fit this request (~3M tokens) in the model's 1M-token context window. " +
    `Run /ccc:memtree-compact or /clear. Session: ${LINK}`);
  const compressedTooBig = { ...REFUSED_413, compress: { ms: 900, ok: true, timedOut: false },
    compaction: { reason: "prefix-mismatch" } };
  assert.equal(refusalCause(compressedTooBig, facts(compressedTooBig)).kind, "over-budget");
  const noCompress = { ...REFUSED_413, compress: undefined };
  assert.equal(refusalCause(noCompress, facts(noCompress)).kind, "over-budget");
});

test("the final 400 carries the given message; without one, the generic text", () => {
  const failures = new RouteFallbackFailures();
  failures.fail("lane", { refusalMessage: "custom" });
  failures.fail("lane", { refusalMessage: "custom" });
  const third = failures.fail("lane", { refusalMessage: "custom" });
  assert.equal(third.status, 400);
  assert.equal(third.body.error.message, "custom");
  assert.equal(failures.fail("lane").body.error.message, FINAL_REFUSAL_MESSAGE);
  const waits = new RouteFallbackFailures(128, 1_000);
  waits.fail("w", { awaitingIndex: true, now: 0, refusalMessage: "indexing" });
  const closed = waits.fail("w", { awaitingIndex: true, now: 1_000, refusalMessage: "indexing" });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.error.message, "indexing");
});

test("server fields: memory_ready_in_seconds and the un-indexed tokens", () => {
  assert.equal(memoryReadySeconds({ messages: [], memory_ready_in_seconds: 170 }), 170);
  for (const bad of [0, -1, "90", null, NaN]) {
    assert.equal(memoryReadySeconds({ messages: [], memory_ready_in_seconds: bad }), undefined);
  }
  assert.equal(unindexedTokenCount({ messages: [],
    usage: { raw_prompt_tokens: 1_500_000, indexed_tokens: 300_000 } }), 1_200_000);
  assert.equal(unindexedTokenCount({ messages: [], usage: { raw_prompt_tokens: 10 } }), undefined);
});

test("number formats", () => {
  assert.equal(tokensText(1_200_000), "1.2M");
  assert.equal(tokensText(3_000_000), "3M");
  assert.equal(tokensText(480_400), "480k");
  assert.equal(tokensText(900), "900");
  assert.equal(durationText(1), "1 min");
  assert.equal(durationText(170), "3 min");
  assert.equal(durationText(119 * 60), "119 min");
  assert.equal(durationText(90 * 60 * 2), "3 h");
  assert.equal(durationText(150 * 60), "2.5 h");
});

test("a timeout that was not a large upload's whole long budget: MemTree was slow", () => {
  // A short-budget call, a small body, or one cut short by an index hold (no uploadTimeout).
  const rec = { ...BUDGET_TIMEOUT, requestBytes: 2_000_000,
    compress: { ms: 20_000, ok: false, timedOut: true } };
  const cause = refusalCause(rec, facts(rec, { nextCompressBudgetMs: 999_000 }));
  assert.deepEqual(cause, { kind: "slow-answer", ms: 20_000 });
  assert.equal(refusalMessage(cause, LINK),
    "MemTree didn't answer within 20 s. Retry in a minute; if it keeps happening, run " +
    `/ccc:memtree-compact or /clear. Session: ${LINK}`);
});
