#!/usr/bin/env node
/**
 * Daily end-to-end checks of installing and first-running ccc, run by
 * .github/workflows/e2e-daily.yml on Linux, macOS and Windows, against PRODUCTION:
 *
 *   node scripts/e2e/client-e2e.mjs install     after `npm i -g claude-code-infinite@latest`,
 *                                               before Claude Code is installed
 *   node scripts/e2e/client-e2e.mjs first-run   after Claude Code's official installer
 *   node scripts/e2e/client-e2e.mjs turn        one real `ccc -p` turn (E2E Anthropic key)
 *   node scripts/e2e/client-e2e.mjs memtree     a scripted MemTree call makes a tree
 *   node scripts/e2e/client-e2e.mjs summary     job summary; exit 1 on any failure
 *
 * Each phase appends PASS/FAIL/SKIP rows to a results file and exits 0, so every phase
 * runs; `summary` decides. Secrets (env, all optional; missing ones SKIP their checks):
 * MEMTREE_E2E_KEY (the dedicated e2e-test account's MemTree key) and ANTHROPIC_API_KEY.
 * This repo is public, so nothing here prints a key, an email or a tree id.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FAIL, PASS, PROD_BASE_URL, SKIP, E2E_EMAIL_MARKER, claudeMissingProblems, exitCode,
  installedVersion, journeyLines, noKeyProblems, parsePrintResult, redactUrl,
  requestLogLines, summaryMarkdown, uniqueFirstMessage,
} from "./lib.mjs";

const RESULTS_FILE = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "ccc-e2e-results.jsonl");
const CONFIG_DIR = path.join(os.homedir(), ".claude-code-infinite");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const REQUEST_LOG = path.join(CONFIG_DIR, "logs", "requests.jsonl");
const KEY = process.env.MEMTREE_E2E_KEY?.trim() || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim() || "";
const IS_WINDOWS = process.platform === "win32";
const TREE_WAIT_MS = 10 * 60_000;
const TREE_POLL_MS = 20_000;
const TURN_TIMEOUT_MS = 4 * 60_000;
const CLIENT = "cc-infinite-e2e"; // labels the scripted call's usage row as e2e traffic
let cliPath; // cccCli()
const PHASES = { install, "first-run": firstRun, turn, memtree, summary };

const phase = process.argv[2];
if (!PHASES[phase]) {
  console.error(`usage: client-e2e.mjs <${Object.keys(PHASES).join("|")}>`);
  process.exit(2);
}
await PHASES[phase]();

async function install() {
  const latest = npm(["view", "claude-code-infinite", "version"]).stdout.trim();
  await check("install", "npm installs the latest ccc", () => {
    const installed = installedVersion(npm(["ls", "-g", "claude-code-infinite", "--json"]).stdout);
    assert(installed === latest, `installed ${installed}, npm latest ${latest}`);
    return `ccc ${installed}`;
  });
  await check("install", "ccc is on PATH", () => {
    const found = spawnSync(IS_WINDOWS ? "where" : "which", ["ccc"], { encoding: "utf8" });
    assert(found.status === 0, "`ccc` not found on PATH after npm install -g");
  });
  if (claudeInstalled()) {
    record("first-run", "no Claude Code: clear install message", SKIP, "runner already has Claude Code");
  } else {
    await check("first-run", "no Claude Code: clear install message", () => {
      const problems = claudeMissingProblems(runCcc(["-p", "hi"]), process.platform);
      assert(problems.length === 0, problems.join("; "));
    });
  }
  phaseDone("install");
}

async function firstRun() {
  await check("first-run", "Claude Code installed by its official installer", () => {
    assert(claudeInstalled(), "no claude in ~/.local/bin after the installer");
  });
  await check("first-run", "no key, no terminal: clear message, no prompt", () => {
    assert(!fs.existsSync(CONFIG_FILE), "a ccc config already exists on this runner");
    const problems = noKeyProblems(runCcc(["-p", "hi"]));
    assert(problems.length === 0, problems.join("; "));
  });
  if (!KEY) {
    record("first-run", "key accepted by production", SKIP, "secret MEMTREE_E2E_KEY not set");
    return phaseDone("first-run");
  }
  await check("first-run", "key accepted by production's status endpoint", keyStatus);
  await check("first-run", "a wrong key is refused (401)", async () => {
    const res = await statusRequest("sk-e2e-not-a-real-key");
    assert(res.status === 401, `HTTP ${res.status}`);
  });
  saveKey();
  await check("first-run", "ccc --version", () => {
    const run = spawnSync("ccc", ["--version"], { encoding: "utf8", input: "", shell: IS_WINDOWS, timeout: 60_000 });
    assert(run.status === 0, `exit ${run.status}: ${tail(run.stderr)}`);
    assert(/\(Claude Code\)/.test(run.stdout), "no Claude Code version in the output");
    return run.stdout.trim().split("\n").at(-1);
  });
  phaseDone("first-run");
}

async function turn() {
  if (!KEY || !ANTHROPIC_KEY) {
    const missing = [!KEY && "MEMTREE_E2E_KEY", !ANTHROPIC_KEY && "E2E_ANTHROPIC_API_KEY"].filter(Boolean);
    record("model-turn", "one ccc -p turn", SKIP, `secret ${missing.join(", ")} not set`);
    return phaseDone("turn");
  }
  saveKey();
  const started = Date.now();
  let sessionId;
  const ok = await check("model-turn", "one ccc -p turn returns clean JSON", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-e2e-turn-"));
    const run = runCcc(
      ["-p", "Reply with exactly the word OK and nothing else.", "--model", "haiku", "--output-format", "json"],
      { cwd, timeout: TURN_TIMEOUT_MS, env: { ...process.env, ANTHROPIC_API_KEY: ANTHROPIC_KEY } }
    );
    assert(run.status === 0, `exit ${run.status}: ${tail(run.stderr)}`);
    const result = parsePrintResult(run.stdout);
    assert(!result.isError, `is_error: ${result.result.slice(0, 120)}`);
    assert(/\bOK\b/.test(result.result), `unexpected reply ${JSON.stringify(result.result.slice(0, 60))}`);
    sessionId = result.sessionId;
    assert(sessionId, "no session_id in the JSON");
  });
  await check("model-turn", "MemTree answered ccc during the turn", () => {
    const calls = requestLogLines(readText(REQUEST_LOG), "memtree", started);
    assert(calls.length > 0, "no MemTree calls in ccc's request log");
    const bad = calls.filter((c) => !c.ok);
    assert(bad.length === 0, `failed MemTree calls: ${bad.map((c) => c.status ?? "network").join(", ")}`);
    return `${calls.length} call(s), all OK`;
  });
  if (ok) await treeChecks("model-turn", sessionId);
  phaseDone("turn");
}

async function memtree() {
  if (!KEY) {
    record("memtree", "scripted MemTree call makes a tree", SKIP, "secret MEMTREE_E2E_KEY not set");
    return phaseDone("memtree");
  }
  saveKey();
  const sessionId = randomUUID();
  const ok = await check("memtree", "scripted index call accepted", async () => {
    const res = await fetch(`${PROD_BASE_URL}/v1/context_memory`, {
      method: "POST",
      headers: { ...clientHeaders(KEY), "content-type": "application/json", "x-claude-code-session-id": sessionId },
      body: JSON.stringify({
        messages: [
          { role: "user", content: uniqueFirstMessage(new Date().toISOString(), process.env.GITHUB_RUN_ID ?? "local", process.platform) },
          { role: "assistant", content: "Noted: the code word is juniper." },
          { role: "user", content: "What was the code word?" },
          { role: "assistant", content: "juniper" },
        ],
        model_context_limit: 200_000,
        index_only: true,
        final_index: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    assert(res.status === 200, `HTTP ${res.status}: ${tail(await res.text())}`);
    const body = await res.json();
    assert(body.index_only === true, "not answered as an index-only call");
  });
  if (ok) await treeChecks("memtree", sessionId);
  phaseDone("memtree");
}

/** `ccc link` finds the session's tree; its page opens for the owner and for no one else. */
async function treeChecks(journey, sessionId) {
  let url;
  const found = await check(journey, "ccc link returns the session's tree", async () => {
    const started = Date.now();
    let last;
    while (Date.now() - started < TREE_WAIT_MS) {
      last = runCcc(["link", sessionId], { timeout: 60_000 });
      if (last.status === 0) {
        url = last.stdout.trim();
        return `${redactUrl(url)} after ${Math.round((Date.now() - started) / 1000)} s`;
      }
      await sleep(TREE_POLL_MS);
    }
    throw new Error(`no tree after ${TREE_WAIT_MS / 60_000} min (last: exit ${last?.status}, ${tail(last?.stderr)})`);
  });
  if (!found) return;
  await check(journey, "tree page opens for its owner", async () => {
    const started = Date.now();
    let res;
    do {
      res = await fetch(url, { headers: { authorization: `Bearer ${KEY}`, accept: "text/html" }, redirect: "manual" });
      if (res.status !== 202) break;
      await sleep(TREE_POLL_MS);
    } while (Date.now() - started < TREE_WAIT_MS);
    assert(res.status === 200, `HTTP ${res.status}`);
  });
  await check(journey, "tree page refused without the key", async () => {
    const res = await fetch(url, { headers: { accept: "text/html" }, redirect: "manual" });
    assert(res.status === 404, `HTTP ${res.status}, expected the uniform 404`);
  });
}

async function keyStatus() {
  const res = await statusRequest(KEY);
  assert(res.status === 200, `HTTP ${res.status}`);
  const body = await res.json();
  assert(typeof body.paid === "boolean", "no `paid` in the status");
  assert(String(body.email ?? "").includes(E2E_EMAIL_MARKER),
    "MEMTREE_E2E_KEY is not a dedicated e2e-test account's key");
  assert(body.paid, "the e2e test account is unpaid, so MemTree calls get 402 (give it a free subscription)");
  return "paid";
}

function statusRequest(key) {
  return fetch(`${PROD_BASE_URL}/v1/context_memory/status`, {
    headers: clientHeaders(key), signal: AbortSignal.timeout(30_000),
  });
}

async function summary() {
  const rows = readText(RESULTS_FILE).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const results = rows.filter((r) => r.journey);
  const done = rows.filter((r) => r.phaseDone).map((r) => r.phaseDone);
  const expected = ["install", "first-run", "turn", ...(process.platform === "linux" ? ["memtree"] : [])];
  const missing = expected.filter((p) => !done.includes(p));
  const title = `ccc e2e (daily) on ${process.env.RUNNER_OS ?? process.platform}`;
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";
  const markdown = summaryMarkdown(title, results, missing, runUrl);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log([title, ...journeyLines(results), ...missing.map((p) => `FAIL phase ${p} did not finish`)].join("\n"));
  process.exit(exitCode(results, expected, done));
}

// ---- helpers ----

async function check(journey, name, fn) {
  try {
    const detail = await fn();
    record(journey, name, PASS, detail ?? "");
    return true;
  } catch (err) {
    record(journey, name, FAIL, err?.message ?? String(err));
    return false;
  }
}

function record(journey, name, status, detail = "") {
  const masked = mask(String(detail)).slice(0, 300);
  console.log(`[${status}] ${journey}: ${name}${masked ? `  - ${masked}` : ""}`);
  fs.appendFileSync(RESULTS_FILE, JSON.stringify({ journey, name, status, detail: masked }) + "\n");
}

function phaseDone(name) {
  fs.appendFileSync(RESULTS_FILE, JSON.stringify({ phaseDone: name }) + "\n");
}

function mask(text) {
  let out = text;
  for (const secret of [KEY, ANTHROPIC_KEY]) if (secret) out = out.split(secret).join("***");
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function clientHeaders(key) {
  return { authorization: `Bearer ${key}`, "x-client": CLIENT, "x-client-version": "e2e" };
}

/** ccc run as `node <global>/claude-code-infinite/dist/cli.js`: no shell quoting, stdin not a TTY. */
function runCcc(args, { cwd, timeout = 120_000, env = process.env } = {}) {
  const run = spawnSync(process.execPath, [cccCli(), ...args], { cwd, env, timeout, input: "", encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function cccCli() {
  cliPath ??= path.join(npm(["root", "-g"]).stdout.trim(), "claude-code-infinite", "dist", "cli.js");
  return cliPath;
}

function npm(args) {
  const run = spawnSync("npm", args, { encoding: "utf8", shell: IS_WINDOWS, timeout: 120_000 });
  if (run.status !== 0 && args[0] !== "ls") throw new Error(`npm ${args.join(" ")}: exit ${run.status}`);
  return run;
}

function claudeInstalled() {
  const exe = path.join(os.homedir(), ".local", "bin", IS_WINDOWS ? "claude.exe" : "claude");
  const onPath = spawnSync(IS_WINDOWS ? "where" : "which", ["claude"], { encoding: "utf8" }).status === 0;
  return onPath || fs.existsSync(exe);
}

function saveKey() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, polychatApiKey: KEY }, null, 2), { mode: 0o600 });
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function tail(text) {
  return mask(String(text ?? "").trim().split("\n").slice(-2).join(" ")).slice(0, 200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
