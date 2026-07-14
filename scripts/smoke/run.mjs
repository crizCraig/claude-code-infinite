#!/usr/bin/env node
/**
 * ccc smoke tests with REAL `claude -p` sessions through the local proxy
 * (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md §Tests/smoke).
 *
 *   node scripts/smoke/run.mjs [a] [b] [c] [d] [e]   (default: all)
 *
 * a — first user turn: index_only call + byte-verbatim non-flattened body
 * b — two-user-turn conversation: exactly one blocking compression on turn 2
 * c — degraded display hook, clean transcript, resume clean
 * d — stalled upstream stays byte-transparent (no fabricated prelude)
 * e — legacy marker cleanup: strip → Anthropic accepts thinking replay
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
import {
  startProxy,
  MemtreeClient,
  terminalSupportsColor,
} from "../../dist/index.js";
import { projectTranscriptDir, startTranscriptScrubber } from "../../dist/scrub.js";
import {
  COMPRESSED_NOTICE,
  NOTICE_OPEN,
  wrapNotice,
} from "../../dist/notices.js";
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

async function postHook(ctx, input) {
  const res = await fetch(ctx.proxy.hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "smoke-session", ...input }),
  });
  return res.status === 204 ? null : res.json();
}

async function armNotice(ctx, prompt, promptId) {
  await postHook(ctx, {
    hook_event_name: "UserPromptSubmit",
    prompt,
    prompt_id: promptId,
  });
}

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

    const prompt = "What is my favorite color? Answer with the color name only.";
    await armNotice(ctx, prompt, "smoke-b-turn2");
    const r2 = await runClaude(ctx, ["--resume", sid, prompt]);
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
    check("b", "-p result contains no UI notice", !r2.stdout.includes(COMPRESSED_NOTICE));
    const hook = await postHook(ctx, {
      hook_event_name: "MessageDisplay",
      turn_id: "smoke-b",
      message_id: "smoke-b-message",
      index: 0,
      final: true,
      delta: "teal",
      prompt_id: "smoke-b-turn2",
    });
    check(
      "b",
      "MessageDisplay returns a color-capable, timed display-only compression prefix",
      hook?.hookSpecificOutput?.displayContent?.startsWith(
        `${terminalSupportsColor() ? "\x1b[32m" : ""}${COMPRESSED_NOTICE} in `
      ) &&
        (terminalSupportsColor()
          ? hook.hookSpecificOutput.displayContent.includes("\x1b[39m")
          : !hook.hookSpecificOutput.displayContent.includes("\x1b[")),
      JSON.stringify(hook)
    );
    const captures = await readCaptures(ctx.captureDir);
    const flattened = captures.filter((c) => c.body.includes("MEMTREE_COMPRESSED_SENTINEL"));
    check("b", "turn 2 forwarded the flattened compressed body", flattened.length === 1, `got ${flattened.length}`);
  } finally {
    await ctx.cleanup();
  }
}

// --------------------------------------------------------------------------
// (c) Degraded display hook: API/print/transcript remain clean, resume works
// --------------------------------------------------------------------------
async function scenarioC() {
  console.log("\n=== scenario c: degraded display hook + clean resume ===");
  const ctx = await setup("c", { failCompress: true });
  try {
    const sid = randomUUID();
    const r1 = await runClaude(ctx, ["--session-id", sid, "Reply with exactly: READY"]);
    check("c", "turn 1 exits 0", r1.code === 0, r1.stderr.slice(0, 300));

    const prompt = "Reply with exactly: DONE";
    await armNotice(ctx, prompt, "smoke-c-turn2");
    const r2 = await runClaude(ctx, ["--resume", sid, prompt]);
    check("c", "turn 2 (degraded) exits 0", r2.code === 0, r2.stderr.slice(0, 300));
    check("c", "turn 2 still answered (passthrough)", /DONE/i.test(r2.stdout), r2.json?.result);
    check("c", "-p output contains no degraded UI notice", !r2.stdout.includes("MemTree degraded"));
    const hook = await postHook(ctx, {
      hook_event_name: "MessageDisplay",
      turn_id: "smoke-c",
      message_id: "smoke-c-message",
      index: 0,
      final: true,
      delta: "DONE",
      prompt_id: "smoke-c-turn2",
    });
    check("c", "degraded warning is returned only by display hook",
      hook?.hookSpecificOutput?.displayContent?.includes("MemTree degraded"), JSON.stringify(hook));
    const turn2Session = r2.json?.session_id;
    check("c", "turn 2 reported a session id", Boolean(turn2Session));

    // Display hooks never add assistant marker blocks to the transcript.
    let transcripts = {};
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      transcripts = await readTranscripts(ctx.transcriptDir);
      const all = Object.values(transcripts).join("");
      if (all.length && !all.includes(NOTICE_OPEN)) break;
      await sleep(100);
    }
    const all = Object.values(transcripts).join("");
    check("c", "transcripts contain no notice marker", all.length > 0 && !all.includes(NOTICE_OPEN));

    // Resume from the clean transcript (vanilla-style --resume).
    const r3 = await runClaude(ctx, ["--resume", turn2Session ?? sid, "Reply with exactly: FINAL"]);
    check("c", "resume from clean transcript exits 0", r3.code === 0, r3.stderr.slice(0, 300));
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
// (d) Stalled upstream remains byte-transparent; no fabricated assistant prelude
// --------------------------------------------------------------------------
async function scenarioD() {
  console.log("\n=== scenario d: stalled upstream stays byte-transparent ===");
  const anthropicMock = await startMockAnthropic({
    stallOn: "MEMTREE_COMPRESSED_SENTINEL",
    answer: "MOCK_ANSWER_OK",
  });
  const ctx = await setup("d", { upstreamOrigin: `http://127.0.0.1:${anthropicMock.port}` });
  try {
    const sid = randomUUID();
    const r1 = await runClaude(ctx, ["--session-id", sid, "Turn one. Reply briefly."]);
    check("d", "turn 1 exits 0 against mock upstream", r1.code === 0, r1.stderr.slice(0, 300));

    // Turn 2 compresses, then the mock stalls 11.5s. The proxy must wait and
    // forward only the real upstream response; there is no safe async UI hook.
    const prompt = "Turn two. Reply briefly.";
    await armNotice(ctx, prompt, "smoke-d-turn2");
    const r2 = await runClaude(ctx, ["--resume", sid, prompt]);
    check("d", "turn 2 exits 0", r2.code === 0, r2.stderr.slice(0, 300));
    check("d", "no fabricated ✨ assistant text", !r2.stdout.includes("Something special is happening"), r2.stdout.slice(0, 300));
    check("d", "real upstream answer arrives unchanged", r2.stdout.includes("MOCK_ANSWER_OK"), (r2.json?.result ?? "").slice(0, 300));
    const hook = await postHook(ctx, {
      hook_event_name: "MessageDisplay",
      turn_id: "smoke-d",
      message_id: "smoke-d-message",
      index: 0,
      final: true,
      delta: "MOCK_ANSWER_OK",
      prompt_id: "smoke-d-turn2",
    });
    check("d", "success notice is available once answer displays",
      hook?.hookSpecificOutput?.displayContent?.includes(COMPRESSED_NOTICE), JSON.stringify(hook));

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
    check("d", "transcript never contains a notice marker", all.length > 0 && !all.includes(NOTICE_OPEN));
  } finally {
    await ctx.cleanup();
    anthropicMock.close();
  }
}

// --------------------------------------------------------------------------
// (e) Legacy marker cleanup: strip → Anthropic accepts thinking replay
// --------------------------------------------------------------------------
async function scenarioE() {
  console.log("\n=== scenario e: thinking round-trip through legacy strip ===");
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

    // Simulate a transcript from an older ccc release, where the fabricated ✨
    // prelude put a marker before thinking. The compatibility strip must
    // restore the history so Anthropic honors the signature.
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
    check("e", "non-streaming Anthropic response contains no injected notice",
      !viaProxy.body.includes("MemTree degraded") && !viaProxy.body.includes(NOTICE_OPEN));
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
