import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  formatLines,
  formatNode,
  formatSearch,
  formatSearchHits,
  MemtreeIndex,
  parseNodeAddress,
  queryTerms,
  serverSearchHits,
  READ_LINES_MAX_LINES,
  ToolInputError,
} from "../dist/memtree-tools.js";
import {
  CurrentTree,
  handleMcpMessage,
  MEMTREE_MCP_INSTRUCTIONS,
  MEMTREE_TOOLS,
  SessionFinder,
} from "../dist/memtree-mcp.js";
import { formatSessions, formatSearchResults, searchQuery, sessionsQuery } from "../dist/memtree-finder.js";
import { readProjectMeta, repoNameFromRemote } from "../dist/project-meta.js";
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

test("scoped finder responses must confirm the requested tree; unscoped legacy hits work", async () => {
  let body = { hits: [{ id: "s", tree: { request_id: "other" }, range: { block: 0, start: 1, end: 2 } }] };
  const finder = new SessionFinder({ proxyUrl: "http://localhost:9", fetch: async () => Response.json(body) });
  await assert.rejects(finder.searchSessions({ query: "x", mode: "vector" }, "wanted"), /confirm.*tree/);
  assert.match(await finder.searchSessions({ query: "x" }), /read_lines/);
  body = { ...body, tree: "wrong" };
  await assert.rejects(finder.searchSessions({ query: "x" }, "wanted"), /confirm.*tree/);
  body = { ...body, tree: "wanted" };
  assert.match(await finder.searchSessions({ query: "x" }, "wanted"), /read_lines/);
});

test("current search and prefix cache enforce the page session", async () => {
  const fetch = async (url) => Response.json(String(url).includes("/current")
    ? { id: "page", session_id: "A" }
    : String(url).includes("/search")
      ? { terms: ["billing"], hits: [], session_id: "B" }
      : { ...PAGE, session_id: "B", served_prefix: true });
  const tree = new CurrentTree({ proxyUrl: "http://localhost:9", sessionId: "A", fetch });
  await assert.rejects(tree.search("billing", 10), /different.*session/);
  await tree.get("page");
  await assert.rejects(tree.get(), /different.*session/);
  await assert.rejects(tree.currentId(true), /different.*session/);
});

test("old per-tree search without session identity falls back to a validated page", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    return Response.json(String(url).includes("/current") ? { id: "page", session_id: "A" }
      : String(url).includes("/search") ? { terms: ["billing"], hits: [] }
      : { ...PAGE, session_id: "A" });
  };
  const tree = new CurrentTree({ proxyUrl: "http://localhost:9", sessionId: "A", fetch });
  assert.match(await tree.search("billing", 10), /best match/);
  assert.ok(urls.some((url) => url.endsWith("page.json")));
});

test("invalid JSON-RPC values do not kill the stdio queue", () => {
  const messages = [null, [], 42, { method: "ping", id: {} },
    { jsonrpc: "2.0", id: 7, method: "ping" }];
  const child = spawnSync(process.execPath, ["dist/memtree-mcp.js"], {
    input: messages.map(JSON.stringify).join("\n") + "\n", encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const answers = child.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(answers.length, messages.length);
  assert.ok(answers.slice(0, -1).every((a) => a.error.code === -32600));
  assert.deepEqual(answers.at(-1), { jsonrpc: "2.0", id: 7, result: {} });
});

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

test("CurrentTree serves a prefix through its cooldown, refreshes after it, then caches completion", async () => {
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
  assert.equal(await tree.get(), first, "the last prefix is served during its cooldown");
  now = 44_999;
  assert.equal(await tree.get(), first);
  assert.equal(pageFetches, 1, "the prefix is not fetched again during its cooldown");

  now = 45_000;
  complete = true;
  assert.equal((await tree.get()).nodes.size, PAGE.nodes.length);
  assert.equal(pageFetches, 2);
  await tree.get();
  assert.equal(pageFetches, 2, "only the completed page is cached");
});

test("CurrentTree keeps at most four stored prefixes; an evicted one waits out its cooldown", async () => {
  let pageFetches = 0;
  const tree = new CurrentTree({
    proxyUrl: "http://mock",
    now: () => 0,
    fetch: async () => {
      pageFetches++;
      return Response.json({ ...PAGE, served_prefix: true });
    },
  });
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) await tree.get(id);
  assert.equal(pageFetches, 5);
  await tree.get("p5");
  assert.equal(pageFetches, 5, "a stored prefix is served without a fetch");
  await assert.rejects(tree.get("p1"), /temporary prefix.*45 seconds/, "evicted: no copy to serve");
  assert.equal(pageFetches, 5, "and no fetch before its cooldown ends");
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
  const prefix = await (async () => {
    await assert.rejects(tree.get(), /HTTP 503/);
    failRefresh = false;
    return tree.get();
  })();
  assert.equal(prefix.nodes.size, PAGE.nodes.length, "the stored prefix is served after a failed refresh");
  assert.equal(pageFetches, 2, "a failed refresh still starts a new cooldown");

  current = "page-b";
  assert.equal((await tree.get()).nodes.size, PAGE.nodes.length);
  assert.equal(pageFetches, 3, "a new current id can be fetched immediately");
  current = "page-a";
  assert.equal(await tree.get(), prefix, "cooldown and stored prefix are tracked per page id");
  assert.equal(pageFetches, 3);
});

for (const explicit of [false, true]) {
  test(`CurrentTree refreshes a temporary prefix for ${explicit ? "an explicit" : "the current"} tree`, async () => {
    const id = "aaa111";
    const path = `/memtree/${id}.json`;
    const state = {
      urls: [], pageFetches: 0, current: id,
      pages: { [path]: { ...PAGE, session_id: "session-1", served_prefix: true, nodes: PAGE.nodes.slice(0, 2) } },
    };
    let clock = 0;
    const tree = new CurrentTree({
      proxyUrl: "http://127.0.0.1:9", sessionId: "session-1", now: () => clock, fetch: fakeProxyFetch(state),
    });
    const requested = explicit ? id : undefined;
    assert.equal((await tree.get(requested)).nodes.size, 2, "prefix remains readable while building");
    state.pages[path] = { ...PAGE, session_id: "session-1" };
    clock += 45_001; // past the temporary-prefix recheck cooldown
    const completed = await tree.get(requested);
    assert.equal(completed.nodes.size, 6, "same request id resolves to the completed tree");
    assert.equal(await tree.get(requested), completed, "completed tree stays cached");
    assert.equal(state.pageFetches, 2);
  });
}

test("CurrentTree caches immutable pinned served trees", async () => {
  for (const version of [1, 3]) {
    const ref = `ea18af90-658b-485f-ad71-063e0ca5e724-v${version}-served`;
    const state = {
      urls: [], pageFetches: 0,
      pages: { [`/memtree/${ref}.json`]: { ...PAGE, served_prefix: true, ref } },
    };
    const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9", fetch: fakeProxyFetch(state) });
    const first = await tree.get(ref);
    assert.equal(await tree.get(ref), first, "a pinned served tree cannot switch to the own tree");
    assert.equal(state.pageFetches, 1);
  }
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
  assert.deepEqual(list.result.tools.map((t) => t.name), [
    "search",
    "read_node",
    "read_lines",
    "list",
  ]);
  assert.equal(list.result.tools, MEMTREE_TOOLS);

  const call = (name, args) =>
    handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, tree);
  const found = await call("search", { query: "8443", tree: "current" });
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

test("search routes by tree and mode; read_node and read_lines take node addresses", async () => {
  const seen = [];
  const tree = {
    get: async (t) => (seen.push(["get", t]), index()),
    search: async (q, limit, t) => (seen.push(["tree-search", q, t]), "tree hits"),
    currentId: async () => "cur-id",
  };
  const finder = {
    listSessions: async () => "sessions",
    searchSessions: async (args, t) => (seen.push(["server-search", args.mode ?? "text", t]), "server hits"),
  };
  const call = async (name, args) =>
    (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tree, finder))
      .result.content[0].text;

  assert.equal(await call("search", { query: "x", tree: "current" }), "tree hits");
  assert.equal(await call("search", { query: "x", tree: "abc-v1-own" }), "tree hits");
  assert.equal(await call("search", { query: "x" }), "server hits");
  assert.equal(await call("search", { query: "x", mode: "vector", tree: "current" }), "server hits");
  assert.equal(await call("search", { query: "x", mode: "vector", tree: "abc-v1-own" }), "server hits");
  assert.deepEqual(seen, [
    ["tree-search", "x", undefined],
    ["tree-search", "x", "abc-v1-own"],
    ["server-search", "text", undefined],
    ["server-search", "vector", "cur-id"],
    ["server-search", "vector", "abc-v1-own"],
  ]);
  assert.equal(await call("list", {}), "sessions");

  seen.length = 0;
  assert.match(await call("read_node", { node: "abc-v1-own#5" }), /^node 5 · leaf/);
  assert.match(await call("read_lines", { node: "abc-v1-own#5" }), /^block 1 lines 1-5 .*\n1\tMessage 4 from user/);
  assert.deepEqual(seen, [["get", "abc-v1-own"], ["get", "abc-v1-own"]]);
  assert.match(await call("read_lines", { node: "abc-v1-own#0" }), /is a branch; read_node/);
  assert.match(await call("read_node", { node: "abc#x" }), /node must be an address/);
  assert.match(await call("read_node", { node: "../x#1" }), /node must be an address/);
  assert.match(await call("read_node", { id: 0, tree: "current" }), /^node 0/);
  assert.deepEqual(parseNodeAddress(" t-v3-served#12 "), { tree: "t-v3-served", id: 12 });
});

test("hits show their node address and path from the root", () => {
  const hit = {
    id: "s1", kind: "claude_code_session", session_id: "s1",
    tree: { request_id: "r1", ref: "r1-v1-own" }, range: { block: 0, start: 3, end: 4 },
    address: "r1-v1-own#7", node: 7,
    path: [{ id: 0, summary: "Deploys" }, { id: 2, summary: "Staging rollout" }],
    snippet: "port **8443**", score: 0.5,
  };
  const text = formatSearchResults({ query: "8443", hits: [hit] }, { query: "8443" });
  assert.match(text, /path: Deploys \(r1-v1-own#0\) › Staging rollout \(r1-v1-own#2\)/);
  assert.match(text, /address: r1-v1-own#7/);
  assert.match(text, /read_node \{"node": <address>\}/);
  const local = serverSearchHits({ terms: ["8443"], hits: [{ id: 5, leaf: true, summary: "s", address: "r#5",
    path: [{ id: 0, summary: "root" }] }] });
  const shown = formatSearchHits(local.hits, "8443", local.terms);
  assert.match(shown, /address: r#5/);
  assert.match(shown, /path: root \(node 0\)/);
});

test("mcp config: bound to the proxy, argv prepended with = forms, detection in --mcp-config", () => {
  assert.equal(MEMTREE_TOOLS_HEADER_VALUE, "search,read_node,read_lines,list");
  const config = memtreeMcpConfig("http://127.0.0.1:1234");
  const server = config.mcpServers.memtree;
  assert.equal(server.env.CCC_MEMTREE_PROXY, "http://127.0.0.1:1234");
  assert.match(server.args[0], /dist\/memtree-mcp\.js$/);

  assert.deepEqual(withMemtreeMcpArgs(["hello"], "/tmp/m.json"), [
    "--mcp-config=/tmp/m.json",
    `--allowedTools=${MEMTREE_ALLOWED_TOOLS.join(",")}`,
    "hello",
  ]);
  assert.deepEqual(MEMTREE_ALLOWED_TOOLS, [
    "mcp__memtree__search",
    "mcp__memtree__read_node",
    "mcp__memtree__read_lines",
    "mcp__memtree__list",
  ]);

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

test("CurrentTree search: the server's tree search first, the page JSON when the server lacks it", async () => {
  const urls = [];
  let serverHasSearch = true;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    urls.push(u.pathname + u.search);
    if (u.pathname === "/memtree/current") return Response.json({ id: "aaa111", session_id: "session-1" });
    if (u.pathname.endsWith("/search")) {
      if (!serverHasSearch) return Response.json({ detail: "Not Found" }, { status: 404 });
      return Response.json({
        query: u.searchParams.get("q"),
        session_id: "session-1",
        terms: ["8443"],
        hits: [{ id: 5, leaf: true, depth: 2, summary: "Billing port", range: { block: 0, start: 5, end: 5 },
                 matched_terms: ["8443"], line_hits: 1, score: 120, snippets: [{ line: 5, text: "port 8443" }] }],
      });
    }
    return Response.json({ ...PAGE, session_id: "session-1" });
  };
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9", sessionId: "session-1", fetch: fetchImpl });
  const viaServer = await tree.search("8443", 3);
  assert.match(viaServer, /\[node 5 · leaf · depth 2 · block 0 lines 5-5 · matched 8443 · 1 matching line\]/);
  assert.match(viaServer, /L5: port 8443/);
  assert.deepEqual(urls, ["/memtree/current?session=session-1", "/memtree/aaa111/search?q=8443&limit=3"], "no page download");

  const other = await tree.search("8443", undefined, "bbb222");
  assert.equal(urls.at(-1), "/memtree/bbb222/search?q=8443");
  assert.match(other, /read_lines \{"tree": "bbb222", block, start, end\}/);

  serverHasSearch = false;
  urls.length = 0;
  const local = await tree.search("8443");
  assert.match(local, /The billing service port is 8443/);
  assert.deepEqual(urls, [
    "/memtree/current?session=session-1", "/memtree/aaa111/search?q=8443",
    "/memtree/current?session=session-1", "/memtree/aaa111.json",
  ]);
  urls.length = 0;
  await tree.search("8443");
  assert.deepEqual(urls, ["/memtree/current?session=session-1"], "an old server is asked once; the page stays cached");
});

test("tree tools read another session's tree by id, cached, with follow-ups naming it", async () => {
  const pageFetches = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/memtree/current") return Response.json({ id: "cur" });
    pageFetches.push(u.pathname);
    return Response.json(PAGE);
  };
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9", fetch: fetchImpl });
  const call = (name, args) =>
    handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tree);
  const lines = await call("read_lines", { tree: "ea18af90-658b-485f-ad71-063e0ca5e724", block: 0, start: 5, end: 5 });
  assert.match(lines.result.content[0].text, /5\tThe billing/);
  const node = await call("read_node", { tree: "ea18af90-658b-485f-ad71-063e0ca5e724", id: 5 });
  assert.match(node.result.content[0].text, /read_lines \{"tree": "ea18af90-658b-485f-ad71-063e0ca5e724", "block": 1/);
  assert.deepEqual(pageFetches, ["/memtree/ea18af90-658b-485f-ad71-063e0ca5e724.json"], "fetched once");
  for (const id of ["t1", "t2", "t3", "t4"]) await call("read_node", { tree: id, id: 0 });
  await call("read_node", { tree: "ea18af90-658b-485f-ad71-063e0ca5e724", id: 0 });
  assert.equal(pageFetches.length, 6, "least recently used tree evicted after four others");
  const bad = await call("read_node", { tree: "../x", id: 0 });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /tree must be a tree reference/);
});

test("finder follow-ups preserve pinned tree references and fall back for older servers", async () => {
  const request_id = "ea18af90-658b-485f-ad71-063e0ca5e724";
  const state = { urls: [], pageFetches: 0, pages: {} };
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9", fetch: fakeProxyFetch(state) });
  for (const suffix of ["-v1-own", "-v3-served", undefined]) {
    const ref = suffix ? `${request_id}${suffix}` : undefined;
    const target = ref ?? request_id;
    const identity = { request_id, ...(ref ? { ref } : {}) };
    const sessions = formatSessions({ sessions: [{ id: "session", latest_tree: identity }] }, {});
    assert.ok(sessions.includes(`read_node {"tree": "${target}", "id": 0}`));
    assert.ok(sessions.includes(`search {"tree": "${target}", "query":`));
    const hit = { id: "session", tree: identity, range: { block: 0, start: 1, end: 2 } };
    for (const body of [{ hits: [hit] }, { groups: [{ embedding_model: "mock", hits: [hit] }] }]) {
      const result = formatSearchResults(body, { query: "test" });
      assert.ok(result.includes(`read_lines {"tree": "${target}", "block": 0, "start": 1, "end": 2}`));
    }
    state.pages[`/memtree/${target}.json`] = PAGE;
    assert.equal((await tree.get(target)).nodes.size, PAGE.nodes.length);
    assert.equal(state.urls.at(-1), `/memtree/${target}.json`);
  }
  const before = state.urls.length;
  await assert.rejects(tree.get(`${request_id}-v1-own/../search`), /tree must be/);
  assert.equal(state.urls.length, before);
});

test("finder query strings: filters pass through, mode defaults to text, tree scopes, limits clamp", () => {
  assert.equal(sessionsQuery({}), "");
  assert.equal(
    sessionsQuery({ since: "2026-09-01", project: " polychat ", q: "deploy", cursor: "abc", limit: 500 }),
    "?since=2026-09-01&project=polychat&q=deploy&cursor=abc&limit=100"
  );
  assert.equal(searchQuery({ query: "how did we deploy" }), "?q=how+did+we+deploy&mode=text");
  assert.equal(searchQuery({ query: "x", mode: "vector" }, "t-v1-own"), "?q=x&mode=vector&tree=t-v1-own");
  assert.equal(searchQuery({ query: "x", mode: "TEXT", limit: 0, until: "2026-09-30" }), "?q=x&mode=text&until=2026-09-30&limit=1");
  assert.throws(() => searchQuery({ query: " " }), ToolInputError);
  assert.throws(() => searchQuery({ query: "x", mode: "fuzzy" }), /mode must be/);
  assert.throws(() => sessionsQuery({ since: 5 }), /since must be a string/);
});

test("MCP instructions mention the cross-session tools and stay constant", () => {
  assert.match(MEMTREE_MCP_INSTRUCTIONS, /\blist\b/);
  assert.match(MEMTREE_MCP_INSTRUCTIONS, /"tree": "current"/);
  assert.doesNotMatch(MEMTREE_MCP_INSTRUCTIONS, /_sessions/);
  const search = MEMTREE_TOOLS.find((t) => t.name === "search");
  for (const description of [MEMTREE_MCP_INSTRUCTIONS, search.description]) {
    assert.match(description, /text.*default/i);
    assert.match(description, /address/i);
    assert.match(description, /first page.*charged/i);
    assert.match(description, /cached/i);
    assert.match(description, /cursor continuation.*free/i);
    assert.match(description, /text.*free/i);
    assert.match(description, /live.*snapshot/i);
  }
  assert.match(search.inputSchema.properties.mode.description, /first page.*charged/i);
  assert.equal(search.inputSchema.properties.mode.enum.join(","), "text,vector");
  for (const name of ["search", "read_node", "read_lines"]) {
    const tree = MEMTREE_TOOLS.find((t) => t.name === name).inputSchema.properties.tree;
    assert.ok(tree, name);
    assert.match(tree.description, /reference from list or search.*"current"/i);
    assert.match(tree.description, /legacy request ids/i);
  }
});

test("project meta: owner/repo only from any remote form, failures leave parts out", async () => {
  for (const [remote, expected] of [
    ["https://github.com/acme/polychat.git", "acme/polychat"],
    ["https://user:ghp_secret@github.com/acme/polychat", "acme/polychat"],
    ["git@github.com:acme/polychat.git", "acme/polychat"],
    ["ssh://git@gitlab.example.com:2222/group/sub/repo.git", "sub/repo"],
    ["/Users/me/src/polychat", "src/polychat"],
    ["https://github.com/acme/polychat.git?token=x#frag", "acme/polychat"],
    ["", undefined],
  ]) {
    assert.equal(repoNameFromRemote(remote), expected, remote);
  }
  const git = async (args) =>
    ({ "remote get-url origin": "git@github.com:acme/polychat.git", "rev-parse --abbrev-ref HEAD": "main",
       "rev-parse --short HEAD": "c6fe251" })[args.join(" ")];
  assert.deepEqual(await readProjectMeta("/Users/me/src/polychat", git), {
    project_dir: "polychat", git_repo: "acme/polychat", git_branch: "main", git_commit: "c6fe251",
  });
  const detached = async (args) => (args.includes("--abbrev-ref") ? "HEAD" : undefined);
  assert.deepEqual(await readProjectMeta("/tmp/not a repo", detached), { project_dir: "not a repo" });
  // The real runner outside a repository: resolves, never throws.
  const outside = await readProjectMeta(os.tmpdir());
  assert.equal(outside.project_dir, path.basename(os.tmpdir()));
});
