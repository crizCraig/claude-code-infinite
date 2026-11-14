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
import { type SessionCa } from "./mitm-ca.js";
/** The user name in HTTPS_PROXY; the session token is its password. */
export declare const PROXY_USER = "ccc";
export interface HttpsProxyModeOptions {
    /** The leaf for api.anthropic.com (its CA's key is already gone). */
    ca: Pick<SessionCa, "leafCertPem" | "leafKeyPem">;
    /** Per-session secret: Claude Code sends it on every CONNECT (HTTPS_PROXY's userinfo). */
    proxyToken: string;
    /** Debug trace (CONNECT targets, intercepted method/path/status, User-Agent). */
    tracePath?: string;
}
/** Where intercepted traffic goes: api.anthropic.com, or a test's fake upstream. */
export interface InterceptUpstream {
    host: string;
    port: number;
    secure: boolean;
}
/**
 * Raw sockets drain can't see (they keep server.close() waiting): `blind` destroys the
 * blind tunnels (no ccc work in them; called when drain starts), `all` everything left
 * (at the drain deadline).
 */
export interface CloseTunnels {
    blind: () => void;
    all: () => void;
}
/** The HTTPS_PROXY value Claude Code gets: the loopback port with the token. */
export declare function proxyUrlFor(port: number, proxyToken: string): string;
export declare function attachHttpsProxyMode(server: http.Server, onInterceptedRequest: http.RequestListener, upstream: InterceptUpstream, opts: HttpsProxyModeOptions): CloseTunnels;
/** host:port of a CONNECT (IPv6 in brackets); null when malformed. */
export declare function parseAuthority(authority: string): {
    host: string;
    port: number;
} | null;
//# sourceMappingURL=https-proxy-mode.d.ts.map