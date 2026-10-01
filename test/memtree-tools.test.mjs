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
      return Response.json({ id: state.current, url: `https://app/m/${state.current}` });
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
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9/", sessionId: "sess 1", fetch: fakeProxyFetch(state) });
  assert.equal((await tree.get()).nodes.size, 6);
  assert.equal((await tree.get()).nodes.size, 6);
  assert.equal(state.pageFetches, 1, "cached while the page is unchanged");
  assert.equal(state.urls[0], "/memtree/current?session=sess%201");
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

for (const explicit of [false, true]) {
  test(`CurrentTree refreshes a temporary prefix for ${explicit ? "an explicit" : "the current"} tree`, async () => {
    const id = "aaa111";
    const path = `/memtree/${id}.json`;
    const state = {
      urls: [], pageFetches: 0, current: id,
      pages: { [path]: { ...PAGE, served_prefix: true, nodes: PAGE.nodes.slice(0, 2) } },
    };
    const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9", fetch: fakeProxyFetch(state) });
    const requested = explicit ? id : undefined;
    assert.equal((await tree.get(requested)).nodes.size, 2, "prefix remains readable while building");
    state.pages[path] = PAGE;
    const completed = await tree.get(requested);
    assert.equal(completed.nodes.size, 6, "same request id resolves to the completed tree");
    assert.equal(await tree.get(requested), completed, "completed tree stays cached");
    assert.equal(state.pageFetches, 2);
  });
}

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
    "list_sessions",
    "search_sessions",
  ]);
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
  assert.equal(MEMTREE_TOOLS_HEADER_VALUE, "search,read_node,read_lines,list_sessions,search_sessions");
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
    "mcp__memtree__list_sessions",
    "mcp__memtree__search_sessions",
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

test("CurrentTree search: the server's tree search first, the page JSON when the server lacks it", async () => {
  const urls = [];
  let serverHasSearch = true;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    urls.push(u.pathname + u.search);
    if (u.pathname === "/memtree/current") return Response.json({ id: "aaa111" });
    if (u.pathname.endsWith("/search")) {
      if (!serverHasSearch) return Response.json({ detail: "Not Found" }, { status: 404 });
      return Response.json({
        query: u.searchParams.get("q"),
        terms: ["8443"],
        hits: [{ id: 5, leaf: true, depth: 2, summary: "Billing port", range: { block: 0, start: 5, end: 5 },
                 matched_terms: ["8443"], line_hits: 1, score: 120, snippets: [{ line: 5, text: "port 8443" }] }],
      });
    }
    return Response.json(PAGE);
  };
  const tree = new CurrentTree({ proxyUrl: "http://127.0.0.1:9", fetch: fetchImpl });
  const viaServer = await tree.search("8443", 3);
  assert.match(viaServer, /\[node 5 · leaf · depth 2 · block 0 lines 5-5 · matched 8443 · 1 matching line\]/);
  assert.match(viaServer, /L5: port 8443/);
  assert.deepEqual(urls, ["/memtree/current", "/memtree/aaa111/search?q=8443&limit=3"], "no page download");

  const other = await tree.search("8443", undefined, "bbb222");
  assert.equal(urls.at(-1), "/memtree/bbb222/search?q=8443");
  assert.match(other, /read_lines \{"tree": "bbb222", block, start, end\}/);

  serverHasSearch = false;
  urls.length = 0;
  const local = await tree.search("8443");
  assert.match(local, /The billing service port is 8443/);
  assert.deepEqual(urls, ["/memtree/current", "/memtree/aaa111/search?q=8443", "/memtree/current", "/memtree/aaa111.json"]);
  urls.length = 0;
  await tree.search("8443");
  assert.deepEqual(urls, ["/memtree/current"], "an old server is asked once; the page stays cached");
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
  assert.match(bad.result.content[0].text, /tree must be a request id/);
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

test("finder query strings: filters pass through, mode defaults to vector, limits clamp", () => {
  assert.equal(sessionsQuery({}), "");
  assert.equal(
    sessionsQuery({ since: "2026-09-01", project: " polychat ", q: "deploy", cursor: "abc", limit: 500 }),
    "?since=2026-09-01&project=polychat&q=deploy&cursor=abc&limit=100"
  );
  assert.equal(searchQuery({ query: "how did we deploy" }), "?q=how+did+we+deploy&mode=vector");
  assert.equal(searchQuery({ query: "x", mode: "TEXT", limit: 0, until: "2026-09-30" }), "?q=x&mode=text&until=2026-09-30&limit=1");
  assert.throws(() => searchQuery({ query: " " }), ToolInputError);
  assert.throws(() => searchQuery({ query: "x", mode: "fuzzy" }), /mode must be/);
  assert.throws(() => sessionsQuery({ since: 5 }), /since must be a string/);
});

test("MCP instructions mention the cross-session tools and stay constant", () => {
  assert.match(MEMTREE_MCP_INSTRUCTIONS, /list_sessions/);
  assert.match(MEMTREE_MCP_INSTRUCTIONS, /search_sessions/);
  const search = MEMTREE_TOOLS.find((t) => t.name === "search_sessions");
  assert.match(search.description, /charged a small per-query embedding cost/);
  assert.match(search.description, /free/);
  assert.equal(search.inputSchema.properties.mode.enum.join(","), "vector,text");
  for (const name of ["search", "read_node", "read_lines"]) {
    assert.ok(MEMTREE_TOOLS.find((t) => t.name === name).inputSchema.properties.tree, name);
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
