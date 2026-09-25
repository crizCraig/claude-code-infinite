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
