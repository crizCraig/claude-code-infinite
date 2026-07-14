/**
 * Claude Code Infinite local proxy (plans/2026-06-09_PLAN_local_proxy_app.md,
 * refined by plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 *
 * Claude Code points ANTHROPIC_BASE_URL at this 127.0.0.1 server. We never
 * read, store, or refresh credentials: Claude Code keeps its native login and
 * sends its own OAuth bearer here, and we forward its headers and query string
 * verbatim to api.anthropic.com (the anthropic-beta flag list churns across CC
 * versions — never reconstruct it). Only the `messages` body is ever altered
 * (compression, plus defensive removal of legacy notice markers);
 * auth, identity, and routing are never touched.
 *
 * Turn classification for POST /v1/messages:
 * - Tool turn (last message isn't a real user input): background indexing,
 *   forward as-is.
 * - First user turn (no earlier real user input): background indexing, forward
 *   as-is — nothing is indexed yet, so blocking would be a guaranteed no-op.
 * - Followup user turn: blocking compress + substitute. When indexed history
 *   was actually used, queue a display-only compression-success notice.
 *   Degrade to passthrough on any MemTree failure/timeout — with a degraded
 *   notice, except 402 (unpaid key), which gets a payment-specific notice
 *   shown at most once per proxy process.
 *
 * Every /v1/messages and count_tokens body is run through the legacy notice
 * strip pass before hashing/forwarding. Live notices use Claude Code hooks and
 * upstream response bytes are always passed through unchanged.
 */

import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import type { Transform } from "node:stream";
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  didMemtreeCompress,
  MemtreeClient,
  rawPromptTokenCount,
} from "./memtree.js";
import {
  contextLimitForModel,
  flattenToSingleUserMessage,
  hasEarlierNonToolUserMessage,
  isAwaySummaryUserMessage,
  isNonToolUserMessage,
  lastNonSystemMessage,
  messagesWithSystem,
  userMessageText,
  type Message,
} from "./turns.js";
import {
  DEGRADED_NOTICE,
  PAYMENT_REQUIRED_NOTICE,
  SseNoticeRewriter,
  compressedNoticeText,
  sanitizeNoticeDetail,
  stripNoticeBlocks,
  stripNoticeSystem,
} from "./notices.js";
import {
  NoticeDeliveryQueue,
  parseNoticeHookInput,
} from "./hooks.js";
import {
  approxTokensFromBytes,
  mergeUsageFromJsonBody,
  mergeUsageFromSseEvent,
  type MessagesRecord,
  type RequestLogger,
  type UsageRecord,
} from "./reqlog.js";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const HOOK_BODY_LIMIT = 64 * 1024;
const TOKEN_COUNT_CACHE_MAX = 64;

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
  /**
   * Always-on request/timing JSONL log (see reqlog.ts). One line per
   * /v1/messages request; omitted (e.g. in unit tests) means no logging.
   */
  reqlog?: RequestLogger;
  /** Test-only: forward to this origin instead of api.anthropic.com. */
  upstreamOrigin?: string;
  /** Test-only: dump each forwarded /v1/messages body to this directory. */
  captureDir?: string;
}

export interface RunningProxy {
  port: number;
  /** Random per-process endpoint used by the ephemeral Claude plugin. */
  hookUrl: string;
  close: () => void;
}

interface Upstream {
  module: typeof http | typeof https;
  host: string;
  port: number;
}

/** Per-server mutable state (one server per ccc process). */
interface ProxyState {
  /** Set only when a hook actually claims the payment notice for display. */
  paymentNoticeShown: boolean;
  notices: NoticeDeliveryQueue;
  /** Armed only by a main-thread UserPromptSubmit hook. */
  mainPromptArmed: boolean;
  mainPromptId?: string;
  mainPromptText?: string;
  mainPromptGeneration: number;
  /** Suppress producer-side state changes while agent API traffic is active. */
  activeSubagents: Set<string>;
  /** Claude's full-input token estimates, keyed by token-relevant fields. */
  tokenCounts: Map<string, number>;
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
  const hookPath = `/_ccc/hooks/${randomBytes(24).toString("hex")}`;
  const state: ProxyState = {
    paymentNoticeShown: false,
    notices: new NoticeDeliveryQueue(),
    mainPromptArmed: false,
    mainPromptGeneration: 0,
    activeSubagents: new Set(),
    tokenCounts: new Map(),
  };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, opts, upstream, state, hookPath).catch((err) => {
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
      resolve({
        port,
        hookUrl: `http://127.0.0.1:${port}${hookPath}`,
        close: () => server.close(),
      });
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream,
  state: ProxyState,
  hookPath: string
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (url.pathname === hookPath) {
    return handleNoticeHook(req, res, state);
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handleMessages(req, res, opts, upstream, state);
  }
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return handleCountTokens(req, res, opts, upstream, state);
  }
  return passThroughStreaming(req, res, upstream);
}

/** Serve only validated Claude hook POSTs on the randomized localhost path. */
async function handleNoticeHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ProxyState
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > HOOK_BODY_LIMIT) {
    res.writeHead(413);
    res.end();
    req.resume();
    return;
  }

  const raw = await readBody(req);
  if (raw.length > HOOK_BODY_LIMIT) {
    res.writeHead(413);
    res.end();
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw.toString("utf-8"));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const parsed = parseNoticeHookInput(input);
  if (!parsed) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (parsed.hook_event_name === "UserPromptSubmit") {
    if (parsed.agent_id === undefined) {
      state.mainPromptArmed = true;
      state.mainPromptId = parsed.prompt_id;
      state.mainPromptText = parsed.prompt;
      state.mainPromptGeneration++;
      state.notices.clearForUserRequest();
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (parsed.hook_event_name === "SubagentStart") {
    state.activeSubagents.add(parsed.agent_id);
    res.writeHead(204);
    res.end();
    return;
  }
  if (parsed.hook_event_name === "SubagentStop") {
    state.activeSubagents.delete(parsed.agent_id);
    res.writeHead(204);
    res.end();
    return;
  }

  const output = state.notices.claim(parsed);
  const stopMatchesMainPrompt =
    parsed.hook_event_name === "Stop" &&
    parsed.agent_id === undefined &&
    (state.mainPromptId === undefined ||
      parsed.prompt_id === undefined ||
      state.mainPromptId === parsed.prompt_id);
  if (stopMatchesMainPrompt) {
    state.mainPromptArmed = false;
    state.mainPromptId = undefined;
    state.mainPromptText = undefined;
    // A normal main Stop means all child work for the turn has settled. Clear
    // stale lifecycle entries left by a missed SubagentStop hook.
    state.activeSubagents.clear();
  }
  if (!output) {
    res.writeHead(204);
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(output), "utf-8");
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Buffer + inspect /v1/messages; classify the turn, strip notices, forward. */
async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream,
  state: ProxyState
): Promise<void> {
  const received = Date.now();
  const rawBody = await readBody(req);

  // One request-log record per /v1/messages, filled in as the request flows
  // through the forward path and written exactly once when the response is
  // done (success or failure) — always on, so a stalled turn leaves a trace.
  const rec: MessagesRecord = {
    kind: "messages",
    turnType: "unparseable",
    requestBytes: rawBody.length,
  };
  const logged = (forward: Promise<void>): Promise<void> =>
    forward.finally(() => {
      rec.totalMs = Date.now() - received;
      opts.reqlog?.log(rec);
    });

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody.toString("utf-8"));
    if (!Array.isArray(body.messages)) throw new Error("no messages array");
  } catch {
    // Not a shape we understand — forward verbatim rather than break the session.
    return logged(forwardRaw(req, res, rawBody, opts, upstream, rec));
  }

  // Defensive legacy strip pass first: old marker-wrapped notices (including
  // one copied into an away-summary or top-level system prompt) must never
  // reach Anthropic or MemTree. Hook-delivered notices never enter this body.
  const stripped = stripNoticeBlocks(body.messages);
  const strippedSystem = stripNoticeSystem(body.system);
  let forwardBody = rawBody;
  if (stripped.stripped || strippedSystem.stripped) {
    body.messages = stripped.messages;
    if (strippedSystem.system === undefined) delete body.system;
    else body.system = strippedSystem.system;
    forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
    if (opts.debug) console.error("[ccc proxy] stripped legacy notice span(s) from request");
  }

  const messages: Message[] = body.messages;
  // CC 2.1.207 appends ambient role=system blocks after the typed prompt. Use
  // the last non-system conversation message for classification while keeping
  // every system block in the body sent to MemTree/Anthropic.
  const lastMsg = lastNonSystemMessage(messages);
  const isUserTurn = isNonToolUserMessage(lastMsg);
  const isAwaySummary = isAwaySummaryUserMessage(lastMsg);
  const isFollowupUserTurn =
    isUserTurn && hasEarlierNonToolUserMessage(messages);
  // CC 2.1.207 identifies agent API calls explicitly. Use that wire-level
  // attribution before lifecycle-hook state so an agent request cannot claim
  // or consume a main prompt arm even if SubagentStart ordering is delayed.
  const agentHeader = req.headers["x-claude-code-agent-id"];
  const isSubagentRequest = Array.isArray(agentHeader)
    ? agentHeader.some((value) => value.trim() !== "")
    : typeof agentHeader === "string" && agentHeader.trim() !== "";
  const armedMainFollowup =
    isFollowupUserTurn &&
    !isAwaySummary &&
    !isSubagentRequest &&
    state.mainPromptArmed &&
    state.mainPromptText !== undefined &&
    userMessageText(lastMsg).includes(state.mainPromptText);
  const displayForThisTurn =
    armedMainFollowup &&
    state.activeSubagents.size === 0;
  const noticePromptId = state.mainPromptId;
  const noticePromptGeneration = state.mainPromptGeneration;
  const modelContextLimit = contextLimitForModel(body.model);
  const msgsForMemtree = messagesWithSystem(messages, body.system);
  const hash = MemtreeClient.hashMessages(msgsForMemtree);
  const originalTokenCountKey = tokenCountKey(body, req.headers, req.url);

  // UserPromptSubmit clears/arms only a real main-thread human turn. Keep that
  // arm through CC's small first-user probe/retries; consume it only when the
  // actual followup request reaches the compression branch below. Hidden
  // away-summary requests neither produce notices nor mutate a concurrently
  // armed human turn.

  if (typeof body.model === "string") rec.model = body.model;
  rec.stream = body.stream === true;

  if (!isFollowupUserTurn) {
    // Tool turn or FIRST user turn: keep the index fed off the response path;
    // forward as-is. On the first user turn nothing is indexed yet, so a
    // blocking compress would be a guaranteed no-op costing first-token
    // latency (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
    if (opts.debug && isUserTurn) {
      console.error("[ccc proxy] first user turn: index in background, forward verbatim");
    }
    recordTurn(rec, isUserTurn ? "first-user" : "tool", forwardBody);
    opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit);
    capture(opts, "anthropic-request", forwardBody);
    return logged(forwardRaw(req, res, forwardBody, opts, upstream, rec));
  }

  const compressStarted = Date.now();
  // An active subagent can repeat/embed the human prompt in its own request;
  // producer suppression must also preserve the arm for the later main call.
  if (displayForThisTurn) state.mainPromptArmed = false;
  const result = await opts.memtree.compress(
    hash,
    msgsForMemtree,
    modelContextLimit
  );
  const compressMs = Date.now() - compressStarted;
  rec.compress = {
    ms: compressMs,
    ok: result !== null,
    // Budget-consumed heuristic: the client maps every failure to null, so a
    // null that took (roughly) the whole abort budget was almost certainly
    // the AbortSignal timeout, not a fast server error.
    timedOut: result === null && compressMs >= opts.memtree.compressBudgetMs,
  };

  if (!result) {
    // MemTree down/slow/402: the user's own Anthropic call is never gated on
    // it. Degrade to passthrough and queue a display-only hook notice for a
    // visible turn. The hidden away-summary request deliberately stays quiet.
    // Unpaid key (402, from this compress OR an earlier background index) gets
    // a payment-specific notice instead of the generic degraded one, at most
    // once per proxy process after it has actually been delivered.
    recordTurn(rec, "followup-degraded", forwardBody);
    capture(opts, "anthropic-request", forwardBody);
    const paymentDetail = opts.memtree.paymentRequiredDetail;
    const mayQueueNotice =
      displayForThisTurn && state.mainPromptGeneration === noticePromptGeneration;
    if (mayQueueNotice && paymentDetail !== null && !state.paymentNoticeShown) {
      const detailFirstLine = sanitizeNoticeDetail(
        paymentDetail.split(/[\r\n]/, 1)[0]
      );
      state.notices.queueSuffix(
        detailFirstLine
          ? `${PAYMENT_REQUIRED_NOTICE}\n${detailFirstLine}`
          : PAYMENT_REQUIRED_NOTICE,
        () => {
          state.paymentNoticeShown = true;
        },
        noticePromptId
      );
    } else if (mayQueueNotice && paymentDetail === null) {
      state.notices.queueSuffix(DEGRADED_NOTICE, undefined, noticePromptId);
    }
    return logged(forwardRaw(req, res, forwardBody, opts, upstream, rec));
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
  recordTurn(rec, "followup-compressed", compressedRaw);
  capture(opts, "anthropic-request", compressedRaw);
  if (
    displayForThisTurn &&
    state.mainPromptGeneration === noticePromptGeneration &&
    didMemtreeCompress(result)
  ) {
    const memtreeOriginalTokens = rawPromptTokenCount(result);
    const originalTokensAtCompression =
      originalTokenCountKey === null
        ? undefined
        : state.tokenCounts.get(originalTokenCountKey);
    state.notices.queuePrefix(
      () =>
        compressedNoticeText({
          latencyMs: result.clientLatencyMs ?? compressMs,
          originalTokens:
            memtreeOriginalTokens ??
            originalTokensAtCompression ??
            (originalTokenCountKey === null
              ? undefined
              : state.tokenCounts.get(originalTokenCountKey)),
          consolidatedTokens: totalInputTokens(rec.usage),
        }),
      undefined,
      noticePromptId
    );
  }
  return logged(forwardRaw(req, res, compressedRaw, opts, upstream, rec));
}

/** Stamp the classified turn type and forwarded-size fields on the record. */
function recordTurn(
  rec: MessagesRecord,
  turnType: MessagesRecord["turnType"],
  forwardBody: Buffer
): void {
  rec.turnType = turnType;
  rec.forwardedBytes = forwardBody.length;
  rec.approxInputTokens = approxTokensFromBytes(forwardBody.length);
}

const TOKEN_GENERATION_ONLY_FIELDS = new Set([
  "inference_geo",
  "max_tokens",
  "metadata",
  "service_tier",
  "speed",
  "stop_sequences",
  "stream",
  "temperature",
  "top_k",
  "top_p",
]);

/**
 * Project a Messages request to the Count Tokens request shape. Keeping every
 * unknown field is deliberately conservative: new token-affecting beta fields
 * match automatically, while a future generation-only field merely causes a
 * safe cache miss (and totals are omitted).
 */
function tokenCountBody(
  body: Record<string, any>
): Record<string, unknown> | null {
  if (typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return null;
  }
  const relevant: Record<string, unknown> = {};
  for (const field of Object.keys(body).sort()) {
    if (!TOKEN_GENERATION_ONLY_FIELDS.has(field)) {
      relevant[field] = body[field];
    }
  }
  return relevant;
}

function headerText(
  headers: http.IncomingHttpHeaders,
  name: string
): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function tokenizationHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string> {
  const beta = headerText(headers, "anthropic-beta")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
    .join(",");
  return {
    "anthropic-beta": beta,
    "anthropic-version": headerText(headers, "anthropic-version").trim(),
  };
}

/** Stable key shared by Claude's count_tokens and messages request shapes. */
function tokenCountKey(
  body: Record<string, any>,
  headers: http.IncomingHttpHeaders,
  requestUrl: string | undefined
): string | null {
  const relevant = tokenCountBody(body);
  if (!relevant) return null;
  const search = new URL(
    requestUrl ?? "/",
    "http://127.0.0.1"
  ).search;
  return createHash("sha256")
    .update(
      JSON.stringify({
        body: relevant,
        headers: tokenizationHeaders(headers),
        search,
      })
    )
    .digest("hex");
}

/** Actual full model input: uncached + cache read + cache creation. */
function totalInputTokens(usage: UsageRecord | undefined): number | undefined {
  if (typeof usage?.input_tokens !== "number") return undefined;
  let total = 0;
  for (const value of [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += value;
    }
  }
  return total;
}

function rememberTokenCount(state: ProxyState, key: string, tokens: number): void {
  state.tokenCounts.delete(key);
  state.tokenCounts.set(key, tokens);
  if (state.tokenCounts.size > TOKEN_COUNT_CACHE_MAX) {
    const oldest = state.tokenCounts.keys().next().value;
    if (oldest !== undefined) state.tokenCounts.delete(oldest);
  }
}

/**
 * count_tokens: strip notices and pass through. Retain Claude's full original
 * input count so a later display hook can compare it with Anthropic's actual
 * post-compression usage. The response itself remains byte-transparent.
 */
async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ProxyOptions,
  upstream: Upstream,
  state: ProxyState
): Promise<void> {
  const rawBody = await readBody(req);
  let forwardBody = rawBody;
  let countKey: string | null = null;
  try {
    const body = JSON.parse(rawBody.toString("utf-8"));
    if (Array.isArray(body.messages)) {
      const stripped = stripNoticeBlocks(body.messages);
      const strippedSystem = stripNoticeSystem(body.system);
      if (stripped.stripped || strippedSystem.stripped) {
        body.messages = stripped.messages;
        if (strippedSystem.system === undefined) delete body.system;
        else body.system = strippedSystem.system;
        forwardBody = Buffer.from(JSON.stringify(body), "utf-8");
      }
      countKey = tokenCountKey(body, req.headers, req.url);
    }
  } catch {
    // Unknown shape: forward verbatim.
  }
  return forwardRaw(req, res, forwardBody, opts, upstream, undefined, (response) => {
    if (countKey === null) return;
    try {
      const inputTokens = JSON.parse(response.toString("utf-8"))?.input_tokens;
      if (
        typeof inputTokens === "number" &&
        Number.isFinite(inputTokens) &&
        inputTokens >= 0
      ) {
        rememberTokenCount(state, countKey, inputTokens);
      }
    } catch {
      // A failed/non-JSON count simply means the success notice omits totals.
    }
  });
}

/**
 * Forward a buffered request and pipe the response back byte-for-byte. A
 * passive observer parses copies of SSE/JSON chunks for request logging only;
 * its output is discarded and can never change the client response.
 */
function forwardRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream,
  rec?: MessagesRecord,
  onJsonResponse?: (body: Buffer) => void
): Promise<void> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    headers["content-length"] = String(bodyBuffer.length);
    const forwardStarted = Date.now();

    const upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url, // path + query string verbatim (?beta=true etc.)
        headers,
      },
      (upstreamRes) => {
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const isSse = contentType.includes("text/event-stream");
        const contentEncoding = String(
          upstreamRes.headers["content-encoding"] ?? "identity"
        ).trim().toLowerCase();
        const compressed = contentEncoding !== "" && contentEncoding !== "identity";
        let sawFirstByte = false;
        const observeSseEvent = rec
          ? (data: any) => {
              mergeUsageFromSseEvent(data, rec);
              if (
                rec.firstContentMs === undefined &&
                data?.type === "content_block_delta"
              ) {
                rec.firstContentMs = Date.now() - forwardStarted;
              }
            }
          : undefined;
        const sseObserver = rec && isSse
          ? new SseNoticeRewriter({
              onEvent: observeSseEvent,
            })
          : null;
        const incrementalDecoder = sseObserver && compressed
          ? createObservationDecoder(contentEncoding)
          : null;
        const observedChunks: Buffer[] | null =
          onJsonResponse !== undefined ||
          (rec && (!isSse || (compressed && !incrementalDecoder)))
            ? []
            : null;
        const observeRawChunk = (chunk: Buffer) => {
          if (rec && !sawFirstByte) {
            sawFirstByte = true;
            rec.ttfbMs = Date.now() - forwardStarted;
          }
          if (sseObserver && !compressed) void sseObserver.push(chunk);
          if (observedChunks) observedChunks.push(Buffer.from(chunk));
        };
        if (rec) {
          rec.upstreamStatus = upstreamRes.statusCode ?? 502;
        }
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          forwardableResponseHeaders(upstreamRes)
        );

        if (incrementalDecoder && sseObserver) {
          // Gate each encoded SSE chunk on locally decoding its copy. This
          // guarantees message_start usage is recorded before the identical
          // gzip/Brotli/deflate bytes can trigger Claude's MessageDisplay hook.
          // Only the original bytes are written to the client.
          let decoderFailed = false;
          let pendingForward: (() => void) | null = null;
          let pendingFinish: (() => void) | null = null;
          incrementalDecoder.on("data", (chunk: Buffer) => {
            if (!decoderFailed) void sseObserver.push(chunk);
          });
          incrementalDecoder.on("error", () => {
            decoderFailed = true;
            const forward = pendingForward;
            pendingForward = null;
            forward?.();
            const finish = pendingFinish;
            pendingFinish = null;
            finish?.();
          });
          res.once("close", () => incrementalDecoder.destroy());

          const forwardEncoded = (chunk: Buffer) => {
            if (res.destroyed || res.writableEnded) {
              upstreamRes.destroy();
              return;
            }
            if (res.write(chunk)) upstreamRes.resume();
            else res.once("drain", () => upstreamRes.resume());
          };

          upstreamRes.on("data", (chunk: Buffer) => {
            upstreamRes.pause();
            observeRawChunk(chunk);
            if (decoderFailed) {
              forwardEncoded(chunk);
              return;
            }
            let forwarded = false;
            const forwardOnce = () => {
              if (forwarded) return;
              forwarded = true;
              forwardEncoded(chunk);
            };
            pendingForward = forwardOnce;
            try {
              incrementalDecoder.write(chunk, (err) => {
                if (err) decoderFailed = true;
                if (pendingForward === forwardOnce) pendingForward = null;
                forwardOnce();
              });
            } catch {
              decoderFailed = true;
              if (pendingForward === forwardOnce) pendingForward = null;
              forwardOnce();
            }
          });
          upstreamRes.on("end", () => {
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              pendingFinish = null;
              void sseObserver.flush();
              if (observedChunks && onJsonResponse) {
                const observed = decodeForObservation(
                  Buffer.concat(observedChunks),
                  contentEncoding
                );
                if (observed) {
                  try {
                    onJsonResponse(observed);
                  } catch {
                    // Passive observation must never affect proxying.
                  }
                }
              }
              if (!res.destroyed && !res.writableEnded) res.end();
              resolve();
            };
            if (decoderFailed) {
              finish();
              return;
            }
            try {
              pendingFinish = finish;
              incrementalDecoder.end(finish);
            } catch {
              finish();
            }
          });
          upstreamRes.on("error", () => {
            incrementalDecoder.destroy();
            res.destroy();
            resolve();
          });
          return;
        }

        upstreamRes.on("data", observeRawChunk);
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => {
          if (sseObserver && !compressed) void sseObserver.flush();
          if (observedChunks) {
            const observed = decodeForObservation(
              Buffer.concat(observedChunks),
              contentEncoding
            );
            if (observed && onJsonResponse) {
              try {
                onJsonResponse(observed);
              } catch {
                // Passive observation must never affect the proxied response.
              }
            }
            if (rec && observed && isSse) {
              void sseObserver?.push(observed);
              void sseObserver?.flush();
            } else if (rec && observed) {
              mergeUsageFromJsonBody(observed, rec);
            }
          }
          resolve();
        });
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
  const dir = opts.captureDir;
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

/** Incremental decoder used only to observe a copy of encoded SSE bytes. */
function createObservationDecoder(encoding: string): Transform | null {
  if (encoding === "gzip") return createGunzip();
  if (encoding === "br") return createBrotliDecompress();
  if (encoding === "deflate") return createInflate();
  return null;
}

/** Decode a response copy for diagnostics without ever touching forwarded bytes. */
function decodeForObservation(body: Buffer, encoding: string): Buffer | null {
  try {
    if (!encoding || encoding === "identity") return body;
    if (encoding === "gzip") return gunzipSync(body);
    if (encoding === "br") return brotliDecompressSync(body);
    if (encoding === "deflate") return inflateSync(body);
  } catch {
    // Diagnostics only. Unknown/corrupt encodings do not affect proxying.
  }
  return null;
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
