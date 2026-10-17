// Whether ccc registers its `memtree` MCP server, which tools it pre-allows,
// and what it tells MemTree (x-memtree-tools): the same for interactive and
// print (-p) / non-TTY runs, never overriding the caller's own choices.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MEMTREE_ALLOWED_TOOLS,
  disallowedMemtreeTools,
  planMemtreeMcp,
  withMemtreeMcpArgs,
} from "../dist/memtree-mcp-config.js";

const ALL = ["search", "read_node", "read_lines", "list"];

function withConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-mcp-plan-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("print and plain runs get ccc's server with all four tools by default", () => {
  for (const args of [["-p", "q"], ["--print", "--output-format", "json", "q"], ["q"], []]) {
    assert.deepEqual(planMemtreeMcp(args, {}), { register: true, tools: ALL }, args.join(" "));
  }
  for (const args of [
    ["-p", "--resume", "abc", "q"],
    ["-p", "--session-id", "6472823f-ca4f-4027-9b89-64a81c367dc3", "q"],
    ["-p", "--strict-mcp-config", "q"],
    ["-p", "--output-format", "stream-json", "--verbose", "q"],
  ]) {
    assert.deepEqual(planMemtreeMcp(args, {}), { register: true, tools: ALL }, args.join(" "));
  }
});

test("CCC_MEMTREE_MCP=0 turns it off: no server, no header", () => {
  assert.deepEqual(planMemtreeMcp(["-p", "q"], { CCC_MEMTREE_MCP: "0" }), { register: false, tools: [] });
  assert.deepEqual(planMemtreeMcp(["-p", "q"], { CCC_MEMTREE_MCP: "1" }), { register: true, tools: ALL });
});

test("the caller's own ccc memtree server is kept: ccc adds none, still sends the header", () => {
  withConfigDir((dir) => {
    const own = path.join(dir, "own.json");
    fs.writeFileSync(own, JSON.stringify({ mcpServers: { memtree: { command: "ccc", args: ["memtree-mcp"] } } }));
    assert.deepEqual(planMemtreeMcp(["-p", "q", "--mcp-config", own], {}), { register: false, tools: ALL });
    // Even under the opt-out: the caller asked for the tools explicitly.
    assert.deepEqual(planMemtreeMcp(["-p", "--mcp-config", own], { CCC_MEMTREE_MCP: "0" }),
      { register: false, tools: ALL });
  });
});

test("someone else's server named memtree: ccc neither replaces nor pre-allows it, no header", () => {
  withConfigDir((dir) => {
    const other = path.join(dir, "other.json");
    fs.writeFileSync(other, JSON.stringify({ mcpServers: { memtree: { command: "other-server" } } }));
    assert.deepEqual(planMemtreeMcp(["-p", "--mcp-config", other, "--", "q"], {}), { register: false, tools: [] });
    const inline = JSON.stringify({ mcpServers: { memtree: { type: "http", url: "https://x" } } });
    assert.deepEqual(planMemtreeMcp([`--mcp-config=${inline}`, "-p", "q"], {}), { register: false, tools: [] });
    // Unrelated servers in the caller's config change nothing.
    fs.writeFileSync(other, JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    assert.deepEqual(planMemtreeMcp(["-p", "--strict-mcp-config", "--mcp-config", other], {}),
      { register: true, tools: ALL });
  });
});

test("--disallowedTools is respected: whole server, wildcard, or single tools", () => {
  const none = { register: false, tools: [] };
  assert.deepEqual(planMemtreeMcp(["-p", "--disallowedTools", "mcp__memtree", "q"], {}), none);
  assert.deepEqual(planMemtreeMcp(["-p", "--disallowedTools=mcp__memtree__*"], {}), none);
  assert.deepEqual(planMemtreeMcp(["-p", "--disallowed-tools", "Bash", "mcp__memtree"], {}), none);
  assert.deepEqual(
    planMemtreeMcp(["-p", "--disallowedTools", "mcp__memtree__list,mcp__memtree__search", "q"], {}),
    { register: true, tools: ["read_node", "read_lines"] }
  );
  assert.deepEqual(
    planMemtreeMcp(["-p", "--disallowedTools", "mcp__memtree__read_lines", "--disallowedTools=Edit"], {}),
    { register: true, tools: ["search", "read_node", "list"] }
  );
  // After `--` it is prompt text, not an option.
  assert.deepEqual(planMemtreeMcp(["-p", "--", "--disallowedTools", "mcp__memtree"], {}),
    { register: true, tools: ALL });
  // Other servers' names never match by prefix.
  assert.deepEqual(planMemtreeMcp(["--disallowedTools", "mcp__memtree2", "mcp__memtree_x__search"], {}),
    { register: true, tools: ALL });
  assert.deepEqual(disallowedMemtreeTools(["--disallowedTools", "mcp__memtree__se*"]), ["search"]);
});

test("pre-allow adds only the memtree tools ccc registers; the caller's lists stay intact", () => {
  const args = ["-p", "--allowedTools", "Read", "--disallowedTools", "mcp__memtree__list", "--", "q"];
  const plan = planMemtreeMcp(args, {});
  const child = withMemtreeMcpArgs(args, "/tmp/m.json", plan.tools);
  assert.deepEqual(child, [
    "--mcp-config=/tmp/m.json",
    "--allowedTools=mcp__memtree__search,mcp__memtree__read_node,mcp__memtree__read_lines",
    ...args,
  ]);
  // Default: all four, and never anything that is not a memtree tool.
  const allowed = withMemtreeMcpArgs(["q"], "/tmp/m.json")[1].slice("--allowedTools=".length).split(",");
  assert.deepEqual(allowed, MEMTREE_ALLOWED_TOOLS);
  assert.ok(allowed.every((tool) => /^mcp__memtree__(search|read_node|read_lines|list)$/.test(tool)));
});
