// PROTOTYPE (proto/https-proxy-rc): did the turns of one ccc session get MemTree?
// Usage: node scripts/proto/rc-check.mjs --pid <ccc pid> --since <ISO time> [--until <ISO>]
//        [--log ~/.claude-code-infinite/logs/requests.jsonl]
// Reads ccc's request log (no bodies in it), keeps that pid's records in the window, and fails
// if any model turn bypassed or lost MemTree, or a turn has no successful MemTree call
// (index or compress) from the same ccc within 2 minutes of it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OK_TURNS = new Set(["first-user", "tool", "tool-memory", "tool-prefix", "tool-recompressed",
  "followup-compressed", "followup-noop", "followup-prefix", "followup-under-budget",
  "followup-empty-memory"]);
const PAIR_MS = 120_000;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) =>
  (v.startsWith("--") ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
if (!args.pid || !args.since) {
  console.error("usage: rc-check.mjs --pid <ccc pid> --since <ISO time> [--until <ISO>] [--log <path>]");
  process.exit(2);
}
const logPath = args.log ?? join(homedir(), ".claude-code-infinite", "logs", "requests.jsonl");
const since = Date.parse(args.since);
const until = args.until ? Date.parse(args.until) : Infinity;
const records = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter((r) => r && String(r.pid) === String(args.pid) &&
  Date.parse(r.ts) >= since && Date.parse(r.ts) <= until);

const turns = records.filter((r) => r.kind === "messages");
const memtreeOk = records.filter((r) => r.kind === "memtree" && r.ok === true).map((r) => Date.parse(r.ts));
let failures = 0;
for (const t of turns) {
  const at = Date.parse(t.ts);
  const paired = memtreeOk.some((m) => Math.abs(m - at) <= PAIR_MS);
  const good = OK_TURNS.has(t.turnType) && t.upstreamStatus === 200 && paired;
  if (!good) failures++;
  console.log(`${good ? "ok  " : "FAIL"} ${t.ts} turnType=${t.turnType} upstream=${t.upstreamStatus}` +
    `${paired ? "" : " (no successful MemTree call within 2 min)"}`);
}
console.log(`${turns.length} model turns, ${memtreeOk.length} successful MemTree calls, ${failures} failing`);
process.exit(turns.length > 0 && failures === 0 ? 0 : 1);
