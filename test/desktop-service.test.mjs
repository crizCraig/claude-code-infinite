// PROTOTYPE (proto/desktop-app): the ccc desktop service (src/desktop-service.ts) and the
// desktop flavour of the memtree MCP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  desktopEnvLines, desktopPaths, setupDesktopFiles, startDesktopService, workingDirectoryFromBody,
} from "../dist/desktop-service.js";
import { desktopMcpTarget, handleMcpMessage } from "../dist/memtree-mcp.js";

test("the working directory comes from Claude Code's system prompt, JSON-escaped", () => {
  const body = JSON.stringify({ system: [{ type: "text", text: "env:\n - Primary working directory: /Users/a/proj\n - Is a git repo" }] });
  assert.equal(workingDirectoryFromBody(body), "/Users/a/proj");
  assert.equal(workingDirectoryFromBody(JSON.stringify({ system: "no env here" })), undefined);
  assert.equal(workingDirectoryFromBody("Primary working directory: relative/dir\\n"), undefined);
});

test("the desktop MCP entry follows a ccc proxy and is inert elsewhere", () => {
  const token = "a".repeat(48);
  assert.deepEqual(desktopMcpTarget({ HTTPS_PROXY: `http://ccc:${token}@127.0.0.1:4567` }),
    { proxyUrl: "http://127.0.0.1:4567", token });
  // Terminal ccc (base-URL mode) keeps working through the same user-scope entry.
  assert.deepEqual(desktopMcpTarget({ ANTHROPIC_BASE_URL: "http://127.0.0.1:999" }),
    { proxyUrl: "http://127.0.0.1:999" });
  // Desktop without the ccc lines: its own base URL is api.anthropic.com.
  assert.equal(desktopMcpTarget({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), undefined);
  assert.equal(desktopMcpTarget({ HTTPS_PROXY: "http://corp:8080" }), undefined);
});

test("an inert server lists no tools and gives no instructions", async () => {
  const tree = {};
  const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, tree, undefined, undefined, undefined, true);
  assert.equal(init.result.instructions, undefined);
  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tree, undefined, undefined, undefined, true);
  assert.deepEqual(list.result.tools, []);
  const live = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, tree);
  assert.ok(live.result.tools.length > 0);
});

test("the service: token on CONNECT and loopback routes, session calls reach the upstream", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-desktop-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url, session: req.headers["x-claude-code-session-id"], auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-test",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  const memtree = http.createServer((req, res) => { req.resume(); res.writeHead(503); res.end(); });
  await Promise.all([listen(upstream), listen(memtree)]);
  t.after(() => { upstream.close(); memtree.close(); });

  const paths = desktopPaths(dir, "local");
  const state = await setupDesktopFiles(paths, "local");
  assert.equal(fs.statSync(paths.leafKey).mode & 0o777, 0o600);
  assert.ok(desktopEnvLines(paths, state)[0].startsWith(`HTTPS_PROXY=http://ccc:${state.token}@127.0.0.1:`));
  const service = await startDesktopService({
    paths, state, apiKey: "test-key",
    memtreeBaseUrl: `http://127.0.0.1:${memtree.address().port}`,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    log: () => {},
  });
  t.after(() => service.close());

  assert.equal(await connectStatus(state.port, ""), 407);
  const good = `Basic ${Buffer.from(`ccc:${state.token}`).toString("base64")}`;
  const ca = fs.readFileSync(paths.caPem, "utf8");
  const body = JSON.stringify({
    model: "claude-test", max_tokens: 5, stream: false,
    system: [{ type: "text", text: `Primary working directory: ${dir}` }],
    messages: [{ role: "user", content: "hi" }],
  });
  const res = await viaProxy(state.port, good, ca, "POST", "/v1/messages", body, {
    "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555",
    authorization: "Bearer sk-ant-oat-test",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(service.sessions(), ["11111111-2222-3333-4444-555555555555"]);
  const call = seen.find((s) => s.path.startsWith("/v1/messages"));
  assert.equal(call.session, "11111111-2222-3333-4444-555555555555");
  assert.equal(call.auth, "Bearer sk-ant-oat-test");

  const other = await viaProxy(state.port, good, ca, "GET", "/api/oauth/profile", "", {});
  assert.equal(other.status, 200);
  assert.ok(seen.some((s) => s.path === "/api/oauth/profile"));

  assert.equal((await fetch(`http://127.0.0.1:${state.port}/memtree/sessions`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${state.port}/v1/models`, {
    headers: { "x-ccc-proxy-token": state.token },
  })).status, 404);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function connectStatus(port, auth) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
    sock.once("data", (d) => { resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(d.toString())?.[1])); sock.destroy(); });
    sock.on("error", reject);
  });
}

function viaProxy(port, auth, ca, method, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    });
    sock.once("data", (d) => {
      assert.match(d.toString(), /^HTTP\/1\.1 200/);
      const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca });
      const req = http.request({
        createConnection: () => secure, host: "api.anthropic.com", method, path: reqPath,
        headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
      }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => { resolve({ status: res.statusCode, text }); secure.destroy(); });
      });
      req.on("error", reject);
      req.end(body || undefined);
    });
    sock.on("error", reject);
  });
}
