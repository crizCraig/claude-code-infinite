import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  extendsHistory, prefixIdentity, prefixMessageMatches, routeMessageHash, stablePrefixMessageHash,
} from "../dist/route-identity.js";

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

test("a prefix still covers a message Claude Code evicted media from, never a replaced one", () => {
  // Claude Code 2.1.310 caps media by count and by bytes; past a cap it evicts the oldest:
  // inside a tool result an image becomes its placeholder, a top-level one is dropped,
  // and a message left empty becomes the placeholder. The long-session test lost its
  // route (and then every compress) the moment it did this to ~100 old screenshots.
  const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const removed = { type: "text", text: "[media removed: request limit]" };
  const tool = (parts, id = "t") => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: parts }] });
  const evictions = [
    [tool([image("a"), { type: "text", text: "ok" }]), tool([removed, { type: "text", text: "ok" }])],
    [{ role: "user", content: [{ type: "text", text: "look" }, image("b")] },
      { role: "user", content: [{ type: "text", text: "look" }] }],
    [{ role: "user", content: [image("c")] }, { role: "user", content: [removed] }],
    [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "d" } }, { type: "text", text: "pdf" }] },
      { role: "user", content: [{ type: "text", text: "pdf" }] }],
  ];
  for (const kind of ["route", "stable"]) {
    for (const [before, after] of evictions) {
      const id = prefixIdentity([before], kind);
      assert.ok(prefixMessageMatches(after, kind, id.originalPrefixHashes[0], id.originalMediaFreeHashes[0]),
        `${kind}: ${JSON.stringify(after)}`);
      assert.ok(!prefixMessageMatches(after, kind, id.originalPrefixHashes[0], undefined),
        `${kind}: a prefix stored without media-free hashes matches exactly only`);
    }
    const [before] = evictions[0];
    const id = prefixIdentity([before], kind);
    const matches = (message) =>
      prefixMessageMatches(message, kind, id.originalPrefixHashes[0], id.originalMediaFreeHashes[0]);
    assert.ok(matches(before), "unchanged");
    assert.ok(!matches(tool([image("other"), { type: "text", text: "ok" }])), "a replaced image");
    assert.ok(!matches(tool([removed, { type: "text", text: "changed" }])), "different text");
    assert.ok(!matches(tool([removed, { type: "text", text: "ok" }], "u")), "different tool_use_id");
    const two = { role: "user", content: [{ type: "text", text: "x" }, image("p"), image("q")] };
    const twoId = prefixIdentity([two], kind);
    assert.ok(!prefixMessageMatches({ role: "user", content: [{ type: "text", text: "x" }, image("r")] },
      kind, twoId.originalPrefixHashes[0], twoId.originalMediaFreeHashes[0]), "media left: exact only");
  }
});

test("a newer history extends an older one across Claude Code's media eviction, not a replacement", () => {
  // Past its media caps every new screenshot evicts an old one, so an older message changes on
  // every round; a waiting background call must still count as covered by the newer one.
  const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const removed = { type: "text", text: "[media removed: request limit]" };
  const tool = (parts) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: parts }] });
  const system = (line) => ({ role: "system", content: line });
  const older = [system("billing 1"), { role: "user", content: "task" }, tool([image("a")]),
    { role: "assistant", content: "seen" }];
  const evicted = [system("billing 2"), { role: "user", content: "task" }, tool([removed]),
    { role: "assistant", content: "seen" }, { role: "user", content: "next" }];
  assert.ok(extendsHistory(evicted, older), "eviction keeps the older history covered");
  assert.ok(extendsHistory(older, older));
  const replaced = evicted.map((m, i) => i === 2 ? tool([image("b")]) : m);
  assert.ok(!extendsHistory(replaced, older), "a replaced image is new content");
  assert.ok(!extendsHistory(older.slice(0, 3), older), "a shorter history covers nothing more");
  const edited = evicted.map((m, i) => i === 1 ? { role: "user", content: "other task" } : m);
  assert.ok(!extendsHistory(edited, older), "an edited message is new content");
});

test("a prefix still covers messages a newer Claude Code renders differently on resume", () => {
  // 2026-11-09: a session built under Claude Code 2.1.302 and resumed under 2.1.319
  // lost its persisted prefix (then 413'd on a 2.2M-token compress): 2.1.319 moved a
  // reminder out of a tool result's text into its own block, and parsed a tool input
  // the model had sent as a JSON string. Two of 3,294 covered messages; same content.
  const reminder = "<system-reminder>\nAttribution lines\n</system-reminder>";
  const oldResult = { role: "user", content: [
    { type: "tool_result", tool_use_id: "t", content: `moved to background.\n\n${reminder}`, is_error: false },
    { type: "text", text: "[Request interrupted by user]\n" }] };
  const newResult = { role: "user", content: [
    { type: "tool_result", tool_use_id: "t", content: "moved to background.", is_error: false },
    { type: "text", text: `${reminder}\n` },
    { type: "text", text: "[Request interrupted by user]\n" }] };
  const edits = [{ old_str: "a\n</ul>", new_str: "b \"q\"" }];
  const oldUse = { role: "assistant", content: [{ type: "tool_use", id: "u", name: "Artifact",
    input: { action: "publish", edits: JSON.stringify(edits, null, 1) } }] };
  const newUse = { role: "assistant", content: [{ type: "tool_use", id: "u", name: "Artifact",
    input: { action: "publish", edits } }] };
  for (const kind of ["route", "stable"]) {
    for (const [before, after] of [[oldResult, newResult], [oldUse, newUse]]) {
      const id = prefixIdentity([before], kind);
      const matches = (message, stored = true) => prefixMessageMatches(message, kind,
        id.originalPrefixHashes[0], id.originalMediaFreeHashes[0],
        stored ? id.originalPortableHashes[0] : undefined);
      assert.ok(matches(after), `${kind}: ${JSON.stringify(after)}`);
      assert.ok(!matches(after, false), `${kind}: stored without portable hashes: exact only`);
    }
    const id = prefixIdentity([oldResult], kind);
    const matches = (message) => prefixMessageMatches(message, kind, id.originalPrefixHashes[0],
      id.originalMediaFreeHashes[0], id.originalPortableHashes[0]);
    const withText = structuredClone(newResult);
    withText.content[1].text = `${reminder} but real text`;
    assert.ok(!matches(withText), "a block with real text left is content");
    const otherResult = structuredClone(newResult);
    otherResult.content[0].content = "moved elsewhere.";
    assert.ok(!matches(otherResult), "different tool output");
    const useId = prefixIdentity([oldUse], kind);
    const otherUse = structuredClone(newUse);
    otherUse.content[0].input.edits[0].new_str = "c";
    assert.ok(!prefixMessageMatches(otherUse, kind, useId.originalPrefixHashes[0],
      useId.originalMediaFreeHashes[0], useId.originalPortableHashes[0]), "different tool input");
    const plainString = { role: "assistant", content: [{ type: "tool_use", id: "u", name: "Write",
      input: { content: "not json" } }] };
    const plainId = prefixIdentity([plainString], kind);
    assert.ok(prefixMessageMatches(plainString, kind, plainId.originalPrefixHashes[0],
      plainId.originalMediaFreeHashes[0], plainId.originalPortableHashes[0]));
  }
});

test("a prefix still covers ToolSearch results after a model switch drops their note", () => {
  // 2026-11-09 (session e32c1f3e): on Claude Code 2.1.321, Opus 5.5 gets "Tool loaded."
  // after a ToolSearch result and Fable 5.2 does not. Switching the model changed 12 of
  // 14,274 covered messages and the persisted prefix was discarded.
  const refs = { type: "tool_result", tool_use_id: "t", content: [
    { type: "tool_reference", tool_name: "mcp__memtree__search" },
    { type: "tool_reference", tool_name: "mcp__memtree__list" }] };
  const other = { type: "tool_result", tool_use_id: "u", content: "ran" };
  const note = { type: "text", text: "Tool loaded." };
  const typed = { type: "text", text: "and then?" };
  const user = (...content) => ({ role: "user", content });
  for (const kind of ["route", "stable"]) {
    const matches = (stored, message) => {
      const id = prefixIdentity([stored], kind);
      return prefixMessageMatches(message, kind, id.originalPrefixHashes[0],
        id.originalMediaFreeHashes[0], id.originalPortableHashes[0]);
    };
    assert.ok(matches(user(refs, note), user(refs)), `${kind}: Opus then Fable`);
    assert.ok(matches(user(refs), user(refs, note)), `${kind}: Fable then Opus`);
    assert.ok(matches(user(refs, other, note), user(refs, other)), `${kind}: parallel tool call`);
    assert.ok(matches(user(refs, { ...note, cache_control: { type: "ephemeral" } }), user(refs)));
    assert.ok(matches(user(refs, note, typed), user(refs, typed)), "only the note is dropped");
    assert.ok(!matches(user(refs, typed), user(refs)), "other text after the result");
    assert.ok(!matches(user(note), user()), "the user typed it");
    assert.ok(!matches(user(other, note), user(other)), "a result that loaded no tool");
    assert.ok(!matches(user(note, refs), user(refs)), "before the result");
    assert.ok(!matches(user(refs, typed, other, note), user(refs, typed, other)), "text between");
    const empty = { type: "tool_result", tool_use_id: "t", content: [] };
    assert.ok(!matches(user(empty, note), user(empty)), "an empty result loaded nothing");
  }
});

test("a portable match never equates different content (Codex r1)", () => {
  for (const kind of ["route", "stable"]) {
    const ids = (message) => prefixIdentity([message], kind);
    const matches = (message, id) => prefixMessageMatches(message, kind,
      id.originalPrefixHashes[0], id.originalMediaFreeHashes[0], id.originalPortableHashes[0]);
    const use = (input) => ({ role: "assistant",
      content: [{ type: "tool_use", id: "u", name: "Write", input }] });
    // JSON.parse is lossy: these strings would parse to the same value.
    for (const [a, b] of [
      ['{"n":9007199254740992}', '{"n":9007199254740993}'],
      ['{"a":1,"a":2}', '{"a":2}'],
      ['{"a":1.0}', '{"a":1}'],
      ['{"a":"\\u0041"}', '{"a":"A"}'],
    ]) {
      assert.ok(!matches(use({ content: b }), ids(use({ content: a }))), `${kind}: ${a} vs ${b}`);
    }
    const lossy = '{"n":9007199254740993}';
    assert.ok(!matches(use({ content: JSON.parse(lossy) }), ids(use({ content: lossy }))),
      `${kind}: a lossy string is not its parse`);
    // An own __proto__ key is data, not the prototype.
    const proto = (value) => use(JSON.parse(`{"__proto__":{"v":"${value}"},"content":"same"}`));
    assert.ok(!matches(proto("new"), ids(proto("old"))), `${kind}: own __proto__ keys differ`);
    assert.ok(matches(proto("old"), ids(proto("old"))), `${kind}: same __proto__ data`);
  }
});

test("a reminder moved beside unchanged media still matches; replaced media does not", () => {
  const reminder = "<system-reminder>\nAttribution lines\n</system-reminder>";
  const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const before = { role: "user", content: [{ type: "tool_result", tool_use_id: "t",
    content: [{ type: "text", text: `shot.\n\n${reminder}` }, image("AAAA")] }] };
  const after = (data) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t",
    content: [{ type: "text", text: "shot." }, image(data)] }, { type: "text", text: `${reminder}\n` }] });
  for (const kind of ["route", "stable"]) {
    const id = prefixIdentity([before], kind);
    const matches = (message) => prefixMessageMatches(message, kind, id.originalPrefixHashes[0],
      id.originalMediaFreeHashes[0], id.originalPortableHashes[0]);
    assert.ok(matches(after("AAAA")), `${kind}: same image, reminder moved`);
    assert.ok(!matches(after("BBBB")), `${kind}: another image`);
  }
});

test("a stored JSON string stands only for its parse, never for another string (Codex r2)", () => {
  const use = (input) => ({ role: "assistant",
    content: [{ type: "tool_use", id: "u", name: "Write", input }] });
  for (const kind of ["route", "stable"]) {
    const all = (stored, message) => {
      const id = prefixIdentity([stored], kind);
      return prefixMessageMatches(message, kind, id.originalPrefixHashes[0],
        id.originalMediaFreeHashes[0], id.originalPortableHashes[0],
        id.originalPortableMediaFreeHashes[0]);
    };
    for (const [a, b] of [['{"a":1}', '{ "a": 1 }'], ['{"a":1,"b":2}', '{"b":2,"a":1}'],
      ['[1, 2]', '[1,2]']]) {
      assert.ok(!all(use({ content: a }), use({ content: b })), `${kind}: ${a} -> ${b}`);
      assert.ok(!all(use({ content: b }), use({ content: a })), `${kind}: ${b} -> ${a}`);
    }
    assert.ok(all(use({ content: '{ "a": [1, 2] }' }), use({ content: { a: [1, 2] } })),
      `${kind}: the string Claude Code parsed`);
    assert.ok(!all(use({ content: { a: [1, 2] } }), use({ content: '{"a":[1,2]}' })),
      `${kind}: a parsed value never stands for a string`);
  }
});

test("a reminder moved while Claude Code evicted the image beside it still matches (Codex r2)", () => {
  const reminder = "<system-reminder>\nAttribution lines\n</system-reminder>";
  const image = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const before = { role: "user", content: [{ type: "tool_result", tool_use_id: "t",
    content: [{ type: "text", text: `shot.\n\n${reminder}` }, image("AAAA")] }] };
  const after = (media) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t",
    content: [{ type: "text", text: "shot." }, media] }, { type: "text", text: `${reminder}\n` }] });
  const evicted = after({ type: "text", text: "[media removed: request limit]" });
  for (const kind of ["route", "stable"]) {
    const id = prefixIdentity([before], kind);
    const matches = (message) => prefixMessageMatches(message, kind, id.originalPrefixHashes[0],
      id.originalMediaFreeHashes[0], id.originalPortableHashes[0],
      id.originalPortableMediaFreeHashes[0]);
    assert.ok(matches(evicted), `${kind}: moved and evicted`);
    assert.ok(!matches(after(image("BBBB"))), `${kind}: replaced`);
    const edited = structuredClone(evicted);
    edited.content[0].content[0].text = "other shot.";
    assert.ok(!matches(edited), `${kind}: edited text`);
  }
});

test("one input parsed since beside one still the same JSON string matches (Codex r3)", () => {
  const edits = [{ old_str: "a", new_str: "b" }];
  const message = (editsValue, content) => ({ role: "assistant", content: [
    { type: "tool_use", id: "u1", name: "Artifact", input: { edits: editsValue } },
    { type: "tool_use", id: "u2", name: "Write", input: { content } }] });
  const stored = message(JSON.stringify(edits), '{"a":1}');
  for (const kind of ["route", "stable"]) {
    const id = prefixIdentity([stored], kind);
    const matches = (m) => prefixMessageMatches(m, kind, id.originalPrefixHashes[0],
      id.originalMediaFreeHashes[0], id.originalPortableHashes[0],
      id.originalPortableMediaFreeHashes[0]);
    assert.ok(matches(message(edits, '{"a":1}')), `${kind}: edits parsed, content unchanged`);
    assert.ok(!matches(message(edits, '{ "a": 1 }')), `${kind}: content reformatted`);
    assert.ok(matches(message(edits, { a: 1 })), `${kind}: both parsed`);
    assert.ok(!matches(message([{ old_str: "a", new_str: "c" }], '{"a":1}')), `${kind}: other edits`);
  }
});
