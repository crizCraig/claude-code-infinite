// Anthropic's 429/529 told apart (rate-limit.ts): the plan's usage limit vs busy, the
// line ccc says for each, when it says it, and the proxy passing the response through.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUSY_AFTER_NOTICE,
  BUSY_NOTICE,
  UNKNOWN_RESET_TTL_MS,
  PLAN_LIMIT_NOTICE,
  RateLimitNotices,
  localResetTime,
  rateLimitFromResponse,
  rateLimitNoticeText,
} from "../dist/rate-limit.js";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { Diagnostics, DiagnosticsRequestSink } from "../dist/diagnostics.js";
import { sanitizeEvent } from "../dist/diagnostics-schema.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const RESET_S = NOW / 1000 + 3 * 3600;
const planHeaders = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-reset": String(RESET_S),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
};

test("a 429 the plan's limiter rejected is the plan limit, with its reset", () => {
  assert.deepEqual(rateLimitFromResponse(429, planHeaders, NOW),
    { kind: "plan_limit", status: 429, resetsAt: RESET_S * 1000 });
  // No reset header: retry-after (seconds) stands in; neither: unknown.
  const noReset = { "anthropic-ratelimit-unified-status": "rejected", "retry-after": "60" };
  assert.equal(rateLimitFromResponse(429, noReset, NOW).resetsAt, NOW + 60_000);
  assert.equal(rateLimitFromResponse(429, { "anthropic-ratelimit-unified-status": "rejected" },
    NOW).resetsAt, undefined);
});

test("529 and any other 429 are busy; other statuses are not rate limits", () => {
  assert.deepEqual(rateLimitFromResponse(529, {}, NOW), { kind: "busy", status: 529 });
  // An API key's rate limit, or the limiter allowed (another limit refused it).
  assert.equal(rateLimitFromResponse(429, { "retry-after": "5" }, NOW).kind, "busy");
  assert.equal(rateLimitFromResponse(429,
    { "anthropic-ratelimit-unified-status": "allowed" }, NOW).kind, "busy");
  for (const status of [200, 400, 401, 500, 503, undefined]) {
    assert.equal(rateLimitFromResponse(status, planHeaders, NOW), null, String(status));
  }
});

test("the lines: busy; the plan limit with its local reset time when it is ahead", () => {
  const at = () => "3:00 PM";
  assert.equal(rateLimitNoticeText({ kind: "busy", status: 529 }, NOW, at),
    "Anthropic is busy; Claude Code will retry.");
  assert.equal(rateLimitNoticeText({ kind: "plan_limit", status: 429, resetsAt: NOW + 1 }, NOW, at),
    "You've hit your Claude plan's usage limit. It resets at 3:00 PM.");
  assert.equal(rateLimitNoticeText({ kind: "plan_limit", status: 429 }, NOW, at), PLAN_LIMIT_NOTICE);
  assert.equal(rateLimitNoticeText({ kind: "plan_limit", status: 429, resetsAt: NOW }, NOW, at),
    PLAN_LIMIT_NOTICE);
});

test("the reset time is local: no weekday today, a weekday on another day", () => {
  const today = new Date(NOW);
  today.setHours(23, 59, 0, 0);
  const sameDay = localResetTime(today.getTime(), today.getTime() - 60_000);
  assert.match(sameDay, /\d/);
  assert.doesNotMatch(sameDay, /Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  const later = localResetTime(NOW + 3 * 86_400_000, NOW);
  assert.notEqual(later, localResetTime(NOW + 3 * 86_400_000, NOW + 3 * 86_400_000));
});

test("notices: plan limit on every prompt until it resets; busy once; an answer clears both", () => {
  let now = NOW;
  const notices = new RateLimitNotices(() => now);
  assert.equal(notices.promptLine(), undefined);
  const plan = { kind: "plan_limit", status: 429, resetsAt: NOW + 3_600_000 };
  assert.equal(notices.observe(plan), true, "a new episode is said now (print runs)");
  assert.equal(notices.observe({ ...plan }), false, "the same limit again is not");
  assert.match(notices.promptLine(), /^You've hit your Claude plan's usage limit\. It resets at /);
  assert.match(notices.promptLine(), /usage limit/, "every prompt while it lasts");
  assert.match(notices.exitLine(), /usage limit/);
  now = NOW + 3_600_000;
  assert.equal(notices.promptLine(), undefined, "reset passed");
  assert.equal(notices.exitLine(), undefined);

  assert.equal(notices.observe({ kind: "busy", status: 529 }), true);
  // After the fact Claude Code's retries are over: no "will retry".
  assert.equal(notices.promptLine(), BUSY_AFTER_NOTICE);
  assert.equal(notices.promptLine(), undefined, "busy is said once per episode");
  assert.equal(notices.exitLine(), "Anthropic was busy; try again in a moment.");
  // A request that reached ccc before the refusal (a subagent's) proves nothing.
  notices.answered(now - 1);
  assert.equal(notices.exitLine(), BUSY_AFTER_NOTICE);
  notices.answered(now);
  assert.equal(notices.exitLine(), undefined);
  assert.equal(notices.observe({ kind: "busy", status: 429 }), true, "a new episode after an answer");
});

test("notices: one plan limit per reset minute; no reset time is forgotten after 5 hours", () => {
  let now = NOW;
  const notices = new RateLimitNotices(() => now);
  // retry-after counts down per refusal: the same limit, said once.
  assert.equal(notices.observe({ kind: "plan_limit", status: 429, resetsAt: NOW + 600_000 }), true);
  now += 2000;
  assert.equal(notices.observe({ kind: "plan_limit", status: 429, resetsAt: NOW + 601_000 }), false);
  assert.equal(notices.observe({ kind: "plan_limit", status: 429, resetsAt: NOW + 3_600_000 }), true);
  notices.answered();
  notices.observe({ kind: "plan_limit", status: 429 });
  assert.equal(notices.promptLine(), PLAN_LIMIT_NOTICE);
  now += UNKNOWN_RESET_TTL_MS;
  assert.equal(notices.promptLine(), undefined);
});

test("the tee: a turn's 429/529 calls back and is recorded; side requests are not", async () => {
  const sent = [];
  const diagnostics = new Diagnostics({
    baseUrl: "https://api.example.test/", configDir: mkdtempSync(join(tmpdir(), "ccc-rl-")),
    clientName: "cc-infinite", clientVersion: "1.0.30", env: {}, config: {},
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; },
    now: () => NOW,
  });
  const seen = [];
  let answered = 0;
  const startedAts = [];
  const sink = new DiagnosticsRequestSink(undefined, diagnostics, undefined, undefined,
    (startedAt) => { answered += 1; startedAts.push(startedAt); }, (info) => seen.push(info.kind));
  const rec = (over) => ({ kind: "messages", turnType: "first-user", requestBytes: 10, ...over });
  sink.log(rec({ upstreamStatus: 429, rateLimit: { kind: "plan_limit", status: 429, resetsAt: 1 } }));
  sink.log(rec({ upstreamStatus: 529, turnType: "side-request",
                 rateLimit: { kind: "busy", status: 529 } }));
  sink.log(rec({ upstreamStatus: 529, turnType: "tool", rateLimit: { kind: "busy", status: 529 } }));
  const before = Date.now();
  sink.log(rec({ upstreamStatus: 200, totalMs: 60_000 }));
  await diagnostics.flush(1000);
  assert.deepEqual(seen, ["plan_limit", "busy"]);
  assert.equal(answered, 1);
  // When that request reached ccc: now minus its total time.
  assert.ok(startedAts[0] <= Date.now() - 60_000 && startedAts[0] >= before - 60_000);
  const events = sent.flatMap((b) => b.events).filter((e) => e.name === "rate_limit");
  assert.deepEqual(events.map((e) => [e.kind, e.status]), [["plan_limit", 429], ["busy", 529]]);
  assert.equal(sanitizeEvent("rate_limit", { kind: "other", status: 429 }, 1).kind, undefined);
});

test("proxy: a 429 reaches Claude Code unchanged, and the record carries its kind", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } });
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7",
        "x-should-retry": "false", ...planHeaders });
      res.end(body);
    });
  });
  const records = [];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    reqlog: { log: (r) => records.push(structuredClone(r)) },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 8,
        messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7", "Claude Code's retry signals pass through");
    assert.equal(res.headers.get("x-should-retry"), "false");
    assert.equal(res.headers.get("anthropic-ratelimit-unified-reset"), String(RESET_S));
    assert.equal(await res.text(), body);
    const rec = records.find((r) => r.kind === "messages" && r.upstreamStatus === 429);
    assert.deepEqual(rec?.rateLimit, { kind: "plan_limit", status: 429, resetsAt: RESET_S * 1000 });
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("proxy: UserPromptSubmit shows the prompt notice to main sessions only, never throws", async () => {
  const upstream = await listen((req, res) => res.end());
  const lines = ["You've hit your Claude plan's usage limit.", undefined];
  const proxy = await startProxy({
    memtree: new MemtreeClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    promptSubmitNotice: () => lines.shift(),
  });
  const throwing = await startProxy({
    memtree: new MemtreeClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k" }),
    upstreamOrigin: upstream.origin,
    promptSubmitNotice: () => { throw new Error("boom"); },
  });
  const prompt = { hook_event_name: "UserPromptSubmit", prompt: "hi", prompt_id: "p1" };
  try {
    assert.equal((await postHook(proxy, { ...prompt, agent_id: "a1" })).status, 204);
    const first = await postHook(proxy, prompt);
    assert.deepEqual(first.body, { systemMessage: "You've hit your Claude plan's usage limit." });
    assert.equal((await postHook(proxy, { ...prompt, prompt_id: "p2" })).status, 204);
    assert.equal((await postHook(throwing, prompt)).status, 204);
  } finally {
    proxy.close();
    throwing.close();
    upstream.close();
  }
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => server.close(),
    }));
  });
}

async function postHook(proxy, input) {
  const res = await fetch(proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "session-1", ...input }),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
