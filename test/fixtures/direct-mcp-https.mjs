// Preloaded into the MCP subprocess. Substitute only the socket, so the real
// https request and agent choose the destination, TLS options and HTTP headers.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import inspector from "node:inspector";
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { homedir } from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { rootCertificates } from "node:tls";

if (process.env.TEST_INSPECTOR_LISTENING === "1") inspector.url = () => "ws://127.0.0.1:9229/test";

// For delivery tests, let the real ticket read finish before returning the tool data.
let ticketRead;
if (process.env.WAIT_FOR_TICKET === "1") {
  const read = fs.promises.readFile;
  fs.promises.readFile = (file, ...args) => {
    const result = read(file, ...args);
    if (typeof file === "string" && path.basename(path.dirname(file)) === "recall-notices") ticketRead = result;
    return result;
  };
}

if (process.env.STALL_TICKET === "1") {
  const read = fs.promises.readFile;
  let release;
  fs.promises.readFile = async (file, ...args) => {
    if (typeof file === "string" && path.basename(path.dirname(file)) === "recall-notices") {
      await new Promise(resolve => { release = resolve; });
    }
    return read(file, ...args);
  };
  const watchdog = setTimeout(() => { throw new Error("ticket read blocked the queued ping"); }, 3000);
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (line, ...args) => {
    if (JSON.parse(line).id === 1) {
      assert.ok(release, "the tool never attempted the ticket read");
      clearTimeout(watchdog);
      release();
    }
    return write(line, ...args);
  };
}

if (process.env.STALL_RECEIPT === "1") {
  let replied = false;
  let stalled = false;
  let ping = false;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (line, ...args) => {
    if (JSON.parse(line).id === 0) replied = true;
    if (JSON.parse(line).id === 1) ping = true;
    return write(line, ...args);
  };
  fs.promises.rename = async () => {
    assert.ok(replied, "publication started before the tool reply");
    stalled = true;
    setTimeout(() => process.exit(88), 2000);
    await new Promise(() => {});
  };
  process.on("exit", () => {
    assert.ok(stalled, "the fixture never attempted publication");
    assert.ok(ping, "receipt publication blocked the queued ping");
  });
}

if (process.env.CHECK_PID_UNREAD === "1") {
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (typeof file === "string" && path.basename(file) === process.ppid + ".json") process.exit(85);
    return read(file, ...args);
  };
}

if (process.env.CHECK_NO_SPAWN === "1") {
  for (const method of ["exec", "execFile", "execSync", "execFileSync", "fork", "spawn", "spawnSync"]) {
    childProcess[method] = () => {
      process.stderr.write(`Unexpected child_process.${method} in direct mode\n`);
      process.exit(87);
    };
  }
  syncBuiltinESMExports();
}

if (process.env.CHECK_KEY_UNREAD === "1" || process.env.CHECK_SIGUSR1 === "1") {
  const read = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (file === path.join(homedir(), ".claude-code-infinite", "config.json")) {
      if (process.env.CHECK_KEY_UNREAD === "1" || process.listenerCount("SIGUSR1") === 0) {
        process.stderr.write("Direct mode attempted to read the saved key before startup checks\n");
        process.exit(86);
      }
    }
    return read.call(this, file, ...args);
  };
  syncBuiltinESMExports();
}

const staging = process.env.EXPECT_STAGING === "1";
const expectedHost = staging ? "polychat-staging-421312241218.us-west2.run.app" : "api.polychat.co";
const key = staging ? "fixture-staging-key" : "fixture-production-key";

const server = http.createServer(async (req, res) => {
  if (process.env.CHECK_SIGUSR1 === "1") {
    process.kill(process.pid, "SIGUSR1");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(inspector.url(), undefined);
  }
  await ticketRead;
  const response = fixtureResponse(new URL(req.url, "https://" + req.headers.host), req.method, new Headers(req.headers));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
server.unref();

globalThis.fetch = () => { throw new Error("global fetch used for a direct read"); };
https.Agent.prototype.createConnection = function (options) {
  assert.ok(this !== https.globalAgent, "expected a private HTTPS agent");
  assert.equal(options.host, expectedHost);
  assert.equal(options.port, 443);
  assert.equal(options.rejectUnauthorized, true);
  assert.deepEqual(options.ca, rootCertificates);
  return net.connect(server.address().port, "127.0.0.1");
};

function fixtureResponse(url, method, headers) {
  if (url.origin !== "https://" + expectedHost || method !== "GET" ||
      headers.get("authorization") !== "Bearer " + key || !headers.get("x-memtree-tool") ||
      headers.has("x-claude-code-session-id") || headers.has("x-ccc-host-token") ||
      headers.has("x-ccc-proxy-token")) {
    console.error("Unexpected MemTree request");
    throw new Error("Unexpected MemTree request");
  }
  if (process.env.EXPECT_NO_PROJECT_META === "1") assert.equal(headers.get("x-client-meta"), null);
  if (process.env.EXPECT_PROJECT_META === "1" && url.pathname.startsWith("/v1/memtree/")) {
    const expected = { project_dir: path.basename(process.cwd()) };
    const meta = headers.get("x-client-meta");
    if (expected.project_dir.includes(key)) assert.equal(meta, null);
    else assert.deepEqual(JSON.parse(meta), expected);
  }
  switch (url.pathname) {
    case "/v1/memtree/sessions":
      if (url.searchParams.get("q") === "denied") {
        return new Response(JSON.stringify({ detail: key }).replace("fixture", "\\u0066ixture"), { status: 403 });
      }
      if (url.searchParams.get("q") === "nested") {
        return new Response(JSON.stringify({ error: { message: key } }).replace("fixture", "\\u0066ixture"), { status: 403 });
      }
      if (url.searchParams.get("q") === "plain") return new Response("x".repeat(285) + key, { status: 403 });
      if (url.searchParams.get("q") === "title") {
        return Response.json({ sessions: [{ title: "x".repeat(285) + key, latest_tree: { ref: "abcd-v1-own" } }] });
      }
      return Response.json({ sessions: [{ session_id: "12345678-1234-1234-1234-123456789abc",
        latest_tree: { ref: "abcd-v1-own" } }] });
    case "/v1/memtree/search":
      if (url.searchParams.get("q") === "deploy") return Response.json({ hits: [] });
      break;
    case "/usage/memtree/abcd-v1-own.json":
      return new Response(readFileSync(new URL("./memtree-page.json", import.meta.url)));
    case "/usage/memtree/abcd-v1-own/search":
      return Response.json({ hits: [], terms: ["deploy"] });
    case "/usage/memtree/abcd-v1-own/messages":
      return Response.json({ messages: [] });
    case "/usage/memtree/abcd-v1-own/handover":
    case "/usage/memtree/abcd-v1-own/user_messages":
      return Response.json({ messages: [{ n: 1, text: "fixture message" }] });
  }
  console.error("Unexpected MemTree route");
  throw new Error("Unexpected MemTree route");
}
