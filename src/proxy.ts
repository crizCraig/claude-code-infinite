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
 * - Followup user turn: blocking compress + substitute. In CLI A/B mode, a
 *   compact request below the effective-context gate uses memory directly;
 *   above the gate, the proxy starts memory and full-history SSE legs, grades
 *   their semantic prefixes, commits the in-flight winner, and aborts the
 *   loser. A memory winner remains the prefix for that turn's tool loop.
 * - MemTree failure/timeout degrades to passthrough. A display-only success
 *   notice is queued only when the memory response is selected; degraded and
 *   unpaid states get their own notices.
 *
 * Every /v1/messages and count_tokens body is run through the legacy notice
 * strip pass before hashing/forwarding. Live notices use Claude Code hooks and
 * selected upstream response bytes pass through unchanged in the default
 * buffered mode. Explicit speculative mode performs documented SSE surgery.
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
  abGateDecision,
  buildFusionGraderBody,
  extractUnfoldedMemory,
  GRADING_TRUNCATION_MARKER,
  parseFusionVerdictResponse,
  resolveAbRoutingOptions,
  winnerForVerdict,
  type AbGradeInput,
  type AbRoutingOptions,
  type AbWinner,
  type FusionVerdict,
  type ResolvedAbRoutingOptions,
} from "./ab-routing.js";
import {
  didMemtreeCompress,
  MemtreeClient,
  rawPromptTokenCount,
  type CompressResult,
} from "./memtree.js";
import {
  contextLimitForModel,
  flattenToSingleUserMessage,
  hasEarlierNonToolUserMessage,
  isAwaySummaryUserMessage,
  isLocalBashCommandTurn,
  isNonToolUserMessage,
  isToolResultUserMessage,
  lastNonSystemMessage,
  messagesWithSystem,
  stripSystemReminderText,
  userMessageText,
  type Message,
} from "./turns.js";
import {
  DEGRADED_NOTICE,
  FULL_HISTORY_OVERRIDE_NOTICE,
  PAYMENT_REQUIRED_NOTICE,
  RECOVERED_NOTICE,
  SseNoticeRewriter,
  compressedNoticeText,
  sanitizeNoticeDetail,
  stripNoticeBlocks,
  stripNoticeSystem,
} from "./notices.js";
import {
  RECOVERY_BRIDGE_TEXT,
  SseEventForwarder,
  SseSpliceWriter,
  bridgeBlockEvents,
  contentBlockStopEvent,
} from "./splice.js";
import {
  NoticeDeliveryQueue,
  parseNoticeHookInput,
} from "./hooks.js";
import {
  approxTokensFromBytes,
  mergeUsageFromJsonBody,
  mergeUsageFromSseEvent,
  type MessagesRecord,
  type ComparisonDelivered,
  type ComparisonInterrupt,
  type ComparisonLegRecord,
  type GraderDiagnostic,
  type RequestLogSink,
  type TurnType,
  type UsageRecord,
} from "./reqlog.js";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const HOOK_BODY_LIMIT = 64 * 1024;
const NOTICE_SETTLE_WAIT_MS = 1_000;
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

// Speculative SSE delivery can splice a second response into the first, so
// upstream representation metadata is no longer valid for the bytes sent to
// the client. In particular, retaining content-length disables Node's
// chunked framing and can truncate the splice at the original leg's length.
const SKIP_TRANSFORMED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-range",
  "content-md5",
  "content-digest",
  "repr-digest",
  "digest",
  "etag",
  "trailer",
]);

export interface ProxyOptions {
  memtree: MemtreeClient;
  /**
   * Live with-memory vs full-history routing. Omit to retain the legacy
   * single-memory-leg path (useful to embedders/tests); the CLI enables it.
   */
  abRouting?: AbRoutingOptions;
  debug?: boolean;
  /**
   * Always-on request/timing JSONL log (see reqlog.ts). Includes messages,
   * MemTree calls, and successful notice claims; omitted means no logging.
   */
  reqlog?: RequestLogSink;
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
  /**
   * Stop accepting work and give active requests a bounded grace period.
   * On expiry, speculative shadows are cancelled and their finalizers awaited;
   * false reports that forced cancellation was required.
   */
  drain: (timeoutMs?: number) => Promise<boolean>;
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
  /** Matching Stop waits briefly for this response's final notice decision. */
  mainNoticeDelivery?: MainNoticeDelivery;
  /** Suppress producer-side state changes while agent API traffic is active. */
  activeSubagents: Set<string>;
  /** Claude's full-input token estimates, keyed by token-relevant fields. */
  tokenCounts: Map<string, number>;
  /** Resolved once at startup; absent means single-leg legacy behavior. */
  abRouting?: ResolvedAbRoutingOptions;
  /** A memory winner carried through the current human turn's tool loop. */
  mainMemoryRoute?: MainMemoryRoute;
  /** Monotonic guard against stale async routing decisions, hooks or no hooks. */
  mainRouteEpoch: number;
  /** Fired by drain after its grace period so speculative work can finalize. */
  shutdownSignal: AbortSignal;
}

interface MainNoticeDelivery {
  promptGeneration: number;
  promptId?: string;
  pending: number;
  /** The selected memory response ended upstream, so first display may wait briefly. */
  firstDisplayCanWait: boolean;
  settled: Promise<void>;
  resolve: () => void;
}

function beginMainNoticeDelivery(
  state: ProxyState,
  promptGeneration: number,
  promptId: string | undefined
): MainNoticeDelivery {
  const current = state.mainNoticeDelivery;
  if (
    current &&
    current.promptGeneration === promptGeneration &&
    current.promptId === promptId
  ) {
    current.pending++;
    return current;
  }
  cancelMainNoticeDelivery(state);
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  const delivery: MainNoticeDelivery = {
    promptGeneration,
    promptId,
    pending: 1,
    firstDisplayCanWait: false,
    settled,
    resolve,
  };
  state.mainNoticeDelivery = delivery;
  return delivery;
}

function settleMainNoticeDelivery(
  state: ProxyState,
  delivery: MainNoticeDelivery
): void {
  if (delivery.pending > 0) delivery.pending--;
  if (delivery.pending !== 0) return;
  delivery.resolve();
  if (state.mainNoticeDelivery === delivery) {
    state.mainNoticeDelivery = undefined;
  }
}

function cancelMainNoticeDelivery(state: ProxyState): void {
  const delivery = state.mainNoticeDelivery;
  if (!delivery) return;
  state.mainNoticeDelivery = undefined;
  delivery.pending = 0;
  delivery.resolve();
}

async function waitForMainNoticeDelivery(
  state: ProxyState,
  promptId: string | undefined
): Promise<void> {
  const delivery = state.mainNoticeDelivery;
  if (
    !delivery ||
    (delivery.promptId !== undefined &&
      promptId !== undefined &&
      delivery.promptId !== promptId)
  ) {
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      delivery.settled,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, NOTICE_SETTLE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface MainMemoryRoute {
  sessionId: string;
  model: string;
  originalSystemHash: string;
  originalPrefixHashes: string[];
  compressedMessages: Message[];
  compressedSystem: unknown;
  hasCompressedSystem: boolean;
  routeEpoch: number;
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
  const activeRequests = new Set<Promise<void>>();
  const shutdownAbort = new AbortController();
  const state: ProxyState = {
    paymentNoticeShown: false,
    notices: new NoticeDeliveryQueue(),
    mainPromptArmed: false,
    mainPromptGeneration: 0,
    activeSubagents: new Set(),
    tokenCounts: new Map(),
    abRouting: opts.abRouting
      ? resolveAbRoutingOptions(opts.abRouting)
      : undefined,
    mainRouteEpoch: 0,
    shutdownSignal: shutdownAbort.signal,
  };
  const server = http.createServer((req, res) => {
    const task = handleRequest(req, res, opts, upstream, state, hookPath).catch(
      (err) => {
        try {
          sendAnthropicError(res, `local proxy error: ${err?.message ?? err}`);
        } catch {
          // A failed error response must not strand shutdown bookkeeping.
        }
      }
    );
    activeRequests.add(task);
    void task.then(
      () => activeRequests.delete(task),
      () => activeRequests.delete(task)
    );
  });
  // Long-running SSE responses must not be cut by idle timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let closePromise: Promise<void> | undefined;
  const beginClose = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = new Promise((done) => {
      if (!server.listening) {
        done();
        return;
      }
      server.close(() => done());
    });
    return closePromise;
  };
  const drain = async (timeoutMs = 5_000): Promise<boolean> => {
    const boundedMs =
      Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : 5_000;
    const quiesced = (async () => {
      // Once close completes, every accepted request has entered the tracked
      // set. Some handlers intentionally outlive their downstream response
      // while a speculative shadow grade finishes.
      await beginClose();
      while (activeRequests.size > 0) {
        await Promise.allSettled([...activeRequests]);
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      quiesced.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (completed) return true;

    // The grace period only protects useful late shadow verdicts. Once it
    // expires, actively cancel speculative work and wait for each handler's
    // finally-log to run before returning to the caller's RequestLogger flush.
    shutdownAbort.abort();
    await quiesced;
    return false;
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        hookUrl: `http://127.0.0.1:${port}${hookPath}`,
        close: () => {
          void beginClose();
        },
        drain,
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
    return handleNoticeHook(req, res, state, opts.reqlog);
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
  state: ProxyState,
  reqlog: RequestLogSink | undefined
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
      cancelMainNoticeDelivery(state);
      state.mainPromptArmed = true;
      state.mainPromptId = parsed.prompt_id;
      state.mainPromptText = parsed.prompt;
      state.mainPromptGeneration++;
      state.mainRouteEpoch++;
      state.mainMemoryRoute = undefined;
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

  const hookPromptGeneration = state.mainPromptGeneration;
  const displayWaitsForNotice =
    parsed.hook_event_name === "MessageDisplay" &&
    parsed.agent_id === undefined &&
    parsed.index === 0 &&
    state.mainNoticeDelivery?.firstDisplayCanWait === true &&
    (state.mainNoticeDelivery.promptId === undefined ||
      parsed.prompt_id === undefined ||
      state.mainNoticeDelivery.promptId === parsed.prompt_id);
  if (displayWaitsForNotice) {
    await waitForMainNoticeDelivery(state, parsed.prompt_id);
  }
  const stopMatchesMainPrompt =
    parsed.hook_event_name === "Stop" &&
    parsed.agent_id === undefined &&
    (state.mainPromptId === undefined ||
      parsed.prompt_id === undefined ||
      state.mainPromptId === parsed.prompt_id);
  if (stopMatchesMainPrompt) {
    await waitForMainNoticeDelivery(state, parsed.prompt_id);
  }
  // UserPromptSubmit can run while a display or Stop hook awaits the prior
  // response. Never let that old hook consume or clear the newer prompt's state.
  const stopStillMatches =
    stopMatchesMainPrompt &&
    state.mainPromptGeneration === hookPromptGeneration;
  const displayStillMatches =
    !displayWaitsForNotice ||
    state.mainPromptGeneration === hookPromptGeneration;
  const output =
    (parsed.hook_event_name === "Stop" && !stopStillMatches) ||
    !displayStillMatches
      ? null
      : state.notices.claim(parsed);
  if (stopStillMatches) {
    cancelMainNoticeDelivery(state);
    state.mainPromptArmed = false;
    state.mainPromptId = undefined;
    state.mainPromptText = undefined;
    // Invalidate a response that did not settle within the bounded hook wait.
    // Otherwise its late callback could enqueue a notice after Stop returned.
    state.mainPromptGeneration++;
    state.mainRouteEpoch++;
    state.mainMemoryRoute = undefined;
    // A normal main Stop means all child work for the turn has settled. Clear
    // stale lifecycle entries left by a missed SubagentStop hook.
    state.activeSubagents.clear();
  }
  if (!output) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (
    parsed.hook_event_name === "MessageDisplay" ||
    parsed.hook_event_name === "Stop"
  ) {
    try {
      reqlog?.log({
        kind: "notice",
        event: "claimed",
        via: parsed.hook_event_name,
      });
    } catch {
      // Custom/test loggers get RequestLogger's never-break-hook policy.
    }
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
  let noticeDelivery: MainNoticeDelivery | undefined;
  const settleNoticeDelivery = () => {
    if (!noticeDelivery) return;
    settleMainNoticeDelivery(state, noticeDelivery);
    noticeDelivery = undefined;
  };
  const logged = async (forward: Promise<unknown>): Promise<void> => {
    try {
      await forward;
    } finally {
      settleNoticeDelivery();
      // Speculative A/B stamps delivery-complete time itself: its forward
      // promise intentionally outlives delivery to also capture the shadow
      // grade, which must not inflate the delivery metric.
      if (rec.totalMs === undefined) rec.totalMs = Date.now() - received;
      opts.reqlog?.log(rec);
    }
  };

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
  const isToolResultTurn = isToolResultUserMessage(lastMsg);
  const isAwaySummary = isAwaySummaryUserMessage(lastMsg);
  const isLocalBashCommand = isLocalBashCommandTurn(messages);
  const isFollowupUserTurn =
    isUserTurn && hasEarlierNonToolUserMessage(messages);
  // CC 2.1.207 identifies agent API calls explicitly. Use that wire-level
  // attribution before lifecycle-hook state so an agent request cannot claim
  // or consume a main prompt arm even if SubagentStart ordering is delayed.
  const isSubagentRequest = hasAgentAttribution(req);
  const isMainRequest = !isAwaySummary && !isSubagentRequest;
  let routeEpoch = state.mainRouteEpoch;
  if (isUserTurn && isMainRequest) {
    routeEpoch = ++state.mainRouteEpoch;
    state.mainMemoryRoute = undefined;
  }
  const hookOwnedMainFollowup =
    isFollowupUserTurn &&
    !isAwaySummary &&
    !isSubagentRequest &&
    state.mainPromptArmed &&
    state.mainPromptText !== undefined &&
    userMessageText(lastMsg).includes(state.mainPromptText);
  // Local `!command` turns do not consistently emit UserPromptSubmit, and the
  // API history contains bash wrappers rather than the literal typed command.
  // Their strict main-thread replay shape can safely own its own notice.
  const localCommandMainFollowup =
    isFollowupUserTurn &&
    !isAwaySummary &&
    !isSubagentRequest &&
    isLocalBashCommand;
  const displayForThisTurn =
    (hookOwnedMainFollowup || localCommandMainFollowup) &&
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
    let routedBody = forwardBody;
    let routedTool = false;
    if (
      isToolResultTurn &&
      isMainRequest &&
      state.abRouting &&
      state.mainMemoryRoute
    ) {
      const rewritten = memoryRoutedToolBody(
        body,
        messages,
        state.mainMemoryRoute,
        state.mainRouteEpoch,
        requestSessionId(req)
      );
      if (rewritten) {
        routedBody = rewritten;
        routedTool = true;
      } else {
        // A mismatch means a different/resumed conversation shape. Never risk
        // grafting one session's compressed prefix onto another.
        state.mainMemoryRoute = undefined;
      }
    }
    recordTurn(
      rec,
      routedTool ? "tool-memory" : isUserTurn ? "first-user" : "tool",
      routedBody
    );
    opts.memtree.indexInBackground(hash, msgsForMemtree, modelContextLimit);
    capture(opts, routedTool ? "anthropic-request-memory-tool" : "anthropic-request", routedBody);
    return logged(forwardRaw(req, res, routedBody, opts, upstream, rec));
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
    if (isMainRequest) state.mainMemoryRoute = undefined;
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
      `[ccc proxy] user turn compressed: ${forwardBody.length} → ` +
        `${compressedRaw.length} body bytes`
    );
  }
  const actuallyCompressed = didMemtreeCompress(result);
  const abRouting = state.abRouting;
  if (
    abRouting &&
    actuallyCompressed &&
    displayForThisTurn &&
    state.mainPromptGeneration === noticePromptGeneration
  ) {
    // A/B mode intentionally decides success only after complete downstream
    // delivery. Let a nearly simultaneous display or Stop wait briefly for
    // that decision instead of racing the late notice callback.
    noticeDelivery = beginMainNoticeDelivery(
      state,
      noticePromptGeneration,
      noticePromptId
    );
  }
  const canRouteAb =
    abRouting !== undefined &&
    actuallyCompressed &&
    body.stream === true &&
    isMainRequest;

  if (canRouteAb) {
    // M1c gates on the whole A request. Until count_tokens is available here,
    // use its conservative fallback (encoded body bytes / 3 chars per token).
    const contextTokens = Math.ceil(compressedRaw.length / 3);
    const gate = abGateDecision(String(body.model ?? ""), contextTokens, abRouting);
    rec.comparison = {
      attempted: gate.compare,
      gateReason: gate.reason,
      approxContextTokens: gate.contextTokens,
      contextTokenEstimate: "body-bytes/3",
      effectiveContextTokens: gate.effectiveContextTokens,
      thresholdTokens: gate.thresholdTokens,
    };

    if (!gate.compare) {
      rec.comparison.winner = "memory";
      recordTurn(rec, "followup-compressed", compressedRaw);
      capture(opts, "anthropic-request-memory", compressedRaw);
      return logged(
        forwardRaw(req, res, compressedRaw, opts, upstream, rec).then(
          (delivered) => {
            rec.comparison!.deliveryOk = delivered;
            if (delivered && state.mainRouteEpoch === routeEpoch) {
              queueCompressionNotice({
                state,
                displayForThisTurn,
                noticePromptGeneration,
                noticePromptId,
                result,
                compressMs,
                originalTokenCountKey,
                rec,
              });
              installMainMemoryRoute(
                state,
                req,
                body,
                messages,
                compressedBody,
                routeEpoch
              );
            } else if (state.mainRouteEpoch === routeEpoch) {
              state.mainMemoryRoute = undefined;
            }
          }
        )
      );
    }

    return logged(
      forwardComparedSse({
        req,
        res,
        opts,
        upstream,
        routing: abRouting,
        memoryBody: compressedRaw,
        fullBody: forwardBody,
        question: stripSystemReminderText(userMessageText(lastMsg)),
        unfoldedMemory:
          typeof result.unfolded_memory === "string"
            ? result.unfolded_memory
            : extractUnfoldedMemory(result.messages),
        model: String(body.model ?? ""),
        rec,
        receivedAt: received,
        shutdownSignal: state.shutdownSignal,
        onDecision: (winner, selectedAlreadyComplete) => {
          if (
            state.mainPromptGeneration !== noticePromptGeneration ||
            state.mainRouteEpoch !== routeEpoch
          ) {
            return;
          }
          if (
            winner === "memory" &&
            selectedAlreadyComplete &&
            noticeDelivery &&
            state.mainNoticeDelivery === noticeDelivery
          ) {
            // The whole selected response ended upstream before any client
            // bytes. Its first MessageDisplay may make a bounded wait for the
            // downstream finish and then claim the completed-delivery notice.
            noticeDelivery.firstDisplayCanWait = true;
          }
          if (winner === "full") {
            state.mainMemoryRoute = undefined;
          }
        },
        onDeliveryComplete: (delivered, ok) => {
          // Route/notice bookkeeping is keyed off DELIVERED content, not the
          // verdict: a late B verdict after a clean memory delivery changes
          // priors, never the installed route.
          try {
            if (state.mainRouteEpoch !== routeEpoch) return;
            if (delivered === "memory" && ok) {
              queueCompressionNotice({
                state,
                displayForThisTurn,
                noticePromptGeneration,
                noticePromptId,
                result,
                compressMs,
                originalTokenCountKey,
                rec,
              });
              installMainMemoryRoute(
                state,
                req,
                body,
                messages,
                compressedBody,
                routeEpoch
              );
              return;
            }
            state.mainMemoryRoute = undefined;
            const mayQueueNotice =
              ok &&
              displayForThisTurn &&
              state.mainPromptGeneration === noticePromptGeneration;
            if (mayQueueNotice && delivered === "spliced") {
              state.notices.queueSuffix(
                FULL_HISTORY_OVERRIDE_NOTICE,
                undefined,
                noticePromptId
              );
            } else if (mayQueueNotice && delivered === "recovered") {
              state.notices.queueSuffix(
                RECOVERED_NOTICE,
                undefined,
                noticePromptId
              );
            }
          } finally {
            // In speculative mode delivery completes while the shadow grade
            // is still running; release a waiting display/Stop hook now.
            settleNoticeDelivery();
          }
        },
      })
    );
  }

  if (abRouting && isMainRequest) state.mainMemoryRoute = undefined;
  recordTurn(rec, "followup-compressed", compressedRaw);
  capture(opts, "anthropic-request", compressedRaw);
  // Preserve the legacy embedder contract: without A/B enabled, a long live
  // stream may claim its display notice before message_stop. CLI A/B paths
  // above require complete delivery before queuing the same success notice.
  if (actuallyCompressed && !abRouting) {
    queueCompressionNotice({
      state,
      displayForThisTurn,
      noticePromptGeneration,
      noticePromptId,
      result,
      compressMs,
      originalTokenCountKey,
      rec,
    });
  }
  return logged(
    forwardRaw(req, res, compressedRaw, opts, upstream, rec).then(
      (delivered) => {
        if (!abRouting || !actuallyCompressed || !delivered) return;
        queueCompressionNotice({
          state,
          displayForThisTurn,
          noticePromptGeneration,
          noticePromptId,
          result,
          compressMs,
          originalTokenCountKey,
          rec,
        });
      }
    )
  );
}

function queueCompressionNotice(args: {
  state: ProxyState;
  displayForThisTurn: boolean;
  noticePromptGeneration: number;
  noticePromptId: string | undefined;
  result: CompressResult;
  compressMs: number;
  originalTokenCountKey: string | null;
  rec: MessagesRecord;
}): void {
  const {
    state,
    displayForThisTurn,
    noticePromptGeneration,
    noticePromptId,
    result,
    compressMs,
    originalTokenCountKey,
    rec,
  } = args;
  if (
    !displayForThisTurn ||
    state.mainPromptGeneration !== noticePromptGeneration
  ) {
    return;
  }
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

function installMainMemoryRoute(
  state: ProxyState,
  req: http.IncomingMessage,
  originalBody: Record<string, any>,
  originalMessages: Message[],
  compressedBody: Record<string, any>,
  routeEpoch: number
): void {
  if (state.mainRouteEpoch !== routeEpoch) return;
  const sessionId = requestSessionId(req);
  if (
    !sessionId ||
    typeof originalBody.model !== "string" ||
    !Array.isArray(compressedBody.messages)
  ) {
    state.mainMemoryRoute = undefined;
    return;
  }
  state.mainMemoryRoute = {
    sessionId,
    model: originalBody.model,
    originalSystemHash: routeValueHash(
      withoutContentBlockCacheControl(originalBody.system)
    ),
    // Include trailing ambient role=system blocks: MemTree consolidated them
    // into compressedBody.system, so treating them as suffix would duplicate
    // those instructions on every tool request.
    originalPrefixHashes: originalMessages.map(routeMessageHash),
    compressedMessages: cloneJson(compressedBody.messages),
    compressedSystem: cloneJson(compressedBody.system),
    hasCompressedSystem: Object.prototype.hasOwnProperty.call(
      compressedBody,
      "system"
    ),
    routeEpoch,
  };
}

function memoryRoutedToolBody(
  body: Record<string, any>,
  messages: Message[],
  route: MainMemoryRoute,
  routeEpoch: number,
  sessionId: string | undefined
): Buffer | null {
  if (
    !sessionId ||
    route.sessionId !== sessionId ||
    route.routeEpoch !== routeEpoch ||
    body.model !== route.model ||
    routeValueHash(withoutContentBlockCacheControl(body.system)) !==
      route.originalSystemHash
  ) {
    return null;
  }
  const prefixLength = route.originalPrefixHashes.length;
  if (messages.length <= prefixLength) return null;
  for (let i = 0; i < prefixLength; i++) {
    if (routeMessageHash(messages[i]) !== route.originalPrefixHashes[i]) {
      return null;
    }
  }
  const suffix = messages.slice(prefixLength);
  if (!validToolRouteSuffix(suffix)) return null;
  const routed: Record<string, any> = {
    ...body,
    messages: [...cloneJson(route.compressedMessages), ...suffix],
  };
  if (route.hasCompressedSystem) routed.system = cloneJson(route.compressedSystem);
  else delete routed.system;
  return Buffer.from(JSON.stringify(routed), "utf-8");
}

/** Ignore cache-control churn when matching Claude's next tool-loop request. */
function routeMessageHash(message: Message): string {
  return routeValueHash(normalizeRouteMessage(message));
}

function routeValueHash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        present: value !== undefined,
        value: stableRouteValue(value),
      })
    )
    .digest("hex");
}

function normalizeRouteMessage(message: Message): Message {
  const normalized = cloneJson(message);
  if (normalized.role === "user" && typeof normalized.content === "string") {
    normalized.content = [{ type: "text", text: normalized.content }];
  }
  normalized.content = normalizeReminderContent(normalized.content);
  normalized.content = withoutContentBlockCacheControl(normalized.content);
  return normalized;
}

function normalizeReminderContent(content: unknown): unknown {
  if (typeof content === "string") return stripSystemReminderText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part === "string") return stripSystemReminderText(part);
    if (!part || typeof part !== "object") return part;
    const copy = { ...(part as Record<string, unknown>) };
    if (copy.type === "text" && typeof copy.text === "string") {
      copy.text = stripSystemReminderText(copy.text);
    } else if (copy.type === "tool_result") {
      copy.content = normalizeReminderContent(copy.content);
    }
    return copy;
  });
}

/** Ignore only Anthropic content-block cache metadata, never user/tool data. */
function withoutContentBlockCacheControl(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((part) => withoutContentBlockCacheControl(part));
  }
  if (!content || typeof content !== "object") return content;
  const { cache_control: _cacheControl, ...block } = content as Record<
    string,
    unknown
  >;
  return block;
}

function stableRouteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRouteValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stableRouteValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function validToolRouteSuffix(messages: Message[]): boolean {
  if (!messages.length || messages.some(isNonToolUserMessage)) return false;
  const toolUses = new Set<string>();
  const toolResults: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_use" && typeof part.id === "string") {
        toolUses.add(part.id);
      } else if (
        part.type === "tool_result" &&
        typeof part.tool_use_id === "string"
      ) {
        toolResults.push(part.tool_use_id);
      }
    }
  }
  return (
    toolUses.size > 0 &&
    toolResults.length > 0 &&
    toolResults.every((id) => toolUses.has(id))
  );
}

function requestSessionId(req: http.IncomingMessage): string | undefined {
  const value = req.headers["x-claude-code-session-id"];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function hasAgentAttribution(req: http.IncomingMessage): boolean {
  for (const name of [
    "x-claude-code-agent-id",
    "x-claude-code-parent-agent-id",
  ]) {
    const value = req.headers[name];
    const present = Array.isArray(value)
      ? value.some((item) => item.trim() !== "")
      : typeof value === "string" && value.trim() !== "";
    if (present) return true;
  }
  return false;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
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
 * count_tokens: strip notices and mirror an active memory route during its
 * tool loop. Retain Claude's full original input count so a later display hook
 * can compare it with Anthropic's actual post-compression usage. The response
 * itself remains byte-transparent.
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
      let countedBody = body;
      const lastMsg = lastNonSystemMessage(body.messages);
      if (
        state.abRouting &&
        state.mainMemoryRoute &&
        isToolResultUserMessage(lastMsg) &&
        !hasAgentAttribution(req)
      ) {
        const routed = memoryRoutedToolBody(
          body,
          body.messages,
          state.mainMemoryRoute,
          state.mainRouteEpoch,
          requestSessionId(req)
        );
        if (routed) {
          forwardBody = routed;
          countedBody = JSON.parse(routed.toString("utf-8"));
        }
      }
      countKey = tokenCountKey(countedBody, req.headers, req.url);
    }
  } catch {
    // Unknown shape: forward verbatim.
  }
  return forwardRaw(
    req,
    res,
    forwardBody,
    opts,
    upstream,
    undefined,
    (response) => {
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
    }
  ).then(() => undefined);
}

interface ComparedSseArgs {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  opts: ProxyOptions;
  upstream: Upstream;
  routing: ResolvedAbRoutingOptions;
  memoryBody: Buffer;
  fullBody: Buffer;
  question: string;
  unfoldedMemory: string;
  model: string;
  rec: MessagesRecord;
  /** Request-received timestamp so delivery-complete can stamp rec.totalMs. */
  receivedAt: number;
  /** Proxy-wide forced-shutdown signal, observed by speculative mode only. */
  shutdownSignal: AbortSignal;
  /** Buffered mode only; speculative mode reports through onDeliveryComplete. */
  onDecision: (winner: AbWinner, selectedAlreadyComplete: boolean) => void;
  onDeliveryComplete: (delivered: ComparisonDelivered, ok: boolean) => void;
}

/**
 * Live memory-vs-full comparison. Buffered mode is the safe default and holds
 * both prefixes until the grader selects a leg. Explicit speculative mode
 * commits the memory leg from its first byte and treats a B verdict as an
 * in-stream interruption.
 */
async function forwardComparedSse(args: ComparedSseArgs): Promise<void> {
  if (args.routing.speculative) return forwardSpeculativeSse(args);
  return forwardBufferedComparedSse(args);
}

/** Buffer two live SSE legs, grade their semantic prefixes, then commit one. */
async function forwardBufferedComparedSse(args: ComparedSseArgs): Promise<void> {
  const {
    req,
    res,
    opts,
    upstream,
    routing,
    memoryBody,
    fullBody,
    question,
    unfoldedMemory,
    model,
    rec,
    onDecision,
    onDeliveryComplete,
  } = args;
  const comparison = rec.comparison!;
  comparison.prefixChars = routing.prefixChars;
  const memoryRecord: ComparisonLegRecord = { requestBytes: memoryBody.length };
  const fullRecord: ComparisonLegRecord = { requestBytes: fullBody.length };
  comparison.memoryLeg = memoryRecord;
  comparison.fullLeg = fullRecord;
  rec.turnType = "followup-ab-pending";

  capture(opts, "anthropic-request-memory", memoryBody);
  capture(opts, "anthropic-request-full", fullBody);

  const memoryLeg = new BufferedUpstreamLeg({
    name: "memory",
    req,
    body: memoryBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: memoryRecord,
  });
  const fullLeg = new BufferedUpstreamLeg({
    name: "full",
    req,
    body: fullBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: fullRecord,
  });
  const decisionAbort = new AbortController();
  let clientClosed = false;
  const abortAll = () => {
    if (!res.writableFinished) {
      clientClosed = true;
      comparison.clientAborted = true;
    }
    decisionAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
  };
  res.once("close", abortAll);

  try {
    memoryLeg.start();
    fullLeg.start();

    const prefixStarted = Date.now();
    const prefixesReady = await waitForBothPrefixes(
      memoryLeg,
      fullLeg,
      routing.prefixTimeoutMs,
      decisionAbort.signal
    );
    comparison.prefixWaitMs = Date.now() - prefixStarted;
    if (clientClosed || res.destroyed) return;

    let winner: AbWinner = "memory";
    let verdict: FusionVerdict | undefined;
    let fallbackReason: string | undefined;
    const memoryHealthy = memoryLeg.isHealthy();
    const fullHealthy = fullLeg.isHealthy();

    if (!prefixesReady) {
      const memoryReady = memoryLeg.isPrefixReadyAndHealthy();
      const fullReady = fullLeg.isPrefixReadyAndHealthy();
      if (fullReady && !memoryReady) {
        winner = "full";
        fallbackReason = "memory-prefix-timeout";
      } else if (memoryReady) {
        fallbackReason = "full-prefix-timeout";
      } else if (
        !memoryHealthy &&
        (fullHealthy || (memoryLeg.hasFailed() && !fullLeg.hasFailed()))
      ) {
        winner = "full";
        fallbackReason = "memory-leg-failed-before-prefix";
      } else {
        // The prefix timer is not an upstream timeout. Extended thinking can
        // legitimately exceed it without producing gradable answer text, so
        // stop comparing and continue the preferred in-flight memory request.
        fallbackReason = "prefix-timeout-default-memory";
      }
    } else if (!memoryHealthy && fullHealthy) {
      winner = "full";
      fallbackReason = "memory-leg-failed";
    } else if (memoryHealthy && !fullHealthy) {
      fallbackReason = "full-leg-failed";
    } else if (!memoryHealthy && !fullHealthy) {
      fallbackReason = "both-legs-failed";
    } else {
      const gradeStarted = Date.now();
      const graderDiagnostic: GraderDiagnostic = {
        model: routing.grader ? "injected" : routing.graderModel,
        ok: false,
      };
      comparison.grader = graderDiagnostic;
      const gradeOutcome = await gradeComparedPrefixes({
        req,
        upstream,
        routing,
        input: {
          question,
          unfoldedMemory,
          memoryResponse: memoryLeg.semanticForGrading(),
          fullResponse: fullLeg.semanticForGrading(),
          model,
          signal: decisionAbort.signal,
        },
        overflow: Promise.race([
          memoryLeg.bufferOverflow,
          fullLeg.bufferOverflow,
        ]),
        parentSignal: decisionAbort.signal,
        diagnostic: graderDiagnostic,
      });
      comparison.gradeMs = Date.now() - gradeStarted;
      if (gradeOutcome.verdict) {
        graderDiagnostic.ok = true;
        verdict = gradeOutcome.verdict;
        winner = winnerForVerdict(verdict.verdict);
      } else {
        fallbackReason = gradeOutcome.reason ?? "grader-failed";
        graderDiagnostic.error ??= fallbackReason;
      }
    }

    if (clientClosed || res.destroyed) return;
    // A leg can fail while the grader is running. Never commit a failed selected
    // arm when its peer is still healthy.
    const memoryFailed = memoryLeg.hasFailed();
    const fullFailed = fullLeg.hasFailed();
    if (winner === "memory" && memoryFailed && !fullFailed) {
      winner = "full";
      fallbackReason = "memory-leg-failed-after-grade";
    } else if (winner === "full" && fullFailed && !memoryFailed) {
      winner = "memory";
      fallbackReason = "full-leg-failed-after-grade";
    } else if (memoryFailed && fullFailed) {
      fallbackReason = "both-legs-failed";
    }
    let selected = winner === "memory" ? memoryLeg : fullLeg;
    let discarded = winner === "memory" ? fullLeg : memoryLeg;
    if (!selected.hasHealthyFallbackEvidence()) {
      // A prefix timeout can fire while one arm has only bare 2xx headers (or
      // both calls are still pending). Keep both alive until one produces a
      // healthy semantic prefix, a complete short response, or valid SSE work
      // (including extended thinking); headers alone do not justify destroying
      // the only fallback.
      const responsive = await firstHealthyFallbackEvidence(
        selected,
        discarded,
        decisionAbort.signal
      );
      if (!responsive || clientClosed || res.destroyed) return;
      if (responsive !== selected) {
        const previousWinner = winner;
        winner = winner === "memory" ? "full" : "memory";
        fallbackReason = selected.hasFailed()
          ? `${previousWinner}-leg-failed-before-commit`
          : `${previousWinner}-no-progress-before-commit`;
        selected = responsive;
        discarded = winner === "memory" ? fullLeg : memoryLeg;
      }
    }
    comparison.verdict = verdict?.verdict;
    comparison.winner = winner;
    comparison.fallbackReason = fallbackReason;
    comparison.loserAborted = discarded.abort();
    recordTurn(
      rec,
      winner === "memory" ? "followup-ab-memory" : "followup-ab-full",
      winner === "memory" ? memoryBody : fullBody
    );
    if (selected.hasFailed()) rec.turnType = "followup-ab-failed";
    copyWinnerObservation(rec, selected.record);
    let decisionNotified = false;
    const notifyDecision = () => {
      if (decisionNotified || !selected.isHealthy()) return;
      decisionNotified = true;
      try {
        onDecision(winner, selected.completedSuccessfully());
      } catch {
        // UI/route bookkeeping can never prevent delivery of the chosen response.
      }
    };
    notifyDecision();
    if (opts.debug) {
      console.error(
        `[ccc proxy] A/B routed ${winner}` +
          `${verdict ? ` (verdict ${verdict.verdict})` : ""}` +
          `${fallbackReason ? ` (${fallbackReason})` : ""}`
      );
    }

    decisionAbort.abort();
    const delivered = await selected.commitTo(res, notifyDecision);
    copyWinnerObservation(rec, selected.record);
    comparison.delivered = winner;
    comparison.deliveryOk = delivered;
    if (!delivered) rec.turnType = "followup-ab-failed";
    try {
      onDeliveryComplete(winner, delivered);
    } catch {
      // Route bookkeeping is best-effort and never changes delivered bytes.
    }
  } finally {
    decisionAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    res.off("close", abortAll);
  }
}

/**
 * Speculative A/B delivery (plans/2026-07-17_PLAN_speculative_ab_streaming.md):
 * commit the memory leg (A) to the client from its first sign of stream
 * progress through an event-aligned forwarder; grade both semantic prefixes
 * OFF the delivery path; and if the shadow verdict is B while the interrupt
 * window is still open, splice the full leg (B) into A's message envelope —
 * closing A's open block, emitting a model-visible bridge text block, and
 * replaying B's content with renumbered indices. A short answer that finishes
 * before B can be graded simply stands, and the late verdict is logged for
 * effective-context priors.
 */
async function forwardSpeculativeSse(args: ComparedSseArgs): Promise<void> {
  const {
    req,
    res,
    opts,
    upstream,
    routing,
    memoryBody,
    fullBody,
    question,
    unfoldedMemory,
    model,
    rec,
    receivedAt,
    shutdownSignal,
    onDeliveryComplete,
  } = args;
  const comparison = rec.comparison!;
  comparison.prefixChars = routing.prefixChars;
  comparison.speculative = true;
  comparison.interrupt = "none";
  const memoryRecord: ComparisonLegRecord = { requestBytes: memoryBody.length };
  const fullRecord: ComparisonLegRecord = { requestBytes: fullBody.length };
  comparison.memoryLeg = memoryRecord;
  comparison.fullLeg = fullRecord;
  rec.turnType = "followup-ab-pending";

  capture(opts, "anthropic-request-memory", memoryBody);
  capture(opts, "anthropic-request-full", fullBody);

  const started = Date.now();
  const memoryLeg = new BufferedUpstreamLeg({
    name: "memory",
    req,
    body: memoryBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: memoryRecord,
  });
  const fullLeg = new BufferedUpstreamLeg({
    name: "full",
    req,
    body: fullBody,
    upstream,
    prefixChars: routing.prefixChars,
    maxBufferedBytes: routing.maxBufferedBytesPerLeg,
    record: fullRecord,
  });

  // Unlike buffered mode, this controller cancels GRADING only — delivery is
  // already committed. A client abort still tears down everything.
  const graderAbort = new AbortController();
  let clientClosed = false;

  // ---- interrupt-window state machine -------------------------------------
  let committedLeg: AbWinner | null = null;
  let forwarder: SseEventForwarder | null = null;
  let spliceStarted = false;
  let pendingDeferredSplice = false;
  let recoveryStarted = false;
  let shadowSettled = false;
  let deliverySettled = false;
  let shutdownCancelled = false;
  let resolveDelivery!: () => void;
  const deliveryDone = new Promise<void>((r) => (resolveDelivery = r));

  const currentDeliveredKind = (): ComparisonDelivered => {
    if (spliceStarted) {
      return comparison.interrupt === "recovered" ? "recovered" : "spliced";
    }
    if (committedLeg === "full") return "full";
    if (committedLeg === "memory") return "memory";
    return "none";
  };

  const finishDelivery = (delivered: ComparisonDelivered, ok: boolean): void => {
    if (deliverySettled) return;
    deliverySettled = true;
    comparison.delivered = delivered;
    comparison.deliveryOk = ok;
    const turnType: TurnType = !ok
      ? "followup-ab-failed"
      : delivered === "memory"
        ? "followup-ab-memory"
        : delivered === "full"
          ? "followup-ab-full"
          : delivered === "spliced"
            ? "followup-ab-spliced"
            : delivered === "recovered"
              ? "followup-ab-recovered"
              : "followup-ab-failed";
    recordTurn(
      rec,
      turnType,
      delivered === "memory" || delivered === "none" ? memoryBody : fullBody
    );
    copyWinnerObservation(
      rec,
      delivered === "memory" || delivered === "none"
        ? memoryRecord
        : fullRecord
    );
    rec.totalMs = Date.now() - receivedAt;
    if (opts.debug) {
      console.error(
        `[ccc proxy] A/B speculative delivered ${delivered}` +
          ` (ok=${ok}, interrupt=${comparison.interrupt})`
      );
    }
    try {
      onDeliveryComplete(delivered, ok);
    } catch {
      // Route/notice bookkeeping can never affect delivered bytes.
    }
    resolveDelivery();
  };

  const abortAll = () => {
    // res "close" also follows a NORMAL finish; the shadow grade deliberately
    // outlives delivery (late verdicts feed effective-context priors), so
    // only an abnormal close tears everything down.
    if (res.writableFinished || shutdownCancelled) return;
    if (!deliverySettled) {
      clientClosed = true;
      comparison.clientAborted = true;
    }
    graderAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    finishDelivery(currentDeliveredKind(), false);
  };
  res.once("close", abortAll);

  const cancelForShutdown = (): void => {
    if (shutdownCancelled) return;
    shutdownCancelled = true;
    comparison.fallbackReason ??= deliverySettled
      ? "shutdown-shadow-cancelled"
      : "shutdown-delivery-cancelled";
    graderAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    if (!deliverySettled) {
      // This is proxy-owned cancellation, not a client abort. Detach the
      // close classifier before terminating any still-open downstream body.
      res.off("close", abortAll);
      if (!res.destroyed) res.destroy();
      finishDelivery(currentDeliveredKind(), false);
    }
  };
  shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
  if (shutdownSignal.aborted) cancelForShutdown();

  const writeToClient = (bytes: string): boolean => {
    if (res.destroyed || res.writableEnded) return true;
    return res.write(bytes);
  };

  /**
   * Abort the shadow leg once it can no longer be spliced in. Before delivery
   * has committed to A, B is still the only failover candidate — the
   * pre-commit phase (not the shadow grade) owns its fate until then.
   */
  const releaseFullLeg = () => {
    if (
      committedLeg === "memory" &&
      !spliceStarted &&
      !pendingDeferredSplice &&
      !recoveryStarted
    ) {
      comparison.loserAborted = fullLeg.abort();
    }
  };

  /** Replay B into A's open envelope after the bridge block. */
  const replayFullLeg = (
    startIndex: number,
    kind: "spliced" | "recovered"
  ): void => {
    const writer = new SseSpliceWriter({ startIndex });
    fullLeg.streamTo({
      write: (chunk) => writeToClient(writer.push(chunk)),
      end: () => {
        writer.flush();
        const ok = fullLeg.completedSuccessfully();
        if (ok) {
          if (!res.destroyed && !res.writableEnded) res.end();
        } else if (!res.destroyed) {
          res.destroy();
        }
        void waitForResponseFinishOrClose(res).then((flushed) =>
          finishDelivery(kind, flushed && ok)
        );
      },
      drain: (resume) => res.once("drain", resume),
    });
  };

  const performSplice = (interrupt: ComparisonInterrupt): void => {
    if (spliceStarted || !forwarder || clientClosed) return;
    spliceStarted = true;
    pendingDeferredSplice = false;
    comparison.interrupt = interrupt;
    comparison.spliceAtChars = forwarder.textChars;
    const openBlock = forwarder.openBlock;
    const bridgeIndex = forwarder.maxIndex + 1;
    forwarder.stop();
    comparison.loserAborted = memoryLeg.abort() || undefined;
    if (opts.debug) {
      console.error(`[ccc proxy] A/B splice (${interrupt}) at block ${bridgeIndex}`);
    }
    let head = "";
    if (openBlock) head += contentBlockStopEvent(openBlock.index);
    head += bridgeBlockEvents(
      bridgeIndex,
      interrupt === "recovered" ? RECOVERY_BRIDGE_TEXT : routing.bridgeText
    );
    const beginReplay = () => {
      if (clientClosed || res.destroyed || res.writableEnded) return;
      replayFullLeg(
        bridgeIndex + 1,
        interrupt === "recovered" ? "recovered" : "spliced"
      );
    };
    // write(false) accepted the whole fabricated head, but B must remain
    // private until that head drains or its replay can overtake backpressure.
    if (writeToClient(head)) beginReplay();
    else res.once("drain", beginReplay);
  };

  /** Apply a B verdict against the interrupt-window table. */
  const attemptInterrupt = () => {
    if (
      clientClosed ||
      spliceStarted ||
      pendingDeferredSplice ||
      committedLeg !== "memory" ||
      !forwarder
    ) {
      return;
    }
    if (deliverySettled || forwarder.sawMessageDelta) {
      comparison.interrupt = "late-verdict";
      comparison.verdictLate = true;
      return;
    }
    const disposition = forwarder.interruptDisposition();
    if (disposition === "blocked") {
      // Any structured/non-text block can carry state that must not be cut in
      // half or mixed with B. Keep the established diagnostic for log readers.
      comparison.interrupt = "blocked-tool-use";
      return;
    }
    if (disposition === "defer") {
      // A partial thinking block lacks its signature_delta; truncating it
      // would poison replay. Wait for the block to close, then re-check.
      pendingDeferredSplice = true;
      return;
    }
    performSplice("spliced");
  };

  /** Deferred-splice re-check on the exact event boundary that closed a block. */
  const onForwardedEvent = (fwd: SseEventForwarder): void => {
    if (!pendingDeferredSplice || spliceStarted) return;
    const disposition = fwd.interruptDisposition();
    if (disposition === "blocked") {
      pendingDeferredSplice = false;
      comparison.interrupt = "blocked-tool-use";
      releaseFullLeg();
      return;
    }
    if (fwd.sawMessageDelta) {
      pendingDeferredSplice = false;
      comparison.interrupt = "late-verdict";
      comparison.verdictLate = true;
      releaseFullLeg();
      return;
    }
    if (disposition === "splice") performSplice("deferred-then-spliced");
  };

  /** A died or emitted a terminal error: healthy B can recover a safe prefix. */
  const recoverFromFullLeg = async (): Promise<void> => {
    if (recoveryStarted || spliceStarted || clientClosed || deliverySettled) {
      return;
    }
    recoveryStarted = true;
    if (
      !forwarder ||
      forwarder.sawMessageDelta ||
      forwarder.interruptDisposition() !== "splice"
    ) {
      // Structured content, unfinished signed thinking, or the closing
      // envelope is already on the wire. A synthetic stop would corrupt the
      // message, so terminate this delivery instead of splicing.
      failDelivery();
      return;
    }
    pendingDeferredSplice = false;
    await fullLeg.waitForFallbackEvidence();
    if (clientClosed || spliceStarted || deliverySettled) return;
    if (fullLeg.hasHealthyFallbackEvidence()) {
      performSplice("recovered");
    } else {
      failDelivery();
    }
  };

  const failDelivery = (): void => {
    if (!res.destroyed) res.destroy();
    finishDelivery(committedLeg === "memory" ? "memory" : "none", false);
  };

  /** A's upstream stream ended — cleanly or not. */
  const onMemoryStreamEnd = (): void => {
    if (spliceStarted || clientClosed || deliverySettled) return;
    if (forwarder?.sawMessageStop) {
      // The full message is on the wire; a late upstream hiccup is irrelevant.
      if (!res.destroyed && !res.writableEnded) res.end();
      void waitForResponseFinishOrClose(res).then((flushed) =>
        finishDelivery("memory", flushed)
      );
      return;
    }
    void recoverFromFullLeg();
  };

  const commitMemory = async (): Promise<void> => {
    committedLeg = "memory";
    if (!memoryLeg.isSseResponse()) {
      // Degenerate upstream (JSON body on a stream request): raw passthrough.
      const ok = await memoryLeg.commitTo(res);
      finishDelivery("memory", ok);
      return;
    }
    comparison.clientTtfbMs = Date.now() - started;
    memoryLeg.sendHeadTo(res);
    forwarder = new SseEventForwarder({
      write: writeToClient,
      afterEvent: onForwardedEvent,
      onTerminalError: () => void recoverFromFullLeg(),
    });
    const drainForwarder = (resume: () => void): void => {
      const resumeAfterClientDrain = (): void => {
        // A raw upstream chunk is not fully consumed until every parsed frame
        // it owned has crossed its own ServerResponse drain seam.
        if (!forwarder || forwarder.resumeAfterDrain()) resume();
        else res.once("drain", resumeAfterClientDrain);
      };
      res.once("drain", resumeAfterClientDrain);
    };
    memoryLeg.streamTo({
      write: (chunk) => forwarder!.push(chunk),
      end: onMemoryStreamEnd,
      drain: drainForwarder,
    });
    // If the shadow grade already finished (with no B verdict to apply), the
    // deferred release of B lands now that A owns the delivery.
    if (shadowSettled) releaseFullLeg();
    await deliveryDone;
  };

  const deliverWholeFullLeg = async (fallbackReason: string): Promise<void> => {
    committedLeg = "full";
    comparison.fallbackReason ??= fallbackReason;
    comparison.loserAborted = memoryLeg.abort();
    comparison.clientTtfbMs = Date.now() - started;
    const ok = await fullLeg.commitTo(res);
    finishDelivery("full", ok);
  };

  const deliverBothFailed = async (): Promise<void> => {
    fullLeg.abort();
    comparison.fallbackReason ??= "both-legs-failed";
    // Surface the memory leg's actual error response (or a synthetic 502).
    await memoryLeg.commitTo(res);
    finishDelivery("none", false);
  };

  /**
   * Pre-commit phase: the client is committed to A at its first sign of
   * stream progress; until then A can still be swapped for a whole-B
   * failover. A silent A past the prefix window yields to a producing B.
   */
  const waitForCommitChoice = async (): Promise<
    | { kind: "memory" }
    | { kind: "full"; reason: string }
    | { kind: "error" }
    | { kind: "closed" }
  > => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        memoryLeg.waitForFallbackEvidence(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, routing.prefixTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (clientClosed) return { kind: "closed" };
    if (memoryLeg.hasHealthyFallbackEvidence()) return { kind: "memory" };
    if (memoryLeg.isFallbackEvidenceSettled()) {
      // A failed (or ended empty) before any client-visible progress: today's
      // full failover, minus the wait.
      await fullLeg.waitForFallbackEvidence();
      if (clientClosed) return { kind: "closed" };
      return fullLeg.hasHealthyFallbackEvidence()
        ? { kind: "full", reason: "memory-leg-failed-before-prefix" }
        : { kind: "error" };
    }
    if (fullLeg.hasHealthyFallbackEvidence()) {
      return { kind: "full", reason: "memory-no-progress-before-commit" };
    }
    const responsive = await firstHealthyFallbackEvidence(
      memoryLeg,
      fullLeg,
      graderAbort.signal
    );
    if (!responsive || clientClosed) return { kind: "closed" };
    if (responsive === memoryLeg && memoryLeg.hasHealthyFallbackEvidence()) {
      return { kind: "memory" };
    }
    if (responsive === fullLeg && fullLeg.hasHealthyFallbackEvidence()) {
      return { kind: "full", reason: "memory-no-progress-before-commit" };
    }
    return { kind: "error" };
  };

  // ---- shadow grading ------------------------------------------------------
  const shadowGrade = async (): Promise<FusionVerdict | undefined> => {
    const prefixStarted = Date.now();
    const prefixesReady = await waitForBothPrefixes(
      memoryLeg,
      fullLeg,
      routing.prefixTimeoutMs,
      graderAbort.signal
    );
    comparison.prefixWaitMs = Date.now() - prefixStarted;
    if (clientClosed) return undefined;

    let verdict: FusionVerdict | undefined;
    let fallbackReason: string | undefined;
    const memoryHealthy = memoryLeg.isHealthy();
    const fullHealthy = fullLeg.isHealthy();
    if (!prefixesReady) {
      const memoryReady = memoryLeg.isPrefixReadyAndHealthy();
      const fullReady = fullLeg.isPrefixReadyAndHealthy();
      if (fullReady && !memoryReady) {
        fallbackReason = "memory-prefix-timeout";
      } else if (memoryReady) {
        fallbackReason = "full-prefix-timeout";
      } else if (
        !memoryHealthy &&
        (fullHealthy || (memoryLeg.hasFailed() && !fullLeg.hasFailed()))
      ) {
        fallbackReason = "memory-leg-failed-before-prefix";
      } else {
        fallbackReason = "prefix-timeout-default-memory";
      }
    } else if (!memoryHealthy && fullHealthy) {
      fallbackReason = "memory-leg-failed";
    } else if (memoryHealthy && !fullHealthy) {
      fallbackReason = "full-leg-failed";
    } else if (!memoryHealthy && !fullHealthy) {
      fallbackReason = "both-legs-failed";
    } else {
      const gradeStarted = Date.now();
      let attempt = 0;
      while (true) {
        const graderDiagnostic: GraderDiagnostic = {
          model: routing.grader ? "injected" : routing.graderModel,
          ok: false,
        };
        comparison.grader = graderDiagnostic;
        const gradeOutcome = await gradeComparedPrefixes({
          req,
          upstream,
          routing,
          input: {
            question,
            unfoldedMemory,
            memoryResponse: memoryLeg.semanticForGrading(),
            fullResponse: fullLeg.semanticForGrading(),
            model,
            signal: graderAbort.signal,
          },
          overflow: Promise.race([
            memoryLeg.bufferOverflow,
            fullLeg.bufferOverflow,
          ]),
          parentSignal: graderAbort.signal,
          diagnostic: graderDiagnostic,
        });
        if (gradeOutcome.verdict) {
          graderDiagnostic.ok = true;
          verdict = gradeOutcome.verdict;
          fallbackReason = undefined;
          break;
        }
        fallbackReason = gradeOutcome.reason ?? "grader-failed";
        graderDiagnostic.error ??= fallbackReason;
        // Off the delivery path, a 429 (both legs just saturated the org
        // limit) or network blip earns one retry with jittered backoff.
        const retryable =
          attempt === 0 &&
          fallbackReason === "grader-failed" &&
          (graderDiagnostic.status === undefined ||
            graderDiagnostic.status === 429) &&
          !graderAbort.signal.aborted;
        if (!retryable) break;
        attempt += 1;
        comparison.graderRetries = attempt;
        const backoff =
          routing.graderRetryMinDelayMs +
          Math.random() *
            (routing.graderRetryMaxDelayMs - routing.graderRetryMinDelayMs);
        if (!(await abortableDelay(backoff, graderAbort.signal))) break;
      }
      comparison.gradeMs = Date.now() - gradeStarted;
    }
    comparison.verdict = verdict?.verdict;
    comparison.fallbackReason ??= fallbackReason;
    if (opts.debug) {
      console.error(
        `[ccc proxy] A/B shadow grade ` +
          `${verdict ? `verdict ${verdict.verdict}` : `no verdict`}` +
          `${fallbackReason ? ` (${fallbackReason})` : ""}`
      );
    }
    return verdict;
  };

  try {
    if (!shutdownCancelled) {
      memoryLeg.start();
      fullLeg.start();
    }

    const deliveryTask = (async () => {
      const choice = await waitForCommitChoice();
      if (choice.kind === "closed" || shutdownCancelled) return;
      if (choice.kind === "memory") await commitMemory();
      else if (choice.kind === "full") await deliverWholeFullLeg(choice.reason);
      else await deliverBothFailed();
    })();

    const shadowTask = (async () => {
      const verdict = await shadowGrade();
      shadowSettled = true;
      if (verdict && winnerForVerdict(verdict.verdict) === "full") {
        attemptInterrupt();
      }
      // B has served its grading purpose; keep it only if a splice (or a
      // pending deferred splice / whole-B delivery) is consuming it.
      releaseFullLeg();
      return verdict;
    })();

    const [, verdict] = await Promise.all([deliveryTask, shadowTask]);
    comparison.winner =
      verdict !== undefined
        ? winnerForVerdict(verdict.verdict)
        : comparison.delivered === "full"
          ? "full"
          : "memory";
    // The deferred-splice window can outlive the shadow task; wait for the
    // delivery to settle before tearing the legs down.
    await deliveryDone;
  } finally {
    graderAbort.abort();
    memoryLeg.abort();
    fullLeg.abort();
    res.off("close", abortAll);
    shutdownSignal.removeEventListener("abort", cancelForShutdown);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForBothPrefixes(
  memoryLeg: BufferedUpstreamLeg,
  fullLeg: BufferedUpstreamLeg,
  timeoutMs: number,
  signal: AbortSignal
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all([memoryLeg.prefixReady, fullLeg.prefixReady]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        signal.addEventListener("abort", () => resolve(false), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function firstHealthyFallbackEvidence(
  preferred: BufferedUpstreamLeg,
  alternate: BufferedUpstreamLeg,
  signal: AbortSignal
): Promise<BufferedUpstreamLeg | null> {
  const candidates = [preferred, alternate];
  while (!signal.aborted) {
    for (const candidate of candidates) {
      if (candidate.hasHealthyFallbackEvidence()) {
        return candidate;
      }
    }
    const pending = candidates.filter(
      (candidate) => !candidate.isFallbackEvidenceSettled()
    );
    if (pending.length === 0) return preferred;
    const settled = await waitForLegFallbackEvidence(pending, signal);
    if (!settled) return null;
  }
  return null;
}

function waitForLegFallbackEvidence(
  legs: BufferedUpstreamLeg[],
  signal: AbortSignal
): Promise<BufferedUpstreamLeg | null> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (leg: BufferedUpstreamLeg | null) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      resolve(leg);
    };
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(null);
      return;
    }
    for (const leg of legs) {
      void leg.waitForFallbackEvidence().then(() => finish(leg));
    }
  });
}

async function gradeComparedPrefixes(args: {
  req: http.IncomingMessage;
  upstream: Upstream;
  routing: ResolvedAbRoutingOptions;
  input: AbGradeInput;
  overflow: Promise<void>;
  parentSignal: AbortSignal;
  diagnostic: GraderDiagnostic;
}): Promise<{ verdict?: FusionVerdict; reason?: string }> {
  const {
    req,
    upstream,
    routing,
    input,
    overflow,
    parentSignal,
    diagnostic,
  } = args;
  const controller = new AbortController();
  let settleStop!: (kind: "timeout" | "aborted") => void;
  const stopPromise = new Promise<
    { kind: "timeout" } | { kind: "aborted" }
  >((resolve) => {
    settleStop = (kind) =>
      resolve(kind === "timeout" ? { kind: "timeout" } : { kind: "aborted" });
  });
  const abort = () => {
    controller.abort();
    settleStop("aborted");
  };
  parentSignal.addEventListener("abort", abort, { once: true });
  // AbortSignal listeners are not replayed when they are attached after the
  // signal has already fired. Close that race before scheduling any grader
  // work so a cancelled client can never launch another billed request.
  if (parentSignal.aborted) abort();
  const timer = setTimeout(() => {
    controller.abort();
    settleStop("timeout");
  }, routing.graderTimeoutMs);
  const gradePromise = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw new Error("grader aborted");
      }
      return routing.grader
        ? routing.grader({ ...input, signal: controller.signal })
        : gradeWithIncomingAnthropicAuth({
            req,
            upstream,
            routing,
            input: { ...input, signal: controller.signal },
            diagnostic,
          });
    })
    .then((value) => ({ kind: "verdict" as const, value }))
    .catch((error) => ({ kind: "error" as const, error }));
  const overflowPromise = overflow.then(() => ({ kind: "overflow" as const }));
  try {
    const outcome = await Promise.race([
      gradePromise,
      overflowPromise,
      stopPromise,
    ]);
    if (outcome.kind === "timeout") return { reason: "grader-timeout" };
    if (outcome.kind === "aborted") return { reason: "grader-aborted" };
    if (outcome.kind === "overflow") {
      controller.abort();
      return { reason: "buffer-limit" };
    }
    if (outcome.kind === "error") {
      diagnostic.error = String(outcome.error?.message ?? outcome.error);
      return {
        reason: controller.signal.aborted ? "grader-timeout" : "grader-failed",
      };
    }
    const validated = validateInjectedVerdict(outcome.value);
    return validated ? { verdict: validated } : { reason: "grader-malformed" };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

function validateInjectedVerdict(value: FusionVerdict): FusionVerdict | null {
  // Reuse the same runtime parser shape without relying on TypeScript-only
  // trust for injected/custom graders.
  return parseFusionVerdictResponse({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
}

async function gradeWithIncomingAnthropicAuth(args: {
  req: http.IncomingMessage;
  upstream: Upstream;
  routing: ResolvedAbRoutingOptions;
  input: AbGradeInput;
  diagnostic: GraderDiagnostic;
}): Promise<FusionVerdict> {
  const { req, upstream, routing, input, diagnostic } = args;
  if (input.signal.aborted) throw new Error("grader aborted");
  const body = Buffer.from(
    JSON.stringify(
      buildFusionGraderBody(
        {
          question: input.question,
          unfoldedMemory: input.unfoldedMemory,
          memoryResponse: input.memoryResponse,
          fullResponse: input.fullResponse,
          model: input.model,
        },
        routing.graderModel,
        routing.prefixChars
      )
    ),
    "utf-8"
  );
  const headers = forwardableRequestHeaders(req);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(body.length);
  headers.accept = "application/json";
  headers["accept-encoding"] = "identity";

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, verdict?: FusionVerdict) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (verdict) resolve(verdict);
      else reject(new Error("grader returned no verdict"));
    };
    const graderReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: "POST",
        path: req.url,
        headers,
      },
      (graderRes) => {
        diagnostic.status = graderRes.statusCode ?? 502;
        const chunks: Buffer[] = [];
        let bytes = 0;
        graderRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            graderReq.destroy(new Error("grader response exceeded 4 MiB"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        graderRes.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if ((graderRes.statusCode ?? 500) < 200 || (graderRes.statusCode ?? 500) >= 300) {
            finish(
              new Error(
                `grader ${graderRes.statusCode ?? 500}: ${raw.slice(0, 300)}`
              )
            );
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            diagnostic.usage = usageFromResponse(parsed?.usage);
            const verdict = parseFusionVerdictResponse(parsed);
            finish(
              verdict ? undefined : new Error("grader returned malformed output"),
              verdict ?? undefined
            );
          } catch {
            finish(new Error("grader returned invalid JSON"));
          }
        });
        graderRes.on("error", (error) => finish(error));
      }
    );
    const abort = () => graderReq.destroy(new Error("grader aborted"));
    input.signal.addEventListener("abort", abort, { once: true });
    graderReq.on("error", (error) => finish(error));
    // The signal can fire after the entry check but before its listener is
    // installed. Re-check after both abort and error handlers are ready.
    if (input.signal.aborted) {
      abort();
      return;
    }
    graderReq.end(body);
  });
}

function copyWinnerObservation(
  rec: MessagesRecord,
  winner: ComparisonLegRecord
): void {
  rec.upstreamStatus = winner.upstreamStatus;
  rec.ttfbMs = winner.ttfbMs;
  rec.firstContentMs = winner.firstContentMs;
  rec.usage = winner.usage ? { ...winner.usage } : undefined;
}

function usageFromResponse(value: unknown): UsageRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: UsageRecord = {};
  for (const field of [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
  ] as const) {
    const tokenCount = (value as Record<string, unknown>)[field];
    if (typeof tokenCount === "number" && Number.isFinite(tokenCount)) {
      out[field] = tokenCount;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

interface BufferedUpstreamLegOptions {
  name: AbWinner;
  req: http.IncomingMessage;
  body: Buffer;
  upstream: Upstream;
  prefixChars: number;
  maxBufferedBytes: number;
  record: ComparisonLegRecord;
}

/**
 * Speculative-mode chunk consumer. Unlike commitTo's raw piping, a sink lets
 * the orchestrator transform/track bytes (event-aligned forwarding, splice
 * renumbering) and decide itself how the client response ends.
 */
interface UpstreamLegSink {
  /** Forward one raw chunk; false requests an upstream pause until drain. */
  write(chunk: Buffer): boolean;
  /** Upstream ended — cleanly or not; inspect the leg to tell which. */
  end(): void;
  /** Register a one-shot resume callback for backpressure release. */
  drain(resume: () => void): void;
}

/**
 * Ordered hand-off from a leg's private buffer to its selected downstream
 * sink. Writable.write(false) still accepts the current chunk, but no later
 * chunk may be submitted until drain. Keeping that distinction here avoids
 * replaying up to maxBufferedBytes into ServerResponse's own memory buffer.
 *
 * Exported from this internal module solely so the drain state machine can be
 * tested without depending on operating-system socket buffer sizes.
 */
export class DrainAwareChunkQueue {
  private readonly queue: Buffer[];
  private started = false;
  private flushing = false;
  private waitingForDrain = false;
  private ending = false;
  private ended = false;

  constructor(
    bufferedChunks: Buffer[],
    private readonly sink: UpstreamLegSink,
    private readonly onWritable: () => void
  ) {
    this.queue = bufferedChunks;
  }

  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.flush();
  }

  /** Write live data, retaining it behind any replay already in progress. */
  write(chunk: Buffer): boolean {
    if (this.ending || this.ended) return true;
    if (
      !this.started ||
      this.flushing ||
      this.waitingForDrain ||
      this.queue.length > 0
    ) {
      this.queue.push(chunk);
      return false;
    }
    const writable = this.sink.write(chunk);
    if (!writable) this.waitForDrain();
    return writable;
  }

  /** End only after every accepted/retained chunk has crossed a drain seam. */
  finish(): void {
    if (this.ending || this.ended) return;
    this.ending = true;
    this.flush();
  }

  /** Abandon a deselected/client-aborted leg without firing its sink end. */
  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue.length = 0;
  }

  private flush(): void {
    if (
      !this.started ||
      this.flushing ||
      this.waitingForDrain ||
      this.ended
    ) {
      return;
    }
    this.flushing = true;
    let consumed = 0;
    while (consumed < this.queue.length) {
      const writable = this.sink.write(this.queue[consumed]);
      consumed++;
      if (!writable) {
        this.queue.splice(0, consumed);
        this.flushing = false;
        this.waitForDrain();
        return;
      }
    }
    if (consumed > 0) this.queue.splice(0, consumed);
    this.flushing = false;
    if (this.ending) {
      this.ended = true;
      this.sink.end();
    } else {
      this.onWritable();
    }
  }

  private waitForDrain(): void {
    if (this.waitingForDrain || this.ended) return;
    this.waitingForDrain = true;
    this.sink.drain(() => {
      if (this.ended) return;
      this.waitingForDrain = false;
      this.flush();
    });
  }
}

/** One in-flight completion whose raw bytes stay private until selected. */
class BufferedUpstreamLeg {
  readonly record: ComparisonLegRecord;
  readonly prefixReady: Promise<void>;
  readonly bufferOverflow: Promise<void>;

  private readonly name: AbWinner;
  private readonly incomingReq: http.IncomingMessage;
  private readonly body: Buffer;
  private readonly upstream: Upstream;
  private readonly prefixChars: number;
  private readonly maxBufferedBytes: number;
  private readonly startedAt = Date.now();
  private readonly observerRecord: MessagesRecord;
  private readonly chunks: Buffer[] = [];
  private readonly toolBlocks = new Map<number, { name: string; json: string }>();
  private semantic = "";
  private semanticComplete = false;
  private sawStreamProgress = false;
  private totalBufferedBytes = 0;
  private upstreamReq?: http.ClientRequest;
  private upstreamRes?: http.IncomingMessage;
  private clientRes?: http.ServerResponse;
  private sinkQueue?: DrainAwareChunkQueue;
  private sseObserver?: SseNoticeRewriter;
  private expectsSse = false;
  private sawMessageStop = false;
  private validJsonResponse = false;
  private ended = false;
  private completedNormally = false;
  private aborted = false;
  private prefixSettled = false;
  private fallbackEvidenceSettled = false;
  private overflowSettled = false;
  private responseSettled = false;
  private doneSettled = false;
  private resolvePrefix!: () => void;
  private resolveFallbackEvidence!: () => void;
  private resolveOverflow!: () => void;
  private resolveResponse!: () => void;
  private resolveDone!: () => void;
  private readonly responseReady: Promise<void>;
  private readonly fallbackEvidenceReady: Promise<void>;
  private readonly done: Promise<void>;

  constructor(options: BufferedUpstreamLegOptions) {
    this.name = options.name;
    this.incomingReq = options.req;
    this.body = options.body;
    this.upstream = options.upstream;
    this.prefixChars = options.prefixChars;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.record = options.record;
    this.observerRecord = {
      kind: "messages",
      turnType: "unparseable",
      requestBytes: options.body.length,
    };
    this.prefixReady = new Promise((resolve) => (this.resolvePrefix = resolve));
    this.fallbackEvidenceReady = new Promise(
      (resolve) => (this.resolveFallbackEvidence = resolve)
    );
    this.bufferOverflow = new Promise(
      (resolve) => (this.resolveOverflow = resolve)
    );
    this.responseReady = new Promise(
      (resolve) => (this.resolveResponse = resolve)
    );
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  start(): void {
    const headers = forwardableRequestHeaders(this.incomingReq);
    headers["content-length"] = String(this.body.length);
    // A/B needs an incrementally inspectable copy. The winner's bytes remain
    // exact; we merely ask Anthropic not to encode this response.
    headers["accept-encoding"] = "identity";
    this.upstreamReq = this.upstream.module.request(
      {
        host: this.upstream.host,
        port: this.upstream.port,
        method: this.incomingReq.method,
        path: this.incomingReq.url,
        headers,
      },
      (response) => this.handleResponse(response)
    );
    this.upstreamReq.on("error", (error) => this.fail(error));
    this.upstreamReq.end(this.body);
  }

  isHealthy(): boolean {
    const status = this.record.upstreamStatus;
    return (
      !this.aborted &&
      !this.record.error &&
      typeof status === "number" &&
      status >= 200 &&
      status < 300
    );
  }

  completedSuccessfully(): boolean {
    return this.ended && this.completedNormally && this.isHealthy();
  }

  isPrefixReadyAndHealthy(): boolean {
    return this.prefixSettled && this.isHealthy();
  }

  waitForResponse(): Promise<void> {
    return this.responseReady;
  }

  isSseResponse(): boolean {
    return this.expectsSse;
  }

  /** Mirror this leg's upstream status line and headers onto the client. */
  sendHeadTo(res: http.ServerResponse): void {
    if (res.headersSent || !this.upstreamRes) return;
    res.writeHead(
      this.upstreamRes.statusCode ?? 502,
      forwardableResponseHeaders(
        this.upstreamRes,
        SKIP_TRANSFORMED_RESPONSE_HEADERS
      )
    );
  }

  /**
   * Speculative delivery: flush already-buffered chunks into the sink, then
   * hand it every future chunk as it arrives. The passive SSE observer keeps
   * running, so grading/usage extraction are unaffected.
   */
  streamTo(sink: UpstreamLegSink): void {
    if (this.sinkQueue) throw new Error(`${this.name} leg already has a sink`);
    // Freeze live delivery before replay starts so a newly-arriving data event
    // cannot overtake chunks accumulated during prefix grading.
    this.upstreamRes?.pause();
    const queue = new DrainAwareChunkQueue(
      this.chunks.splice(0),
      sink,
      () => {
        // Also undoes a buffer-overflow pause once the private replay is empty.
        if (!this.aborted && !this.ended) this.upstreamRes?.resume();
      }
    );
    this.sinkQueue = queue;
    if (this.ended) queue.finish();
    queue.start();
  }

  hasFailed(): boolean {
    const status = this.record.upstreamStatus;
    return (
      this.record.error !== undefined ||
      (typeof status === "number" && (status < 200 || status >= 300))
    );
  }

  hasHealthyFallbackEvidence(): boolean {
    return (
      this.isHealthy() && (this.prefixSettled || this.sawStreamProgress)
    );
  }

  isFallbackEvidenceSettled(): boolean {
    return this.fallbackEvidenceSettled;
  }

  waitForFallbackEvidence(): Promise<void> {
    return this.fallbackEvidenceReady;
  }

  semanticForGrading(): string {
    if (this.semantic.length > this.prefixChars) {
      return (
        this.semantic.slice(0, this.prefixChars) + GRADING_TRUNCATION_MARKER
      );
    }
    if (
      this.semantic.length === this.prefixChars &&
      !this.semanticComplete
    ) {
      return this.semantic + GRADING_TRUNCATION_MARKER;
    }
    return this.semantic;
  }

  abort(): boolean {
    if (this.aborted || this.ended) return false;
    this.aborted = true;
    this.sinkQueue?.cancel();
    this.upstreamRes?.destroy();
    this.upstreamReq?.destroy();
    this.settlePrefix();
    this.settleResponse();
    this.settleDone();
    return true;
  }

  async commitTo(
    res: http.ServerResponse,
    onResponseReady?: () => void
  ): Promise<boolean> {
    await this.responseReady;
    onResponseReady?.();
    if (!this.upstreamRes) {
      sendAnthropicError(
        res,
        `${this.name} comparison leg failed: ${this.record.error ?? "no response"}`
      );
      return false;
    }
    this.upstreamRes.pause();
    if (!res.headersSent) {
      res.writeHead(
        this.upstreamRes.statusCode ?? 502,
        forwardableResponseHeaders(this.upstreamRes)
      );
    }
    for (const chunk of this.chunks.splice(0)) {
      if (res.destroyed || res.writableEnded) {
        this.abort();
        return false;
      }
      if (!res.write(chunk) && !(await waitForDrainOrClose(res))) {
        this.abort();
        return false;
      }
    }
    this.clientRes = res;
    if (this.ended) {
      if (!res.destroyed && !res.writableEnded) res.end();
      const flushed = await waitForResponseFinishOrClose(res);
      return flushed && this.completedNormally && this.isHealthy();
    }
    this.upstreamRes.resume();
    await this.done;
    const flushed = await waitForResponseFinishOrClose(res);
    return (
      flushed &&
      this.completedNormally &&
      this.isHealthy() &&
      !this.aborted
    );
  }

  private handleResponse(response: http.IncomingMessage): void {
    this.upstreamRes = response;
    this.record.upstreamStatus = response.statusCode ?? 502;
    const contentType = String(response.headers["content-type"] ?? "");
    if (contentType.includes("text/event-stream")) {
      this.expectsSse = true;
      this.sseObserver = new SseNoticeRewriter({
        onEvent: (event) => this.observeEvent(event),
      });
    }
    this.settleResponse();
    if (!this.isHealthy()) this.settlePrefix();
    response.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    response.on("end", () => this.finish());
    response.on("aborted", () =>
      this.fail(new Error("upstream response aborted"))
    );
    response.on("error", (error) => this.fail(error));
  }

  private handleChunk(chunk: Buffer): void {
    if (this.aborted) return;
    if (this.record.ttfbMs === undefined) {
      this.record.ttfbMs = Date.now() - this.startedAt;
    }
    if (this.sinkQueue) {
      if (!this.sinkQueue.write(chunk)) this.upstreamRes?.pause();
    } else if (this.clientRes) {
      if (!this.clientRes.write(chunk)) {
        this.upstreamRes?.pause();
        this.clientRes.once("drain", () => this.upstreamRes?.resume());
      }
    } else {
      this.chunks.push(Buffer.from(chunk));
      this.totalBufferedBytes += chunk.length;
      if (
        this.totalBufferedBytes > this.maxBufferedBytes &&
        !this.overflowSettled
      ) {
        this.overflowSettled = true;
        this.upstreamRes?.pause();
        this.resolveOverflow();
      }
    }
    if (this.sseObserver) this.sseObserver.push(chunk);
  }

  private observeEvent(event: any): void {
    mergeUsageFromSseEvent(event, this.observerRecord);
    if (
      event?.type === "content_block_start" ||
      event?.type === "content_block_delta" ||
      event?.type === "content_block_stop" ||
      event?.type === "message_delta" ||
      event?.type === "message_stop"
    ) {
      this.sawStreamProgress = true;
      this.settleFallbackEvidence();
    }
    if (
      this.record.firstContentMs === undefined &&
      event?.type === "content_block_delta"
    ) {
      this.record.firstContentMs = Date.now() - this.startedAt;
    }
    if (event?.type === "content_block_start" && typeof event.index === "number") {
      const block = event.content_block;
      if (block?.type === "text" && typeof block.text === "string") {
        if (this.semantic) this.appendSemantic("\n");
        this.appendSemantic(block.text);
      } else if (block?.type === "tool_use") {
        this.toolBlocks.set(event.index, {
          name: typeof block.name === "string" ? block.name : "unknown",
          json: "",
        });
      }
    } else if (event?.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.appendSemantic(delta.text);
      } else if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        typeof event.index === "number"
      ) {
        const tool = this.toolBlocks.get(event.index);
        // Tool JSON only feeds the graded semantic prefix (via the
        // content_block_stop append below, which itself truncates), so stop
        // accumulating once it can no longer reach the grading window.
        if (
          tool &&
          this.semantic.length + tool.json.length <= this.prefixChars
        ) {
          tool.json += delta.partial_json;
        }
      }
    } else if (
      event?.type === "content_block_stop" &&
      typeof event.index === "number"
    ) {
      const tool = this.toolBlocks.get(event.index);
      if (tool) {
        this.appendSemantic(
          `${this.semantic ? "\n" : ""}[Tool call: ${tool.name}(${tool.json || "{}"})]`
        );
        this.toolBlocks.delete(event.index);
      }
    } else if (event?.type === "message_stop") {
      this.sawMessageStop = true;
      this.semanticComplete = true;
      this.settlePrefix();
    }
    if (this.observerRecord.usage) {
      this.record.usage = { ...this.observerRecord.usage };
    }
  }

  private appendSemantic(text: string): void {
    // Grading only ever reads the first prefixChars characters. Keep one
    // extra character so semanticForGrading() can still detect truncation,
    // and drop the rest so long responses are not buffered a second time.
    const capacity = this.prefixChars + 1 - this.semantic.length;
    if (capacity > 0) {
      this.semantic +=
        text.length > capacity ? text.slice(0, capacity) : text;
    }
    if (this.semantic.length >= this.prefixChars) this.settlePrefix();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.record.ended = true;
    if (this.sseObserver) this.sseObserver.flush();
    if (!this.sseObserver && this.chunks.length) {
      this.observeJsonBody(Buffer.concat(this.chunks));
    }
    this.completedNormally = this.expectsSse
      ? this.sawMessageStop
      : this.validJsonResponse;
    this.semanticComplete = this.completedNormally;
    if (
      !this.completedNormally &&
      this.record.error === undefined &&
      typeof this.record.upstreamStatus === "number" &&
      this.record.upstreamStatus >= 200 &&
      this.record.upstreamStatus < 300
    ) {
      this.record.error = this.expectsSse
        ? "upstream SSE ended before message_stop"
        : "upstream returned an incomplete message response";
    }
    this.settlePrefix();
    if (this.clientRes && !this.clientRes.destroyed && !this.clientRes.writableEnded) {
      this.clientRes.end();
    }
    this.sinkQueue?.finish();
    this.settleDone();
  }

  private observeJsonBody(body: Buffer): void {
    try {
      const parsed = JSON.parse(body.toString("utf-8"));
      mergeUsageFromJsonBody(body, this.observerRecord);
      this.record.usage = this.observerRecord.usage
        ? { ...this.observerRecord.usage }
        : undefined;
      if (parsed?.type !== "message" || !Array.isArray(parsed.content)) return;
      this.validJsonResponse = true;
      for (const block of parsed.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          this.appendSemantic(block.text);
        } else if (block?.type === "tool_use") {
          this.appendSemantic(
            `${this.semantic ? "\n" : ""}[Tool call: ${String(block.name)}(` +
              `${JSON.stringify(block.input ?? {})})]`
          );
        }
      }
    } catch {
      // Error/non-JSON bodies remain forwardable; they simply are not gradable.
    }
  }

  private fail(error: Error): void {
    if (this.aborted || this.ended) return;
    this.record.error = error.message;
    this.ended = true;
    this.settleResponse();
    this.settlePrefix();
    if (this.clientRes) this.clientRes.destroy(error);
    // A sink-attached leg leaves the client response to the orchestrator,
    // which may recover the turn from the peer leg instead of destroying it.
    this.sinkQueue?.finish();
    this.settleDone();
  }

  private settlePrefix(): void {
    if (this.prefixSettled) return;
    this.prefixSettled = true;
    this.resolvePrefix();
    this.settleFallbackEvidence();
  }

  private settleFallbackEvidence(): void {
    if (this.fallbackEvidenceSettled) return;
    this.fallbackEvidenceSettled = true;
    this.resolveFallbackEvidence();
  }

  private settleResponse(): void {
    if (this.responseSettled) return;
    this.responseSettled = true;
    this.resolveResponse();
  }

  private settleDone(): void {
    if (this.doneSettled) return;
    this.doneSettled = true;
    this.resolveDone();
  }
}

function waitForDrainOrClose(res: http.ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

function waitForResponseFinishOrClose(
  res: http.ServerResponse
): Promise<boolean> {
  if (res.writableFinished) return Promise.resolve(true);
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("finish", onFinish);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    const onFinish = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once("finish", onFinish);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

/**
 * Forward a buffered request and pipe the response back byte-for-byte. A
 * passive observer parses copies of SSE/JSON chunks for request logging and
 * completion validation; its output is discarded and can never change the
 * client response.
 */
function forwardRaw(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
  opts: ProxyOptions,
  upstream: Upstream,
  rec?: MessagesRecord,
  onJsonResponse?: (body: Buffer) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const headers = forwardableRequestHeaders(req);
    headers["content-length"] = String(bodyBuffer.length);
    // The passive observer must be able to decode its copy to verify complete
    // delivery (message_stop for SSE, complete JSON otherwise). Constrain the
    // negotiated coding to what the observation decoders support — same idea
    // as the A/B comparison legs forcing identity — so an upstream choice
    // like zstd cannot mark a byte-perfectly delivered response as failed.
    // The bytes written to the client stay exact.
    headers["accept-encoding"] = observableAcceptEncoding(
      headers["accept-encoding"]
    );
    const forwardStarted = Date.now();
    let settled = false;
    let upstreamCompleted = false;
    let responseFinished = false;
    let protocolComplete = false;
    let successfulStatus = false;
    let clientAborted = false;
    let upstreamReq: http.ClientRequest | undefined;
    let activeUpstreamRes: http.IncomingMessage | undefined;

    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      res.off("finish", onResponseFinish);
      res.off("close", onResponseClose);
      resolve(ok);
    };
    const maybeSettle = () => {
      if (upstreamCompleted && responseFinished) {
        settle(successfulStatus && protocolComplete && !clientAborted);
      }
    };
    const onResponseFinish = () => {
      responseFinished = true;
      maybeSettle();
    };
    const onResponseClose = () => {
      if (res.writableFinished) return;
      clientAborted = true;
      activeUpstreamRes?.destroy();
      upstreamReq?.destroy();
      settle(false);
    };
    const completeUpstream = (complete: boolean) => {
      upstreamCompleted = true;
      protocolComplete = complete;
      if (res.destroyed && !res.writableFinished) {
        settle(false);
        return;
      }
      maybeSettle();
    };
    res.once("finish", onResponseFinish);
    res.once("close", onResponseClose);

    upstreamReq = upstream.module.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url, // path + query string verbatim (?beta=true etc.)
        headers,
      },
      (upstreamRes) => {
        activeUpstreamRes = upstreamRes;
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const isSse = contentType.includes("text/event-stream");
        const contentEncoding = String(
          upstreamRes.headers["content-encoding"] ?? "identity"
        ).trim().toLowerCase();
        const compressed =
          contentEncoding !== "" && contentEncoding !== "identity";
        let sawFirstByte = false;
        let sawMessageStop = false;
        let observerFailed = false;
        const observeSseEvent = (data: any) => {
          if (data?.type === "message_stop") sawMessageStop = true;
          if (rec) {
            mergeUsageFromSseEvent(data, rec);
            if (
              rec.firstContentMs === undefined &&
              data?.type === "content_block_delta"
            ) {
              rec.firstContentMs = Date.now() - forwardStarted;
            }
          }
        };
        const sseObserver = isSse
          ? new SseNoticeRewriter({
              onEvent: observeSseEvent,
            })
          : null;
        const incrementalDecoder = sseObserver && compressed
          ? createObservationDecoder(contentEncoding)
          : null;
        const observedChunks: Buffer[] | null =
          onJsonResponse !== undefined ||
          !isSse ||
          (compressed && !incrementalDecoder)
            ? []
            : null;
        const observeRawChunk = (chunk: Buffer) => {
          if (rec && !sawFirstByte) {
            sawFirstByte = true;
            rec.ttfbMs = Date.now() - forwardStarted;
          }
          if (sseObserver && !compressed) sseObserver.push(chunk);
          if (observedChunks) observedChunks.push(Buffer.from(chunk));
        };
        if (rec) {
          rec.upstreamStatus = upstreamRes.statusCode ?? 502;
        }
        successfulStatus =
          typeof upstreamRes.statusCode === "number" &&
          upstreamRes.statusCode >= 200 &&
          upstreamRes.statusCode < 300;
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
            if (!decoderFailed) sseObserver.push(chunk);
          });
          incrementalDecoder.on("error", () => {
            decoderFailed = true;
            observerFailed = true;
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
                if (err) {
                  decoderFailed = true;
                  observerFailed = true;
                }
                if (pendingForward === forwardOnce) pendingForward = null;
                forwardOnce();
              });
            } catch {
              decoderFailed = true;
              observerFailed = true;
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
              sseObserver.flush();
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
              completeUpstream(!observerFailed && sawMessageStop);
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
            settle(false);
          });
          upstreamRes.on("aborted", () => {
            incrementalDecoder.destroy();
            res.destroy();
            settle(false);
          });
          return;
        }

        upstreamRes.on("data", observeRawChunk);
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => {
          let observed: Buffer | null = null;
          if (observedChunks) {
            observed = decodeForObservation(
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
            if (rec && observed && !isSse) {
              mergeUsageFromJsonBody(observed, rec);
            }
          }
          if (isSse) {
            if (compressed && !incrementalDecoder) {
              if (observed) sseObserver?.push(observed);
              else observerFailed = true;
            }
            sseObserver?.flush();
            completeUpstream(!observerFailed && sawMessageStop);
          } else {
            completeUpstream(
              observed !== null && isCompleteJsonResponse(req.url, observed)
            );
          }
        });
        upstreamRes.on("error", () => {
          res.destroy();
          settle(false);
        });
        upstreamRes.on("aborted", () => {
          res.destroy();
          settle(false);
        });
      }
    );

    upstreamReq.on("error", (err) => {
      sendAnthropicError(res, `upstream connection failed: ${err.message}`);
      settle(false);
    });

    upstreamReq.end(bodyBuffer);
  });
}

function isCompleteJsonResponse(
  requestUrl: string | undefined,
  body: Buffer
): boolean {
  try {
    const parsed = JSON.parse(body.toString("utf-8"));
    const pathname = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
    if (pathname.endsWith("/count_tokens")) {
      return (
        typeof parsed?.input_tokens === "number" &&
        Number.isFinite(parsed.input_tokens) &&
        parsed.input_tokens >= 0
      );
    }
    return parsed?.type === "message" && Array.isArray(parsed.content);
  } catch {
    return false;
  }
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
  upstreamRes: http.IncomingMessage,
  additionalSkippedHeaders?: ReadonlySet<string>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    const lowerKey = key.toLowerCase();
    if (
      SKIP_RESPONSE_HEADERS.has(lowerKey) ||
      additionalSkippedHeaders?.has(lowerKey)
    ) {
      continue;
    }
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

const OBSERVABLE_ENCODINGS = new Set(["gzip", "br", "deflate", "identity"]);

/**
 * Restrict a client Accept-Encoding value to codings the passive observer can
 * decode (see createObservationDecoder/decodeForObservation). Client tokens
 * are kept verbatim (q-values included) so negotiation semantics survive —
 * except q=0 tokens, which the client explicitly refuses and so cannot count
 * as an acceptable coding; an absent header means "anything", so advertise
 * the full supported set, and if nothing supported and acceptable remains
 * fall back to identity, which every client accepts.
 */
const REFUSED_Q_ZERO = /;\s*q\s*=\s*0(?:\.0{0,3})?\s*(?:;|$)/i;

function observableAcceptEncoding(clientValue: string | undefined): string {
  if (clientValue === undefined) return "gzip, br, deflate";
  const kept = clientValue
    .split(",")
    .map((token) => token.trim())
    .filter(
      (token) =>
        OBSERVABLE_ENCODINGS.has(token.split(";", 1)[0].trim().toLowerCase()) &&
        !REFUSED_Q_ZERO.test(token)
    );
  return kept.length > 0 ? kept.join(", ") : "identity";
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
