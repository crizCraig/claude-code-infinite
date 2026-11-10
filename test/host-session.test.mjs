// The memtree MCP server is started with the session id Claude Code had at launch.
// Resuming through the picker (`ccc --resume` with no id), /resume and /clear move the
// process to another session without restarting that server, so its "current" tree
// lookups asked about a session with no page (2026-11-09: "no MemTree yet" on a
// 14,261-message session). The proxy now tells its own Claude Code's MCP server which
// session that process is on.
import test from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { CurrentTree, refreshHostSession } from "../dist/memtree-mcp.js";
import { memtreeMcpConfig } from "../dist/memtree-mcp-config.js";

const HOST_PID = 4242;

async function harness() {
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "offline" });
  memtree.compress = async () => null;
  memtree.indexInBackground = () => {};
  const proxy = await startProxy({ memtree, upstreamOrigin: "http://127.0.0.1:1" });
  return proxy;
}

/** A SessionStart relay post from the Claude Code process `claudePid` (hooks.ts). */
async function hook(proxy, input, claudePid = HOST_PID) {
  const res = await fetch(proxy.hookUrl, { method: "POST",
    headers: { "content-type": "application/json",
      ...(claudePid === null ? {} : { "x-ccc-claude-pid": String(claudePid) }) },
    body: JSON.stringify(input) });
  await res.arrayBuffer();
}

async function hostSession(proxy, query, token = proxy.hostToken) {
  const res = await fetch(`http://127.0.0.1:${proxy.port}/memtree/host-session${query}`,
    { headers: token === null ? {} : { "x-ccc-host-token": token } });
  return { status: res.status, body: await res.json() };
}

test("the proxy names its own Claude Code's current session, to that process only", async () => {
  const proxy = await harness();
  try {
    const start = (source, session_id, extra = {}, claudePid = HOST_PID) =>
      hook(proxy, { hook_event_name: "SessionStart", source, session_id, ...extra }, claudePid);
    await start("resume", "too-early");
    proxy.setHostPid(HOST_PID);
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).status, 404,
      "a session start before the process was recorded names nothing");
    await start("resume", "resumed-1");
    assert.deepEqual(await hostSession(proxy, `?host_pid=${HOST_PID}`),
      { status: 200, body: { session_id: "resumed-1" } });
    for (const query of ["", "?host_pid=1", "?host_pid=abc", `?host_pid=${HOST_PID}x`]) {
      assert.equal((await hostSession(proxy, query)).status, 404, `another process: ${query}`);
    }
    await start("startup", "subagent-session", { agent_id: "a1" });
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).body.session_id, "resumed-1",
      "a subagent's start does not move the process");
    // A teammate Claude Code loads the same plugin and MCP config, from another process.
    await start("startup", "teammate-session", {}, HOST_PID + 1);
    await start("startup", "no-pid-session", {}, null);
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).body.session_id, "resumed-1",
      "another process's start does not move this one");
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID + 1}`)).status, 404,
      "a teammate's server has the token but another parent");
    for (const token of [null, "", "wrong", proxy.hostToken + "x"]) {
      assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`, token)).status, 404,
        `the pid alone is not enough: ${token}`);
    }
    await start("fork", "forked-3");
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).body.session_id, "forked-3");
    await start("clear", "cleared-2");
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).body.session_id, "cleared-2");
    await start("compact", "cleared-2");
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).body.session_id, "cleared-2");
  } finally {
    proxy.close();
  }
});

test("a proxy that never saw a session start names none", async () => {
  const proxy = await harness();
  try {
    proxy.setHostPid(HOST_PID);
    assert.equal((await hostSession(proxy, `?host_pid=${HOST_PID}`)).status, 404);
  } finally {
    proxy.close();
  }
});

test("the MCP server follows the process's session, and keeps its own id otherwise", async () => {
  const urls = [], tokens = [];
  let answer = () => Response.json({ session_id: "resumed-1" });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    urls.push(u.pathname + u.search);
    if (u.pathname === "/memtree/host-session") tokens.push(init?.headers?.["x-ccc-host-token"]);
    if (u.pathname === "/memtree/host-session") return answer();
    if (u.pathname === "/memtree/current") return new Response("{}", { status: 404 });
    throw new Error(`unexpected ${u.pathname}`);
  };
  const deps = { proxyUrl: "http://127.0.0.1:9/", sessionId: "launch-0", hostToken: "secret",
    fetch: fetchImpl };
  await refreshHostSession(deps, HOST_PID);
  assert.equal(urls[0], `/memtree/host-session?host_pid=${HOST_PID}`);
  assert.deepEqual(tokens, ["secret"]);
  assert.equal(deps.sessionId, "resumed-1");
  await assert.rejects(new CurrentTree(deps).get(), /no MemTree yet/);
  assert.equal(urls.at(-1), "/memtree/current?session=resumed-1");

  for (const [why, next] of [
    ["an older proxy", () => new Response("{}", { status: 404 })],
    ["a malformed answer", () => Response.json({ session_id: 7 })],
    ["an empty id", () => Response.json({ session_id: "" })],
    ["a network error", () => { throw new Error("down"); }],
  ]) {
    answer = next;
    const kept = { proxyUrl: "http://127.0.0.1:9/", sessionId: "launch-0", hostToken: "secret",
      fetch: fetchImpl };
    await refreshHostSession(kept, HOST_PID);
    assert.equal(kept.sessionId, "launch-0", why);
  }
  const noProxy = { sessionId: "launch-0", hostToken: "secret", fetch: fetchImpl };
  await refreshHostSession(noProxy, HOST_PID);
  assert.equal(noProxy.sessionId, "launch-0", "no proxy configured");
  // An older ccc's config has no token and its proxy no such route (it would relay the
  // path to the server as a page id): nothing is asked.
  const asked = urls.length;
  const older = { proxyUrl: "http://127.0.0.1:9/", sessionId: "launch-0", fetch: fetchImpl };
  answer = () => Response.json({ session_id: "resumed-1" });
  await refreshHostSession(older, HOST_PID);
  assert.equal(older.sessionId, "launch-0");
  assert.equal(urls.length, asked, "no request without a token");
});

test("ccc's MCP config carries the host token, and only when there is one", () => {
  const env = (token) => memtreeMcpConfig("http://127.0.0.1:1", token).mcpServers.memtree.env;
  assert.equal(env("secret").CCC_MEMTREE_HOST_TOKEN, "secret");
  assert.ok(!("CCC_MEMTREE_HOST_TOKEN" in env(undefined)));
});

test("a cached page is not reused after the process moves to another session", async () => {
  // Both sessions' pointers name the same page id; the page belongs to the first.
  const page = { session_id: "session-a", nodes: [{ id: 0, s: "root", k: [] }], blocks: ["x"] };
  let pageFetches = 0;
  const deps = { proxyUrl: "http://127.0.0.1:9/", sessionId: "session-a",
    fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname === "/memtree/current") {
        return Response.json({ session_id: u.searchParams.get("session"), id: "same1",
          url: "https://app/m/same1" });
      }
      pageFetches++;
      return Response.json(page);
    } };
  const tree = new CurrentTree(deps);
  await tree.get();
  await tree.get();
  assert.equal(pageFetches, 1);
  deps.sessionId = "session-b";
  await assert.rejects(tree.get(), /session/i, "session-a's page is checked again, and refused");
  assert.equal(pageFetches, 2);
});
