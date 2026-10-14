import test from "node:test";
import assert from "node:assert/strict";
import { MEMTREE_TOOLS } from "../dist/memtree-mcp.js";
import { withMemtreeToolDefinitions } from "../dist/memtree-tool-inject.js";

// A resumed session whose transcript announced the memtree tools as deferred
// (started before ccc set alwaysLoad): Claude Code 2.1.296 keeps the placement
// its record latched, so `tools` has ToolSearch but no memtree schemas.
const NAMES = MEMTREE_TOOLS.map((tool) => `mcp__memtree__${tool.name}`);
const DEFERRED_NOTE = {
  role: "system",
  content: [{ type: "text", text: `The following deferred tools are now available via ToolSearch:\n${NAMES.join("\n")}` }],
};
const tool = (name, extra = {}) => ({ name, description: name, input_schema: { type: "object" }, ...extra });

function latchedBody(extraTools = []) {
  return {
    model: "claude-x",
    tools: [tool("Bash", { eager_input_streaming: true }), tool("ToolSearch", { eager_input_streaming: true }),
      { name: "DeferredToolPlaceholder", defer_loading: true }, ...extraTools],
    messages: [{ role: "user", content: "hi" }, DEFERRED_NOTE],
  };
}

test("a deferred-latched session gets the memtree schemas, exactly as Claude Code lists them", () => {
  const body = latchedBody();
  const added = withMemtreeToolDefinitions(body);
  assert.deepEqual(added, NAMES);
  const byName = new Map(body.tools.map((t) => [t.name, t]));
  for (const def of MEMTREE_TOOLS) {
    const sent = byName.get(`mcp__memtree__${def.name}`);
    assert.equal(sent.description, def.description);
    assert.deepEqual(sent.input_schema, def.inputSchema);
    assert.equal(sent.eager_input_streaming, true, "same wire shape as Claude Code's own tools");
    assert.equal(sent._meta, undefined);
  }
  assert.deepEqual(body.tools.slice(0, 3).map((t) => t.name), ["Bash", "ToolSearch", "DeferredToolPlaceholder"],
    "Claude Code's own tools keep their order (appended after them)");
});

test("the result is stable: a second pass adds nothing", () => {
  const body = latchedBody();
  withMemtreeToolDefinitions(body);
  const once = JSON.stringify(body);
  assert.deepEqual(withMemtreeToolDefinitions(body), []);
  assert.equal(JSON.stringify(body), once);
});

test("only missing memtree tools are added; never a duplicate name", () => {
  const search = MEMTREE_TOOLS.find((t) => t.name === "search");
  const body = latchedBody([{ name: "mcp__memtree__search", description: search.description, input_schema: search.inputSchema }]);
  const added = withMemtreeToolDefinitions(body);
  assert.deepEqual(added, NAMES.filter((n) => n !== "mcp__memtree__search"));
  assert.equal(body.tools.filter((t) => t.name === "mcp__memtree__search").length, 1);
});

test("nothing changes when Claude Code already sends them inline or by value", () => {
  const inline = latchedBody(MEMTREE_TOOLS.map((t) => tool(`mcp__memtree__${t.name}`)));
  assert.deepEqual(withMemtreeToolDefinitions(inline), []);
  const byValue = latchedBody();
  byValue.messages.push({ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition",
    definition: tool("mcp__memtree__search") } }] });
  assert.deepEqual(withMemtreeToolDefinitions(byValue), NAMES.filter((n) => n !== "mcp__memtree__search"));
});

test("requests that do not have the memtree tools are left alone", () => {
  const noToolSearch = latchedBody();
  noToolSearch.tools = noToolSearch.tools.filter((t) => t.name !== "ToolSearch");
  assert.deepEqual(withMemtreeToolDefinitions(noToolSearch), [], "no tool search: all MCP tools would be inline");
  const unannounced = latchedBody();
  unannounced.messages = [{ role: "user", content: "hi" }];
  assert.deepEqual(withMemtreeToolDefinitions(unannounced), [], "a pool without memtree (e.g. a restricted subagent)");
  assert.deepEqual(withMemtreeToolDefinitions({ messages: [DEFERRED_NOTE] }), [], "no tools at all (side request)");
});
