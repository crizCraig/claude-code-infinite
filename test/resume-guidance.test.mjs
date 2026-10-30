// A resumed session is given the current MemTree guidance, once per resume.
// 2026-10-30, Craig's coordinator session (begun 2026-09-29, resumed daily since): its transcript
// announced the memtree server once, with the first one-line instructions ("Search and read this
// session's MemTree… Use it when a detail from earlier in the session is not in your context"),
// and Claude Code 2.1.314 never announces a known server again when its instructions change
// (mcp_instructions_delta compares names). So the session never got the full guidance: search
// before re-deriving, read_lines for exact detail, cross-session search, the tail.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { MemtreeLinkStore } from "../dist/memtree-links.js";
import { createSessionNoticePlugin } from "../dist/hooks.js";
import { MEMTREE_MCP_INSTRUCTIONS, MEMTREE_TOOL_NAMES } from "../dist/memtree-mcp.js";
import {
  ANNOUNCED_INSTRUCTIONS_NEEDLE,
  RESUME_GUIDANCE,
  RESUME_GUIDANCE_HOOK_SUFFIX,
  RESUME_GUIDANCE_PREFIX,
  ResumeGuidance,
  fileContains,
  withinDeadline,
  resumeGuidanceAgain,
  resumeGuidanceFor,
} from "../dist/resume-guidance.js";

const SESSION = "6472823f-ca4f-4027-9b89-64a81c367dc3";
const OLD_INSTRUCTIONS =
  "Search and read this session's MemTree: the summarized earlier part of the conversation, " +
  "with its verbatim transcript lines. Use it when a detail from earlier in the session is not " +
  "in your context.";

/** One transcript line as Claude Code writes a server announcement. */
function announcement(instructions) {
  const block = `## memtree\n${instructions}`;
  return JSON.stringify({
    parentUuid: "34287ae6-ec06-44ca-8f36-713b6252fa3d",
    attachment: { type: "mcp_instructions_delta", addedNames: ["memtree"],
      addedBlocks: [block], removedNames: [] },
    type: "attachment",
    rendered: [{ content: `<system-reminder>\n# MCP Server Instructions\n\n${block}\n</system-reminder>` }],
    sessionId: SESSION,
  });
}

function transcript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-resume-guidance-"));
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const USER_LINE = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });

// ------------------------------------------------------------------ texts

test("the guidance is the current instructions behind a line saying they replace older ones", () => {
  assert.equal(RESUME_GUIDANCE, `${RESUME_GUIDANCE_PREFIX}\n\n${MEMTREE_MCP_INSTRUCTIONS}`);
  assert.match(RESUME_GUIDANCE_PREFIX,
    /^ccc: current MemTree guidance \(replaces any earlier MemTree instructions in this conversation/);
  assert.match(RESUME_GUIDANCE_PREFIX, /mcp__memtree__\*/);
  assert.ok(!RESUME_GUIDANCE.includes("## memtree"), "never mistaken for a native announcement");
  assert.ok(!JSON.stringify(RESUME_GUIDANCE).includes(ANNOUNCED_INSTRUCTIONS_NEEDLE));
  // About 750 tokens (Anthropic's count, 2026-10-30), once per resume.
  assert.ok(RESUME_GUIDANCE.length < 4_000, `${RESUME_GUIDANCE.length} characters`);
});

test("a compressed session's guidance names the resume's time, so Claude Code adds it again", () => {
  const at = new Date("2026-10-30T18:58:31.825Z");
  assert.equal(resumeGuidanceAgain(at), `${RESUME_GUIDANCE}\n\n(Given again at the resume of ` +
    "2026-10-30T18:58:31.825Z: MemTree may have compressed this conversation, so an earlier " +
    "copy may be out of view.)");
  assert.notEqual(resumeGuidanceAgain(new Date("2026-10-30T18:58:59.000Z")), resumeGuidanceAgain(at),
    "two resumes in one minute are still two texts");
});

test("only an mcp_instructions_delta line counts as an announcement, not a quote of one", async () => {
  const block = JSON.stringify(`## memtree\n${MEMTREE_MCP_INSTRUCTIONS}`);
  const quoted = transcript([JSON.stringify({ type: "user", message: { role: "user",
    content: [{ type: "tool_result", content: `## memtree\n${MEMTREE_MCP_INSTRUCTIONS}` }] } })]);
  const real = transcript([USER_LINE, announcement(MEMTREE_MCP_INSTRUCTIONS)]);
  try {
    assert.ok(fs.readFileSync(quoted.file, "utf8").includes(block.slice(1, -1)));
    assert.equal(await fileContains(quoted.file, ANNOUNCED_INSTRUCTIONS_NEEDLE, 1_000), false);
    assert.equal(await fileContains(real.file, ANNOUNCED_INSTRUCTIONS_NEEDLE, 1_000), true);
  } finally { quoted.cleanup(); real.cleanup(); }
});

test("withinDeadline answers by its deadline even when the work never settles", async () => {
  const started = Date.now();
  assert.equal(await withinDeadline(new Promise(() => {}), 50, "late"), "late");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(await withinDeadline(Promise.resolve("done"), 1_000, "late"), "done");
  assert.equal(await withinDeadline(Promise.reject(new Error("x")), 1_000, "late"), "late");
});

test("the needle matches Claude Code's transcript line for the current instructions only", () => {
  assert.ok(announcement(MEMTREE_MCP_INSTRUCTIONS).includes(ANNOUNCED_INSTRUCTIONS_NEEDLE));
  assert.ok(!announcement(OLD_INSTRUCTIONS).includes(ANNOUNCED_INSTRUCTIONS_NEEDLE));
});

test("resumes get the guidance only in interactive runs with MemTree on and every memtree tool", () => {
  const on = { interactive: true, memtreeOff: false, tools: [...MEMTREE_TOOL_NAMES] };
  assert.ok(resumeGuidanceFor(on) instanceof ResumeGuidance);
  assert.equal(resumeGuidanceFor({ ...on, interactive: false }), undefined, "-p resumes every call");
  assert.equal(resumeGuidanceFor({ ...on, memtreeOff: true }), undefined);
  assert.equal(resumeGuidanceFor({ ...on, tools: [] }), undefined);
  assert.equal(resumeGuidanceFor({ ...on, tools: MEMTREE_TOOL_NAMES.slice(1) }), undefined,
    "the guidance names every tool");
});

// ------------------------------------------------------------------ transcript scan

test("fileContains finds the needle in the head, the tail, and across a chunk boundary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-contains-"));
  const file = path.join(dir, "t.jsonl");
  try {
    const filler = "x".repeat(1000);
    for (const at of [40, 95, 97, 100, 300, 990, 1990, 1994]) {
      fs.writeFileSync(file, filler + filler);
      const fd = fs.openSync(file, "r+");
      fs.writeSync(fd, '"type":"mcp_instructions_delta"', 0);
      fs.writeSync(fd, "NEEDLE", at);
      fs.closeSync(fd);
      // 100-byte head, then 64-byte chunks from the end: every split is covered.
      assert.equal(await fileContains(file, "NEEDLE", 1_000, 100, 64), true, `at ${at}`);
    }
    fs.writeFileSync(file, filler);
    assert.equal(await fileContains(file, "NEEDLE", 1_000, 100, 64), false);
    assert.equal(await fileContains(path.join(dir, "missing"), "NEEDLE", 1_000), false);
    fs.writeFileSync(file, '"type":"mcp_instructions_delta"' + filler + "NEEDLE");
    assert.equal(await fileContains(file, "NEEDLE", 0, 100, 64), false,
      "past its time box the scan gives up: the guidance is given");
  } finally {
    // The abandoned scan may still hold the file open (Windows refuses the rmdir).
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

// ------------------------------------------------------------------ through the proxy

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => handler(req, res, raw));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close() { server.closeAllConnections(); server.close(); } };
}

/** MemTree answers `h.status` (402: paused, 500: failing) or passes the conversation through. */
/** A link store naming SESSION's latest page uncompressed (`compressed` to change it). */
function links(compressed = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-guidance-links-"));
  const store = new MemtreeLinkStore(path.join(dir, "links.json"));
  store.put(SESSION, { url: "https://app.polychat.co/m/abc", index: "i1", compressed });
  store.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return store;
}

/** `linkStore: null`: ccc knows no page for the session. */
async function harness({ guidance = new ResumeGuidance(), projectTrees, linkStore = links() } = {}) {
  const h = { status: undefined, turns: 0 };
  const upstream = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", role: "assistant",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const memory = await serve((req, res, raw) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.statusCode = 404; return res.end("{}"); }
    if (h.status) {
      res.statusCode = h.status;
      return res.end(JSON.stringify({ detail: "Payment required for MemTree API" }));
    }
    const body = JSON.parse(raw);
    if (body.index_only) return res.end(JSON.stringify({ messages: [] }));
    res.end(JSON.stringify({ messages: body.messages }));
  });
  h.memtree = new MemtreeClient({ baseUrl: memory.url, apiKey: "offline" });
  h.proxy = await startProxy({
    memtree: h.memtree, upstreamOrigin: upstream.url,
    ...(guidance ? { resumeGuidance: guidance } : {}),
    ...(projectTrees ? { projectTrees } : {}),
    ...(linkStore ? { memtreeLinkStore: linkStore } : {}),
  });
  h.close = () => { h.proxy.close(); upstream.close(); memory.close(); linkStore?.cleanup?.(); };
  return h;
}

/** A main turn, then MemTree's answer settles (`settled` says when). */
async function turn(h, settled) {
  const response = await fetch(`http://127.0.0.1:${h.proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
    body: JSON.stringify({ model: "claude-opus-4-7", max_tokens: 1000,
      messages: [{ role: "user", content: `hello ${h.turns++}` }] }),
  });
  await response.text();
  for (let i = 0; i < 100 && !settled(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(settled(), "MemTree's answer arrived");
}

/** The guidance hook (its own SessionStart command); `main` asks the notice hook instead. */
async function sessionStart(h, extra = {}, main = false) {
  const url = main ? h.proxy.hookUrl : `${h.proxy.hookUrl}${RESUME_GUIDANCE_HOOK_SUFFIX}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart",
      source: "resume", ...extra }),
  });
  return res.status === 204 ? null : await res.json();
}

const context = (body) => body?.hookSpecificOutput?.additionalContext;

test("proxy: a resume whose transcript has the older instructions gets the guidance", async () => {
  const old = transcript([USER_LINE, announcement(OLD_INSTRUCTIONS), USER_LINE]);
  const h = await harness();
  try {
    const body = await sessionStart(h, { transcript_path: old.file });
    assert.deepEqual(body, {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: RESUME_GUIDANCE },
    });
    assert.equal(context(await sessionStart(h, { transcript_path: old.file })), RESUME_GUIDANCE,
      "every resume, word for word (cached)");
    assert.equal(context(await sessionStart(h, { source: "fork", transcript_path: old.file })),
      RESUME_GUIDANCE, "a fork carries the same history");
    const forked = context(await sessionStart(h, { source: "fork",
      session_id: "0f2a1c3e-8a6b-4c1d-9e2f-3a4b5c6d7e8f", transcript_path: old.file }));
    assert.match(forked, /\(Given again at the resume of /,
      "a fork's new id has no page: maybe compressed, so new to Claude Code");
    assert.equal(context(await sessionStart(h)), RESUME_GUIDANCE, "no transcript path: given");
    await turn(h, () => h.memtree.answering === true);
    assert.equal(context(await sessionStart(h, { transcript_path: old.file })), RESUME_GUIDANCE,
      "an in-app /resume while MemTree works");
  } finally { h.close(); old.cleanup(); }
});

test("proxy: no guidance for a fresh start, /clear, a compaction or a subagent", async () => {
  const old = transcript([announcement(OLD_INSTRUCTIONS)]);
  const h = await harness();
  try {
    for (const source of ["startup", "clear", "compact"]) {
      assert.equal(await sessionStart(h, { source, transcript_path: old.file }), null, source);
    }
    assert.equal(await sessionStart(h, { agent_id: "a1", transcript_path: old.file }), null);
  } finally { h.close(); old.cleanup(); }
});

test("proxy: no guidance when the transcript already announced the current instructions", async () => {
  const current = transcript([
    USER_LINE, announcement(OLD_INSTRUCTIONS), USER_LINE, announcement(MEMTREE_MCP_INSTRUCTIONS),
  ]);
  const h = await harness();
  try {
    assert.equal(await sessionStart(h, { transcript_path: current.file }), null);
  } finally { h.close(); current.cleanup(); }
});

test("proxy: no guidance while MemTree is paused, failing, or without the tools", async () => {
  const paused = await harness();
  try {
    paused.status = 402;
    await turn(paused, () => paused.memtree.paymentRequiredDetail !== null);
    assert.equal(context(await sessionStart(paused)), undefined, "paused (the user sees why)");
  } finally { paused.close(); }
  const failing = await harness();
  try {
    failing.status = 500;
    await turn(failing, () => failing.memtree.answering === false);
    assert.equal(await sessionStart(failing), null, "its latest answer a failure");
    failing.status = undefined;
    await turn(failing, () => failing.memtree.answering === true);
    assert.equal(context(await sessionStart(failing)), RESUME_GUIDANCE, "working again");
  } finally { failing.close(); }
  const toolless = await harness({ guidance: null });
  try {
    assert.equal(await sessionStart(toolless), null, "no memtree tools in the session");
  } finally { toolless.close(); }
  const gate = new ResumeGuidance();
  gate.disable();
  const withdrawn = await harness({ guidance: gate });
  try {
    assert.equal(await sessionStart(withdrawn), null, "the MCP server failed to register");
  } finally { withdrawn.close(); }
});

test("proxy: the guidance is its own hook's only context; the notice hook keeps the rest", async () => {
  const projectTrees = { contextFor: async () => "Earlier sessions in this project: …" };
  const h = await harness({ projectTrees });
  try {
    assert.deepEqual(await sessionStart(h), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: RESUME_GUIDANCE },
    });
    assert.equal(context(await sessionStart(h, {}, true)), "Earlier sessions in this project: …",
      "a separate context: Claude Code drops an identical one, and this one changes");
    const other = await fetch(`${h.proxy.hookUrl}${RESUME_GUIDANCE_HOOK_SUFFIX}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: SESSION, hook_event_name: "Stop" }) });
    assert.equal(other.status, 204, "SessionStart only");
    const junk = await fetch(`${h.proxy.hookUrl}${RESUME_GUIDANCE_HOOK_SUFFIX}`, {
      method: "POST", body: "not json" });
    assert.equal(junk.status, 204, "never fails the hook");
    const guessed = await fetch(`http://127.0.0.1:${h.proxy.port}/_ccc/hooks/x${RESUME_GUIDANCE_HOOK_SUFFIX}`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", source: "resume" }) });
    assert.ok(!(await guessed.text()).includes(RESUME_GUIDANCE_PREFIX),
      "only under the secret hook path");
  } finally { h.close(); }
});

test("proxy: a session MemTree compressed gets the guidance again, at every resume", async () => {
  const h = await harness({ linkStore: links(true) });
  try {
    const text = context(await sessionStart(h));
    assert.ok(text.startsWith(`${RESUME_GUIDANCE}\n\n(Given again at the resume of `), text);
    assert.match(text, /MemTree may have compressed this conversation/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.notEqual(context(await sessionStart(h)), text, "each resume is new to Claude Code");
    const current = transcript([announcement(MEMTREE_MCP_INSTRUCTIONS)]);
    try {
      assert.match(context(await sessionStart(h, { transcript_path: current.file })),
        /Given again/, "compressed: Claude Code's own announcement is out of view too");
    } finally { current.cleanup(); }
  } finally { h.close(); }
  const unknown = await harness({ linkStore: null });
  try {
    assert.match(context(await sessionStart(unknown)), /Given again/,
      "no page known (evicted or unreadable link store): treated as maybe compressed");
    const current = transcript([announcement(MEMTREE_MCP_INSTRUCTIONS)]);
    try {
      assert.equal(await sessionStart(unknown, { transcript_path: current.file }), null,
        "but a young session begun on this version needs none");
    } finally { current.cleanup(); }
  } finally { unknown.close(); }
});

test("proxy: the guidance hook drops a body past its limit, streamed or declared", async () => {
  const h = await harness();
  try {
    const big = JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart",
      source: "resume", pad: "x".repeat(70 * 1024) });
    const url = `${h.proxy.hookUrl}${RESUME_GUIDANCE_HOOK_SUFFIX}`;
    const declared = await fetch(url, { method: "POST", body: big,
      headers: { "content-type": "application/json" } });
    assert.equal(declared.status, 204);
    const stream = new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const chunked = await fetch(url, { method: "POST", body: stream, duplex: "half",
      headers: { "content-type": "application/json" } });
    assert.equal(chunked.status, 204, "no content-length: counted as it streams");
  } finally { h.close(); }
});

test("the session plugin runs the guidance as its own SessionStart hook, on resume and fork", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-guidance-plugin-"));
  const url = "http://127.0.0.1:12345/_ccc/hooks/token";
  const plugin = createSessionNoticePlugin(url, { tempRoot, resumeLink: true, resumeGuidance: true });
  const without = createSessionNoticePlugin(url, { tempRoot, resumeLink: true });
  try {
    const read = (p) => JSON.parse(fs.readFileSync(path.join(p.dir, "hooks", "hooks.json"), "utf8"));
    const starts = read(plugin).hooks.SessionStart;
    const guidance = starts.filter((entry) =>
      entry.hooks[0].command.endsWith(`'${url}${RESUME_GUIDANCE_HOOK_SUFFIX}'`));
    assert.equal(guidance.length, 1);
    assert.equal(guidance[0].matcher, "resume|fork", "never startup, clear or compact");
    assert.equal(guidance[0].hooks[0].timeout, 5);
    assert.equal(starts.length, read(without).hooks.SessionStart.length + 1);
    assert.ok(!JSON.stringify(read(without)).includes(RESUME_GUIDANCE_HOOK_SUFFIX));
  } finally {
    plugin.close();
    without.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
