#!/usr/bin/env node
/**
 * A long ccc session the way a person has one: real Claude Code under ccc in a real console
 * (node-pty: ConPTY on Windows), ~300 typed prompts whose tool rounds read large text files
 * and PNG/JPEG images, until the conversation has crossed ccc's budget on a human turn and
 * in a tool round and Claude Code's conversation passes ~30 MB (MemTree's image references
 * keep its bodies well under that), and then the console window is closed. Anthropic is a local mock (servers.mjs, via CCC_ANTHROPIC_UPSTREAM); MemTree is
 * staging, reached through a recording relay in ccc's `local` mode. Run by
 * .github/workflows/windows-long-session.yml; checks in lib.mjs evaluateRun.
 *
 *   node scripts/long-session/run.mjs
 *
 * Env (all optional except the key for a staging run):
 *   MEMTREE_E2E_KEY       MemTree key of the e2e-test account (staging shares production's
 *                         accounts). Without it the run uses the mock MemTree (LS_TARGET=mock).
 *   LS_TARGET             staging (default with a key) or mock
 *   LS_TURNS              prompts to type (300)
 *   LS_MAX_MINUTES        stop typing after this long, leaving time to close and check (40)
 *   LS_MODEL              Claude Code's --model (claude-opus-5-5, a native 1M window)
 *   LS_CCC_CLI            run `node <this cli.js>` instead of the installed `ccc`
 *   LS_INJECT_COOLDOWN    1 (default) fails the prepare calls before the first crossing and
 *                         its compress call once (servers.mjs shouldInject), to exercise ccc's
 *                         MemTree outage cooldown
 *   LS_CLAUDE             Claude Code's binary (default ~/.local/bin/claude[.exe])
 *   LS_POSIX_CLOSE_SIGNAL off Windows, the signal that closes the console (SIGHUP)
 *   LS_ALLOW_ANY_KEY      1 skips the check that the key belongs to an e2e-test account
 *   LS_ARTIFACTS_DIR      where logs and the summary go (RUNNER_TEMP/long-session)
 * This repo is public: nothing written to the console or the artifacts holds a key, an
 * email, a session id or a MemTree link.
 */
import { fork, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import {
  CHARS_PER_TOKEN, FAIL, crossingPath, PASS, evaluateRun, pngFixture, planTurn, redactPublic, summaryMarkdown, tailLines,
  textFileContent, turnPrompt, uniqueJpeg,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
const E2E_EMAIL_MARKER = "e2e-test";
const IS_WINDOWS = process.platform === "win32";
const KEY = process.env.MEMTREE_E2E_KEY?.trim() ?? "";
const TARGET = process.env.LS_TARGET || (KEY ? "staging" : "mock");
const TURNS = Number(process.env.LS_TURNS || 300);
const MAX_MINUTES = Number(process.env.LS_MAX_MINUTES || 40);
const MODEL = process.env.LS_MODEL || "claude-opus-5-5";
const INJECT_COOLDOWN = process.env.LS_INJECT_COOLDOWN !== "0";
const RUN_TAG = randomBytes(4).toString("hex");
const TMP = process.env.RUNNER_TEMP || os.tmpdir();
const ARTIFACTS = process.env.LS_ARTIFACTS_DIR || path.join(TMP, "long-session");
const BASE = path.join(TMP, `ccc-long-session-${RUN_TAG}`);
const HOME = path.join(BASE, "home");
const PROJECT = path.join(BASE, `ls-project-${RUN_TAG}`);
const CLAUDE_CONFIG_DIR = path.join(HOME, ".claude");
const REQLOG_FILE = path.join(HOME, ".claude-code-infinite", "logs", "requests.jsonl");
const DUMMY_ANTHROPIC_KEY = `sk-ant-api03-longsession-mock-${RUN_TAG}-${"x".repeat(40)}`;
/** Per turn: the answer must arrive within this (a blocking compress can wait 10 min). */
const TURN_TIMEOUT_MS = 12 * 60_000;
/** Output silence that counts as Claude Code idle again after a turn's answer. */
const QUIET_MS = 1_200;
/** After the close: how long ccc may take to exit, then to send its final index. */
const EXIT_WAIT_MS = 45_000;
/** For the final index to show on the server's session list. */
const SESSION_WAIT_MS = 8 * 60_000;
/** Minutes kept at the end for closing, the server lookup and the summary. */
const RESERVED_MINUTES = 10;

const state = { events: [], forwardedTokens: 0, memtreeBytes: 0, conversationBytes: 0, crossings: 0,
  answers: new Map(), screen: "", screenTotal: 0, lastOutputAt: Date.now(), waiters: new Set() };
const started = Date.now();

await main();

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  const facts = { os: `${process.platform}-${os.release()}`, platform: process.platform, turns: TURNS, turnsDone: 0,
    target: TARGET, model: MODEL, injectCooldown: INJECT_COOLDOWN };
  let results;
  try {
    if (TARGET === "staging") await checkStagingKey();
    writeConfigs();
    const servers = await startServers();
    facts.claudeVersion = versionOf(claudeCommand(), ["--version"]);
    facts.cccVersion = readCccVersion();
    log(`run ${RUN_TAG}: ${TURNS} turns, MemTree ${TARGET}, model ${MODEL}, ` +
      `Claude Code ${facts.claudeVersion}, ccc ${facts.cccVersion}`);
    const term = launch(servers);
    await waitForReady(term);
    const typed = await typeTurns(term);
    facts.turnsDone = typed.done;
    facts.turnError = typed.error;
    // Closed even after a failed turn: the exit path is checked either way.
    if (!state.exited) Object.assign(facts, await closeConsole(term));
    if (TARGET === "staging" && facts.turnsDone > 0) facts.serverSession = await serverSession(facts.turnsDone);
    servers.child.disconnect();
    results = evaluate(facts);
  } catch (err) {
    log(`harness error: ${err?.stack ?? err}`);
    results = [{ name: "harness ran to the end", status: FAIL, detail: redactPublic(String(err?.message ?? err), [KEY]) }];
  }
  facts.minutes = ((Date.now() - started) / 60_000).toFixed(1);
  finish(results, facts);
}

/** Staging answers for the key (retrying a cold start) and it is an e2e-test account. */
async function checkStagingKey() {
  if (!KEY) throw new Error("LS_TARGET=staging needs MEMTREE_E2E_KEY");
  const deadline = Date.now() + 4 * 60_000;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${STAGING_BASE_URL}/v1/context_memory/status`, {
        headers: { authorization: `Bearer ${KEY}`, "x-client": "cc-infinite-e2e" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      res = { status: `network ${err?.name ?? "error"}` };
    }
    if (res.status === 200) {
      const body = await res.json();
      if (process.env.LS_ALLOW_ANY_KEY !== "1" && !String(body.email ?? "").includes(E2E_EMAIL_MARKER)) {
        throw new Error("MEMTREE_E2E_KEY is not an e2e-test account's key");
      }
      log(`staging answered the key on attempt ${attempt}`);
      return;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`staging refused the key (${res.status})`);
    if (Date.now() > deadline) throw new Error(`staging not ready after ${attempt} attempts (${res.status})`);
    log(`staging not ready (${res.status}), retrying`);
    await sleep(10_000);
  }
}

/** A fresh home: ccc's config (the key, no update checks), Claude Code's onboarding done. */
function writeConfigs() {
  const cccDir = path.join(HOME, ".claude-code-infinite");
  fs.mkdirSync(cccDir, { recursive: true });
  fs.writeFileSync(path.join(cccDir, "config.json"), JSON.stringify({
    localPolychatApiKey: KEY || "mock-memtree-key", updateCheck: false, autoUpdate: false,
  }), { mode: 0o600 });
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const project = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: 1, allowedTools: [] };
  fs.writeFileSync(path.join(CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: "9.9.9", theme: "dark",
    numStartups: 5, hasSeenTasksHint: true, bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [DUMMY_ANTHROPIC_KEY.slice(-20)], rejected: [] },
    projects: Object.fromEntries(projectKeys().map((k) => [k, project])),
  }, null, 2));
  fs.writeFileSync(path.join(CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
    permissions: { allow: [`Read(${PROJECT.replace(/\\/g, "/")}/**)`, "Read"] },
    promptSuggestionEnabled: false, spinnerTipsEnabled: false,
  }, null, 2));
}

/** The project's path as Claude Code may key it: as given, real (macOS /private), with /. */
function projectKeys() {
  const real = fs.realpathSync.native(PROJECT);
  return [...new Set([PROJECT, real].flatMap((p) => [p, p.replace(/\\/g, "/")]))];
}

/** servers.mjs in its own process; resolves with its ports once both listen. */
function startServers() {
  const eventsFile = path.join(ARTIFACTS, "events.jsonl");
  fs.writeFileSync(eventsFile, "");
  const child = fork(path.join(HERE, "servers.mjs"), [], {
    env: { ...process.env, LS_SERVERS_CONFIG: JSON.stringify({
      runTag: RUN_TAG, workDir: PROJECT, model: MODEL, eventsFile, memtreeBaseUrl: STAGING_BASE_URL,
      mockMemtree: TARGET !== "staging", injectCooldown: INJECT_COOLDOWN,
    }) },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", (msg) => { if (msg.type === "event") onEvent(msg.event); });
  return new Promise((resolve, reject) => {
    child.once("message", (msg) => msg.type === "ready" ? resolve({ child, ...msg }) : reject(new Error("servers")));
    child.once("exit", (code) => reject(new Error(`servers exited ${code}`)));
  });
}

function onEvent(event) {
  state.events.push(event);
  if (event.kind === "messages" && event.lane === "main") {
    state.forwardedTokens = event.tokens;
    if (event.step === "answer") state.answers.set(event.turn, event);
  }
  if (event.kind === "memtree" && event.path === "/v1/context_memory" && event.requestBytes) {
    state.memtreeBytes = Math.max(state.memtreeBytes, event.requestBytes);
    // The server's budget for this model (staging may differ from ccc's 900k fallback).
    if (event.modelBudgetTokens > 0) state.budget = event.modelBudgetTokens;
  }
  for (const waiter of state.waiters) waiter();
}

/** ccc in a pseudo-console, in `local` mode pointed at the relay, Anthropic at the mock. */
function launch(servers) {
  ensureSpawnHelper();
  const [file, args] = cccInvocation();
  const term = pty.spawn(file, args, {
    name: "xterm-256color", cols: 160, rows: 48, cwd: PROJECT, env: childEnv(servers),
  });
  const screenLog = fs.createWriteStream(path.join(BASE, "screen.raw.log"));
  term.onData((data) => {
    screenLog.write(data);
    state.lastOutputAt = Date.now();
    const text = stripAnsi(data);
    state.screen = (state.screen + text).slice(-20_000);
    state.screenTotal += text.length;
    for (const waiter of state.waiters) waiter();
  });
  term.onExit(({ exitCode, signal }) => {
    state.exited = { exitCode, signal, at: Date.now() };
    screenLog.end();
    for (const waiter of state.waiters) waiter();
  });
  return term;
}

/** node-pty 1.1.0's macOS/Linux prebuilt spawn-helper can arrive without its exec bit. */
function ensureSpawnHelper() {
  if (IS_WINDOWS) return;
  const prebuilds = path.join(HERE, "node_modules", "node-pty", "prebuilds");
  for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}

function cccInvocation() {
  const args = ["local", "--model", MODEL];
  if (process.env.LS_CCC_CLI) return [process.execPath, [path.resolve(process.env.LS_CCC_CLI), ...args]];
  // The npm shim, as a person starts it: ccc.cmd under cmd.exe on Windows.
  if (IS_WINDOWS) return ["cmd.exe", ["/d", "/s", "/c", ["ccc", ...args].join(" ")]];
  return ["ccc", args];
}

function childEnv(servers) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Nothing from a parent Claude Code / ccc session (a developer running this in one).
    if (/^(CCC_|ANTHROPIC_|CLAUDE|MEMTREE_|LS_|DO_NOT_TRACK|DISABLE_TELEMETRY)/.test(k)) continue;
    env[k] = v;
  }
  // Windows spells it Path; one entry only, with Claude Code's directory first.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...env,
    HOME, USERPROFILE: IS_WINDOWS ? HOME : env.USERPROFILE,
    CLAUDE_CONFIG_DIR,
    CCC_LOCAL_BASE_URL: `http://127.0.0.1:${servers.relayPort}`,
    CCC_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${servers.upstreamPort}`,
    ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "60000",
    [pathKey]: [path.dirname(claudeCommand()), env[pathKey]].join(path.delimiter),
  };
}

/** Until Claude Code's prompt is up, answering the first-run dialogs it may still show. */
async function waitForReady(term) {
  const dialogs = [
    // "No, exit" is the default: move to "Yes" first.
    [/Do you trust the files|Yes, ?I ?trust this folder/i, "\x1b[B\r"],
    [/Do you want to use this API key|Detected a custom API key/i, "\x1b[A\r"],
    [/Choose the text style|Press Enter to continue/i, "\r"],
  ];
  const answered = new Set();
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`ccc exited at startup:\n${screenTail()}`);
    for (const [re, keys] of dialogs) {
      if (!answered.has(re) && re.test(state.screen.slice(-4000))) {
        answered.add(re);
        log(`answering a startup dialog (${re.source.slice(0, 30)})`);
        term.write(keys);
      }
    }
    if (/for shortcuts|shift\+tab|Try "|\? for/i.test(state.screen.slice(-4000)) &&
        Date.now() - state.lastOutputAt > 2_000) {
      log("Claude Code is ready");
      return;
    }
    await waitFor(() => false, 500);
  }
  throw new Error(`Claude Code never showed its prompt:\n${screenTail()}`);
}

/** Types each turn's prompt and waits for its answer; returns how many turns finished. */
async function typeTurns(term) {
  const stopAt = started + (MAX_MINUTES - RESERVED_MINUTES) * 60_000;
  const jpeg = fs.readFileSync(path.join(HERE, "fixtures", "photo.jpg"));
  for (let turn = 1; turn <= TURNS; turn++) {
    if (Date.now() > stopAt) {
      log(`time budget reached after ${turn - 1} turns`);
      return { done: turn - 1, error: `stopped at the ${MAX_MINUTES - RESERVED_MINUTES} min typing budget` };
    }
    // ccc's own record of the turns it compressed so far picks the plan's phase.
    state.crossings = readJsonl(REQLOG_FILE).filter((r) => crossingPath(r) !== undefined).length;
    const plan = planTurn({ turn, turns: plannedTurns(turn, stopAt), forwardedTokens: state.forwardedTokens,
      conversationBytes: state.conversationBytes, crossings: state.crossings,
      ...(state.budget ? { budget: state.budget } : {}) });
    const files = writeTurnFiles(turn, plan, jpeg);
    state.conversationBytes += plan.answerTokens * CHARS_PER_TOKEN;
    term.write(turnPrompt(RUN_TAG, turn, files, plan.answerTokens));
    await sleep(150);
    term.write("\r");
    const screenStart = state.screenTotal;
    const answered = await waitFor(() => state.answers.has(turn) || state.exited ||
      apiError(screenStart) !== null, TURN_TIMEOUT_MS);
    if (!state.answers.has(turn)) {
      const why = state.exited ? "ccc exited" : apiError(screenStart) ?? (answered ? "?" : "timed out");
      log(`turn ${turn} got no answer (${why})`);
      return { done: turn - 1, error: `turn ${turn}: ${why}` };
    }
    await waitFor(() => Date.now() - state.lastOutputAt > QUIET_MS, 30_000);
    // The answer joins the next turn's request: the plan must count it now (a long answer
    // that leaves the session under the budget would otherwise be planned again).
    state.forwardedTokens += plan.answerTokens;
    if (turn % 10 === 0 || plan.jump || plan.answerTokens) {
      log(`turn ${turn}: forwarded ${Math.round(state.forwardedTokens / 1000)}k tokens, ` +
        `conversation ${(state.conversationBytes / 1e6).toFixed(1)} MB, largest MemTree call ` +
        `${(state.memtreeBytes / 1e6).toFixed(1)} MB, ${state.crossings} crossings, ${elapsedMin()} min`);
    }
  }
  return { done: TURNS };
}

/**
 * Claude Code's final word on a failed request since `from` (characters of output), e.g.
 * "API Error: 400 MemTree couldn't fit this request…", once its retries are spent.
 */
function apiError(from) {
  const seen = state.screen.slice(Math.max(0, state.screen.length - (state.screenTotal - from)));
  for (const m of seen.matchAll(/API Error: \d{3}[^⏺✻❯\n]{0,160}/g)) {
    if (!/Retrying/i.test(m[0])) return redactPublic(m[0].trim(), [KEY]);
  }
  return null;
}

/**
 * The turns the plan aims at: all of them, or, once the pace (from turn 20 on) says the
 * typing budget ends sooner, as many as fit, so both crossings still land before it.
 */
function plannedTurns(turn, stopAt) {
  if (turn <= 20) return TURNS;
  const perTurn = (Date.now() - started) / (turn - 1);
  return Math.max(turn, Math.min(TURNS, turn - 1 + Math.floor((stopAt - Date.now()) / perTurn)));
}

function writeTurnFiles(turn, plan, jpeg) {
  const names = [];
  plan.texts.forEach((chars, i) => {
    const name = `t${turn}-${i}.txt`;
    const text = textFileContent(turn * 101 + i, chars, `T${turn}.${i}`);
    fs.writeFileSync(path.join(PROJECT, name), text);
    state.conversationBytes += text.length;
    names.push(name);
  });
  for (let i = 0; i < plan.images; i++) {
    const usePng = (turn + i) % 2 === 0;
    const name = `i${turn}-${i}.${usePng ? "png" : "jpg"}`;
    const image = usePng ? pngFixture(turn * 31 + i) : uniqueJpeg(jpeg, `${RUN_TAG}-${turn}-${i}`);
    fs.writeFileSync(path.join(PROJECT, name), image);
    // As Claude Code sends it: base64.
    state.conversationBytes += Math.ceil(image.length / 3) * 4;
    names.push(name);
  }
  return names;
}

/**
 * Closes the console the way closing its window does. On Windows that is ClosePseudoConsole
 * alone, which sends CTRL_CLOSE_EVENT (Node: SIGHUP) to every process attached to it;
 * node-pty's kill() would also TerminateProcess them all within moments, which no window
 * close does. Elsewhere the terminal hangs up (SIGHUP).
 */
async function closeConsole(term) {
  await waitFor(() => Date.now() - state.lastOutputAt > 3_000, 20_000);
  const closedAt = Date.now();
  let closeDetail;
  if (IS_WINDOWS) {
    const agent = term._agent;
    agent._ptyNative.kill(agent._pty, agent._useConptyDll === true);
    closeDetail = "ClosePseudoConsole (CTRL_CLOSE_EVENT)";
  } else {
    // LS_POSIX_CLOSE_SIGNAL=SIGTERM to exercise ccc's shutdown here (ccc handles SIGHUP on Windows only).
    const signal = process.env.LS_POSIX_CLOSE_SIGNAL || "SIGHUP";
    term.kill(signal);
    closeDetail = signal;
  }
  log(`console closed (${closeDetail})`);
  await waitFor(() => state.exited, EXIT_WAIT_MS);
  const exitMs = state.exited ? state.exited.at - closedAt : undefined;
  // ccc sends its final index while it exits: give the relay's record time to land.
  await waitFor(() => state.events.some((e) => e.kind === "memtree" && e.finalIndex && e.at >= closedAt &&
    (e.status !== undefined || e.error)), 20_000);
  await sleep(3_000);
  if (!state.exited) forceKill(term);
  return { consoleClosed: true, closedAt,
    closeDetail: `${closeDetail}; the console reported exit ${exitMs === undefined ? "never" : `after ${exitMs} ms`}` };
}

/** ccc still running after the close: end its whole tree (node-pty's kill would close the console again). */
function forceKill(term) {
  if (IS_WINDOWS) spawnSync("taskkill", ["/T", "/F", "/PID", String(term.pid)], { stdio: "ignore" });
  else term.kill("SIGKILL");
}

/**
 * The server's record of the session after the close: the sessions list (owner-only, by
 * this run's unique project directory) until its ending shows the last turn's answer,
 * which only the final index carries (tool-round index calls end before the answer).
 */
async function serverSession(turnsDone) {
  const project = path.basename(PROJECT);
  const wantAnswer = `LSDONE-${RUN_TAG}-${turnsDone}`;
  const deadline = Date.now() + SESSION_WAIT_MS;
  let detail = "session not listed";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${STAGING_BASE_URL}/v1/memtree/sessions?project=${encodeURIComponent(project)}&limit=5`, {
        headers: { authorization: `Bearer ${KEY}`, "x-client": "cc-infinite-e2e" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const session = (await res.json()).sessions?.[0];
        if (session) {
          const ending = session.ending ?? {};
          const indexed = String(ending.last_assistant ?? "").includes(wantAnswer);
          detail = `${session.request_count} usage rows; ending: last turn ` +
            `${String(ending.last_user ?? "").match(/LSTURN-\w+-(\d+)/)?.[1] ?? "?"}, ` +
            `answer ${indexed ? "indexed" : "not indexed yet"}`;
          if (indexed) return { finalTurnIndexed: true, detail };
        }
      } else {
        detail = `sessions list answered ${res.status}`;
      }
    } catch (err) {
      detail = `sessions list failed: ${err?.name ?? err}`;
    }
    await sleep(20_000);
  }
  return { finalTurnIndexed: false, detail: `${detail} after ${SESSION_WAIT_MS / 60_000} min` };
}

function evaluate(facts) {
  const reqlog = readJsonl(REQLOG_FILE);
  fs.writeFileSync(path.join(ARTIFACTS, "requests.redacted.jsonl"),
    reqlog.map((r) => redactPublic(JSON.stringify(r), [KEY])).join("\n") + "\n");
  const relay = state.events.filter((e) => e.kind === "memtree" || e.kind === "diagnostics");
  const mock = state.events.filter((e) => e.kind === "messages" || e.kind === "count");
  return evaluateRun({ reqlog, relay, mock, run: { ...facts, turns: TURNS, budget: state.budget,
    conversationBytes: state.conversationBytes } });
}

function finish(rawResults, facts) {
  // Everything below is public: redact each detail once more on the way out.
  const results = rawResults.map((r) => ({ ...r, detail: redactPublic(String(r.detail ?? ""), [KEY]) }));
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const summary = summaryMarkdown(results, facts, runUrl);
  fs.writeFileSync(path.join(ARTIFACTS, "summary.md"), summary);
  fs.writeFileSync(path.join(ARTIFACTS, "results.json"), JSON.stringify({ facts, results }, null, 2));
  const raw = path.join(BASE, "screen.raw.log");
  if (fs.existsSync(raw)) {
    const text = fs.readFileSync(raw, "utf8");
    fs.writeFileSync(path.join(ARTIFACTS, "screen.log"), redactPublic(stripAnsi(text.slice(-3_000_000)), [KEY]));
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  for (const r of results.filter((x) => x.status === FAIL)) console.log(`::error::${r.name}: ${r.detail}`);
  process.exit(results.some((r) => r.status === FAIL) || !results.some((r) => r.status === PASS) ? 1 : 0);
}

function claudeCommand() {
  if (process.env.LS_CLAUDE) return process.env.LS_CLAUDE;
  const exe = IS_WINDOWS ? "claude.exe" : "claude";
  return path.join(os.homedir(), ".local", "bin", exe);
}

function versionOf(command, args) {
  if (!fs.existsSync(command)) return "unknown";
  const out = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 }).stdout ?? "";
  return out.split(/\s/)[0] || "unknown";
}

function readCccVersion() {
  try {
    const cli = process.env.LS_CCC_CLI;
    const pkg = cli ? path.join(path.dirname(path.resolve(cli)), "..", "package.json")
      : path.join(HERE, "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    return "unknown";
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Resolves true once `cond()` holds (rechecked on every event and output), false at the timeout. */
function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    if (cond()) return resolve(true);
    const check = () => {
      if (!cond()) return;
      done(true);
    };
    const timer = setTimeout(() => done(Boolean(cond())), timeoutMs);
    const poll = setInterval(check, 250);
    function done(value) {
      clearTimeout(timer);
      clearInterval(poll);
      state.waiters.delete(check);
      resolve(value);
    }
    state.waiters.add(check);
  });
}

function screenTail() {
  return redactPublic(tailLines(state.screen, 40), [KEY]);
}

function stripAnsi(text) {
  // Cursor-forward moves stand for spaces in Claude Code's rendering, and so (as one space)
  // do its column moves (`?[24Gfor[28Gshortcuts`).
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Math.min(Number(n || 1), 200)))
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\d*G/g, " ").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g, "");
}

function elapsedMin() {
  return ((Date.now() - started) / 60_000).toFixed(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(message) {
  console.log(`[long-session ${elapsedMin()}m] ${redactPublic(message, [KEY])}`);
}
