import test from "node:test";
import assert from "node:assert/strict";
import { CurrentTree, handleMcpMessage, MEMTREE_MCP_INSTRUCTIONS, MEMTREE_TOOLS } from "../dist/memtree-mcp.js";
import { formatHandover, formatUserMessages, handoverQuery, userMessagesQuery } from "../dist/memtree-handover.js";
import { setDisplayTimeZone } from "../dist/memtree-times.js";

setDisplayTimeZone("UTC");

const MESSAGES = {
  session_id: "session-1", request_id: "aaa111", total: 3, next_cursor: "7",
  window: { since: "2026-11-05T00:00:00Z", until: null },
  messages: [
    { n: 7, at: "2026-11-06T10:00:00.000Z", kind: "typed", text: "Keep prices flat this month",
      read: { block: 3, start: 10, end: 11 } },
    { n: 9, at: null, approx: ["2026-11-07T00:00:00Z", "2026-11-07T05:00:00Z"], kind: "board",
      board: { title: "Pricing" }, text: "a cent per read", read: { block: 4, start: 1, end: 2 },
      shortened: true, chars: 9000, reply_to: "Price the reads?" },
    { n: 12, at: "2026-11-08T19:38:00.000Z", kind: "mid_turn", text: "Let's go", read: { tail: 14100 } },
  ],
  newest: { tail_start: 14014, tail_end: 14100 },
};

const PACK = {
  session_id: "session-1", request_id: "aaa111", llm: "ok", model: "gemini/gemini-3.8-flash",
  window: { since: "2026-11-05T19:47:30Z", until: null }, messages_total: 106, messages_cursor: "1051",
  messages: MESSAGES.messages,
  ending: { at: "2026-11-08T19:47:30.478Z", summary: "The board moved to the mini.",
    last_message: { n: 12, at: "2026-11-08T19:38:00.000Z", text: "Let's go" },
    tools_after: ["Bash", "Bash", "Read", "Bash"], last_words: "I'll accept the trust prompt." },
  goals: [{ text: "Hand the orchestrator role to the mini", refs: [12] }],
  instructions: [{ text: "Never deploy production", refs: [] }],
  decisions: [{ decision: "Charge a cent per read", reason: "value, not cost", refs: [9] }],
  open_questions: [],
};

function fakeServer(answers) {
  const urls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    urls.push(u.pathname + u.search);
    if (u.pathname === "/memtree/current") {
      return Response.json({ session_id: "session-1", id: "aaa111", url: "https://app/m/aaa111" });
    }
    const route = u.pathname.split("/").at(-1);
    const answer = answers[route];
    return typeof answer === "function" ? answer() : Response.json(answer);
  };
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9/", sessionId: "session-1", fetch });
  const call = async (name, args) => {
    const reply = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tree);
    return { text: reply.result.content[0].text, isError: reply.result.isError === true };
  };
  return { urls, call };
}

test("user_messages reads the server's view with its filters and formats each message", async () => {
  const { urls, call } = fakeServer({ user_messages: MESSAGES });
  const { text, isError } = await call("user_messages", { since: "2026-11-05", query: "price", limit: 500, context: true });
  assert.equal(isError, false, text);
  assert.equal(urls.at(-1), "/memtree/aaa111/user_messages?since=2026-11-05&q=price&limit=200&context=true");
  assert.match(text, /^The person's own messages from 2026-11-05 00:00 UTC to now: 3 of 3, oldest first/);
  assert.match(text, /\[n 7 · 2026-11-06 10:00 UTC · typed · block 3 lines 10-11\]\nKeep prices flat this month/);
  assert.match(text, /\[n 9 · ~2026-11-07 00:00 UTC · board \(Pricing\) · block 4 lines 1-2 · shortened from 9000 chars\]\n↳ answering: Price the reads\?\na cent per read/);
  assert.match(text, /\[n 12 · 2026-11-08 19:38 UTC · mid_turn · tail 14100\]\nLet's go/);
  assert.match(text, /older: user_messages \{"cursor": "7", "since": "2026-11-05", "query": "price"\}/);
  assert.match(text, /read_lines \{"tail": true, "start": N, "end": N\}/);
  await call("user_messages", { tree: "bbb222-v1-own", cursor: "7" });
  assert.equal(urls.at(-1), "/memtree/bbb222-v1-own/user_messages?cursor=7", "another session's tree by ref");
});

test("user_messages and handover check their arguments before any read", async () => {
  const { urls, call } = fakeServer({});
  for (const [name, args, pattern] of [
    ["user_messages", { limit: 0 }, /limit must be 1 to 200/],
    ["user_messages", { full: "yes" }, /full must be true or false/],
    ["user_messages", { since: 20261105 }, /since must be a string/],
    ["handover", { days: 90 }, /days must be 1 to 60/],
    ["handover", { tree: "../x" }, /tree must be a tree reference/],
  ]) {
    const { text, isError } = await call(name, args);
    assert.equal(isError, true, name);
    assert.match(text, pattern);
  }
  assert.deepEqual(urls, []);
  assert.equal(handoverQuery({ days: 7 }).toString(), "days=7");
  assert.equal(userMessagesQuery({ full: false, context: true }).toString(), "context=true");
});

test("server answers: errors carry its detail; an old server or proxy says to update", async () => {
  let answer;
  const { call } = fakeServer({ handover: () => answer(), user_messages: () => answer() });
  answer = () => Response.json({ detail: "Not Found" }, { status: 404 });
  assert.match((await call("handover", {})).text, /^handover: this MemTree server \(or this ccc\) does not have it yet/);
  answer = () => Response.json({ detail: "No transcript to read messages from (this share has summaries only)" }, { status: 404 });
  assert.match((await call("user_messages", {})).text, /^user_messages: No transcript to read messages from/);
  answer = () => Response.json({ detail: "The handover pack is not available for partner accounts yet" }, { status: 403 });
  assert.match((await call("handover", {})).text, /^handover: HTTP 403 The handover pack is not available/);
  answer = () => Response.json({ detail: "until must be after since" }, { status: 400 });
  assert.match((await call("user_messages", { since: "2026-11-02", until: "2026-11-01" })).text, /^user_messages: until must be after since/);
  answer = () => Response.json({ status: "building" }, { status: 202 });
  assert.match((await call("handover", {})).text, /still being built/);
  answer = () => Response.json({ ...PACK, session_id: "someone-else" });
  assert.match((await call("handover", {})).text, /different or unknown session/, "this session's tree must be its own");
});

test("handover formats how it ended, the model's lists with their messages, then the messages", async () => {
  const { urls, call } = fakeServer({ handover: PACK });
  const { text } = await call("handover", { tree: "e32c1f3e-v1-own", days: 3 });
  assert.equal(urls.at(-1), "/memtree/e32c1f3e-v1-own/handover?days=3");
  assert.match(text, /^Handover pack for e32c1f3e-v1-own from 2026-11-05 19:47 UTC to now\./);
  assert.match(text, /How it ended \(newest message 2026-11-08 19:47 UTC\):\nThe board moved to the mini\./);
  assert.match(text, /The person's last message \(n 12 at 2026-11-08 19:38 UTC\): Let's go/);
  assert.match(text, /Then the agent ran: Bash ×2, Read, Bash/);
  assert.match(text, /a model's reading of the person's messages: check one/);
  assert.match(text, /Goals:\n- Hand the orchestrator role to the mini \(n 12\)/);
  assert.match(text, /Standing instructions:\n- Never deploy production\n/);
  assert.match(text, /Decisions \(newest first\):\n- Charge a cent per read \(why: value, not cost\) \(n 9\)/);
  assert.match(text, /Open questions: none found\./);
  assert.match(text, /The person's messages in the window \(3 of 106, oldest first/);
  assert.match(text, /older messages in the window: user_messages \{"tree": "e32c1f3e-v1-own", "cursor": "1051", "since": "2026-11-05T19:47:30Z"\}/);
  const off = formatHandover({ ...PACK, llm: "rate_limited", goals: undefined });
  assert.match(off, /No model summary this time: too many packs this hour/);
  assert.doesNotMatch(off, /Goals:/);
});

test("the tools are listed, loaded up front, and the instructions point at them", () => {
  for (const name of ["user_messages", "handover"]) {
    const tool = MEMTREE_TOOLS.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tool.inputSchema.properties.tree.type, "string");
  }
  assert.match(MEMTREE_MCP_INSTRUCTIONS, /call handover with its session id first/);
  assert.match(MEMTREE_MCP_INSTRUCTIONS, /user_messages lists only the person's own messages/);
  assert.equal(formatUserMessages({ messages: [] }, { query: "zebra" }), 'No messages from the person with "zebra".');
});
