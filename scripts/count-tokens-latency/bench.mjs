// Measure Anthropic /v1/messages/count_tokens latency vs body size
// (reports/2026-10-15-count-tokens-latency.md). Usage, from this directory:
//   node bench.mjs seq text|images 50k,1M,27M 3     sizes in SIZES, runs per size
//   node bench.mjs conc images 8M 5                 concurrent counts
//   node exact.mjs /v1/messages/count_tokens 67108865   exact-size limit probe
//   node badmax.mjs 40000000    Messages size probe (max_tokens -5: never runs the model)
// Results append to results.jsonl (OUT=...). Bodies are synthetic only (generated
// prose, code, tool-result JSON, random-noise PNGs). The Claude Code OAuth token
// is read from the macOS keychain into memory and never printed or written.
import { execSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import https from "node:https";
import { userInfo } from "node:os";
import zlib from "node:zlib";
import fs from "node:fs";

const MODEL = process.env.MODEL ?? "claude-opus-5-5";
const OUT = process.env.OUT ?? "results.jsonl";

function token() {
  const raw = execSync(
    `security find-generic-password -s "Claude Code-credentials" -a "${userInfo().username}" -w`,
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(raw.trim()).claudeAiOauth.accessToken;
}
const TOKEN = token();

// ---------- synthetic content ----------
const WORDS = ("the of and to in is that for it as with was on be by this are from at or an " +
  "which have not but all were when there can their more if will one about so what out up " +
  "into them some could time these two may then do first any my now such like over only " +
  "system request window token budget compress memory index tree branch leaf summary deadline " +
  "network upload latency server client proxy session model context image screenshot").split(" ");
function prose(n) {
  let s = "";
  while (s.length < n) {
    const len = 8 + randomInt(14);
    const w = [];
    for (let i = 0; i < len; i++) w.push(WORDS[randomInt(WORDS.length)]);
    s += w.join(" ") + ". ";
    if (randomInt(6) === 0) s += "\n\n";
  }
  return s.slice(0, n);
}
function code(n) {
  let s = "";
  let i = 0;
  while (s.length < n) {
    const v = `v${randomInt(1000)}`;
    s += `export function fn_${i++}_${randomInt(1e6)}(${v}: number, opts?: Opts): Result {\n` +
      `  const ${v}x = ${v} * ${randomInt(97)} + Math.floor(${v} / ${1 + randomInt(9)});\n` +
      `  if (!opts?.enabled || ${v}x > ${randomInt(1e5)}) return { ok: false, value: ${v}x };\n` +
      `  return { ok: true, value: helper_${randomInt(500)}(${v}x, "${randomBytes(6).toString("hex")}") };\n}\n\n`;
  }
  return s.slice(0, n);
}
function toolJson(n) {
  const rows = [];
  let size = 0;
  while (size < n) {
    const row = { id: randomBytes(8).toString("hex"), path: `/src/mod_${randomInt(900)}/file_${randomInt(9000)}.ts`,
      line: randomInt(5000), match: prose(60 + randomInt(80)), score: Math.random() };
    const t = JSON.stringify(row);
    size += t.length;
    rows.push(row);
  }
  return JSON.stringify(rows, null, 1).slice(0, n);
}

// ---------- PNG with random noise (optionally only a fraction of rows noisy) ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c;
});
function crc32(buf) {
  let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function noisePng(w, h, noiseFraction = 1) {
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h, 0xf0);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0;
    if (y / h < noiseFraction) randomBytes(w * 3).copy(raw, y * rowLen + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- bodies ----------
function textBlocks(bytes) {
  const third = Math.floor(bytes / 3);
  return [prose(third), code(third), toolJson(bytes - 2 * third)];
}
/** A Claude-Code-like conversation of about `bytes`, text only or with images. */
export function makeBody(bytes, kind) {
  const messages = [];
  let imgB64 = null;
  if (kind === "images") {
    // ~1.4 MB base64 each: 2000x1250 screenshot-like (14% noise rows).
    // 2000x1250 screenshot-like (14% noise rows, ~1.4 MB base64); smaller
    // bodies use proportionally smaller noise images so they still carry several.
    const frac = Math.min(0.14, Math.max(0.002, bytes / 4 / 7.5e6 / 1.33));
    imgB64 = noisePng(2000, 1250, frac).toString("base64");
  }
  if (kind === "bigimg") imgB64 = noisePng(2000, 1250, 1).toString("base64");
  let remaining = bytes;
  let turn = 0;
  // images: ~90% of bytes in images, the rest text (like the incident).
  const textShare = kind === "text" ? 1 : 0.02;
  const textTotal = Math.floor(bytes * textShare);
  const pieces = textBlocks(textTotal);
  const perTurnText = Math.max(500, Math.floor(textTotal / 40));
  const allText = pieces.join("\n");
  let textPos = 0;
  while (remaining > 0 && turn < 2000) {
    const tid = `toolu_${randomBytes(10).toString("hex")}`;
    const t = allText.slice(textPos, textPos + perTurnText);
    textPos += perTurnText;
    messages.push({ role: "user", content: [{ type: "text", text: `Turn ${turn}: please continue.` }] });
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: tid, name: "Read", input: { file_path: `/x/${turn}.ts` } }] });
    const content = [];
    if (t) content.push({ type: "text", text: t });
    if (imgB64 && remaining > imgB64.length) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imgB64 } });
    if (!content.length) content.push({ type: "text", text: "ok" });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tid, content }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: "Noted." }] });
    remaining = bytes - JSON.stringify(messages).length;
    if (!imgB64 && textPos >= allText.length) break;
    if (imgB64 && remaining <= imgB64.length && textPos >= allText.length) break;
    turn++;
  }
  messages.push({ role: "user", content: "Summarize." });
  return Buffer.from(JSON.stringify({ model: MODEL, system: "You are a test.", messages }));
}

// ---------- request ----------
export function count(body, path = "/v1/messages/count_tokens") {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let tFinish, tHeaders;
    const req = https.request({
      host: "api.anthropic.com", port: 443, method: "POST", path,
      headers: { authorization: `Bearer ${TOKEN}`, "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json",
        "content-length": String(body.length), "accept-encoding": "identity" },
    }, (res) => {
      tHeaders = performance.now();
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
        resolve({ status: res.statusCode, ms: performance.now() - t0,
          uploadMs: tFinish === undefined ? null : tFinish - t0,
          serverMs: tFinish === undefined ? null : tHeaders - tFinish,
          tokens: parsed.input_tokens, error: parsed.error ? `${parsed.error.type}: ${String(parsed.error.message).slice(0, 160)}` : (parsed.raw ?? undefined),
          retryAfter: res.headers["retry-after"], requestId: res.headers["request-id"] });
      });
    });
    req.setTimeout(180_000, () => req.destroy(new Error("client timeout 180s")));
    req.on("finish", () => { tFinish = performance.now(); });
    req.on("error", (e) => resolve({ status: 0, ms: performance.now() - t0,
      uploadMs: tFinish === undefined ? null : tFinish - t0, error: `${e.code ?? ""} ${e.message}` }));
    req.end(body);
  });
}

function record(row) {
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}

const SIZES = { "50k": 50e3, "500k": 500e3, "1M": 1e6, "2M": 2e6, "4M": 4e6, "8M": 8e6,
  "16M": 16e6, "27M": 27e6, "34M": 34e6, "48M": 48e6, "64M": 64e6, "100M": 100e6 };
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "seq") {
    const [kind, sizeList, runs] = args;
    for (const label of sizeList.split(",")) {
      const body = makeBody(SIZES[label], kind);
      for (let r = 0; r < Number(runs); r++) {
        const res = await count(body);
        record({ kind, label, bytes: body.length, run: r, ...res });
      }
    }
  } else if (mode === "probe") {
    // probe <path> <kind> <bytes> [model]: one request of an exact-ish size.
    const [path, kind, bytes, model] = args;
    let body = makeBody(Number(bytes), kind);
    if (model) { const o = JSON.parse(body); o.model = model; o.max_tokens = 1; body = Buffer.from(JSON.stringify(o)); }
    const res = await count(body, path);
    record({ probe: path, kind, bytes: body.length, model: model ?? MODEL, ...res });
  } else if (mode === "conc") {
    const [kind, label, n] = args;
    const body = makeBody(SIZES[label], kind);
    const res = await Promise.all(Array.from({ length: Number(n) }, () => count(body)));
    res.forEach((x, i) => record({ kind, label, bytes: body.length, concurrent: Number(n), run: i, ...x }));
  }
}
if (process.argv[1]?.endsWith("bench.mjs")) main();
