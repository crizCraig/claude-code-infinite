import test from "node:test";
import assert from "node:assert/strict";
import { formatSearchResults } from "../dist/memtree-finder.js";

test("capped search describes ranking without a stale numeric limit", () => {
  const text = formatSearchResults({
    query: "example",
    hits: [{ kind: "session", id: "session-1", tree: { request_id: "tree-1" } }],
    matches_capped: true,
  }, {});
  assert.match(text, /Only the newest matching passages were ranked/);
  assert.doesNotMatch(text, /2,000|500/);
});
