// PROTOTYPE (proto/https-proxy-rc): how did one ccc session's model turns go?
// Usage: node scripts/proto/rc-check.mjs --pid <ccc pid> --since <ISO time> [--until <ISO>]
//        [--log ~/.claude-code-infinite/logs/requests.jsonl]
// Reads ccc's request log (no bodies in it), keeps that pid's records in the window, and
// classifies each `messages` record by its turnType. Exit 1 if any turn bypassed or lost
// MemTree (foreign, degraded, refused, ...), had an unknown type or a non-200 upstream, or if
// any MemTree call failed (other than the final index cut short at exit). This checks how
// ccc classified each turn; it does not tie a turn to its own MemTree call (the log has no
// shared id), so the MemTree lines are listed for reading alongside, not matched.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Turns that went through MemTree's route logic as designed (src/reqlog.ts). */
const MEMTREE_TURNS = new Set(["first-user", "tool", "tool-memory", "tool-prefix",
  "tool-recompressed", "followup-compressed", "followup-prefix", "followup-noop",
  "followup-under-budget", "followup-empty-memory"]);
/** Healthy requests that by design make no MemTree call (security monitor, away recap). */
const AUXILIARY = new Set(["side-request", "fork-memory"]);

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

let failures = 0;
let turns = 0;
for (const r of records) {
  if (r.kind === "messages") {
    const aux = AUXILIARY.has(r.turnType);
    const ok = (MEMTREE_TURNS.has(r.turnType) || aux) && r.upstreamStatus === 200;
    if (!aux) turns++;
    if (!ok) failures++;
    console.log(`${ok ? (aux ? "aux " : "ok  ") : "FAIL"} ${r.ts} turn turnType=${r.turnType} ` +
      `upstream=${r.upstreamStatus}`);
  } else if (r.kind === "memtree") {
    const exitCut = r.exitCut === true || r.finalIndex === true;
    const ok = r.ok === true || exitCut;
    if (!ok) failures++;
    console.log(`${ok ? "    " : "FAIL"} ${r.ts}   memtree ${r.indexOnly ? "index" : "compress"} ` +
      `ok=${r.ok}${exitCut && r.ok !== true ? " (final index cut at exit: fine)" : ""}`);
  }
}
console.log(`${turns} model turns, ${failures} failing`);
process.exit(turns > 0 && failures === 0 ? 0 : 1);
