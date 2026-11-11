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
import { execFileSync } from "node:child_process";
import {
  desktopEnvLines, desktopPaths, setupDesktopFiles, startDesktopService, toolsOffered,
  userClaudeJsonPath, userMcpOwner, workingDirectoryFromBody,
} from "../dist/desktop-service.js";
import { desktopClaudeBinaries } from "../dist/desktop-command.js";
import { desktopMcpTarget, handleMcpMessage } from "../dist/memtree-mcp.js";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";

test("the working directory comes from the decoded system prompt only (Codex r1 P2)", () => {
  const sys = (dir) => [{ type: "text", text: `env:\n - Primary working directory: ${dir}\n - Is a git repo` }];
  const body = (system, messages = []) => JSON.stringify({ system, messages });
  assert.equal(workingDirectoryFromBody(body(sys("/Users/a/proj"))), "/Users/a/proj");
  assert.equal(workingDirectoryFromBody(body(sys('/tmp/a"b/repo'))), '/tmp/a"b/repo');
  assert.equal(workingDirectoryFromBody(body("You are Claude.\n - Primary working directory: /srv/x")), "/srv/x");
  // A user message quoting the phrase is not the session's directory.
  assert.equal(workingDirectoryFromBody(body("no env here",
    [{ role: "user", content: "Primary working directory: /etc/evil" }])), undefined);
  assert.equal(workingDirectoryFromBody(body(sys("relative/dir"))), undefined);
  // Claude Code 2.1.322: the environment block is a system-role entry in messages.
  assert.equal(workingDirectoryFromBody(body("You are Claude.", [
    { role: "user", content: "hi" },
    { role: "system", content: [{ type: "text", text: "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /Users/a/ws" }] },
  ])), "/Users/a/ws");
  assert.equal(workingDirectoryFromBody("not json"), undefined);
});

test("the desktop MCP entry follows a ccc proxy and is inert elsewhere", () => {
  const token = "a".repeat(48);
  assert.deepEqual(desktopMcpTarget({ HTTPS_PROXY: `http://ccc:${token}@127.0.0.1:4567` }),
    { proxyUrl: "http://127.0.0.1:4567", token });
  // Terminal ccc (base-URL mode) keeps working through the same user-scope entry.
  assert.deepEqual(desktopMcpTarget({ ANTHROPIC_BASE_URL: "http://127.0.0.1:999", _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" }),
    { proxyUrl: "http://127.0.0.1:999" });
  // Some other local API proxy is not ccc (Codex r1 P2).
  assert.equal(desktopMcpTarget({ ANTHROPIC_BASE_URL: "http://127.0.0.1:999" }), undefined);
  // The user's opt-out holds for this entry too (Codex r1 P2).
  assert.equal(desktopMcpTarget({ HTTPS_PROXY: `http://ccc:${token}@127.0.0.1:4567`, CCC_MEMTREE_MCP: "0" }), undefined);
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
  const memtreeCalls = [];
  const memtree = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { memtreeCalls.push({ path: req.url, body: b }); res.writeHead(503); res.end(); });
  });
  await Promise.all([listen(upstream), listen(memtree)]);
  t.after(() => { upstream.close(); memtree.close(); });

  const paths = desktopPaths(dir, "local");
  const state = await setupDesktopFiles(paths, "local");
  assert.equal(fs.statSync(paths.leafKey).mode & 0o777, 0o600);
  assert.ok(desktopEnvLines(paths, state)[0].startsWith(`HTTPS_PROXY=http://ccc:${state.token}@127.0.0.1:`));
  execFileSync("bash", ["-n", paths.bashEnv]);
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

  // An intercepted request for a loopback-only path goes to Anthropic, not the local relay (Codex r1 P2).
  const relay = await viaProxy(state.port, good, ca, "GET", "/memtree/sessions", "", { origin: "https://evil.example" });
  assert.equal(relay.status, 200);
  assert.ok(seen.some((s) => s.path === "/memtree/sessions"));

  // Closing an idle session sends its final index (Codex r1 P1).
  const before = memtreeCalls.length;
  await service.closeIdle(0);
  assert.deepEqual(service.sessions(), []);
  assert.ok(memtreeCalls.slice(before).some((c) => /"final_index":true/.test(c.body)),
    `final index call: ${memtreeCalls.slice(before).map((c) => c.path).join(", ")}`);

  assert.equal((await fetch(`http://127.0.0.1:${state.port}/memtree/sessions`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${state.port}/v1/models`, {
    headers: { "x-ccc-proxy-token": state.token },
  })).status, 404);
});

test("setup's Bash env file is valid with an apostrophe in the path (Codex r1 P2)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-o'brien-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = desktopPaths(dir, "local");
  await setupDesktopFiles(paths, "local");
  execFileSync("bash", ["-n", paths.bashEnv]);
  const out = execFileSync("bash", ["-c", `. "$1"; echo "ca=\${NODE_EXTRA_CA_CERTS-unset} dac=\${DISABLE_AUTO_COMPACT-unset} bl=\${CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE-unset}"`, "x", paths.bashEnv],
    { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: paths.caPem, DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "1000000000" } }).toString();
  // Bash children get Claude Code's own compaction back (Claude r2 P2).
  assert.equal(out.trim(), "ca=unset dac=unset bl=unset");
  const kept = execFileSync("bash", ["-c", `. "$1"; echo "bl=\${CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE-unset} rc=$?"`, "x", paths.bashEnv],
    { env: { PATH: process.env.PATH, CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "5000" } }).toString();
  assert.equal(kept.trim(), "bl=5000 rc=0");
});

test("re-running setup keeps the CA, token and port unless asked (Claude r1 P2)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-desktop-rerun-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = desktopPaths(dir, "local");
  const first = await setupDesktopFiles(paths, "local");
  assert.ok(first.caRotated);
  assert.ok(first.port >= 41000 && first.port < 49152, `port ${first.port} below the ephemeral range`);
  const ca = fs.readFileSync(paths.caPem, "utf8");
  const again = await setupDesktopFiles(paths, "local");
  assert.equal(again.caRotated, false);
  assert.equal(fs.readFileSync(paths.caPem, "utf8"), ca);
  assert.equal(again.token, first.token);
  assert.equal(again.port, first.port);
  const rotated = await setupDesktopFiles(paths, "local", { rotateCa: true });
  assert.ok(rotated.caRotated);
  assert.notEqual(fs.readFileSync(paths.caPem, "utf8"), ca);
  assert.equal(rotated.token, first.token);
});

test("the tools header follows the session's own tool list (Codex r2 P2)", () => {
  assert.equal(toolsOffered(JSON.stringify({ tools: [{ name: "Bash" }, { name: "mcp__memtree__search" }] })), true);
  assert.equal(toolsOffered(JSON.stringify({ tools: [{ name: "Bash" }] })), false);
  assert.equal(toolsOffered(JSON.stringify({ messages: [] })), undefined);
  assert.equal(toolsOffered(JSON.stringify({ tools: [] })), undefined);
});

test("MCP ownership reads the config Claude Code would edit, and an unreadable one is not ours (Codex r2 P2)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-owner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(userClaudeJsonPath({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, ".claude.json"));
  const file = path.join(dir, ".claude.json");
  assert.equal(userMcpOwner(file), "none");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { memtree: { command: "x" } } }));
  assert.equal(userMcpOwner(file), "other");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { memtree: { env: { CCC_MEMTREE_MCP_DESKTOP: "1" } } } }));
  assert.equal(userMcpOwner(file), "ccc-desktop");
  fs.writeFileSync(file, "{ not json");
  assert.equal(userMcpOwner(file), "other");
});

test("inner proxies refuse requests without the service's inner token (Codex r1 P1)", async (t) => {
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k" });
  const proxy = await startProxy({ memtree, innerToken: "s".repeat(48) });
  t.after(() => proxy.close());
  const res = await fetch(`http://127.0.0.1:${proxy.port}/memtree/sessions`);
  assert.equal(res.status, 403);
});

test("Desktop's downloaded Claude Code is found in its versioned layouts (Codex r1 P1)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-cc-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 }); };
  exe(path.join(root, "2.1.300", "claude"));
  exe(path.join(root, "2.1.322", "abcdef012345", "claude.app", "Contents", "MacOS", "claude"));
  exe(path.join(root, "2.1.310", "0123456789ab", "claude"));
  fs.mkdirSync(path.join(root, "2.1.400", "partial"), { recursive: true });
  assert.deepEqual(desktopClaudeBinaries(root).map((f) => path.relative(root, f)), [
    path.join("2.1.300", "claude"),
    path.join("2.1.310", "0123456789ab", "claude"),
    path.join("2.1.322", "abcdef012345", "claude.app", "Contents", "MacOS", "claude"),
  ]);
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
