/**
 * Claude Code Infinite local proxy (plans/2026-06-09_PLAN_local_proxy_app.md,
 * refined by plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 *
 * Claude Code points ANTHROPIC_BASE_URL at this 127.0.0.1 server. We never
 * read, store, or refresh credentials: Claude Code keeps its native login and
 * sends its own OAuth bearer here, and we forward its headers and query string
 * verbatim to api.anthropic.com (the anthropic-beta flag list churns across CC
 * versions — never reconstruct it). Only the `messages` body is ever altered
 * (compression, plus removal of the notice blocks we ourselves injected);
 * auth, identity, and routing are never touched.
 *
 * Turn classification for POST /v1/messages:
 * - Tool turn (last message isn't a real user input): background indexing,
 *   forward as-is.
 * - First user turn (no earlier real user input): background indexing, forward
 *   as-is — nothing is indexed yet, so blocking would be a guaranteed no-op.
 * - Followup user turn: blocking compress + substitute; degrade to passthrough
 *   (with an inline degraded notice) on any MemTree failure/timeout/402.
 *
 * Every /v1/messages and count_tokens body is run through the notice strip
 * pass before hashing/forwarding, so injected notices never reach the model
 * and dedupe hashes are stable whether or not a notice was present.
 */

import http from "node:http";
import https from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MemtreeClient } from "./memtree.js";
import {
  contextLimitForModel,
  flattenToSingleUserMessage,
  hasEarlierNonToolUserMessage,
  isNonToolUserMessage,
  messagesWithSystem,
  type Message,
} from "./turns.js";
import {
  DEGRADED_NOTICE,
  SLOW_FIRST_TOKEN_NOTICE,
  SseNoticeRewriter,
  appendNoticeToJsonBody,
  fabricatedPrelude,
  sseErrorEvent,
  stripNoticeBlocks,
} from "./notices.js";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const SLOW_FIRST_TOKEN_MS = 10_000;

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "content-length", // recomputed for buffered/modified bodies
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

export interface ProxyOptions {
  memtree: MemtreeClient;
  debug?: boolean;
  /** Test-only: forward to this origin instead of api.anthropic.com. */
  upstreamOrigin?: string;
  /** Test-only: dump each forwarded /v1/messages body to this directory. */
  captureDir?: string;
}

export interface RunningProxy {
  port: number;
  close: () => void;
}

interface Upstream {
  module: typeof http | typeof https;
  host: string;
  port: number;
}

function resolveUpstream(opts: ProxyOptions): Upstream {
  const url = new URL(opts.upstreamOrigin ?? DEFAULT_UPSTREAM);
  const secure = url.protocol === "https:";
  return {
    module: secure ? https : http,
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
  };
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const upstream = resolveUpstream(opts);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, opts, upstream).catch((err) => {
      sendAnthropicError(res, `local proxy error: ${err?.message ?? err}`);
    });
  });
  // Long-running SSE responses must not be cut by idle timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handleMessages(req, res, opts, upstream);
  }
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return handleCountTokens(req, res, opts, upstream);
  }
  return passThroughStreaming(req, res, upstream);
}

/** Buffer + inspect /v1/messages; classify the turn, strip notices, forward. */
async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream
): Promise<void> {
  const rawBody = await readBody(req);

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody.toString("utf-8"));
    if (!Array.isArray(body.messages)) throw new Error("no messages array");
  } catch {
    // Not a shape we understand — forward verbatim rather than break the session.
    return forwardRaw(req, res, rawBody, opts, upstream);
  }

  // Strip pass first: injected notices must never reach Anthropic or the
  // MemTree index, and the dedupe hash must be notice-independent. When
  // nothing was injected the body stays byte-verbatim.
  const stripped = stripNoticeBlocks(body.messages);
  let forwardBody = rawBody;
  if (stripped.stripped) {
    body.messages = stripped.messages;
    forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
    if (opts.debug) console.error("[ccc proxy] stripped notice block(s) from request");
  }

  const messages: Message[] = body.messages;
  const lastMsg = messages[messages.length - 1];
  const isUserTurn = isNonToolUserMessage(lastMsg);
  const isFollowupUserTurn =
    isUserTurn && hasEarlierNonToolUserMessage(messages);
  const modelContextLimit = contextLimitForModel(body.model);
  const msgsForMemtree = messagesWithSystem(messages, body.system);
  const hash = MemtreeClient.hashMessages(msgsForMemtree);
  const streamRequested = body.stream === true;

  if (!isFollowupUserTurn) {
    // Tool turn or FIRST user turn: keep the index fed off the response path;
    // forward as-is. On the first user turn nothing is indexed yet, so a
    // blocking compress would be a guaranteed no-op costing first-token
    // latency (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
    if (opts.debug && isUserTurn) {
      console.error("[ccc proxy] first user turn: index in background, forward verbatim");
    }
    opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit);
    capture(opts, "anthropic-request", forwardBody);
    return forwardRaw(req, res, forwardBody, opts, upstream);
  }

  const result = await opts.memtree.compress(
    hash,
    msgsForMemtree,
    modelContextLimit
  );

  if (!result) {
    // MemTree down/slow/402: the user's own Anthropic call is never gated on
    // it. Degrade to passthrough and tell the user inline — the notice is
    // stripped from all subsequent request bodies, so the model never sees it.
    capture(opts, "anthropic-request", forwardBody);
    return forwardWithNotices(req, res, forwardBody, opts, upstream, {
      slowFirstToken: false,
      endOfTurnNotice: DEGRADED_NOTICE,
      streamRequested,
      model: String(body.model ?? ""),
    });
  }

  const processed = result.messages;
  const systemMsg = processed.find((m) => m.role === "system");
  const compressedBody: Record<string, any> = {
    ...body,
    messages: flattenToSingleUserMessage(processed),
  };
  if (systemMsg?.content != null) {
    compressedBody.system = systemMsg.content;
  }

  const compressedRaw = Buffer.from(JSON.stringify(compressedBody), "utf-8");
  if (opts.debug) {
    console.error(
      `[ccc proxy] user turn compressed: ${forwardBody.length} → ${compressedRaw.length} body bytes`
    );
  }
  capture(opts, "anthropic-request", compressedRaw);
  return forwardWithNotices(req, res, compressedRaw, opts, upstream, {
    slowFirstToken: true,
    streamRequested,
    model: String(body.model ?? ""),
  });
}

/**
 * count_tokens: strip notices, pass through. Counting is intentionally done on
 * the uncompressed conversation even though /v1/messages forwards a compressed
 * body on followup user turns — the compression result isn't known at count
 * time, so counts are an upper bound rather than an exact match of what's
 * forwarded.
 */
async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream
): Promise<void> {
  const rawBody = await readBody(req);
  let forwardBody = rawBody;
  try {
    const body = JSON.parse(rawBody.toString("utf-8"));
    if (Array.isArray(body.messages)) {
      const stripped = stripNoticeBlocks(body.messages);
      if (stripped.stripped) {
        body.messages = stripped.messages;
        forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
      }
    }
  } catch {
    // Unknown shape: forward verbatim.
  }
  return forwardRaw(req, res, forwardBody, opts, upstream);
}

/** Forward a buffered request and pipe the response back raw (no injection). */
function forwardRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream
): Promise<void> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    headers["content-length"] = String(bodyBuffer.length);

    const upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url, // path + query string verbatim (?beta=true etc.)
        headers,
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          forwardableResponseHeaders(upstreamRes)
        );
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", () => {
          res.destroy();
          resolve();
        });
      }
    );

    upstreamReq.on("error", (err) => {
      sendAnthropicError(res, `upstream connection failed: ${err.message}`);
      resolve();
    });
    // Client gave up (Claude Code retry/abort): drop the upstream call too.
    res.on("close", () => upstreamReq.destroy());

    upstreamReq.end(bodyBuffer);
  });
}

interface NoticeForwardOptions {
  /** Fabricate the "✨" SSE prelude if no upstream byte within 10s (stream only). */
  slowFirstToken: boolean;
  /** Append this notice at end of turn (degraded alert). */
  endOfTurnNotice?: string;
  streamRequested: boolean;
  model: string;
}

/**
 * Forward a followup-user-turn request with the notice-injection layer on the
 * response. Requests upstream identity encoding so the SSE/JSON stream can be
 * rewritten. Error responses (non-200) pass through untouched — unless the
 * fabricated prelude already started the client stream, in which case the
 * failure is converted to an in-stream SSE error event.
 */
function forwardWithNotices(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream,
  notice: NoticeForwardOptions
): Promise<void> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    headers["content-length"] = String(bodyBuffer.length);
    headers["accept-encoding"] = "identity"; // we must be able to rewrite the body

    let preludeSent = false;
    let upstreamStarted = false; // first body byte seen, or non-injectable response
    let slowTimer: NodeJS.Timeout | null = null;

    const disarm = () => {
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
      }
    };

    const finish = () => {
      disarm();
      resolve();
    };

    if (notice.slowFirstToken && notice.streamRequested) {
      slowTimer = setTimeout(() => {
        if (upstreamStarted || preludeSent || res.writableEnded) return;
        preludeSent = true;
        if (!res.headersSent) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
        }
        res.write(fabricatedPrelude(notice.model, SLOW_FIRST_TOKEN_NOTICE));
        if (opts.debug) {
          console.error("[ccc proxy] slow first token: fabricated ✨ notice prelude");
        }
      }, SLOW_FIRST_TOKEN_MS);
    }

    const upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const isSse = contentType.includes("text/event-stream");

        if (status !== 200 || (!isSse && preludeSent)) {
          // Error (or non-SSE after we already started an SSE stream).
          if (preludeSent) {
            // Client stream already open: surface as an in-stream error event.
            readAll(upstreamRes)
              .then((errBody) => {
                res.write(
                  sseErrorEvent(
                    `upstream ${status}: ${errBody.toString("utf-8").slice(0, 300)}`
                  )
                );
                res.end();
                finish();
              })
              .catch(() => {
                res.destroy();
                finish();
              });
            return;
          }
          upstreamStarted = true;
          disarm();
          res.writeHead(status, forwardableResponseHeaders(upstreamRes));
          upstreamRes.pipe(res);
          upstreamRes.on("end", finish);
          upstreamRes.on("error", () => {
            res.destroy();
            finish();
          });
          return;
        }

        if (isSse) {
          if (!res.headersSent) {
            res.writeHead(200, forwardableResponseHeaders(upstreamRes));
          }
          let rewriter: SseNoticeRewriter | null = null;
          upstreamRes.on("data", (chunk: Buffer) => {
            if (!upstreamStarted) {
              upstreamStarted = true;
              disarm();
              rewriter = new SseNoticeRewriter({
                renumberBy: preludeSent ? 1 : undefined,
                endOfTurnNotice: notice.endOfTurnNotice,
              });
            }
            const out = rewriter!.push(chunk);
            if (out) res.write(out);
          });
          upstreamRes.on("end", () => {
            const rest = rewriter?.flush();
            if (rest) res.write(rest);
            res.end();
            finish();
          });
          upstreamRes.on("error", () => {
            res.destroy();
            finish();
          });
          return;
        }

        // 200 JSON (stream: false): the mid-stall notice doesn't apply; append
        // the end-of-turn notice to the body if present.
        upstreamStarted = true;
        disarm();
        readAll(upstreamRes)
          .then((responseBody) => {
            let outBody = responseBody;
            if (notice.endOfTurnNotice) {
              const modified = appendNoticeToJsonBody(
                responseBody,
                notice.endOfTurnNotice
              );
              if (modified) outBody = modified;
            }
            const outHeaders = forwardableResponseHeaders(upstreamRes);
            outHeaders["content-length"] = String(outBody.length);
            res.writeHead(status, outHeaders);
            res.end(outBody);
            finish();
          })
          .catch(() => {
            res.destroy();
            finish();
          });
      }
    );

    upstreamReq.on("error", (err) => {
      if (preludeSent) {
        res.write(sseErrorEvent(`upstream connection failed: ${err.message}`));
        res.end();
      } else {
        sendAnthropicError(res, `upstream connection failed: ${err.message}`);
      }
      finish();
    });
    res.on("close", () => {
      disarm();
      upstreamReq.destroy();
    });

    upstreamReq.end(bodyBuffer);
  });
}

/** Transparent streaming passthrough for everything else. */
function passThroughStreaming(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream
): Promise<void> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    // The body is piped unmodified here, so keep the client's original
    // content-length (SKIP_REQUEST_HEADERS strips it for the buffered paths,
    // which recompute it); dropping it would silently convert the request to
    // chunked transfer-encoding.
    if (req.headers["content-length"] !== undefined) {
      headers["content-length"] = req.headers["content-length"];
    }
    const upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          forwardableResponseHeaders(upstreamRes)
        );
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", () => {
          res.destroy();
          resolve();
        });
      }
    );
    upstreamReq.on("error", (err) => {
      sendAnthropicError(res, `upstream connection failed: ${err.message}`);
      resolve();
    });
    res.on("close", () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  });
}

function forwardableRequestHeaders(
  req: http.IncomingMessage
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function forwardableResponseHeaders(
  upstreamRes: http.IncomingMessage
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Well-formed Anthropic-shaped error body so Claude Code fails fast, not weird. */
function sendAnthropicError(res: http.ServerResponse, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify({
    type: "error",
    error: { type: "api_error", message },
  });
  res.writeHead(502, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

let captureCounter = 0;

/** Test-only diagnostics: dump forwarded bodies for smoke-test inspection. */
function capture(opts: ProxyOptions, kind: string, body: Buffer): void {
  const dir = opts.captureDir ?? process.env.CCC_CAPTURE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${String(++captureCounter).padStart(4, "0")}-${kind}.json`;
    writeFileSync(join(dir, name), body);
  } catch {
    // diagnostics only — never break the proxy path
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return readAll(req);
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
