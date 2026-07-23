#!/usr/bin/env node
/**
 * Spike S1 — franken-message replay against real Anthropic, API-check form
 * (plans/2026-07-17_PLAN_speculative_ab_streaming.md §S1).
 *
 * Validates that Anthropic accepts a proxy-spliced composite assistant
 * message when it comes back as history on the NEXT turn — without an
 * interactive Claude Code session. All real-CC material is captured
 * headlessly, exactly like scripts/smoke/run.mjs scenario e:
 *
 *   1. `claude -p` (thinking on) through recorder+proxy → signed A thinking,
 *      A text, CC's verbatim request body + auth headers (in memory only).
 *   2. `claude -p` (thinking off, same prompt) → real B text.
 *   3. `claude -p` (tool turn) → real B tool_use block + CC's tool_result.
 *   4. Craft the composites exactly as SseSpliceWriter emits them and replay
 *      the next turn, both DIRECT to api.anthropic.com (pure API check) and
 *      via the ccc proxy (production path; degraded MemTree = passthrough).
 *
 * Shapes (per plan §S1):
 *   (a)  A-thinking(signed) + A-text-partial + bridge + B-text        → 200?
 *   (b)  same, but ending in B tool_use; next turn carries tool_result → 200?
 *   (a2) shape (a) under ALTERED prior history — info only: is the thinking
 *        signature bound to surrounding context? (production splice clears
 *        the memory route, so next turns replay A's thinking under history
 *        A never saw)
 *
 * Outcome mapping: (a)+(b) pass → transcript-validity risk retired, only the
 * P4 staged-CC UX/transcript-shape eyeball remains before speculative default.
 * (b) fails → B tool_use becomes a no-splice case, plan otherwise unchanged.
 * (a) fails → splice design rework.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startProxy, MemtreeClient } from "../dist/index.js";
import { projectTranscriptDir, startTranscriptScrubber } from "../dist/scrub.js";
import { CORRECTION_BRIDGE_TEXT } from "../dist/splice.js";
import { startMockMemtree, startRecorder } from "./smoke/servers.mjs";

const MODEL_ARGS = ["--model", "haiku"];
const failures = [];

function check(name, cond, extra = "") {
  const status = cond ? "PASS" : "FAIL";
  console.log(`  [${status}] ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failures.push(`${name} ${extra}`);
}

function info(name, detail) {
  console.log(`  [info] ${name}: ${detail}`);
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
      resolve({ code, stdout, stderr });
    });
  });
}

/** All assistant/user API-shaped messages from one session's transcript. */
async function sessionMessages(transcriptDir, sessionId) {
  let names = [];
  try {
    names = await fsp.readdir(transcriptDir);
  } catch {}
  const file = names.find((n) => n.includes(sessionId) && n.endsWith(".jsonl"));
  if (!file) return [];
  const content = await fsp.readFile(path.join(transcriptDir, file), "utf-8");
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if ((obj.type === "assistant" || obj.type === "user") && obj.message) {
      out.push(obj.message);
    }
  }
  return out;
}

function assistantBlocks(messages) {
  const blocks = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      blocks.push(...m.content);
    }
  }
  return blocks;
}

/** Longest recorded /v1/messages body containing marker = the main request. */
function recordedBody(ctx, marker) {
  let best = null;
  for (const r of ctx.recorder.recorded) {
    const s = r.body.toString("utf-8");
    if (!s.includes(marker)) continue;
    if (!best || s.length > best.length) best = s;
  }
  return best ? JSON.parse(best) : null;
}

function sendCrafted(host, port, useTls, urlPath, headers, body) {
  const mod = useTls ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(
      { host, port, method: "POST", path: urlPath, headers },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.end(JSON.stringify(body));
  });
}

// ---------------------------------------------------------------------------

console.log("=== Spike S1: franken-message replay (API-check form) ===");

const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "ccc-spike-s1-"));
const captureDir = path.join(cwd, ".captures");
// failCompress keeps every followup on the degraded passthrough path, so
// crafted bodies reach Anthropic intact (same trick as smoke scenario e).
const memtreeServer = await startMockMemtree({ failCompress: true });
const memtree = new MemtreeClient({
  baseUrl: `http://127.0.0.1:${memtreeServer.port}`,
  apiKey: "spike-key",
  debug: true,
});
const proxy = await startProxy({ memtree, debug: true, captureDir });
const recorder = await startRecorder(proxy.port);
const transcriptDir = projectTranscriptDir(cwd);
const scrubber = startTranscriptScrubber(transcriptDir, { debug: true });
const ctx = { cwd, recorder };

try {
  // -- 1. Leg A analog: signed thinking + text ------------------------------
  const sidA = randomUUID();
  const promptA =
    "Think briefly about why the sky is blue, then explain the answer in exactly two sentences.";
  const rA = await runClaude(ctx, ["--session-id", sidA, promptA], {
    MAX_THINKING_TOKENS: "1024",
  });
  check("leg A turn exits 0", rA.code === 0, rA.stderr.slice(0, 300));

  const blocksA = assistantBlocks(await sessionMessages(transcriptDir, sidA));
  const thinkingA = blocksA.find((b) => b.type === "thinking" && b.signature);
  const textA = blocksA.find((b) => b.type === "text" && b.text?.length >= 2);
  check("leg A produced a signed thinking block", Boolean(thinkingA));
  check("leg A produced a text block", Boolean(textA));

  const bodyA = recordedBody(ctx, "why the sky is blue");
  check("recorded leg A's main request body", Boolean(bodyA));
  if (!thinkingA || !textA || !bodyA) process.exit(1);
  const headers = { ...ctx.recorder.state.lastMessagesHeaders };
  delete headers["host"];
  delete headers["content-length"];
  delete headers["connection"];
  const urlPath = ctx.recorder.state.lastMessagesUrl;

  // -- 2. Leg B analog (text): same prompt, thinking off --------------------
  const sidB = randomUUID();
  const rB = await runClaude(ctx, ["--session-id", sidB, promptA]);
  check("leg B turn exits 0", rB.code === 0, rB.stderr.slice(0, 300));
  const textB = assistantBlocks(
    await sessionMessages(transcriptDir, sidB)
  ).find((b) => b.type === "text" && b.text?.length >= 2);
  check("leg B produced a text block", Boolean(textB));

  // -- 3. Leg B analog (tool_use): real CC tool round-trip ------------------
  const sidC = randomUUID();
  // NB: --allowedTools is variadic and would swallow a trailing prompt.
  const rC = await runClaude(ctx, [
    "--session-id",
    sidC,
    "Use the Bash tool to run exactly `echo S1_TOOL_MARKER`, then tell me what it printed.",
    "--allowedTools",
    "Bash(echo:*)",
  ]);
  check("tool turn exits 0", rC.code === 0, rC.stderr.slice(0, 300));
  const messagesC = await sessionMessages(transcriptDir, sidC);
  const toolUseC = assistantBlocks(messagesC).find((b) => b.type === "tool_use");
  const toolResultMsgC = messagesC.find(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === toolUseC?.id
      )
  );
  check("tool turn produced a tool_use block", Boolean(toolUseC));
  check("tool turn produced CC's matching tool_result", Boolean(toolResultMsgC));
  if (!textB || !toolUseC || !toolResultMsgC) process.exit(1);

  // Shape (b) needs the tool defined; CC sends its toolset in every request.
  let toolsForB = bodyA.tools;
  if (!toolsForB?.some((t) => t.name === toolUseC.name)) {
    const bodyC = recordedBody(ctx, "S1_TOOL_MARKER");
    toolsForB = bodyC?.tools;
  }
  check(
    `tools array defines ${toolUseC.name}`,
    Boolean(toolsForB?.some((t) => t.name === toolUseC.name))
  );

  // -- 4. Craft the composites exactly as the splice emits them -------------
  const partialText = {
    type: "text",
    text: textA.text.slice(0, Math.max(1, Math.ceil(textA.text.length / 2))),
  };
  const bridge = { type: "text", text: CORRECTION_BRIDGE_TEXT };

  const shapeA = {
    ...bodyA,
    stream: false,
    messages: [
      ...bodyA.messages,
      {
        role: "assistant",
        content: [thinkingA, partialText, bridge, { type: "text", text: textB.text }],
      },
      { role: "user", content: "Reply with exactly: S1_ROUNDTRIP" },
    ],
  };

  const shapeB = {
    ...bodyA,
    tools: toolsForB,
    stream: false,
    messages: [
      ...bodyA.messages,
      {
        role: "assistant",
        content: [thinkingA, partialText, bridge, toolUseC],
      },
      { role: "user", content: toolResultMsgC.content },
    ],
  };

  // (a2) info: same composite, but the prior user turn A actually saw is
  // altered — approximates post-splice turns where the memory route is
  // cleared and the full history no longer matches A's generation context.
  const alteredHistory = JSON.parse(JSON.stringify(bodyA.messages));
  for (const m of alteredHistory) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string" && m.content.includes("sky is blue")) {
      m.content = `Restored full conversation history.\n\n${m.content}`;
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "text" && b.text?.includes("sky is blue")) {
          b.text = `Restored full conversation history.\n\n${b.text}`;
        }
      }
    }
  }
  const shapeA2 = { ...shapeA, messages: [...alteredHistory, ...shapeA.messages.slice(bodyA.messages.length)] };

  // -- 5. Replay the next turn ----------------------------------------------
  for (const [label, body] of [
    ["shape (a) text-splice", shapeA],
    ["shape (b) tool_use-splice", shapeB],
  ]) {
    const direct = await sendCrafted("api.anthropic.com", 443, true, urlPath, headers, body);
    check(
      `${label}: DIRECT replay accepted (pure API check)`,
      direct.status === 200,
      `status=${direct.status} body=${direct.body.slice(0, 300)}`
    );
    const viaProxy = await sendCrafted("127.0.0.1", ctx.recorder.port, false, urlPath, headers, body);
    check(
      `${label}: replay via ccc proxy accepted`,
      viaProxy.status === 200,
      `status=${viaProxy.status} body=${viaProxy.body.slice(0, 300)}`
    );
  }

  const a2 = await sendCrafted("api.anthropic.com", 443, true, urlPath, headers, shapeA2);
  info(
    "shape (a2) altered-history replay (context-sensitivity of signature)",
    `status=${a2.status}${a2.status === 200 ? "" : ` body=${a2.body.slice(0, 300)}`}`
  );
} finally {
  scrubber.close();
  recorder.close();
  proxy.close();
  memtreeServer.close();
  await fsp.rm(cwd, { recursive: true, force: true });
}

console.log(
  `\n${failures.length === 0 ? "S1 API CHECKS PASSED" : `${failures.length} FAILURE(S):`}`
);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
