import test from "node:test";
import assert from "node:assert/strict";
import { formatSearchResults, formatSessions, NOT_SEARCHED_NOTE } from "../dist/memtree-finder.js";

test("capped search describes ranking without a stale numeric limit", () => {
  const text = formatSearchResults({
    query: "example",
    hits: [{ kind: "session", id: "session-1", tree: { request_id: "tree-1" } }],
    matches_capped: true,
  }, {});
  assert.match(text, /Only the newest matching passages were ranked/);
  assert.doesNotMatch(text, /2,000|500/);
});

test("an empty search across sessions says what it covered and why a session may be missing", () => {
  const at = "2026-11-05T20:05:00+00:00";
  const text = formatSearchResults({ query: "codex plan", hits: [], coverage: {
    sessions: 12, newest_indexed_at: at, this_session: { state: "building", percent: 42 } } }, { query: "codex plan" });
  assert.match(text, /^No passage in your sessions matches "codex plan" \(text search\)\. Searched 12 sessions \(newest indexed /);
  assert.match(text, /This session isn't indexed yet: its first index is 42% done\./);
  assert.match(text, /Text mode needs the exact words; for meaning, try mode "vector"\./);
  assert.ok(text.endsWith(NOT_SEARCHED_NOTE), text);
  assert.match(NOT_SEARCHED_NOTE, /Codex and plain claude sessions are not/);
  assert.match(NOT_SEARCHED_NOTE, /read_lines \{"tree": <ref>, "tail": true\}/);
  assert.doesNotMatch(text, /widen since\/until/, "no filter, no filter advice");
  const filtered = formatSearchResults({ hits: [], coverage: { sessions: 1 } }, { query: "x", project: "polychat" });
  assert.match(filtered, /Searched 1 session\. /);
  assert.match(filtered, /Or widen since\/until, or drop the project filter\./);
  const states = [
    [{ state: "indexed", indexed_at: at }, /This session is indexed up to /],
    [{ state: "too_short", tokens: 3200, start_tokens: 10000 }, /indexing starts at about 10k tokens and it has about 3k\./],
    [{ state: "not_indexed" }, /This session isn't indexed yet\. /],
    [{ state: "building", percent: 250 }, /99% done/],
  ];
  for (const [own, expected] of states) {
    assert.match(formatSearchResults({ hits: [], coverage: { sessions: 2, this_session: own } }, { query: "x" }), expected);
  }
  const none = formatSearchResults({ hits: [], coverage: { sessions: 0, newest_indexed_at: null } }, { query: "x" });
  assert.match(none, /None of your sessions has a MemTree yet\./);
  const vector = formatSearchResults({ groups: [], coverage: { sessions: 3 } }, { query: "x", mode: "vector" });
  assert.match(vector, /\(vector search\)\. Searched 3 sessions\. For an exact word/);
  // Older servers send no coverage: the message still names the scope.
  const old = formatSearchResults({ hits: [] }, { query: "x" });
  assert.match(old, /^No passage in your sessions matches "x" \(text search\)\. Text mode needs/);
  assert.equal(formatSearchResults({ hits: [] }, { query: "x", cursor: "c" }), "No more matches.");
  // An empty first page is still a charged search (Codex r1 P3).
  for (const [body, mode] of [[{ hits: [], charged: true }, "text"], [{ groups: [], charged: true }, "vector"]]) {
    const empty = formatSearchResults(body, { query: "x", mode });
    assert.match(empty, new RegExp(`\\(${mode} search, charged: one search\\)\\.`), empty);
  }
  const scoped = formatSearchResults({ groups: [], charged: true }, { query: "x", mode: "vector", tree: "t1" });
  assert.match(scoped, /^Nothing in tree t1 matches "x" \(vector search, charged: one search\)\./);
});

test("list marks the calling session", () => {
  const body = { sessions: [{ id: "a", kind: "claude_code_session", session_id: "a", title: "Other" },
                            { id: "b", kind: "claude_code_session", session_id: "b", title: "Mine" }] };
  const text = formatSessions(body, {}, "b");
  assert.match(text, /\[1\] Other/);
  assert.match(text, /\[2\] \(this session\) Mine/);
  assert.doesNotMatch(formatSessions(body, {}), /this session/);
});
