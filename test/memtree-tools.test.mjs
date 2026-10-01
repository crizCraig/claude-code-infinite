import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatLines,
  formatNode,
  formatSearch,
  MemtreeIndex,
  queryTerms,
  READ_LINES_MAX_LINES,
  ToolInputError,
} from "../dist/memtree-tools.js";
import { CurrentTree, handleMcpMessage, MEMTREE_TOOLS } from "../dist/memtree-mcp.js";
import {
  argsConfigureMemtreeMcp,
  mcpConfigArgs,
  MEMTREE_ALLOWED_TOOLS,
  MEMTREE_TOOLS_HEADER_VALUE,
  memtreeMcpConfig,
  withMemtreeMcpArgs,
} from "../dist/memtree-mcp-config.js";

const PAGE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/memtree-page.json", import.meta.url), "utf-8")
);
const index = () => new MemtreeIndex(PAGE);

test("queryTerms lowercases, trims punctuation, drops stopwords and repeats", () => {
  assert.deepEqual(queryTerms("What is the Bucket name? bucket, deploy.yaml!"), [
    "bucket",
    "name",
    "deploy.yaml",
  ]);
  assert.deepEqual(queryTerms("  the of  "), []);
});

test("search ranks by query coverage, prefers leaf line hits, returns snippets", () => {
  const hits = index().search("billing bucket");
  assert.ok(hits.length >= 2);
  // Both terms on one transcript line of leaf 2 (and of leaf 3).
  assert.ok([2, 3].includes(hits[0].id));
  assert.equal(hits[0].leaf, true);
  assert.deepEqual(hits[0].matchedTerms, ["billing", "bucket"]);
  const leaf3 = hits.find((h) => h.id === 3);
  assert.deepEqual(leaf3.range, { block: 0, start: 6, end: 9 });
  assert.deepEqual(leaf3.snippets.map((s) => s.line), [7, 9]);
  assert.equal(leaf3.snippets[1].text, "Renamed bucket to billing-artifacts-9120 in deploy.yaml");
  // A branch matching one term on its summary ranks below leaves covering both.
  const branch = hits.find((h) => h.id === 1);
  assert.ok(branch && hits.indexOf(branch) > hits.indexOf(leaf3));
  assert.equal(branch.leaf, false);
  assert.equal(branch.depth, 1);
});

test("search finds a detail only the verbatim lines hold, and honors limit", () => {
  const hits = index().search("8443");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 2);
  assert.deepEqual(hits[0].snippets, [{ line: 5, text: "The billing service port is 8443" }]);
  assert.equal(index().search("billing", 1).length, 1);
  assert.equal(index().search("nothing-like-this").length, 0);
});

test("search snippets window long lines around the hit", () => {
  const hits = index().search("xxxxxxxx");
  const snip = hits[0].snippets[0];
  assert.equal(snip.line, 6);
  assert.ok(snip.text.length < 300);
  assert.ok(snip.text.endsWith("…"));
});

test("formatSearch names ranges and the follow-up tools; no terms is an input error", () => {
  const text = formatSearch(index(), "0042 duplicate");
  assert.match(text, /\[node 5 · leaf · depth 2 · block 1 lines 1-6 · matched 0042, duplicate/);
  assert.match(text, /L4: Migration 0042_add_invoice_index failed/);
  assert.match(text, /read_lines \{block, start, end\}/);
  assert.match(formatSearch(index(), "zebra"), /No node or transcript line matches/);
  assert.throws(() => formatSearch(index(), "the"), ToolInputError);
});

test("read_node: summary, path from the root, children, leaf range", () => {
  const leaf = formatNode(index(), 3);
  assert.match(leaf, /^node 3 · leaf · depth 2\nsummary: Bucket renamed\./);
  assert.match(leaf, /transcript: block 0 lines 6-9 \(4 lines;/);
  assert.match(leaf, /path from the root:\n  node 0: Billing service.*\n  node 1: Deploy pipeline/);
  const root = formatNode(index(), 0);
  assert.match(root, /children \(2\):\n  node 1 \(branch\): Deploy pipeline setup for billing\.\n  node 4 \(branch\)/);
  assert.doesNotMatch(root, /path from the root/);
  assert.match(formatNode(index(), 1), /node 2 \(leaf, block 0 lines 1-5\)/);
  assert.throws(() => formatNode(index(), 99), /no node 99 \(this tree has 6 nodes/);
  assert.throws(() => formatNode(index(), 1.5), ToolInputError);
});

test("read_lines returns exact numbered lines and rejects bad bounds", () => {
  assert.equal(
    formatLines(index(), 0, 4, 5),
    "block 0 lines 4-5 (line number, tab, exact text):\n" +
      "4\tI created deploy.yaml with region us-west2 and bucket billing-artifacts-7731\n" +
      "5\tThe billing service port is 8443"
  );
  // End past the block is clamped and said so.
  assert.match(formatLines(index(), 0, 8, 50), /^block 0 lines 8-9 [\s\S]*\[block 0 ends at line 9\]$/);
  assert.throws(() => formatLines(index(), 2, 1, 2), /no block 2 \(blocks 0-1\)/);
  assert.throws(() => formatLines(index(), 0, 0, 2), /at least 1/);
  assert.throws(() => formatLines(index(), 0, 5, 4), /end must be at least start/);
  assert.throws(() => formatLines(index(), 0, 10, 12), /has 9 lines/);
  assert.throws(
    () => formatLines(new MemtreeIndex({ ...PAGE, blocks: [], source_note: "shared without source" }), 0, 1, 1),
    /no transcript blocks \(shared without source\)/
  );
});

test("read_lines caps characters and lines, and says where to continue", () => {
  // Line 6 of block 1 is 50k chars: past the char cap after lines 1-5.
  const capped = formatLines(index(), 1, 1, 6);
  assert.match(capped, /^block 1 lines 1-5 /);
  assert.match(capped, /capped at 400 lines \/ 40000 chars per call: showed 1-5; continue with read_lines \{"block": 1, "start": 6, "end": 6\}/);
  // A single over-long line is shown truncated rather than not at all.
  const single = formatLines(index(), 1, 6, 6);
  assert.match(single, /\[line truncated: 50000 chars\]/);
  assert.ok(single.length < 41_000);

  const many = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
  const big = new MemtreeIndex({ nodes: [{ id: 0, s: "r", k: [] }], blocks: [many] });
  const text = formatLines(big, 0, 1, 1000);
  assert.equal(text.split("\n").filter((l) => /^\d+\t/.test(l)).length, READ_LINES_MAX_LINES);
  assert.match(text, /showed 1-400; continue with read_lines \{"block": 0, "start": 401, "end": 1000\}/);
});

/** A fake ccc proxy: `current` pointer plus page JSON, counting page fetches. */
function fakeProxyFetch(state) {
  return async (url) => {
    const u = new URL(url);
    state.urls.push(u.pathname + u.search);
    if (u.pathname === "/memtree/current") {
      if (!state.current) return new Response("{}", { status: 404 });
      return Response.json({ session_id: "session-1", id: state.current, url: `https://app/m/${state.current}` });
    }
    state.pageFetches++;
    return Response.json(state.pages[u.pathname] ?? { status: "building" });
  };
}

test("CurrentTree follows the proxy's current page and caches it until the page changes", async () => {
  const state = {
    urls: [],
    pageFetches: 0,
    current: "aaa111",
    pages: { "/memtree/aaa111.json": PAGE, "/memtree/bbb222.json": { ...PAGE, nodes: PAGE.nodes.slice(0, 2) } },
  };
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9/", sessionId: "session-1", fetch: fakeProxyFetch(state) });
  assert.equal((await tree.get()).nodes.size, 6);
  assert.equal((await tree.get()).nodes.size, 6);
  assert.equal(state.pageFetches, 1, "cached while the page is unchanged");
  assert.equal(state.urls[0], "/memtree/current?session=session-1");
  state.current = "bbb222";
  assert.equal((await tree.get()).nodes.size, 2);
  assert.equal(state.pageFetches, 2);

  state.current = "ccc333"; // still building: an error, not cached
  await assert.rejects(tree.get(), /still being built/);
  await assert.rejects(tree.get(), /still being built/);
  assert.equal(state.pageFetches, 4);
  state.current = undefined;
  await assert.rejects(tree.get(), /no MemTree yet/);
  await assert.rejects(new CurrentTree({}).get(), /need a running ccc session/);
});

test("CurrentTree returns prefixes transiently, throttles refreshes, then caches completion", async () => {
  let now = 0;
  let pageFetches = 0;
  let complete = false;
  const tree = new CurrentTree({
    proxyUrl: "http://mock",
    sessionId: "session-1",
    now: () => now,
    fetch: async (url) => {
      if (url.includes("/current")) return Response.json({ id: "page-a", session_id: "session-1" });
      pageFetches++;
      return Response.json(complete
        ? { ...PAGE, session_id: "session-1" }
        : { ...PAGE, session_id: "session-1", served_prefix: true });
    },
  });

  const [first, concurrent] = await Promise.all([tree.get(), tree.get()]);
  assert.equal(first.nodes.size, PAGE.nodes.length);
  assert.equal(concurrent, first, "concurrent callers share one fetch sequence");
  assert.equal(pageFetches, 1);
  await assert.rejects(tree.get(), /temporary prefix.*45 seconds/);
  now = 44_999;
  await assert.rejects(tree.get(), /temporary prefix.*1 second/);
  assert.equal(pageFetches, 1, "the prefix is not fetched again during its cooldown");

  now = 45_000;
  complete = true;
  assert.equal((await tree.get()).nodes.size, PAGE.nodes.length);
  assert.equal(pageFetches, 2);
  await tree.get();
  assert.equal(pageFetches, 2, "only the completed page is cached");
});

test("CurrentTree keeps prefix cooldown after a failed refresh and fetches a changed id immediately", async () => {
  let now = 0;
  let current = "page-a";
  let pageFetches = 0;
  let failRefresh = false;
  const tree = new CurrentTree({
    proxyUrl: "http://mock",
    sessionId: "session-1",
    now: () => now,
    fetch: async (url) => {
      if (url.includes("/current")) return Response.json({ id: current, session_id: "session-1" });
      pageFetches++;
      if (failRefresh) return new Response("temporarily unavailable", { status: 503 });
      return Response.json(current === "page-a"
        ? { ...PAGE, session_id: "session-1", served_prefix: true }
        : { ...PAGE, session_id: "session-1" });
    },
  });

  await tree.get();
  now = 45_000;
  failRefresh = true;
  await assert.rejects(tree.get(), /HTTP 503/);
  failRefresh = false;
  await assert.rejects(tree.get(), /temporary prefix.*45 seconds/);
  assert.equal(pageFetches, 2, "a failed refresh still starts a new cooldown");

  current = "page-b";
  assert.equal((await tree.get()).nodes.size, PAGE.nodes.length);
  assert.equal(pageFetches, 3, "a new current id can be fetched immediately");
  current = "page-a";
  await assert.rejects(tree.get(), /temporary prefix.*45 seconds/, "cooldown is tracked per page id");
  assert.equal(pageFetches, 3);
});

test("MCP handler: initialize, tools/list, tools/call results and errors", async () => {
  const tree = { get: async () => index() };
  const init = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    tree
  );
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "memtree");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, tree), undefined);

  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tree);
  assert.deepEqual(list.result.tools.map((t) => t.name), ["search", "read_node", "read_lines"]);
  assert.equal(list.result.tools, MEMTREE_TOOLS);

  const call = (name, args) =>
    handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, tree);
  const found = await call("search", { query: "8443" });
  assert.equal(found.result.isError, undefined);
  assert.match(found.result.content[0].text, /The billing service port is 8443/);
  assert.match((await call("read_node", { id: 5 })).result.content[0].text, /^node 5 · leaf/);
  assert.match((await call("read_lines", { block: 0, start: 5, end: 5 })).result.content[0].text, /5\tThe billing/);

  const bad = await call("read_lines", { block: 7, start: 1, end: 1 });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /no block 7/);
  assert.equal((await call("search", {})).result.isError, true);
  assert.equal((await call("nope", {})).error.code, -32602);
  assert.equal((await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "resources/list" }, tree)).error.code, -32601);
  const down = await handleMcpMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_node", arguments: { id: 0 } } },
    { get: async () => { throw new Error("MemTree unavailable"); } }
  );
  assert.equal(down.result.isError, true);
});

test("mcp config: bound to the proxy, argv prepended with = forms, detection in --mcp-config", () => {
  assert.equal(MEMTREE_TOOLS_HEADER_VALUE, "search,read_node,read_lines");
  const config = memtreeMcpConfig("http://127.0.0.1:1234");
  const server = config.mcpServers.memtree;
  assert.equal(server.env.CCC_MEMTREE_PROXY, "http://127.0.0.1:1234");
  assert.match(server.args[0], /dist\/memtree-mcp\.js$/);

  assert.deepEqual(withMemtreeMcpArgs(["hello"], "/tmp/m.json"), [
    "--mcp-config=/tmp/m.json",
    `--allowedTools=${MEMTREE_ALLOWED_TOOLS.join(",")}`,
    "hello",
  ]);
  assert.deepEqual(MEMTREE_ALLOWED_TOOLS, ["mcp__memtree__search", "mcp__memtree__read_node", "mcp__memtree__read_lines"]);

  assert.deepEqual(mcpConfigArgs(["-p", "q", "--mcp-config", "a.json", "b.json", "--strict-mcp-config", "--mcp-config=c", "--", "--mcp-config", "d"]),
    ["a.json", "b.json", "c"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-mcp-test-"));
  try {
    const probe = path.join(dir, "probe.json");
    fs.writeFileSync(probe, JSON.stringify({ mcpServers: { memtree: { command: "ccc", args: ["memtree-mcp"] } } }));
    assert.equal(argsConfigureMemtreeMcp(["-p", "q", "--mcp-config", "probe.json"], dir), true);
    assert.equal(argsConfigureMemtreeMcp([`--mcp-config=${JSON.stringify(config)}`]), true);
    fs.writeFileSync(probe, JSON.stringify({ mcpServers: { memtree: { command: "other-server" } } }));
    assert.equal(argsConfigureMemtreeMcp(["--mcp-config", probe]), false, "someone else's memtree server");
    assert.equal(argsConfigureMemtreeMcp(["--mcp-config", path.join(dir, "missing.json")]), false);
    assert.equal(argsConfigureMemtreeMcp(["-p", "q"]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("CurrentTree rejects missing or mismatched session identities before exposing a tree", async () => {
  let calls = 0;
  let pointerSession = "session-1";
  let pageSession = "session-1";
  const fetch = async (url) => {
    calls++;
    return Response.json(url.includes("/current")
      ? { id: "page-a", session_id: pointerSession }
      : { ...PAGE, session_id: pageSession });
  };
  await assert.rejects(new CurrentTree({ proxyUrl: "http://mock", fetch }).get(), /session id is missing/);
  assert.equal(calls, 0);
  for (const wrong of [undefined, "session-2"]) {
    pointerSession = wrong;
    const tree = new CurrentTree({ proxyUrl: "http://mock", sessionId: "session-1", fetch });
    await assert.rejects(tree.get(), /different or unknown session/);
    pointerSession = "session-1";
    pageSession = wrong;
    await assert.rejects(tree.get(), /different or unknown session/);
  }
  pageSession = "session-1";
  const tree = new CurrentTree({ proxyUrl: "http://mock", sessionId: "session-1", fetch });
  assert.equal((await tree.get()).nodes.size, PAGE.nodes.length);
  pointerSession = "session-2";
  await assert.rejects(tree.get(), /different or unknown session/, "cached trees also require a matching pointer");
});


test("CurrentTree rejects a mismatched page arriving after the matching pointer", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let pageRequested;
  const requested = new Promise((resolve) => { pageRequested = resolve; });
  const tree = new CurrentTree({
    proxyUrl: "http://mock", sessionId: "session-1",
    fetch: async (url) => {
      if (url.includes("/current")) return Response.json({ id: "a", session_id: "session-1" });
      pageRequested();
      return delayed;
    },
  });
  const result = tree.get();
  await requested;
  release(Response.json({ ...PAGE, session_id: "session-2" }));
  await assert.rejects(result, /different or unknown session/);
});
