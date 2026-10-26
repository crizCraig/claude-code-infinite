import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUDGET_TOKENS, FAIL, HTTP1_EDGE_BYTES, LONG_ANSWER_TOKENS, PASS, PREPARE_START_RATIO, SKIP,
  countBodyTokens, crossingPath, evaluateRun, followsConsoleClose, imageDimensions, imageTokensOf, parseTurnPrompt, percentile,
  planTurn, pngFixture, redactPublic, textFileContent, toolResultsIn, turnPrompt, uniqueJpeg,
} from "../scripts/long-session/lib.mjs";

const JPEG = readFileSync(new URL("../scripts/long-session/fixtures/photo.jpg", import.meta.url));

test("fixture images are 50-100 KB, distinct, and their sizes readable", () => {
  const png = pngFixture(5);
  assert.ok(png.length > 50_000 && png.length < 100_000, `png ${png.length}`);
  assert.deepEqual(imageDimensions(png), { width: 320, height: 240 });
  assert.notDeepEqual(pngFixture(6), png);
  const a = uniqueJpeg(JPEG, "a");
  assert.ok(a.length > 50_000 && a.length < 100_000, `jpeg ${a.length}`);
  assert.deepEqual(imageDimensions(a), { width: 640, height: 480 });
  assert.notDeepEqual(uniqueJpeg(JPEG, "b"), a);
  assert.equal(imageTokensOf(a.toString("base64")), 23 * 18);
  assert.equal(imageTokensOf("not an image"), 1_600);
});

test("token counts: text by characters, images by dimensions, never their base64", () => {
  const text = "x".repeat(27_000);
  const image = { type: "image", source: { type: "base64", media_type: "image/png",
    data: pngFixture(1).toString("base64") } };
  const body = { system: "s".repeat(270), messages: [
    { role: "user", content: text },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [image] }] },
  ] };
  // Every string counts (roles, block types, ids too), except image data.
  const chars = 27_000 + 270 + "useruser".length + "tool_result".length + "t".length;
  assert.equal(countBodyTokens(body), Math.ceil(chars / 2.7) + 108 + 2 * 8);
});

test("a turn's prompt round-trips through flattened records", () => {
  const prompt = turnPrompt("ab12", 7, ["t7-0.txt", "i7-0.png"], 900);
  const record = `[USER]\nLSTURN-ab12-6. answer=0 read: t6-0.txt\n…\n[USER]\n${prompt}\n`;
  assert.deepEqual(parseTurnPrompt(record, "ab12"),
    { turn: 7, answerTokens: 900, files: ["t7-0.txt", "i7-0.png"] });
  assert.equal(parseTurnPrompt(JSON.stringify({ text: prompt }), "ab12").files.length, 2);
  assert.equal(parseTurnPrompt(prompt, "other"), null);
});

test("text files are unique per seed and about the size asked", () => {
  const a = textFileContent(1, 40_000, "T1");
  assert.ok(a.length >= 40_000 && a.length < 40_200);
  assert.notEqual(textFileContent(2, 40_000, "T1"), a);
});

for (const [budget, turns] of [[960_000, 300], [900_000, 300], [960_000, 60]]) {
  test(`the plan crosses by both paths, the second without a prepared prefix (${budget}, ${turns} turns)`, () => {
    const sim = simulate(turns, budget);
    assert.equal(sim.crossings.length, 2, JSON.stringify(sim.crossings));
    const [first, second] = sim.crossings;
    assert.equal(first.path, "human", "the first crossing lands on a human turn (long answer)");
    assert.ok(first.turn > turns * 0.3 && first.turn < turns * 0.4, `first at ${first.turn}`);
    assert.ok(first.prepared, "ccc had started preparing before the human-turn crossing");
    assert.equal(second.path, "tool", "the second lands in a tool round");
    assert.ok(second.turn > turns * 0.63 && second.turn < turns * 0.75, `second at ${second.turn}`);
    assert.equal(second.prepared, false, "nothing was prepared before the jump");
    if (turns === 300) {
      assert.ok(sim.bytesAt270 > 27_000_000 && sim.bytesAt270 < HTTP1_EDGE_BYTES, `${sim.bytesAt270}`);
      assert.ok(sim.finalBytes > HTTP1_EDGE_BYTES, `${sim.finalBytes}`);
    }
    // Every request over the budget stays clear of the window less Claude Code's 16k output floor.
    assert.ok(sim.peakTokens <= 1_000_000 - 16_000, `${sim.peakTokens}`);
  });
}

/**
 * The plan against an idealized ccc: a request at the budget compresses (to half of it),
 * and ccc prepares a prefix once a request reaches the prepare start.
 */
function simulate(turns, budget) {
  let tokens = 25_000;
  let bytes = 150_000;
  let peakTokens = 0;
  let bytesAt270 = 0;
  let prepared = false;
  const crossings = [];
  const send = (path, turn) => {
    peakTokens = Math.max(peakTokens, tokens);
    if (tokens >= budget) {
      crossings.push({ turn, path, prepared });
      tokens = budget / 2;
      prepared = false;
    } else if (tokens >= budget * PREPARE_START_RATIO) {
      prepared = true;
    }
  };
  for (let turn = 1; turn <= turns; turn++) {
    const plan = planTurn({ turn, turns, forwardedTokens: tokens, conversationBytes: bytes,
      crossings: crossings.length, budget });
    tokens += 40; // the prompt
    send("human", turn);
    const chars = plan.texts.reduce((a, b) => a + b, 0);
    tokens += Math.ceil(chars / 2.7) + plan.images * 300;
    send("tool", turn);
    tokens += plan.answerTokens || 30;
    bytes += chars + plan.images * 105_000 + (plan.answerTokens || 30) * 2.7;
    if (turn === 270) bytesAt270 = bytes;
    if (plan.answerTokens) assert.equal(plan.answerTokens, LONG_ANSWER_TOKENS);
  }
  return { crossings, peakTokens, bytesAt270, finalBytes: bytes };
}

test("crossings: a blocking compress or a prepared prefix, main thread only", () => {
  const rec = (turnType, prepared, routeLane) => ({ kind: "messages", turnType, routeLane,
    ...(prepared ? { compaction: { prepared } } : {}) });
  assert.equal(crossingPath(rec("followup-compressed")), "human");
  assert.equal(crossingPath(rec("followup-prefix", "used", "main")), "human");
  assert.equal(crossingPath(rec("followup-prefix")), undefined, "riding an old prefix is no crossing");
  assert.equal(crossingPath(rec("tool-recompressed")), "tool");
  assert.equal(crossingPath(rec("tool-prefix", "truncated")), "tool");
  assert.equal(crossingPath(rec("tool-prefix", "stale")), undefined);
  assert.equal(crossingPath(rec("tool-recompressed", undefined, "agent")), undefined);
});

test("percentile is nearest-rank", () => {
  assert.equal(percentile([], 95), undefined);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
});

test("public output loses MemTree links, tree ids and keys", () => {
  const text = "see https://polychat-staging-1.run.app/m/AbCdEf12 and /usage/memtree/Zz9_xx00 key sk-123";
  const out = redactPublic(text, ["sk-123"]);
  assert.doesNotMatch(out, /AbCdEf12|Zz9_xx00|sk-123|run\.app/);
  const more = redactPublic("ccc --resume 87ddadb7-fa3f-4b65-8159-042b4c2eb45d by e2e-test-a@polychat.co");
  assert.equal(more, "ccc --resume <session-id> by <email>");
});

test("a claude_exit pairs with console_closed within 30 s", () => {
  const closed = { name: "console_closed", t: 1_000 };
  assert.equal(followsConsoleClose(closed, { t: 1_500 }), true);
  assert.equal(followsConsoleClose(closed, { t: 40_000 }), false);
  assert.equal(followsConsoleClose(closed, { t: 500 }), false);
  assert.equal(followsConsoleClose(undefined, { t: 1_500 }), false);
  assert.equal(followsConsoleClose({ name: "console_closed", batch: "b" }, { batch: "b" }), true);
});

test("evaluateRun passes a clean run and names each failure", () => {
  const good = cleanRun();
  const results = evaluateRun(good);
  const failed = results.filter((r) => r.status === FAIL);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.ok(results.some((r) => r.status === SKIP && /32 MiB/.test(r.name)));

  const bad = cleanRun();
  bad.relay.push({ kind: "memtree", path: "/v1/context_memory", indexOnly: true, status: 413,
    requestBytes: HTTP1_EDGE_BYTES + 10, ms: 900 });
  bad.relay.find((r) => r.finalIndex).status = undefined;
  bad.relay.push({ kind: "diagnostics", events: [{ name: "memtree_error", t: 9_500, status: 0 }] });
  const names = evaluateRun(bad).filter((r) => r.status === FAIL).map((r) => r.name);
  assert.deepEqual(names, ["MemTree bodies stay under 30 MiB and image refs are used",
    "no failed MemTree calls", "no 413 anywhere", "MemTree calls past 32 MiB succeed",
    "final index sent and accepted after the close", "no memtree_error at exit"]);
});

function cleanRun() {
  const call = (extra) => ({ kind: "memtree", path: "/v1/context_memory", status: 200, ms: 1_200,
    requestBytes: 17_000_000, indexOnly: false, imageRefs: 200, base64Images: 4, ...extra });
  return {
    reqlog: [
      { kind: "messages", turnType: "followup-degraded", upstreamStatus: 200,
        ts: new Date(3_000).toISOString(), compress: { ok: false, timedOut: false } },
      { kind: "messages", turnType: "followup-compressed", upstreamStatus: 200 },
      { kind: "messages", turnType: "tool-recompressed", upstreamStatus: 200 },
      { kind: "messages", turnType: "followup-prefix", upstreamStatus: 200 },
      { kind: "messages", turnType: "tool", upstreamStatus: 200, routeRecovery: { outcome: "cooldown" },
        ts: new Date(3_500).toISOString() },
      { kind: "messages", turnType: "tool", routeLane: "main", requestBytes: 33_000_000, upstreamStatus: 200 },
      { kind: "memtree", ok: true, ts: new Date(5_000).toISOString() },
    ],
    relay: [
      call({ compressed: true }), call({ compressed: true }), call({ compressed: false }),
      call({ indexOnly: true }), call({ status: 503, ms: 0, injected: true, at: 2_000 }),
      call({ prepare: true, status: 503, ms: 0, injected: true }), call({ prepare: true, ms: 40_000 }),
      call({ indexOnly: true, finalIndex: true, ms: 1_900, startedAt: 9_100 }),
      { kind: "diagnostics", events: [{ name: "console_closed", t: 9_000 },
        { name: "claude_exit", code: 1, t: 9_400 }] },
    ],
    mock: [{ kind: "messages", lane: "main", tokens: 905_000, status: 200 },
      { kind: "messages", lane: "main", step: "answer", tokens: 905_100, status: 200 }],
    run: { turns: 300, turnsDone: 300, injectCooldown: true, consoleClosed: true, closedAt: 9_000,
      serverSession: { finalTurnIndexed: true, detail: "ok" } },
  };
}

test("tool results: structured for every id, or flattened with each text file's tag", () => {
  const prompt = { turn: 9, files: ["t9-0.txt", "i9-0.png"] };
  const ids = ["toolu_a", "toolu_b"];
  const result = (id, extra = {}) => ({ type: "tool_result", tool_use_id: id, content: "x", ...extra });
  const body = (blocks) => ({ messages: [{ role: "user", content: blocks }] });
  const check = (b) => toolResultsIn(b, JSON.stringify(b), ids, prompt);
  assert.deepEqual(check(body([result("toolu_a"), result("toolu_b")])), { complete: true, seen: true, errors: 0 });
  assert.equal(check(body([result("toolu_a"), result("toolu_b", { is_error: true })])).errors, 1);
  assert.deepEqual(check(body([result("toolu_a")])), { complete: false, seen: true, errors: 0 });
  const toolUseOnly = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_a" }, { type: "tool_use", id: "toolu_b" }] }] };
  assert.equal(check(toolUseOnly).complete, false, "a tool_use alone is no result");
  const flat = (text) => ({ messages: [{ role: "user", content: `⟦conversation_record⟧ ${text}` }] });
  const flatOk = "→ result: T9.0 00001 river (tool_use_id=toolu_a)\n→ result: [image] (tool_use_id=toolu_b)";
  assert.deepEqual(check(flat(flatOk)), { complete: true, seen: true, errors: 0 });
  assert.equal(check(flat("toolu_a toolu_b T9.0 ")).complete, false, "ids in tool_use JSON are no results");
  assert.equal(check(flat("→ result: T9.0 x (tool_use_id=toolu_a) toolu_b")).complete, false,
    "the image's result must be there too");
  assert.equal(check(flat("→ result: [image] (tool_use_id=toolu_a)\n→ result: y (tool_use_id=toolu_b)")).complete,
    false, "the text file's lines must be there");
  assert.equal(check(flat(flatOk.replace("→ result: [image]", "→ result (error): no such file"))).errors, 1);
  assert.equal(check(flat("T9.0 contents (tool_use_id=toolu_a) (tool_use_id=toolu_b)")).complete, false,
    "bare suffixes are no results");
  assert.equal(check(flat("→ result: T9.0 x (tool_use_id=toolu_a) (tool_use_id=toolu_b)")).complete, false,
    "one result followed by an orphan suffix covers one id");
  assert.equal(check(flat("→ result (error): gone (tool_use_id=toolu_a)\n→ result: T9.0 x (tool_use_id=toolu_b)")).errors,
    1, "the error prefix belongs to its own entry");
  assert.deepEqual(toolResultsIn(body([]), "", [], prompt), { complete: false, seen: false, errors: 0 });
});

test("bodies: under 30 MiB with image refs; failing either names the check", () => {
  const name = "MemTree bodies stay under 30 MiB and image refs are used";
  const status = (run) => evaluateRun(run).find((r) => r.name === name).status;
  assert.equal(status(cleanRun()), PASS);
  const big = cleanRun();
  big.relay[0].requestBytes = 31_500_000;
  assert.equal(status(big), FAIL);
  const noRefs = cleanRun();
  for (const r of noRefs.relay) if (r.kind === "memtree") r.imageRefs = 0;
  assert.equal(status(noRefs), FAIL);
  const small = cleanRun();
  small.reqlog.find((r) => r.requestBytes).requestBytes = 12_000_000;
  assert.equal(status(small), FAIL, "a small conversation proves nothing about refs");
});

test("degraded turns: only the injected turn's record is excused", () => {
  const name = "no degraded or timed-out compressions";
  const status = (run) => evaluateRun(run).find((r) => r.name === name).status;
  const other = cleanRun();
  other.reqlog[0].ts = new Date(500_000).toISOString(); // long after the injection
  assert.equal(status(other), FAIL);
  const timedOut = cleanRun();
  timedOut.reqlog.push({ kind: "messages", turnType: "followup-compressed", ts: new Date(4_000).toISOString(),
    compress: { ok: true, timedOut: true } });
  assert.equal(status(timedOut), FAIL);
  const cut = cleanRun();
  cut.relay.push({ kind: "memtree", path: "/v1/context_memory", indexOnly: true, error: "client closed", at: 9_500 });
  const failed = evaluateRun(cut).find((r) => r.name === "no failed MemTree calls");
  assert.equal(failed.status, PASS, "a call the shutdown cut is judged by the exit checks");
});

test("crossings need both paths; injected prepares are not the cooldown's failure", () => {
  const humanOnly = cleanRun();
  humanOnly.reqlog = humanOnly.reqlog.filter((r) => r.turnType !== "tool-recompressed");
  humanOnly.reqlog.push({ kind: "messages", turnType: "tool-prefix", compaction: { prepared: "stale" } });
  const both = evaluateRun(humanOnly).find((r) => /both paths/.test(r.name));
  assert.equal(both.status, FAIL);
  const twoInjected = cleanRun();
  twoInjected.relay.push({ kind: "memtree", path: "/v1/context_memory", status: 503, injected: true });
  const cooldown = evaluateRun(twoInjected).find((r) => /cooldown/.test(r.name));
  assert.equal(cooldown.status, FAIL);
  const elsewhere = cleanRun();
  const cool = elsewhere.reqlog.find((r) => r.routeRecovery);
  cool.routeLane = "agent";
  assert.equal(evaluateRun(elsewhere).find((r) => /cooldown/.test(r.name)).status, FAIL,
    "a cooldown on another lane is not the injected one");
  cool.routeLane = "main";
  cool.ts = new Date(1_000).toISOString();
  assert.equal(evaluateRun(elsewhere).find((r) => /cooldown/.test(r.name)).status, FAIL,
    "a cooldown before the injected failure is not its own");
  const drained = cleanRun();
  drained.reqlog.push({ kind: "memtree", ok: false, callerAborted: true, ts: new Date(9_600).toISOString() });
  assert.equal(evaluateRun(drained).find((r) => /memtree_error at exit/.test(r.name)).status, PASS,
    "a drained background call is no exit failure");
  drained.reqlog.push({ kind: "memtree", ok: false, exitCut: true, finalIndex: true, ts: new Date(9_700).toISOString() });
  assert.equal(evaluateRun(drained).find((r) => /memtree_error at exit/.test(r.name)).status, FAIL);
  const latency = evaluateRun(cleanRun()).find((r) => /latency/.test(r.name));
  assert.equal(latency.status, PASS, "a 40 s background prepare call is not a blocking compress");
});

test("refusal details never carry the lane (it names the session)", () => {
  const run = cleanRun();
  run.reqlog.push({ kind: "messages", turnType: "tool", upstreamStatus: undefined,
    refusal: { lane: "[\"87ddadb7-fa3f-4b65-8159-042b4c2eb45d\",\"main\"]", status: 400, inputTokens: 5 } });
  const row = evaluateRun(run).find((r) => r.name === "no failed or refused Anthropic requests");
  assert.equal(row.status, FAIL);
  assert.doesNotMatch(row.detail, /87ddadb7|lane/);
  assert.match(row.detail, /"status":400/);
});

test("a final index that started before the close does not count", () => {
  const run = cleanRun();
  run.relay.find((r) => r.finalIndex).startedAt = 8_900; // closedAt 9_000
  const row = evaluateRun(run).find((r) => r.name === "final index sent and accepted after the close");
  assert.equal(row.status, FAIL);
});
