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
import { type SessionCa } from "./mitm-ca.js";
export declare function isInterceptedRequest(req: http.IncomingMessage): boolean;
export interface HttpsProxyModeOptions {
    ca: SessionCa;
    /** Debug trace (CONNECT targets, intercepted method/path/status; never header values). */
    tracePath?: string;
}
export declare function attachHttpsProxyMode(server: http.Server, opts: HttpsProxyModeOptions): void;
//# sourceMappingURL=https-proxy-mode.d.ts.map