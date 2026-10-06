import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { routeMessageHash, stablePrefixMessageHash } from "../dist/route-identity.js";

test("route identity canonicalizes text, reminders and cache metadata symmetrically", () => {
  const a = { role: "user", content: "  hello <system-reminder>dynamic</system-reminder>world  " };
  const b = { content: [{ text: "hello world", type: "text", cache_control: { type: "ephemeral" } }], role: "user" };
  assert.equal(routeMessageHash(a), routeMessageHash(b));
  assert.notEqual(routeMessageHash(b), routeMessageHash({ ...b, content: "hello  world" }));
});

test("tool results with literal reminder text equal themselves after JSON replay", () => {
  for (const content of [
    "A legitimate <system-reminder>example</system-reminder> and an unmatched <system-reminder>",
    [{ type: "text", text: "<system-reminder>literal</system-reminder> tail" }],
  ]) {
    const message = { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content }] };
    const snapshot = JSON.stringify(message);
    assert.equal(routeMessageHash(message), routeMessageHash(JSON.parse(snapshot)));
    assert.equal(JSON.stringify(message), snapshot);
    assert.notEqual(routeMessageHash(message), routeMessageHash({ role: "user", content: [{ type: "tool_result", tool_use_id: "b", content }] }));
  }
});

test("identity retains tool data and block order while sorting object keys", () => {
  const content = [{ type: "tool_use", id: "a", name: "x", input: { cache_control: 1, b: 2, a: 3 } }];
  const a = { role: "assistant", content };
  const b = { content: [{ input: { a: 3, b: 2, cache_control: 1 }, name: "x", id: "a", type: "tool_use" }], role: "assistant" };
  assert.equal(routeMessageHash(a), routeMessageHash(b));
  b.content[0].input.cache_control = 2;
  assert.notEqual(routeMessageHash(a), routeMessageHash(JSON.parse(JSON.stringify(b))));
  assert.notEqual(routeMessageHash({ role: "user", content: ["a", "b"] }), routeMessageHash({ role: "user", content: ["b", "a"] }));
});

test("only stable identity omits assistant thinking", () => {
  const a = { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "sig" }, { type: "text", text: "answer" }] };
  const b = { role: "assistant", content: [{ type: "text", text: "answer" }] };
  assert.equal(stablePrefixMessageHash(a), stablePrefixMessageHash(b));
  assert.notEqual(routeMessageHash(a), routeMessageHash(b));
  assert.notEqual(stablePrefixMessageHash({ ...a, role: "user" }), stablePrefixMessageHash({ ...b, role: "user" }));
});

test("framed identity distinguishes boundaries and Unicode code units", () => {
  const hash = (content) => routeMessageHash({ role: "user", content });
  assert.notEqual(hash(["ab", "c"]), hash(["a", "bc"]));
  assert.notEqual(hash("\ud800"), hash("\ufffd"));
  assert.notEqual(hash([{ type: "tool_use", input: { a: "bc" } }]), hash([{ type: "tool_use", input: { ab: "c" } }]));
});

test("million-token prefix hashes in milliseconds and repeated comparisons do not rescan", (t) => {
  // Four megabytes is approximately one million tokens by the client's estimate.
  const messages = Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}:` + "ordinary transcript text ".repeat(175) }));
  const stored = messages.map(routeMessageHash);
  const incoming = JSON.parse(JSON.stringify(messages));
  const start = performance.now();
  assert.ok(incoming.every((m, i) => routeMessageHash(m) === stored[i]));
  const coldMs = performance.now() - start;
  const edited = JSON.parse(JSON.stringify(messages));
  edited[500].content += " edited in the middle";
  assert.equal(edited.filter((m, i) => routeMessageHash(m) !== stored[i]).length, 1);
  // A getter that would fail proves a repeated check uses only the cached hash.
  for (const message of incoming) Object.defineProperty(message, "content", { get() { throw new Error("rescanned request message"); } });
  const warmStart = performance.now();
  for (let i = 0; i < 20; i++) assert.ok(incoming.every((m, j) => routeMessageHash(m) === stored[j]));
  const warmMs = performance.now() - warmStart;
  t.diagnostic(`~1M token cold comparison: ${coldMs.toFixed(1)}ms; 20 cached comparisons: ${warmMs.toFixed(1)}ms`);
  // Allow CI contention, while rejecting the former repeated clone/stringify path.
  assert.ok(coldMs < 250, `cold comparison took ${coldMs}ms`);
  assert.ok(warmMs < 100, `cached comparisons took ${warmMs}ms`);
});
