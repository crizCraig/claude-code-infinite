import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const baseline = new URL("./fixtures/desktop-routing-main.json", import.meta.url);

for (const notice of ["0", "1"]) {
  test("desktop current-tree reads follow a PID session change with recall notice " + notice, { timeout: 10000 }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-desktop-routing-"));
    const sessions = path.join(home, "sessions");
    fs.mkdirSync(sessions);
    const setSession = sessionId => fs.writeFileSync(path.join(sessions, process.pid + ".json"),
      JSON.stringify({ pid: process.pid, sessionId }));
    setSession("a");
    const proxy = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/memtree/current") {
        const session = url.searchParams.get("session");
        res.end(JSON.stringify({ session_id: session, id: session }));
      } else if (/^\/memtree\/[ab]\.json$/.test(url.pathname)) {
        const session = path.basename(url.pathname, ".json");
        res.end(JSON.stringify({ session_id: session, request_id: session,
          nodes: [{ id: 0, s: "summary " + session, l: [0, 1, 1] }], blocks: ["transcript " + session] }));
      } else {
        res.writeHead(404).end(); // Exercise the page-backed search.
      }
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + proxy.address().port;
    const child = spawn(process.execPath, [cli, "memtree-mcp"], { stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: "a",
        CCC_MEMTREE_MCP_DESKTOP: "1", CCC_MEMTREE_MCP: "1", CCC_MEMTREE_PROXY: url, HTTPS_PROXY: "",
        CCC_MEMTREE_HOST_TOKEN: "", CCC_PROXY_VERSION: "", CCC_RECALL_PROXY_URL: url,
        CCC_RECALL_ACCOUNT: "fixture", CCC_RECALL_HOOKS_ACTIVE: "1", CCC_RECALL_NOTICE: notice } });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      child.stdin.end();
      await closed;
      await new Promise(resolve => proxy.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const replies = [];
    async function call(name, args) {
      const id = replies.length + 1;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        name, arguments: args, _meta: { "claudecode/toolUseId": "call-" + id },
      } }) + "\n");
      const reply = JSON.parse((await lines.next()).value);
      replies.push(reply);
      return reply.result.content[0].text;
    }
    const range = { tree: "current", block: 0, start: 1, end: 1 };
    assert.match(await call("read_lines", range), /transcript a/);
    setSession("b");
    assert.match(await call("read_lines", range), /transcript b/);
    await call("read_node", { node: "current#0" });
    await call("search", { query: "transcript", tree: "current", mode: "text" });
    // Full JSON-RPC replies captured with the same calls on origin/main (b446031).
    assert.deepEqual(replies, JSON.parse(fs.readFileSync(baseline, "utf8")));
  });
}
