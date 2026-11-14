// HTTPS-proxy mode (src/https-proxy-mode.ts): ccc's loopback as Claude Code's HTTPS_PROXY.
// A fake upstream stands in for api.anthropic.com; clients CONNECT with the proxy token,
// then speak TLS to the session leaf, as Claude Code does.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { startProxy } from "../dist/proxy.js";
import { MemtreeClient } from "../dist/memtree.js";
import { createSessionCa } from "../dist/mitm-ca.js";
import { parseAuthority, proxyUrlFor } from "../dist/https-proxy-mode.js";

const TOKEN = "t0ken".repeat(8);
const SESSION = { "x-claude-code-session-id": "session-1" };

async function harness({ upstream: handler, onUpgrade } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString() });
      (handler ?? defaultUpstream)(req, res);
    });
  });
  if (onUpgrade) upstream.on("upgrade", onUpgrade);
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const memtree = new MemtreeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "offline" });
  const memtreeCalls = [];
  memtree.compress = async () => { memtreeCalls.push("compress"); return null; };
  memtree.indexInBackground = () => { memtreeCalls.push("index"); };
  const ca = createSessionCa();
  const records = [];
  const modelCalls = [];
  const proxy = await startProxy({
    memtree, claudeCodeOnly: true,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    reqlog: { log: (r) => records.push(r) },
    httpsProxyMode: { ca, proxyToken: TOKEN, onModelCall: () => modelCalls.push(1) },
  });
  return {
    proxy, ca, seen, records, memtreeCalls, modelCalls, upstream,
    close: async () => {
      await proxy.drain(1_000);
      upstream.closeAllConnections();
      upstream.close();
    },
  };
}

function defaultUpstream(req, res) {
  if (req.url.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant",
      content: [{ type: "text", text: "hello" }], model: "claude-x", stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 } }));
    return;
  }
  if (req.url === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: one\ndata: 1\n\n");
    setTimeout(() => res.end("event: two\ndata: 2\n\n"), 20);
    return;
  }
  res.writeHead(201, { "content-type": "text/plain", "x-upstream": "yes" });
  res.end(`upstream ${req.method} ${req.url}`);
}

/** CONNECT through the proxy; resolves the raw socket and the proxy's status line. */
function connect(port, target, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const headers = token === null ? {} : {
      "proxy-authorization": `Basic ${Buffer.from(`ccc:${token}`).toString("base64")}`,
    };
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on("error", reject);
    req.end();
  });
}

/** CONNECT api.anthropic.com:443, TLS against the session CA, then one HTTP request. */
async function interceptedRequest(h, { method = "GET", path = "/", headers = {}, body } = {}) {
  const { status, socket } = await connect(h.proxy.port, "api.anthropic.com:443");
  assert.equal(status, 200);
  const tlsSocket = tls.connect({ socket, servername: "api.anthropic.com", ca: [h.ca.caCertPem] });
  await new Promise((r, j) => { tlsSocket.once("secureConnect", r); tlsSocket.once("error", j); });
  return new Promise((resolve, reject) => {
    const req = http.request({ method, path, createConnection: () => tlsSocket,
      headers: { host: "api.anthropic.com", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        tlsSocket.destroy();
        resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks).toString() });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a CONNECT without the session token gets 407, for any host", async () => {
  const h = await harness();
  try {
    for (const token of [null, "wrong", `${TOKEN}x`]) {
      for (const target of ["api.anthropic.com:443", `127.0.0.1:${h.upstream.address().port}`]) {
        const { status, socket } = await connect(h.proxy.port, target, token);
        socket.destroy();
        assert.equal(status, 407, `${token} ${target}`);
      }
    }
    assert.equal(h.seen.length, 0, "nothing reached the upstream");
  } finally {
    await h.close();
  }
});

test("another host is a blind tunnel: bytes both ways, untouched", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const h = await harness();
  try {
    const { status, socket } = await connect(h.proxy.port, `127.0.0.1:${echo.address().port}`);
    assert.equal(status, 200);
    const payload = Buffer.from([0, 1, 2, 255, 0x16, 0x03, 0x01, ...Buffer.from("GET / HTTP/1.1")]);
    socket.write(payload);
    const got = await new Promise((r) => socket.once("data", r));
    assert.deepEqual(got, payload);
    socket.destroy();
    assert.equal(h.seen.length, 0);
  } finally {
    await h.close();
    echo.close();
  }
});

test("an intercepted POST /v1/messages takes the MemTree path, with Claude Code's own auth", async () => {
  const h = await harness();
  try {
    const res = await interceptedRequest(h, { method: "POST", path: "/v1/messages",
      headers: { "content-type": "application/json", authorization: "Bearer oauth-abc", ...SESSION },
      body: JSON.stringify({ model: "claude-x", max_tokens: 64,
        messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).content[0].text, "hello");
    const forwarded = h.seen.find((r) => r.url.startsWith("/v1/messages"));
    assert.equal(forwarded.headers.authorization, "Bearer oauth-abc");
    assert.equal(forwarded.headers["proxy-authorization"], undefined);
    assert.equal(h.modelCalls.length, 1);
    const turn = h.records.find((r) => r.kind === "messages");
    assert.equal(turn.turnType, "first-user", "classified as a Claude Code turn, not foreign");
    assert.ok(h.memtreeCalls.includes("index"), "the first turn is indexed in the background");
  } finally {
    await h.close();
  }
});

test("other intercepted paths go to the upstream verbatim, SSE streamed", async () => {
  const h = await harness();
  try {
    const res = await interceptedRequest(h, { method: "POST", path: "/v1/environments/bridge?x=1",
      headers: { "content-type": "application/json", authorization: "Bearer b" },
      body: '{"a":1}' });
    assert.equal(res.status, 201);
    assert.equal(res.headers["x-upstream"], "yes");
    assert.equal(res.body, "upstream POST /v1/environments/bridge?x=1");
    const got = h.seen.at(-1);
    assert.equal(got.body, '{"a":1}');
    assert.equal(got.headers.authorization, "Bearer b");
    const sse = await interceptedRequest(h, { path: "/stream" });
    assert.equal(sse.body, "event: one\ndata: 1\n\nevent: two\ndata: 2\n\n");
    assert.equal(h.modelCalls.length, 0, "only /v1/messages counts as a model call");
  } finally {
    await h.close();
  }
});

test("ccc's loopback-only routes are Anthropic's paths when intercepted", async () => {
  const h = await harness();
  try {
    for (const path of ["/memtree/host-session?host_pid=1", new URL(h.proxy.hookUrl).pathname]) {
      const res = await interceptedRequest(h, { method: path.startsWith("/memtree") ? "GET" : "POST",
        path, headers: { "x-ccc-host-token": h.proxy.hostToken } });
      assert.equal(res.status, 201, path);
      assert.match(res.body, /^upstream /, path);
    }
  } finally {
    await h.close();
  }
});

test("a WebSocket upgrade on an intercepted stream is piped to the upstream", async () => {
  const h = await harness({
    onUpgrade: (req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
        `Connection: Upgrade\r\nX-Path: ${req.url}\r\n\r\n`);
      socket.pipe(socket);
    },
  });
  try {
    const { socket } = await connect(h.proxy.port, "api.anthropic.com:443");
    const tlsSocket = tls.connect({ socket, servername: "api.anthropic.com", ca: [h.ca.caCertPem] });
    await new Promise((r) => tlsSocket.once("secureConnect", r));
    tlsSocket.write("GET /v1/ws HTTP/1.1\r\nHost: api.anthropic.com\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\n\r\n");
    let text = "";
    await new Promise((r) => tlsSocket.on("data", (d) => {
      text += d;
      if (text.includes("\r\n\r\n")) r();
    }));
    assert.match(text, /^HTTP\/1\.1 101/);
    assert.match(text, /X-Path: \/v1\/ws/);
    tlsSocket.write("ping-frame");
    const echoed = await new Promise((r) => tlsSocket.once("data", r));
    assert.equal(String(echoed), "ping-frame");
    tlsSocket.destroy();
  } finally {
    await h.close();
  }
});

test("a loopback request with an Upgrade header is answered normally (no upgrade listener)", async () => {
  const h = await harness();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h.proxy.port, path: "/v1/models",
        headers: { connection: "Upgrade", upgrade: "h2c" } }, (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode));
      });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("error", reject);
      req.end();
    });
    assert.equal(res, 201, "passed through as before proxy mode");
  } finally {
    await h.close();
  }
});

test("drain doesn't wait for open tunnels or idle decrypted streams", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const h = await harness();
  try {
    const { socket: blind } = await connect(h.proxy.port, `127.0.0.1:${echo.address().port}`);
    const { socket: raw } = await connect(h.proxy.port, "api.anthropic.com:443");
    const idle = tls.connect({ socket: raw, servername: "api.anthropic.com", ca: [h.ca.caCertPem] });
    await new Promise((r) => idle.once("secureConnect", r));
    idle.on("error", () => {});
    blind.on("error", () => {});
    const started = Date.now();
    assert.equal(await h.proxy.drain(5_000), true, "drained cleanly");
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
  } finally {
    h.upstream.close();
    echo.close();
  }
});

test("a malformed CONNECT target gets 400", async () => {
  const h = await harness();
  try {
    const { status, socket } = await connect(h.proxy.port, "no-port-here");
    socket.destroy();
    assert.equal(status, 400);
  } finally {
    await h.close();
  }
});

test("CONNECT authorities parse with IPv6 brackets, ports bounded", () => {
  assert.deepEqual(parseAuthority("API.Anthropic.com:443"), { host: "api.anthropic.com", port: 443 });
  assert.deepEqual(parseAuthority("[::1]:8080"), { host: "::1", port: 8080 });
  for (const bad of ["api.anthropic.com", "api.anthropic.com:0", "a:70000", "user@h:1", "a b:1", ":1"]) {
    assert.equal(parseAuthority(bad), null, bad);
  }
  assert.equal(proxyUrlFor(4321, "abc"), "http://ccc:abc@127.0.0.1:4321");
});

test("a CONNECT after drain started gets no tunnel (review r1 P3)", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const h = await harness();
  try {
    // One kept-alive loopback socket: a request first, then a CONNECT once drain began.
    const sock = net.connect(h.proxy.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.on("error", () => {});
    const draining = h.proxy.drain(5_000);
    sock.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: x\r\n` +
      `Proxy-Authorization: Basic ${Buffer.from(`ccc:${TOKEN}`).toString("base64")}\r\n\r\n`);
    const started = Date.now();
    await draining;
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    sock.destroy();
  } finally {
    h.upstream.close();
    echo.close();
  }
});
