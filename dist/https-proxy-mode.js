/**
 * PROTOTYPE (proto/https-proxy-rc): ccc's loopback server as Claude Code's
 * HTTPS_PROXY, so Claude Code keeps api.anthropic.com as its base URL (and
 * with it Remote Control) while its model calls still reach ccc.
 *
 * - CONNECT api.anthropic.com:443 (from a client that looks like Claude Code):
 *   terminate TLS with the session CA's leaf and hand the decrypted stream to
 *   the same http.Server, which routes it (proxy.ts: messages and count_tokens
 *   through MemTree, every other path verbatim to api.anthropic.com).
 * - Every other CONNECT: a blind TCP tunnel. ccc never sees those bytes.
 * - An HTTP upgrade (WebSocket) on an intercepted stream: piped raw to
 *   api.anthropic.com over a fresh TLS connection.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { INTERCEPT_HOST } from "./mitm-ca.js";
/** Decrypted api.anthropic.com streams: their requests skip the loopback-only routes. */
const intercepted = new WeakSet();
export function isInterceptedRequest(req) {
    return intercepted.has(req.socket);
}
export function attachHttpsProxyMode(server, opts) {
    const secureContext = tls.createSecureContext({ cert: opts.ca.leafCertPem, key: opts.ca.leafKeyPem });
    const trace = (event) => {
        if (!opts.tracePath)
            return;
        try {
            appendFileSync(opts.tracePath, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
        }
        catch { /* tracing is best effort */ }
    };
    server.on("connect", (req, socket, head) => {
        const target = parseAuthority(req.url ?? "");
        const ua = String(req.headers["user-agent"] ?? "");
        const mitm = target !== null && target.host === INTERCEPT_HOST && target.port === 443;
        trace({ ev: "connect", target: req.url, ua, headerNames: Object.keys(req.headers), mitm });
        if (!target)
            return void socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.on("error", () => { });
        if (mitm)
            return interceptConnect(server, socket, head, secureContext, trace);
        tunnelConnect(socket, head, target.host, target.port, trace);
    });
    server.on("upgrade", (req, socket, head) => {
        trace({ ev: "upgrade", path: req.url, intercepted: intercepted.has(socket) });
        if (!intercepted.has(socket))
            return void socket.destroy();
        upgradeToUpstream(req, socket, head);
    });
    if (opts.tracePath) {
        server.on("request", (req, res) => {
            if (!intercepted.has(req.socket))
                return;
            const started = Date.now();
            res.on("finish", () => trace({
                ev: "request", method: req.method, path: (req.url ?? "").split("?")[0],
                status: res.statusCode, ms: Date.now() - started,
                ua: String(req.headers["user-agent"] ?? ""),
            }));
        });
    }
}
function interceptConnect(server, socket, head, secureContext, trace) {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0)
        socket.unshift(head);
    const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true, secureContext, ALPNProtocols: ["http/1.1"],
    });
    tlsSocket.on("error", (err) => trace({ ev: "tls_error", message: err.message }));
    intercepted.add(tlsSocket);
    server.emit("connection", tlsSocket);
}
function tunnelConnect(socket, head, host, port, trace) {
    const upstream = net.connect(port, host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0)
            upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on("error", (err) => {
        trace({ ev: "tunnel_error", host, port, message: err.message });
        if (!socket.destroyed)
            socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
}
function upgradeToUpstream(req, socket, head) {
    const upstream = tls.connect({ host: INTERCEPT_HOST, port: 443, servername: INTERCEPT_HOST }, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0)
            upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
}
function parseAuthority(authority) {
    const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(authority);
    if (!m)
        return null;
    const port = Number(m[2]);
    return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
}
//# sourceMappingURL=https-proxy-mode.js.map