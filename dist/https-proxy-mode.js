/**
 * ccc's loopback server as Claude Code's HTTPS_PROXY (opt-in: CCC_HTTPS_PROXY_MODE=1 or
 * the `httpsProxyMode` config key; https-proxy-session.ts decides and sets it up). Claude
 * Code then keeps api.anthropic.com as its base URL, and with it Remote Control, while its
 * model calls still reach ccc and MemTree.
 *
 * - A CONNECT without this session's proxy token gets 407: other local users and programs
 *   can use neither the tunnel nor the interception.
 * - CONNECT api.anthropic.com:443: TLS is terminated with the session CA's leaf
 *   (mitm-ca.ts) and the decrypted stream goes to a separate, never-listening http.Server
 *   that shares ccc's request handler. proxy.ts routes only POST /v1/messages and
 *   /v1/messages/count_tokens from it to MemTree; every other path (Remote Control's
 *   bridge, sessions, files, OAuth, telemetry) goes verbatim to api.anthropic.com, and
 *   ccc's loopback-only routes (hooks, /memtree/*) are not reachable from it.
 * - Every other CONNECT: a blind TCP tunnel. ccc never decrypts or logs those bytes.
 * - An HTTP upgrade (WebSocket) on an intercepted stream: piped raw to api.anthropic.com
 *   over a fresh TLS connection. The loopback server itself gets no upgrade listener, so
 *   its requests behave exactly as without proxy mode.
 *
 * The optional trace (CCC_PROXY_TRACE) records CONNECT targets and, for intercepted
 * requests, method, path (no query), status and User-Agent: no other header values, no
 * bodies.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { INTERCEPT_HOST } from "./mitm-ca.js";
/** The user name in HTTPS_PROXY; the session token is its password. */
export const PROXY_USER = "ccc";
/** The HTTPS_PROXY value Claude Code gets: the loopback port with the token. */
export function proxyUrlFor(port, proxyToken) {
    return `http://${PROXY_USER}:${proxyToken}@127.0.0.1:${port}`;
}
export function attachHttpsProxyMode(server, onInterceptedRequest, upstream, opts) {
    const tunnels = new TunnelSet();
    const trace = tracer(opts.tracePath);
    const secureContext = tls.createSecureContext({
        cert: opts.ca.leafCertPem, key: opts.ca.leafKeyPem,
    });
    const intercept = interceptServer(onInterceptedRequest, upstream, tunnels, trace);
    server.on("connect", (req, socket, head) => {
        onConnect(req, socket, head, { intercept, secureContext, tunnels, trace, opts });
    });
    return {
        // Drain starts: blind tunnels carry no ccc work, and idle decrypted keep-alive
        // connections none either (a never-listening server can't close those itself).
        blind: () => {
            tunnels.destroyBlind();
            tunnels.closeIdleIntercepted();
        },
        all: () => tunnels.destroyAll(),
    };
}
function onConnect(req, socket, head, ctx) {
    const target = parseAuthority(req.url ?? "");
    const mitm = target !== null && target.host === INTERCEPT_HOST && target.port === 443;
    ctx.trace({ ev: "connect", target: req.url, ua: userAgent(req), mitm });
    // Before any answer: a reset must not be an unhandled error, and drain must see it.
    socket.on("error", () => { });
    ctx.tunnels.track(socket, mitm ? "intercepted" : "blind");
    if (!target)
        return refuse(socket, "HTTP/1.1 400 Bad Request\r\n\r\n");
    if (!authorized(req, ctx.opts.proxyToken)) {
        ctx.trace({ ev: "connect_refused", target: req.url });
        return refuse(socket, "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            `Proxy-Authenticate: Basic realm="${PROXY_USER}"\r\n\r\n`);
    }
    if (mitm) {
        return interceptConnect(ctx.intercept, socket, head, ctx.secureContext, ctx.tunnels, ctx.trace);
    }
    tunnelConnect(socket, head, target.host, target.port, ctx.trace);
}
/**
 * The decrypted api.anthropic.com streams' own server: never listening, fed only by
 * interceptConnect, so nothing on the loopback port can reach it.
 */
function interceptServer(onRequest, upstream, tunnels, trace) {
    const server = http.createServer(onRequest);
    // Same as the loopback server: long SSE responses and long polls must not be cut.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.on("upgrade", (req, socket, head) => {
        trace({ ev: "upgrade", path: pathOf(req) });
        socket.on("error", () => { });
        tunnels.track(socket, "intercepted");
        tunnels.requestStarted(socket); // a live WebSocket is never idle: only the deadline cuts it
        upgradeToUpstream(req, socket, head, upstream);
    });
    server.on("request", (req, res) => {
        tunnels.requestStarted(req.socket);
        res.once("close", () => tunnels.requestEnded(req.socket));
        const started = Date.now();
        res.on("finish", () => trace({
            ev: "request", method: req.method, path: pathOf(req), status: res.statusCode,
            ms: Date.now() - started, ua: userAgent(req),
        }));
    });
    return server;
}
function interceptConnect(intercept, socket, head, secureContext, tunnels, trace) {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0)
        socket.unshift(head);
    const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true, secureContext, ALPNProtocols: ["http/1.1"],
    });
    tlsSocket.on("error", (err) => {
        trace({ ev: "tls_error", message: err.message });
        socket.destroy();
    });
    intercept.emit("connection", tlsSocket);
    return tunnels.trackDecrypted(tlsSocket);
}
function tunnelConnect(socket, head, host, port, trace) {
    let established = false;
    const upstream = net.connect(port, host, () => {
        established = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0)
            upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on("error", (err) => {
        trace({ ev: "tunnel_error", host, port, message: err.message });
        if (socket.destroyed)
            return;
        if (established)
            socket.destroy();
        else
            socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
}
/** Replays the upgrade request upstream byte for byte (headers as sent), then pipes. */
function upgradeToUpstream(req, socket, head, upstream) {
    const connected = () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        up.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0)
            up.write(head);
        up.pipe(socket);
        socket.pipe(up);
    };
    const up = upstream.secure
        ? tls.connect({ host: upstream.host, port: upstream.port, servername: upstream.host,
            ALPNProtocols: ["http/1.1"] }, connected)
        : net.connect(upstream.port, upstream.host, connected);
    up.on("error", () => socket.destroy());
    socket.on("close", () => up.destroy());
    up.on("close", () => socket.destroy());
}
/** Answer, then close: a refused client can't hold the socket open. */
function refuse(socket, response) {
    socket.end(response);
    setTimeout(() => socket.destroy(), 1_000).unref();
}
function authorized(req, token) {
    const credentials = Buffer.from(`${PROXY_USER}:${token}`).toString("base64");
    const expected = Buffer.from(`Basic ${credentials}`);
    const got = Buffer.from(String(req.headers["proxy-authorization"] ?? ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
}
/** host:port of a CONNECT (IPv6 in brackets); null when malformed. */
export function parseAuthority(authority) {
    const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:[\]/@]+)):(\d{1,5})$/.exec(authority);
    if (!m)
        return null;
    const port = Number(m[3]);
    const host = (m[1] ?? m[2]).toLowerCase();
    return port > 0 && port < 65536 ? { host, port } : null;
}
function pathOf(req) {
    return (req.url ?? "").split("?")[0];
}
function userAgent(req) {
    return String(req.headers["user-agent"] ?? "");
}
function tracer(path) {
    if (!path)
        return () => { };
    return (event) => {
        try {
            appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 });
        }
        catch { /* tracing is best effort */ }
    };
}
/**
 * Raw CONNECT and upgrade sockets, by kind, so drain can close them; and each decrypted
 * stream's requests in flight, so drain can close the idle ones at once.
 */
class TunnelSet {
    sets = { blind: new Set(), intercepted: new Set() };
    inFlight = new Map();
    draining = false;
    track(socket, kind) {
        const set = this.sets[kind];
        set.add(socket);
        socket.once("close", () => set.delete(socket));
    }
    trackDecrypted(socket) {
        this.inFlight.set(socket, 0);
        socket.once("close", () => this.inFlight.delete(socket));
        if (this.draining)
            socket.destroy();
    }
    requestStarted(socket) {
        const n = this.inFlight.get(socket);
        if (n !== undefined)
            this.inFlight.set(socket, n + 1);
    }
    requestEnded(socket) {
        const n = this.inFlight.get(socket);
        if (n === undefined)
            return;
        this.inFlight.set(socket, n - 1);
        if (this.draining && n - 1 <= 0)
            socket.end();
    }
    destroyBlind() {
        destroyAll(this.sets.blind);
    }
    /** Drain started: close idle decrypted streams now, busy ones after their request. */
    closeIdleIntercepted() {
        this.draining = true;
        for (const [socket, n] of this.inFlight)
            if (n <= 0)
                socket.end();
    }
    destroyAll() {
        destroyAll(this.sets.blind);
        destroyAll(this.sets.intercepted);
    }
}
function destroyAll(set) {
    for (const socket of set)
        socket.destroy();
    set.clear();
}
//# sourceMappingURL=https-proxy-mode.js.map