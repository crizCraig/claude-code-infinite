import test from "node:test";
import assert from "node:assert/strict";
import { describeClaudeCodeRequest } from "../dist/cc-request.js";

const MAIN = "x-anthropic-billing-header: cc_version=2.1.281.835; cc_entrypoint=cli; cch=e9458; cc_prev_req=req_1; cc_prompt_id=17789129; cc_turn_origin=human;";
const MONITOR = "x-anthropic-billing-header: cc_version=2.1.281.e3c; cc_entrypoint=cli; cch=bb387;";

test("main-thread requests carry a turn origin and are not suspected", () => {
  const info = describeClaudeCodeRequest({
    system: [{ type: "text", text: MAIN }, { type: "text", text: "You are Claude Code." }],
    tools: [{ name: "Bash" }, { name: "Read" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(info, {
    billingHeader: true, promptId: true, tools: 2, suspectedSideRequest: false,
    ccVersion: "2.1.281.835", entrypoint: "cli", turnOrigin: "human",
  });
});

test("the security monitor shape is suspected, with the prompt's opening for audits", () => {
  // Separate block, as Claude Code sends it.
  const split = describeClaudeCodeRequest({
    system: [{ type: "text", text: MONITOR }, { type: "text", text: "You are a security monitor for autonomous AI coding agents.\n\n## Context\n..." }],
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(split.suspectedSideRequest, true);
  assert.equal(split.promptId, false);
  assert.equal(split.tools, 0);
  assert.equal(split.turnOrigin, undefined);
  assert.ok(split.systemHead.startsWith("You are a security monitor for autonomous AI coding agents."));
  assert.ok(split.systemHead.length <= 120);
  // Header and prompt glued in one system message, as the archive shows it.
  const glued = describeClaudeCodeRequest({
    messages: [
      { role: "system", content: `${MONITOR} You are a security monitor for autonomous AI coding agents.` },
      { role: "user", content: "x" },
    ],
  });
  assert.equal(glued.suspectedSideRequest, true);
  assert.equal(glued.systemHead, "You are a security monitor for autonomous AI coding agents.");
});

test("requests without a Claude Code header are never suspected", () => {
  for (const body of [{}, { system: "You are helpful." }, { messages: [{ role: "user", content: "hi" }] }]) {
    const info = describeClaudeCodeRequest(body);
    assert.equal(info.billingHeader, false);
    assert.equal(info.suspectedSideRequest, false);
    assert.equal(info.systemHead, undefined);
  }
});

import { inspectMonitorTranscript, isClaudeCodeSideRequest } from "../dist/cc-request.js";

test("side request = header, no turn origin, no tools; recaps and main turns are not", () => {
  const base = { messages: [{ role: "user", content: "x" }] };
  assert.equal(isClaudeCodeSideRequest(describeClaudeCodeRequest({ ...base, system: MONITOR })), true);
  assert.equal(isClaudeCodeSideRequest(describeClaudeCodeRequest({ ...base, system: MONITOR, tools: [{ name: "Bash" }] })), false, "recap / notification turns carry tools");
  assert.equal(isClaudeCodeSideRequest(describeClaudeCodeRequest({ ...base, system: MAIN })), false);
  assert.equal(isClaudeCodeSideRequest(describeClaudeCodeRequest(base)), false, "no header: other clients");
});

test("monitor transcript shape is recognised, and every deviation is named", () => {
  const wrap = (inner) => ({ messages: [{ role: "user", content: "CLAUDE.md" }, { role: "user", content: `<transcript>\n${inner}\n</transcript>\n\nRespond with <severity>N</severity>` }] });
  const ok = inspectMonitorTranscript(wrap('{"user":"hi"}\n{"Bash":{"command":"ls"}}\n{"meta":"x"}'));
  assert.deepEqual(ok, { ok: true, lines: 3, userLines: 1, toolLines: 1, metaLines: 1 });
  assert.equal(inspectMonitorTranscript({ messages: [{ role: "user", content: "plain" }] }).reason, "no-transcript");
  assert.equal(inspectMonitorTranscript({ messages: [{ role: "user", content: "<transcript>\n{\"user\":1}" }] }).reason, "unclosed");
  const bad = inspectMonitorTranscript(wrap('{"user":"hi"}\n{"a":1,"b":2}'));
  assert.equal(bad.reason, "bad-line");
  assert.equal(bad.sample, '{"a":1,"b":2}');
  assert.equal(inspectMonitorTranscript(wrap("")).reason, "empty");
});

test("only a malformed <transcript> block warns; a request with no transcript is silent", async () => {
  const { transcriptWarning } = await import("../dist/cc-request.js");
  const base = { ok: false, lines: 0, userLines: 0, toolLines: 0, metaLines: 0 };
  assert.equal(transcriptWarning({ ...base, ok: true, lines: 2 }), undefined);
  assert.equal(transcriptWarning({ ...base, reason: "no-transcript" }), undefined);
  for (const reason of ["unclosed", "empty"]) {
    assert.match(transcriptWarning({ ...base, reason }), new RegExp(`\\(${reason}\\)`));
  }
  assert.match(transcriptWarning({ ...base, reason: "bad-line", badLine: 3 }), /\(bad-line at line 3\)/);
});

test("benign no-transcript side requests are classified: session title and WebFetch summary", async () => {
  const { knownSideRequestKind } = await import("../dist/cc-request.js");
  const header = "x-anthropic-billing-header: cc_version=2.1.300.abc; cc_entrypoint=cli; cch=1;";
  const info = (system, user) => describeClaudeCodeRequest({
    system: [{ type: "text", text: header }, { type: "text", text: system }],
    messages: [{ role: "user", content: user }],
  });
  assert.equal(knownSideRequestKind(info(
    "You are Claude Code, Anthropic's official CLI for Claude. You are naming a coding session for a list.",
    "<session> fix the build </session>")), "session-title");
  assert.equal(knownSideRequestKind(info(
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "Web page content: --- # Docs")), "webfetch-summary");
  assert.equal(knownSideRequestKind(info("You are a security monitor for autonomous AI coding agents.", "x")), undefined);
  assert.equal(knownSideRequestKind(describeClaudeCodeRequest({ messages: [] })), undefined);
});

test("header-without-origin requests log the last user message opening, count and a session tag", async () => {
  const { sessionTag } = await import("../dist/cc-request.js");
  const info = describeClaudeCodeRequest({
    system: MONITOR,
    tools: [{ name: "Bash" }],
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "a" },
      { role: "user", content: "<system-reminder>ctx</system-reminder>\n\nwhat does ackack mean" },
    ],
  });
  assert.equal(info.lastUserHead, "what does ackack mean");
  assert.equal(info.messageCount, 3);
  const main = describeClaudeCodeRequest({ system: MAIN, messages: [{ role: "user", content: "secret prompt" }] });
  assert.equal(main.lastUserHead, undefined, "main-thread prompts are never logged");
  assert.equal(sessionTag("abc").length, 8);
  assert.equal(sessionTag(undefined), undefined);
});

test("MemTree client metadata keeps short printable values only", async () => {
  const { memtreeClientMeta } = await import("../dist/cc-request.js");
  const info = describeClaudeCodeRequest({ system: MAIN, tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(
    memtreeClientMeta({ info, lane: "agent", agentId: "a1", parentAgentId: "p1", model: "claude-opus-5-5" }),
    { claude_code_version: "2.1.281.835", entrypoint: "cli", turn_origin: "human", lane: "agent",
      agent_id: "a1", parent_agent_id: "p1", requested_model: "claude-opus-5-5" },
  );
  assert.deepEqual(memtreeClientMeta({ lane: "main", model: 42, agentId: "é", parentAgentId: "x".repeat(129) }), { lane: "main" });
});
