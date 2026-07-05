#!/usr/bin/env node
/**
 * ccc smoke tests with REAL `claude -p` sessions through the local proxy
 * (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md §Tests/smoke).
 *
 *   node scripts/smoke/run.mjs [a] [b] [c] [d] [e]   (default: all)
 *
 * a — first user turn: index_only call + byte-verbatim non-flattened body
 * b — two-user-turn conversation: exactly one blocking compression on turn 2
 * c — degraded alert visible, transcript scrubbed in place, resume clean
 * d — ✨ slow-first-token prelude (mock Anthropic with an 11.5s stall)
 * e — thinking-turn round-trip: inject → strip → Anthropic accepts replay
 *
 * a/b/c/e talk to real api.anthropic.com with Claude Code's own credentials
 * (small haiku calls). d uses a mock Anthropic upstream.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { startProxy, MemtreeClient } from "../../dist/index.js";
import {
  projectTranscriptDir,
  startTranscriptScrubber,
  sweepTranscripts,
} from "../../dist/scrub.js";
import { NOTICE_OPEN, wrapNotice } from "../../dist/notices.js";
import { startMockMemtree, startMockAnthropic, startRecorder } from "./servers.mjs";

const MODEL_ARGS = ["--model", "haiku"];
const failures = [];

function check(scenario, name, cond, extra = "") {
  const status = cond ? "PASS" : "FAIL";
  console.log(`  [${status}] ${scenario}: ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failures.push(`${scenario}: ${name} ${extra}`);
}

async function setup(scenario, { failCompress = false, upstreamOrigin } = {}) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), `ccc-smoke-${scenario}-`));
  const captureDir = path.join(cwd, ".captures");
  const memtreeServer = await startMockMemtree({ failCompress });
  const memtree = new MemtreeClient({
    baseUrl: `http://127.0.0.1:${memtreeServer.port}`,
    apiKey: "smoke-key",
    debug: true,
  });
  const proxy = await startProxy({ memtree, debug: true, captureDir, upstreamOrigin });
  const recorder = await startRecorder(proxy.port);
  const transcriptDir = projectTranscriptDir(cwd);
  await sweepTranscripts(transcriptDir);
  const scrubber = startTranscriptScrubber(transcriptDir, { debug: true });
  return {
    cwd,
    captureDir,
    memtreeServer,
    proxy,
    recorder,
    transcriptDir,
    scrubber,
    cleanup: async () => {
      scrubber.close();
      recorder.close();
      proxy.close();
      memtreeServer.close();
      await fsp.rm(cwd, { recursive: true, force: true });
    },
  };
}

function runClaude(ctx, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", ...MODEL_ARGS, ...args],
      {
        cwd: ctx.cwd,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.recorder.port}`,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        const parsed = JSON.parse(stdout);
        json = Array.isArray(parsed) ? parsed.find((e) => e?.type === "result") : parsed;
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readTranscripts(dir) {
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {}
  const files = {};
  for (const n of names) files[n] = await fsp.readFile(path.join(dir, n), "utf-8");
  return files;
}

async function readCaptures(dir) {
  let names = [];
  try {
    names = (await fsp.readdir(dir)).sort();
  } catch {}
  const out = [];
  for (const n of names) out.push({ name: n, body: await fsp.readFile(path.join(dir, n)) });
  return out;
}

// --------------------------------------------------------------------------
// (a) First user turn: background index_only, byte-verbatim forward
// --------------------------------------------------------------------------
async function scenarioA() {
  console.log("\n=== scenario a: first user turn is non-blocking and verbatim ===");
  const ctx = await setup("a");
  try {
    const sid = randomUUID();
    const r = await runClaude(ctx, ["--session-id", sid, "Reply with exactly: pong"]);
    await sleep(1500); // let background index calls land
    check("a", "claude exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.slice(0, 300)}`);
    check("a", "answer received", /pong/i.test(r.json?.result ?? ""), r.json?.result);

    const calls = ctx.memtreeServer.calls;
    check("a", "MemTree got at least one call", calls.length >= 1);
    check(
      "a",
      "ALL MemTree calls are index_only (no blocking compression)",
      calls.every((c) => c.indexOnly),
      `non-index calls: ${calls.filter((c) => !c.indexOnly).length}`
    );
    const mainIndexed = calls.some((c) => JSON.stringify(c.messages).includes("Reply with exactly: pong"));
    check("a", "main conversation fed the index", mainIndexed);

    const captures = await readCaptures(ctx.captureDir);
    const recordedSet = new Set(ctx.recorder.recorded.map((r2) => r2.body.toString("utf-8")));
    check("a", "proxy forwarded at least one /v1/messages body", captures.length >= 1);
    check(
      "a",
      "every forwarded body is byte-verbatim what Claude Code sent",
      captures.every((c) => recordedSet.has(c.body.toString("utf-8"))),
      "forwarded body not found among recorded client bodies"
    );
    const main = captures.find((c) => c.body.includes("Reply with exactly: pong"));
    check("a", "main body not flattened (messages structure preserved)", (() => {
      if (!main) return false;
      const body = JSON.parse(main.body.toString("utf-8"));
      return Array.isArray(body.messages) && !JSON.stringify(body.messages).includes("MEMTREE_COMPRESSED_SENTINEL");
    })());
  } finally {
    await ctx.cleanup();
  }
}

// --------------------------------------------------------------------------
// (b) Followup user turn: exactly one blocking compression on turn two
// --------------------------------------------------------------------------
async function scenarioB() {
  console.log("\n=== scenario b: followup user turn compresses exactly once ===");
  const ctx = await setup("b");
  try {
    const sid = randomUUID();
    const r1 = await runClaude(ctx, ["--session-id", sid, "My favorite color is teal. Reply with exactly: OK"]);
    await sleep(1000);
    check("b", "turn 1 exits 0", r1.code === 0, r1.stderr.slice(0, 300));
    const nonIndexAfterTurn1 = ctx.memtreeServer.calls.filter((c) => !c.indexOnly).length;
    check("b", "turn 1 made zero blocking compression calls", nonIndexAfterTurn1 === 0, `got ${nonIndexAfterTurn1}`);

    const r2 = await runClaude(ctx, ["--resume", sid, "What is my favorite color? Answer with the color name only."]);
    await sleep(1500);
    check("b", "turn 2 exits 0", r2.code === 0, r2.stderr.slice(0, 300));

    const compressCalls = ctx.memtreeServer.calls.filter(
      (c) => !c.indexOnly && JSON.stringify(c.messages).includes("favorite color")
    );
    check("b", "exactly one blocking compression for the conversation", compressCalls.length === 1, `got ${compressCalls.length}`);
    check(
      "b",
      "compression call saw both user turns",
      compressCalls.length === 1 &&
        JSON.stringify(compressCalls[0].messages).includes("What is my favorite color"),
    );
    check(
      "b",
      "answer used the COMPRESSED context (teal recalled via mock memory)",
      /teal/i.test(r2.json?.result ?? ""),
      r2.json?.result
    );
    const captures = await readCaptures(ctx.captureDir);
    const flattened = captures.filter((c) => c.body.includes("MEMTREE_COMPRESSED_SENTINEL"));
    check("b", "turn 2 forwarded the flattened compressed body", flattened.length === 1, `got ${flattened.length}`);
  } finally {
    await ctx.cleanup();
  }
}

// --------------------------------------------------------------------------
// (c) Degraded alert: visible inline, scrubbed from transcript, clean resume
// --------------------------------------------------------------------------
async function scenarioC() {
  console.log("\n=== scenario c: degraded alert + transcript scrub + resume ===");
  const ctx = await setup("c", { failCompress: true });
  try {
    const sid = randomUUID();
    const r1 = await runClaude(ctx, ["--session-id", sid, "Reply with exactly: READY"]);
    check("c", "turn 1 exits 0", r1.code === 0, r1.stderr.slice(0, 300));

    const r2 = await runClaude(ctx, ["--resume", sid, "Reply with exactly: DONE"]);
    check("c", "turn 2 (degraded) exits 0", r2.code === 0, r2.stderr.slice(0, 300));
    // .result is only the LAST text block (= the appended notice on degraded
    // turns), so scan the full event stream for the real answer.
    check("c", "turn 2 still answered (passthrough)", /DONE/i.test(r2.stdout), r2.json?.result);
    check(
      "c",
      "degraded notice visible in turn 2 output",
      r2.stdout.includes("MemTree degraded"),
      `result=${JSON.stringify(r2.json?.result ?? "").slice(0, 300)}`
    );
    const turn2Session = r2.json?.session_id;
    check("c", "turn 2 reported a session id", Boolean(turn2Session));

    // Watcher scrubs within moments of CC writing the line.
    let transcripts = {};
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      transcripts = await readTranscripts(ctx.transcriptDir);
      const all = Object.values(transcripts).join("");
      if (all.length && !all.includes(NOTICE_OPEN)) break;
      await sleep(100);
    }
    const all = Object.values(transcripts).join("");
    check("c", "transcripts contain no notice marker after scrub", all.length > 0 && !all.includes(NOTICE_OPEN));
    check(
      "c",
      "scrubbed line is space-padded in place (length preserved)",
      Object.values(transcripts).some((t) => / +\n/.test(t) || / +$/.test(t)),
      "no padded line found"
    );
    const paddedFile = Object.entries(transcripts).find(([, t]) => / +\n/.test(t) || / +$/.test(t));
    if (paddedFile) {
      const lines = paddedFile[1].split("\n").filter((l) => l.trim());
      check("c", "all scrubbed transcript lines still parse as JSON", lines.every((l) => {
        try { JSON.parse(l); return true; } catch { return false; }
      }));
    }

    // Resume from the scrubbed, padded transcript (vanilla-style --resume).
    const r3 = await runClaude(ctx, ["--resume", turn2Session ?? sid, "Reply with exactly: FINAL"]);
    check("c", "resume from scrubbed+padded transcript exits 0", r3.code === 0, r3.stderr.slice(0, 300));
    check("c", "resumed turn answered", /FINAL/i.test(r3.stdout), r3.json?.result);
    await sleep(1500);

    // Strip pass: nothing the proxy forwarded or indexed may contain the marker.
    const captures = await readCaptures(ctx.captureDir);
    check(
      "c",
      "no forwarded Anthropic body contains the notice marker",
      captures.every((c) => !c.body.includes(NOTICE_OPEN))
    );
    check(
      "c",
      "no MemTree call contains the notice marker",
      ctx.memtreeServer.calls.every((c) => !JSON.stringify(c.messages).includes(NOTICE_OPEN))
    );
  } finally {
    await ctx.cleanup();
  }
}

// --------------------------------------------------------------------------
// (d) ✨ slow-first-token prelude via mock Anthropic with an 11.5s stall
// --------------------------------------------------------------------------
async function scenarioD() {
  console.log("\n=== scenario d: ✨ prelude on slow first token (mock upstream) ===");
  const anthropicMock = await startMockAnthropic({
    stallOn: "MEMTREE_COMPRESSED_SENTINEL",
    answer: "MOCK_ANSWER_OK",
  });
  const ctx = await setup("d", { upstreamOrigin: `http://127.0.0.1:${anthropicMock.port}` });
  try {
    const sid = randomUUID();
    const r1 = await runClaude(ctx, ["--session-id", sid, "Turn one. Reply briefly."]);
    check("d", "turn 1 exits 0 against mock upstream", r1.code === 0, r1.stderr.slice(0, 300));

    // Turn 2 compresses (mock memtree OK) → forwarded body carries the
    // sentinel → mock upstream stalls 11.5s → proxy fabricates the prelude.
    const r2 = await runClaude(ctx, ["--resume", sid, "Turn two. Reply briefly."]);
    check("d", "turn 2 exits 0", r2.code === 0, r2.stderr.slice(0, 300));
    check("d", "✨ notice text present in output", r2.stdout.includes("Something special is happening"), r2.stdout.slice(0, 300));
    check("d", "upstream answer still streamed in after the prelude", r2.stdout.includes("MOCK_ANSWER_OK"), (r2.json?.result ?? "").slice(0, 300));

    // The notice is scrubbed from the transcript like any other.
    let transcripts = {};
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      transcripts = await readTranscripts(ctx.transcriptDir);
      const all = Object.values(transcripts).join("");
      if (all.length && !all.includes(NOTICE_OPEN)) break;
      await sleep(100);
    }
    const all = Object.values(transcripts).join("");
    check("d", "✨ notice scrubbed from transcript", all.length > 0 && !all.includes(NOTICE_OPEN));
  } finally {
    await ctx.cleanup();
    anthropicMock.close();
  }
}

// --------------------------------------------------------------------------
// (e) Thinking-turn round-trip: inject → strip → Anthropic accepts replay
// --------------------------------------------------------------------------
async function scenarioE() {
  console.log("\n=== scenario e: thinking round-trip through inject→strip ===");
  const ctx = await setup("e", { failCompress: true }); // degraded path keeps history intact
  try {
    const sid = randomUUID();
    const r1 = await runClaude(
      ctx,
      ["--session-id", sid, "Think briefly about why the sky is blue, then reply with exactly: THOUGHT"],
      { MAX_THINKING_TOKENS: "1024" }
    );
    check("e", "thinking turn exits 0", r1.code === 0, r1.stderr.slice(0, 300));

    // Pull the signed thinking + text blocks out of the transcript.
    const transcripts = await readTranscripts(ctx.transcriptDir);
    const blocks = [];
    for (const content of Object.values(transcripts)) {
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
          blocks.push(...obj.message.content);
        }
      }
    }
    const thinking = blocks.find((b) => b.type === "thinking" && b.signature);
    const text = blocks.find((b) => b.type === "text");
    check("e", "turn produced a signed thinking block", Boolean(thinking), "MAX_THINKING_TOKENS had no effect?");
    if (!thinking) return;

    // Recorded main request gives us CC's own body shape + auth fingerprint.
    const recorded = ctx.recorder.recorded.find((r) => r.body.includes("why the sky is blue"));
    check("e", "recorded the original request", Boolean(recorded));
    const origBody = JSON.parse(recorded.body.toString("utf-8"));

    // Worst-case replay: the ✨ prelude puts the notice BEFORE the thinking
    // block. Send it through the proxy — the strip pass must restore the
    // history to byte-identical so Anthropic honors the signature.
    const crafted = {
      ...origBody,
      stream: false,
      messages: [
        ...origBody.messages,
        {
          role: "assistant",
          content: [
            { type: "text", text: wrapNotice("✨ Something special is happening — please wait…") },
            thinking,
            text ?? { type: "text", text: "THOUGHT" },
          ],
        },
        { role: "user", content: "Reply with exactly: ROUNDTRIP" },
      ],
    };
    const headers = { ...ctx.recorder.state.lastMessagesHeaders };
    delete headers["host"];
    delete headers["content-length"];
    delete headers["connection"];

    const send = async (host, port, useTls) => {
      const mod = useTls ? https : (await import("node:http")).default;
      return new Promise((resolve) => {
        const req = mod.request(
          { host, port, method: "POST", path: ctx.recorder.state.lastMessagesUrl, headers },
          (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          }
        );
        req.on("error", (e) => resolve({ status: 0, body: String(e) }));
        req.end(JSON.stringify(crafted));
      });
    };

    const viaProxy = await send("127.0.0.1", ctx.proxy.port, false);
    check(
      "e",
      "replayed thinking history ACCEPTED after strip (via proxy)",
      viaProxy.status === 200,
      `status=${viaProxy.status} body=${viaProxy.body.slice(0, 300)}`
    );
    check(
      "e",
      "degraded notice appended to the non-streaming JSON response",
      viaProxy.body.includes("MemTree degraded"),
    );
    await sleep(1000);
    check(
      "e",
      "MemTree calls for the crafted turn are notice-free",
      ctx.memtreeServer.calls.every((c) => !JSON.stringify(c.messages).includes(NOTICE_OPEN))
    );
    const captures = await readCaptures(ctx.captureDir);
    const craftedCapture = captures.find((c) => c.body.includes("ROUNDTRIP"));
    check("e", "forwarded crafted body kept the signed thinking block", Boolean(craftedCapture) && craftedCapture.body.includes('"signature"'));
    check("e", "forwarded crafted body is notice-free", Boolean(craftedCapture) && !craftedCapture.body.includes(NOTICE_OPEN));

    // Negative control: the SAME body sent to Anthropic directly (no strip)
    // documents the vanilla-resume failure the scrubber exists to prevent.
    const direct = await send("api.anthropic.com", 443, true);
    console.log(`  [info] e: unstripped direct replay → status=${direct.status} ${direct.body.slice(0, 200)}`);
  } finally {
    await ctx.cleanup();
  }
}

const scenarios = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE };
const requested = process.argv.slice(2).filter((s) => scenarios[s]);
const toRun = requested.length ? requested : Object.keys(scenarios);

for (const name of toRun) {
  await scenarios[name]();
}

console.log(`\n${failures.length === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures.length} FAILURE(S):`}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
