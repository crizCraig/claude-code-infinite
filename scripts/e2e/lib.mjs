// Pure helpers for the daily e2e checks (scripts/e2e/client-e2e.mjs), unit tested in
// test/e2e-daily-lib.test.mjs. No I/O here.

export const PASS = "PASS";
export const FAIL = "FAIL";
export const SKIP = "SKIP";

export const PROD_BASE_URL = "https://app.polychat.co";
export const STAGING_BASE_URL = "https://polychat-staging-421312241218.us-west2.run.app";
export const NO_KEY_MESSAGE = "A MemTree API key is required: run `ccc` in a terminal once to save one.";
export const CLAUDE_MISSING_MESSAGE = "Claude Code isn't installed. ccc runs Claude Code, so install it first:";
/** Said instead when only the Claude desktop app is installed (a developer machine, not CI). */
export const DESKTOP_ONLY_MESSAGE = "Found the Claude desktop app, but ccc needs Claude Code in the terminal";
export const E2E_EMAIL_MARKER = "e2e-test";

/**
 * The server a run checks (E2E_TARGET, the workflow's `target` input): its base URL, the
 * words ccc takes before its arguments, the config field `ccc` reads that server's key
 * from, and whether the key must be paid. Staging never 402s (it gives no payment prompt),
 * so its `paid` says nothing about billing and is not checked there.
 */
export function e2eTarget(name) {
  const target = String(name ?? "").trim() || "production";
  if (target === "production") {
    return { name: target, baseUrl: PROD_BASE_URL, cccArgs: [], keyField: "polychatApiKey", requirePaid: true };
  }
  if (target === "staging") {
    return { name: target, baseUrl: STAGING_BASE_URL, cccArgs: ["staging"], keyField: "stagingPolychatApiKey", requirePaid: false };
  }
  throw new Error(`unknown E2E_TARGET ${JSON.stringify(target)} (production or staging)`);
}

/** The first ccc whose `--version` answers without a key (fix/version-without-key). */
export const VERSION_WITHOUT_KEY_SINCE = "1.0.28";

/** Whether dotted version `v` is at least `min` (numeric parts only). */
export function versionAtLeast(v, min) {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

/** Problems with `ccc --version` on a fresh install: ccc's version, then Claude Code's. */
export function versionProblems(run, installed) {
  const problems = [];
  if (run.status !== 0) problems.push(`exit ${run.status}`);
  if (run.stdout.split("\n")[0] !== `${installed} (Claude Code Infinite)`) problems.push("first line is not ccc's version");
  if (!/\(Claude Code\)/.test(run.stdout)) problems.push("no Claude Code version");
  if (/MemTree API key/.test(run.stdout + run.stderr)) problems.push("asked for a MemTree key");
  return problems;
}

/** The command ccc tells someone without Claude Code to run, per OS (claude-locate.ts). */
export function claudeInstallCommand(platform) {
  return platform === "win32"
    ? "irm https://claude.ai/install.ps1 | iex"
    : "curl -fsSL https://claude.ai/install.sh | bash";
}

/** Problems with a no-Claude-Code run: exit 1, the install message on stderr, nothing on stdout. */
export function claudeMissingProblems(run, platform) {
  const problems = [];
  if (run.status !== 1) problems.push(`exit ${run.status}, expected 1`);
  if (!run.stderr.includes(CLAUDE_MISSING_MESSAGE) && !run.stderr.includes(DESKTOP_ONLY_MESSAGE)) {
    problems.push("no 'Claude Code isn't installed' message");
  }
  if (!run.stderr.includes(claudeInstallCommand(platform))) problems.push("no install command for this OS");
  if (run.stdout.trim() !== "") problems.push("printed to stdout");
  return problems;
}

/** Problems with a first run with no key and no terminal: exit 1, one clear line, no prompt. */
export function noKeyProblems(run) {
  const problems = [];
  if (run.status !== 1) problems.push(`exit ${run.status}, expected 1`);
  if (!run.stderr.includes(NO_KEY_MESSAGE)) problems.push("no 'A MemTree API key is required' message");
  if (run.stdout !== "") problems.push("printed to stdout (a key prompt there would break scripts)");
  if (/paste it here/i.test(run.stdout + run.stderr)) problems.push("prompted for a key without a terminal");
  return problems;
}

/** The installed version from `npm ls -g claude-code-infinite --json`, or null. */
export function installedVersion(npmLsJson) {
  try {
    return JSON.parse(npmLsJson)?.dependencies?.["claude-code-infinite"]?.version ?? null;
  } catch {
    return null;
  }
}

/** A `-p --output-format json` result: the whole stdout must be one JSON object. */
export function parsePrintResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not clean JSON (${stdout.length} chars, starts ${JSON.stringify(stdout.slice(0, 40))})`);
  }
  if (parsed?.type !== "result") throw new Error(`JSON type is ${JSON.stringify(parsed?.type)}`);
  return { sessionId: parsed.session_id, result: String(parsed.result ?? ""), isError: parsed.is_error === true };
}

/** ccc's request-log lines (requests.jsonl) of `kind` written at or after `sinceMs`. */
export function requestLogLines(jsonl, kind, sinceMs) {
  const lines = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.kind === kind && Date.parse(entry.ts) >= sinceMs) lines.push(entry);
    } catch {
      // A torn line (another writer) is not ours to judge.
    }
  }
  return lines;
}

/**
 * Text safe for a public log: the given secrets, any `sk-` key, email, UUID, the payment
 * link's user_id/user_email values and MemTree page ids are replaced.
 */
export function redactText(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret) out = out.split(secret).join("***");
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(user_id|user_email)=[^&\s"']+/g, "$1=***")
    .replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[A-Za-z]{2,}/g, "***@***")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/(\/(?:m|usage\/memtree)\/)[A-Za-z0-9_-]+/g, "$1…");
}

/** Whether a URL `ccc link` printed is on the MemTree server we sent the key to. */
export function isMemtreeUrl(url, baseUrl = PROD_BASE_URL) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** A MemTree page URL with its id hidden, for logs that are public. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/[^/]+$/, "/…")}`;
  } catch {
    return "(not a URL)";
  }
}

/** The first message of a scripted session: unique per run, so its final index is never throttled. */
export function uniqueFirstMessage(nowIso, runId, os) {
  return `MemTree e2e check ${nowIso} run ${runId} on ${os}: please remember the code word "juniper".`;
}

/** One line per journey in first-seen order: overall status, counts, first failure. */
export function journeyLines(results) {
  const lines = [];
  for (const journey of [...new Set(results.map((r) => r.journey))]) {
    const rows = results.filter((r) => r.journey === journey);
    const failed = rows.filter((r) => r.status === FAIL);
    const passed = rows.filter((r) => r.status === PASS).length;
    const skipped = rows.filter((r) => r.status === SKIP).length;
    const status = failed.length ? FAIL : passed ? PASS : SKIP;
    let line = `${status} ${journey}: ${passed}/${rows.length} passed`;
    if (skipped) line += `, ${skipped} skipped`;
    if (failed.length) line += ` (first failure: ${failed[0].name})`;
    lines.push(line);
  }
  return lines;
}

/** Exit code for the whole run: 1 on any failure, a missing phase, or nothing passing. */
export function exitCode(results, expectedPhases, phasesDone) {
  if (results.some((r) => r.status === FAIL)) return 1;
  if (expectedPhases.some((p) => !phasesDone.includes(p))) return 1;
  return results.some((r) => r.status === PASS) ? 0 : 1;
}

/** The GitHub job summary for one OS. */
export function summaryMarkdown(title, results, missingPhases, runUrl) {
  const out = [`## ${title}`, ""];
  out.push(...journeyLines(results).map((l) => `- ${l}`));
  for (const phase of missingPhases) out.push(`- FAIL phase ${phase} did not finish (see its step log)`);
  if (runUrl) out.push("", `Logs and artifacts: ${runUrl}`);
  out.push("", "| status | journey | check | detail |", "|---|---|---|---|");
  for (const r of results) {
    out.push(`| ${r.status} | ${r.journey} | ${r.name} | ${String(r.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  return out.join("\n") + "\n";
}
