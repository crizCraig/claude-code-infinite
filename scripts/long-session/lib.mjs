// Pure helpers for the long-session test (run.mjs, servers.mjs): token counting the mock
// upstream answers with, fixture files, the per-turn plan and the end-of-run checks.
// Unit tested in test/long-session-lib.test.mjs. No I/O here.

import { deflateSync } from "node:zlib";

/** Characters per token the mock upstream counts text at (Claude 4.7+ is ~2.2-2.7). */
export const CHARS_PER_TOKEN = 2.7;
/** Per-message overhead tokens, like Anthropic's role/turn framing. */
export const MESSAGE_OVERHEAD_TOKENS = 8;
/**
 * The budget assumed until MemTree reports one (its first answers carry model_budget_tokens,
 * which ccc and the harness then both use; staging says 960k) and the mock MemTree's budget.
 */
export const BUDGET_TOKENS = 900_000;
export const WINDOW_TOKENS = 1_000_000;
/** Cloud Run's request limit over HTTP/1, which ccc's MemTree calls use. */
export const HTTP1_EDGE_BYTES = 32 * 1024 * 1024;
/** MemTree bodies must stay under this (image references keep them there). */
export const MEMTREE_BODY_LIMIT_BYTES = 30 * 1024 * 1024;
/** Claude Code's conversation must reach this for the body check to mean anything. */
export const MIN_CONVERSATION_BYTES = 28_000_000;
/** What a stored image's base64 becomes on a MemTree call (ccc image-refs.ts). */
export const IMAGE_REF_PREFIX = "memtree-image:sha256:";
/** ccc's ordinary compress timeout (memtree.ts DEFAULT_COMPRESS_TIMEOUT_MS). */
export const COMPRESS_TIMEOUT_MS = 15_000;
/** The diagnostics store's pairing window (polychat ccc_diagnostics_store.py). */
export const CONSOLE_CLOSE_PAIR_MS = 30_000;
/** Largest text file one Read returns whole (Claude Code caps a read near 25k tokens). */
export const MAX_TEXT_FILE_CHARS = 56_000;
export const MAX_TEXT_FILES_PER_TURN = 3;
export const MAX_IMAGES_PER_TURN = 4;
/** Typical base64 size of one fixture image, for planning. */
export const IMAGE_B64_BYTES = 105_000;

/** How long after the injected 503 the degraded turn's record may be written. */
const INJECTED_TURN_MS = 120_000;

export const PASS = "PASS";
export const FAIL = "FAIL";
export const SKIP = "SKIP";

/**
 * Tokens the mock upstream reports for a Messages body (count_tokens and usage alike):
 * text characters at CHARS_PER_TOKEN, each base64 image by its dimensions (Anthropic's
 * ceil(w/28) x ceil(h/28)), plus a small per-message overhead.
 */
export function countBodyTokens(body) {
  const tally = { chars: 0, imageTokens: 0, images: 0 };
  for (const key of ["system", "messages", "tools"]) walk(body?.[key], tally);
  const messages = Array.isArray(body?.messages) ? body.messages.length : 0;
  return Math.ceil(tally.chars / CHARS_PER_TOKEN) + tally.imageTokens +
    messages * MESSAGE_OVERHEAD_TOKENS;
}

/** Images (count and tokens) in a Messages body. */
export function bodyImages(body) {
  const tally = { chars: 0, imageTokens: 0, images: 0 };
  walk(body?.messages, tally);
  return { count: tally.images, tokens: tally.imageTokens };
}

function walk(value, tally) {
  if (typeof value === "string") {
    tally.chars += value.length;
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, tally);
  } else if (value && typeof value === "object") {
    if (value.type === "image" && value.source?.type === "base64") {
      tally.images++;
      tally.imageTokens += imageTokensOf(value.source.data);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === "signature" || k === "cache_control") continue;
      walk(v, tally);
    }
  }
}

/** Visual tokens of a base64 PNG/JPEG (a fixed 1,600 when its size can't be read). */
export function imageTokensOf(base64) {
  const dims = imageDimensions(Buffer.from(String(base64).slice(0, 200_000), "base64"));
  if (!dims) return 1_600;
  let { width, height } = dims;
  const scale = Math.min(1, 2576 / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** Width and height from a PNG's IHDR or a JPEG's SOF marker, else null. */
export function imageDimensions(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const length = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + length;
  }
  return null;
}

/** A deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "river engine ledger copper window harbor signal meadow lantern quarry orbit velvet " +
  "pigeon cobalt saddle thunder marble garden falcon prairie beacon canyon walnut frost " +
  "compass anchor timber violet summit pebble canvas ember glacier hollow island jasper " +
  "kettle lumen mosaic nectar oyster parcel quiver rocket shadow tunnel umber vortex"
).split(" ");

/**
 * A text file of about `chars` characters: numbered log-like lines with a unique tag, so
 * every file differs (Claude Code answers a re-read of an unchanged file with a stub).
 */
export function textFileContent(seed, chars, tag) {
  const rand = prng(seed);
  const lines = [];
  let size = 0;
  for (let n = 1; size < chars; n++) {
    const words = [];
    const count = 8 + Math.floor(rand() * 10);
    for (let w = 0; w < count; w++) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
    const line = `${tag} ${String(n).padStart(5, "0")} ${words.join(" ")}.`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + "\n";
}

/** A PNG of noise over flat bands, about 80 KB, unique per seed. */
export function pngFixture(seed, width = 320, height = 240, noiseRows = 84) {
  const rand = prng(seed);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      const noisy = y < noiseRows;
      raw[p] = noisy ? Math.floor(rand() * 256) : (y + seed) & 255;
      raw[p + 1] = noisy ? Math.floor(rand() * 256) : (y * 3) & 255;
      raw[p + 2] = noisy ? Math.floor(rand() * 256) : 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The base JPEG with a comment segment after SOI, so each copy is a distinct file. */
export function uniqueJpeg(base, tag) {
  const text = Buffer.from(`long-session ${tag}`, "ascii");
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([base.subarray(0, 2), segment, text, base.subarray(2)]);
}

/** The prompt for a turn: its marker, the answer length, then the files the mock reads. */
export function turnPrompt(runTag, turn, files, answerTokens = 0) {
  return `${turnMarker(runTag, turn)} answer=${answerTokens} read: ${files.join(" ")}`;
}

export function turnMarker(runTag, turn) {
  return `LSTURN-${runTag}-${turn}.`;
}

/** The turn, answer length and file names of the newest turnPrompt in text, else null. */
export function parseTurnPrompt(text, runTag) {
  const re = new RegExp(`LSTURN-${runTag}-(\\d+)\\. answer=(\\d+) read: ([^\\n"\\\\]*)`, "g");
  let last = null;
  for (const m of String(text).matchAll(re)) last = m;
  if (!last) return null;
  return {
    turn: Number(last[1]),
    answerTokens: Number(last[2]),
    files: last[3].trim().split(/\s+/).filter(Boolean),
  };
}

/**
 * Whether a request carries the results of a turn's Reads (tool_use `ids`, for `prompt`'s
 * files). Each id needs its result: a structured tool_result block, or, in a body MemTree
 * flattened, its `→ result: … (tool_use_id=<id>)` line; a flattened body must also hold
 * each text file's line tag. `seen` is true once any id shows; `errors` counts results
 * marked is_error (flattened: `→ result (error): `).
 */
export function toolResultsIn(body, text, ids, prompt) {
  if (!ids.length) return { complete: false, seen: false, errors: 0 };
  const structured = new Map();
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_result" && ids.includes(block.tool_use_id)) structured.set(block.tool_use_id, block);
    }
  }
  let errors = 0;
  let found = 0;
  for (const id of ids) {
    const block = structured.get(id);
    if (block) {
      found++;
      if (block.is_error === true) errors++;
      continue;
    }
    const entry = flattenedResult(text, id);
    if (!entry) continue;
    found++;
    if (entry.error) errors++;
  }
  const flattenedOnly = found > structured.size;
  const tags = prompt.files.map((f) => f.match(/^t(\d+)-(\d+)\.txt$/)).filter(Boolean)
    .map((m) => `T${m[1]}.${m[2]} `);
  const complete = found === ids.length && (!flattenedOnly || tags.every((tag) => text.includes(tag)));
  return { complete, seen: ids.some((id) => text.includes(id)), errors };
}

/**
 * The flattened result entry for `id`: a `→ result: ` (or `→ result (error): `) prefix whose
 * entry ends with `(tool_use_id=<id>)`, with no other entry's suffix between them.
 */
function flattenedResult(raw, id) {
  // The arrow as JSON may escape it (Python's json.dumps does).
  const text = raw.replaceAll("\\u2192", "→");
  const suffix = `(tool_use_id=${id})`;
  for (let at = text.indexOf(suffix); at >= 0; at = text.indexOf(suffix, at + 1)) {
    const start = text.lastIndexOf("→ result", at);
    if (start < 0) continue;
    if (text.slice(start, at).includes("(tool_use_id=")) continue;
    if (text.startsWith("→ result: ", start)) return { error: false };
    if (text.startsWith("→ result (error): ", start)) return { error: true };
  }
  return null;
}

/** Tokens of the long answer that carries the first crossing into a human turn. */
export const LONG_ANSWER_TOKENS = 24_000;
/** The first crossing: tool rounds stop this far under the budget, then the long answer. */
export const HUMAN_CROSSING_MARGIN_TOKENS = 15_000;
/** ccc starts preparing a compressed prefix at this share of the trigger (prepared-compression.ts). */
export const PREPARE_START_RATIO = 850 / 960;
/** The second crossing: the session waits this far under the prepare start, then one tool round… */
export const JUMP_FROM_MARGIN_TOKENS = 40_000;
/** …lands this far over the budget (still clear of the window less Claude Code's output floor). */
export const JUMP_OVER_TOKENS = 15_000;
/** Text files the jump's tool round may read (each one Read of up to MAX_TEXT_FILE_CHARS). */
export const MAX_JUMP_FILES = 10;

/**
 * What turn `turn` of `turns` reads, steering two quantities:
 * - the tokens of the body forwarded upstream (`forwardedTokens`, the newest main-thread
 *   request; ccc counts exactly near the budget, so its size is ccc's), so the budget is
 *   crossed once by each path. `crossings` (forwarded size dropping after a compression)
 *   picks the phase:
 *   0. near 35% of the run the tool rounds stop HUMAN_CROSSING_MARGIN_TOKENS under the
 *      budget and a long answer carries the conversation over it, so the next human turn
 *      is the one that compresses (followup-compressed, or the prefix ccc prepared from
 *      850k on, followup-prefix);
 *   1. the session then grows only to JUMP_FROM_MARGIN_TOKENS under the prepare start, so
 *      no prefix is prepared, and near 70% one large tool round jumps over the budget:
 *      the mid-turn blocking compress (tool-recompressed);
 *   2. then it grows toward 97% of the budget by the end.
 * - the bytes of Claude Code's whole conversation (`conversationBytes`, every file read
 *   and answer), toward `peakBytes` by 90% of the run and past `edgeBytes` (Cloud Run's
 *   32 MiB HTTP/1 limit) in the last turns, so MemTree's image references are what keep
 *   its bodies small.
 */
export function planTurn({ turn, turns, forwardedTokens, conversationBytes, crossings,
  peakBytes = 30_000_000, edgeBytes = HTTP1_EDGE_BYTES + 1_500_000, budget = BUDGET_TOKENS }) {
  const phase = Math.min(crossings, 2);
  const goalTurn = Math.round(turns * [0.35, 0.7, 1.05][phase]);
  const jumpFrom = Math.floor(budget * PREPARE_START_RATIO) - JUMP_FROM_MARGIN_TOKENS;
  const goalTokens = [budget - HUMAN_CROSSING_MARGIN_TOKENS, jumpFrom, budget * 0.97][phase];
  const left = Math.max(1, goalTurn - turn + 1);
  const under = forwardedTokens < budget;
  let wantTokens = Math.max(1_500, (goalTokens - forwardedTokens) / left);
  const jump = phase === 1 && left <= 1 && under;
  if (jump) wantTokens = Math.max(wantTokens, budget + JUMP_OVER_TOKENS - forwardedTokens);
  const maxChars = (jump ? MAX_JUMP_FILES : MAX_TEXT_FILES_PER_TURN) * MAX_TEXT_FILE_CHARS;
  const textChars = Math.min(maxChars, Math.round(wantTokens * CHARS_PER_TOKEN));
  // Only once the reads reach the goal (a shrinking pace can leave them short: then the
  // answer waits a turn), and once only: a turn already over the budget gets none.
  const reached = forwardedTokens + textChars / CHARS_PER_TOKEN >= goalTokens - 2_000;
  const answerTokens = phase === 0 && left <= 1 && under && reached ? LONG_ANSWER_TOKENS : 0;
  const late = turn > Math.round(turns * 0.9);
  const byteGoal = late ? edgeBytes : peakBytes;
  const byteTurn = late ? turns : Math.round(turns * 0.9);
  const wantBytes = (byteGoal - conversationBytes - textChars) / Math.max(1, byteTurn - turn + 1);
  const images = Math.max(0, Math.min(MAX_IMAGES_PER_TURN, Math.round(wantBytes / IMAGE_B64_BYTES)));
  return { texts: splitChars(textChars), images, answerTokens, jump };
}

function splitChars(total) {
  if (total <= 0) return [];
  const n = Math.ceil(total / MAX_TEXT_FILE_CHARS);
  return Array.from({ length: n }, () => Math.ceil(total / n));
}

/** The p-th percentile (0-100) of numbers, nearest rank; undefined when empty. */
export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Replace MemTree page links, tree ids and keys in text bound for public logs. */
export function redactPublic(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("<redacted>");
  out = out.replace(/https?:\/\/[^\s"'<>)\]]*(polychat|memtree)[^\s"'<>)\]]*/gi, "<memtree-url>");
  out = out.replace(/\/(m|usage\/memtree)\/[A-Za-z0-9_-]{6,}/g, "/$1/<id>");
  // Session ids (ccc's resume hint prints one) and emails.
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<session-id>");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  return out;
}

/** The newest `n` lines of text. */
export function tailLines(text, n) {
  const lines = String(text).split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * The end-of-run checks, from what the run recorded:
 * - `reqlog`: ccc's request log records for this run's ccc process;
 * - `relay`: the MemTree relay's records (one per call, plus diagnostics batches);
 * - `mock`: the mock upstream's records (one per Messages or count_tokens request);
 * - `run`: the driver's facts (turns done, whether the console was closed, the server's
 *   session row after exit, the time it took).
 */
export function evaluateRun({ reqlog, relay, mock, run }) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, status: ok ? PASS : FAIL, detail });
  const skip = (name, detail) => results.push({ name, status: SKIP, detail });
  const calls = relay.filter((r) => r.kind === "memtree" && r.path === "/v1/context_memory");
  // Prepare calls (ccc's background compression ahead of the budget) are not crossings.
  const compressCalls = calls.filter((r) => !r.indexOnly && !r.prepare);
  const prepareCalls = calls.filter((r) => r.prepare);
  const injected = compressCalls.filter((r) => r.injected);
  const messages = reqlog.filter((r) => r.kind === "messages");
  const memtreeLogs = reqlog.filter((r) => r.kind === "memtree");

  add("turns completed", run.turnsDone === run.turns,
    `${run.turnsDone}/${run.turns}${run.turnError ? ` (${run.turnError})` : ""}`);
  const humanTurn = messages.filter((r) => crossingPath(r) === "human");
  const midTurn = messages.filter((r) => crossingPath(r) === "tool");
  add("MemTree compressed at least twice", humanTurn.length + midTurn.length >= 2,
    `${humanTurn.length + midTurn.length} compressions (${compressCalls.length} compress calls, ` +
    `${prepareCalls.length} prepare calls, ${calls.length - compressCalls.length - prepareCalls.length} ` +
    "index calls)");
  add("compressions on both paths (human turn, mid-turn tool round)",
    humanTurn.length > 0 && midTurn.length > 0,
    `human turn ${humanTurn.length} (${humanTurn.filter(adopted).length} on a prepared prefix), ` +
    `tool round ${midTurn.length} (${midTurn.filter(adopted).length} on a prepared prefix)`);
  const peak = Math.max(0, ...mock.filter((r) => r.lane === "main").map((r) => r.tokens));
  const budget = run.budget ?? BUDGET_TOKENS;
  add("forwarded context reached the budget", peak >= budget * 0.97 && peak <= WINDOW_TOKENS,
    `peak forwarded ${Math.round(peak / 1000)}k tokens (budget ${Math.round(budget / 1000)}k)`);
  checkBodies(calls, run, add);

  // Calls ccc's shutdown cut are judged by the exit checks below, not here.
  const failedCalls = calls.filter((r) => !r.injected && r.status !== 200 &&
    !(r.error === "client closed" && run.closedAt && r.at >= run.closedAt));
  add("no failed MemTree calls", failedCalls.length === 0, describeFailures(failedCalls));
  const over413 = [...calls, ...mock].filter((r) => r.status === 413);
  add("no 413 anywhere", over413.length === 0, over413.length ? describeFailures(over413) : "none");
  const edgeCalls = calls.filter((r) => (r.requestBytes ?? 0) > HTTP1_EDGE_BYTES);
  if (edgeCalls.length) {
    const ok = edgeCalls.filter((r) => r.status === 200).length;
    add("MemTree calls past 32 MiB succeed", ok === edgeCalls.length,
      `${ok}/${edgeCalls.length} succeeded (statuses ${[...new Set(edgeCalls.map((r) => r.status))].join(",")})`);
  } else {
    skip("MemTree calls past 32 MiB succeed", "no call crossed 32 MiB");
  }
  const upstreamFailures = messages.filter((r) => r.upstreamStatus !== undefined &&
    r.upstreamStatus !== 200);
  const refusals = messages.filter((r) => r.refusal);
  add("no failed or refused Anthropic requests", !upstreamFailures.length && !refusals.length,
    `${upstreamFailures.length} upstream errors, ${refusals.length} ccc refusals` +
    (refusals.length ? ` (first: ${refusalSummary(refusals[0].refusal)})` : ""));
  const mockOver = mock.filter((r) => r.status && r.status !== 200);
  add("mock upstream saw nothing over the window", mockOver.length === 0,
    mockOver.length ? `${mockOver.length} refused, first ${mockOver[0].tokens} tokens` : "none");
  const answers = mock.filter((r) => r.step === "answer");
  const readErrors = answers.reduce((n, r) => n + (r.toolErrors ?? 0), 0);
  const missing = answers.filter((r) => r.missingResults).length;
  add("every Read's result reached the model", !readErrors && !missing,
    `${readErrors} Read errors, ${missing} turns missing results`);
  const degraded = messages.filter((r) => r.turnType === "followup-degraded" || r.compress?.timedOut);
  // The injected outage degrades exactly one human turn, by design (a failed prepare call
  // degrades nothing: that turn compresses by a blocking call instead): the record of the
  // human turn whose compress call failed, written once its answer finished.
  const byInjection = (r) => r.turnType === "followup-degraded" && r.compress?.timedOut === false &&
    injected.some((c) => r.ts && Date.parse(r.ts) >= c.at && Date.parse(r.ts) - c.at < INJECTED_TURN_MS);
  const real = degraded.filter((r) => !byInjection(r));
  add("no degraded or timed-out compressions", real.length === 0 &&
    degraded.length - real.length === injected.length,
    `${degraded.length} degraded (${degraded.length - real.length} by the injected outage, ` +
    `${injected.length} injected)`);

  const latencies = compressCalls.filter((r) => !r.injected).map((r) => r.ms);
  const p95 = percentile(latencies, 95);
  add("compress latency p95 under ccc's 15 s timeout", p95 !== undefined && p95 < COMPRESS_TIMEOUT_MS,
    p95 === undefined ? "no compress calls" :
      `p50 ${percentile(latencies, 50)} ms, p95 ${p95} ms, max ${Math.max(...latencies)} ms`);

  if (run.injectCooldown) {
    const cooldown = messages.filter((r) => r.routeRecovery?.outcome === "cooldown").length;
    const preparesFailed = prepareCalls.filter((r) => r.injected).length;
    add("outage cooldown engaged after an injected failure", injected.length === 1 && cooldown > 0,
      `${injected.length} compress call failed (and ${preparesFailed} prepare calls before it), ` +
      `${cooldown} tool turns skipped compress in the cooldown`);
  }

  add("console closed like a user (CTRL_CLOSE / SIGHUP)", run.consoleClosed === true,
    run.closeDetail ?? "");
  const windows = run.platform === undefined || run.platform === "win32";
  // Only a final index ccc started after the close proves the shutdown flush (an idle
  // final index earlier in the session would not).
  const finals = calls.filter((r) => r.finalIndex && run.closedAt && (r.startedAt ?? r.at) >= run.closedAt);
  const finalOk = finals.filter((r) => r.status === 200);
  add("final index sent and accepted after the close", finalOk.length >= 1,
    finals.length ? finals.map((r) => `${r.status ?? "no answer"} in ${r.ms} ms, ` +
      `${(r.requestBytes / 1e6).toFixed(1)} MB`).join("; ") : "no final_index call reached MemTree");
  if (run.serverSession === undefined) {
    skip("final-index usage row on the server", "no server session lookup (mock MemTree)");
  } else {
    // The accepted job's stored record (the sessions list's ending) carries the last answer,
  // which only the exit's final index sends; indexing it finishes later, server-side.
  add("final-index usage row on the server", run.serverSession.finalTurnIndexed === true,
      run.serverSession.detail);
  }
  const diag = relay.filter((r) => r.kind === "diagnostics").flatMap((r) => r.events);
  checkExitDiagnostics(diag, memtreeLogs, run, windows ? add
    : (name, ok, detail) => (/console_closed|user close/.test(name) ? skip(name, `Windows only (${detail})`)
      : add(name, ok, detail)));
  return results;
}

/**
 * Which path a ccc request record crossed the budget by, else undefined: a human turn or a
 * tool round that compressed by a blocking call, or rode the prefix ccc prepared for it.
 */
export function crossingPath(record) {
  if (record?.kind !== "messages" || (record.routeLane && record.routeLane !== "main")) return undefined;
  const t = record.turnType;
  if (t === "followup-compressed" || (t === "followup-prefix" && adopted(record))) return "human";
  if (t === "tool-recompressed" || (t === "tool-prefix" && adopted(record))) return "tool";
  return undefined;
}

function adopted(record) {
  return ["used", "truncated"].includes(record.compaction?.prepared);
}

/**
 * Claude Code's conversation passes ~30 MB (its own requests drop old images near there),
 * but MemTree calls carry the images MemTree already stores as references, so its bodies
 * stay under MEMTREE_BODY_LIMIT_BYTES; and references must actually be used.
 */
function checkBodies(calls, run, add) {
  const largest = calls.reduce((a, r) => ((r.requestBytes ?? 0) > (a?.requestBytes ?? 0) ? r : a), undefined);
  const withRefs = calls.filter((r) => (r.imageRefs ?? 0) > 0);
  const refs = withRefs.reduce((n, r) => n + r.imageRefs, 0);
  const conflicts = calls.filter((r) => r.status === 409).length;
  const bytes = largest?.requestBytes ?? 0;
  // Vacuous unless the conversation itself got big.
  const conversation = run.conversationBytes ?? 0;
  add("MemTree bodies stay under 30 MiB and image refs are used",
    bytes < MEMTREE_BODY_LIMIT_BYTES && withRefs.length > 0 && conversation >= MIN_CONVERSATION_BYTES,
    `largest MemTree call ${(bytes / 1e6).toFixed(1)} MB (${largest?.imageRefs ?? 0} refs, ` +
    `${largest?.base64Images ?? 0} images as bytes); ${refs} refs in ${withRefs.length}/${calls.length} ` +
    `calls; ${conflicts} answered 409; conversation ~${(conversation / 1e6).toFixed(1)} MB ` +
    `(needs ${MIN_CONVERSATION_BYTES / 1e6} MB)`);
}

function checkExitDiagnostics(diag, memtreeLogs, run, add) {
  const closed = diag.find((e) => e.name === "console_closed");
  add("ccc recorded console_closed", Boolean(closed),
    closed ? "sent before exit" : `events seen: ${[...new Set(diag.map((e) => e.name))].join(",") || "none"}`);
  const exits = diag.filter((e) => e.name === "claude_exit");
  const unpaired = exits.filter((e) => !followsConsoleClose(closed, e));
  add("Claude Code's exit after the close classifies as a user close", Boolean(closed) && !unpaired.length,
    exits.length ? exits.map((e) => `claude_exit code ${e.code ?? "-"} signal ${e.signal ?? "-"} ` +
      `${closed && e.t !== undefined && closed.t !== undefined ? `${e.t - closed.t} ms after` : ""}`).join("; ")
      : "Claude Code exited 0 (no claude_exit event)");
  const cutoff = closed?.t ?? run.closedAt ?? Infinity;
  const exitErrors = diag.filter((e) => e.name === "memtree_error" && (e.t ?? 0) >= cutoff);
  const exitLogFailures = memtreeLogs.filter((r) => !r.ok && r.ts && run.closedAt &&
    Date.parse(r.ts) >= run.closedAt);
  add("no memtree_error at exit", !exitErrors.length && !exitLogFailures.length,
    `${exitErrors.length} memtree_error events, ${exitLogFailures.length} failed calls in the log` +
    (exitErrors[0] ? ` (first: status ${exitErrors[0].status ?? "none"}, ${exitErrors[0].ms} ms)` : ""));
}

/** A refusal's numbers, without its lane (which names the session). */
function refusalSummary(refusal) {
  const { lane: _lane, ...rest } = refusal ?? {};
  return JSON.stringify(rest);
}

/** Whether a claude_exit event comes within the pairing window after console_closed. */
export function followsConsoleClose(closed, exit) {
  if (!closed) return false;
  if (typeof closed.t === "number" && typeof exit.t === "number") {
    return exit.t - closed.t >= 0 && exit.t - closed.t <= CONSOLE_CLOSE_PAIR_MS;
  }
  return closed.batch === exit.batch;
}

function describeFailures(records) {
  if (!records.length) return "none";
  const byStatus = {};
  for (const r of records) byStatus[r.status ?? "no answer"] = (byStatus[r.status ?? "no answer"] ?? 0) + 1;
  return `${records.length} (${Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(", ")})`;
}

/** The job summary: one table row per check, then the run's numbers. */
export function summaryMarkdown(results, facts, runUrl) {
  const failed = results.filter((r) => r.status === FAIL).length;
  const lines = [
    `## ccc long session on ${facts.os}: ${failed ? `FAILED (${failed} checks)` : "PASSED"}`,
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.status} | ${String(r.detail ?? "").replace(/\|/g, "\\|")} |`),
    "",
    `Turns ${facts.turnsDone}/${facts.turns} in ${facts.minutes} min, MemTree target ${facts.target}, ` +
      `model ${facts.model}, Claude Code ${facts.claudeVersion}, ccc ${facts.cccVersion}.`,
  ];
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  return lines.join("\n") + "\n";
}
