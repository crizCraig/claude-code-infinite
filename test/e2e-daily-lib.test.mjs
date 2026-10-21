import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_MISSING_MESSAGE, FAIL, NO_KEY_MESSAGE, PASS, SKIP, claudeInstallCommand,
  claudeMissingProblems, e2eTarget, exitCode, PROD_BASE_URL, STAGING_BASE_URL, installedVersion, journeyLines, noKeyProblems,
  isMemtreeUrl, parsePrintResult, redactText, redactUrl, versionAtLeast, versionProblems, requestLogLines, summaryMarkdown, uniqueFirstMessage,
} from "../scripts/e2e/lib.mjs";
import { claudeDesktopOnlyText, claudeMissingText } from "../dist/claude-locate.js";

test("e2e: the claude-missing expectation matches what ccc prints on every OS", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const run = { status: 1, stdout: "", stderr: `banner\n${claudeMissingText(platform)}\n` };
    assert.deepEqual(claudeMissingProblems(run, platform), [], platform);
    assert.ok(claudeMissingText(platform).includes(CLAUDE_MISSING_MESSAGE));
    assert.ok(claudeMissingText(platform).includes(claudeInstallCommand(platform)));
    const desktop = { status: 1, stdout: "", stderr: claudeDesktopOnlyText(platform) };
    assert.deepEqual(claudeMissingProblems(desktop, platform), [], `${platform} desktop only`);
  }
  const wrong = claudeMissingProblems({ status: 0, stdout: "x", stderr: "" }, "linux");
  assert.equal(wrong.length, 4);
});

test("e2e: a keyless non-terminal run must not prompt on stdout", () => {
  assert.deepEqual(noKeyProblems({ status: 1, stdout: "", stderr: `${NO_KEY_MESSAGE}\n` }), []);
  const prompted = noKeyProblems({ status: 1, stdout: "Copy your API key and paste it here: ", stderr: NO_KEY_MESSAGE });
  assert.equal(prompted.length, 2);
});

test("e2e: installed version from npm ls", () => {
  assert.equal(installedVersion('{"dependencies":{"claude-code-infinite":{"version":"1.0.27"}}}'), "1.0.27");
  assert.equal(installedVersion("{}"), null);
  assert.equal(installedVersion("not json"), null);
});

test("e2e: -p JSON must be the whole stdout", () => {
  const ok = parsePrintResult('{"type":"result","is_error":false,"result":"OK","session_id":"s1"}');
  assert.deepEqual(ok, { sessionId: "s1", result: "OK", isError: false });
  assert.throws(() => parsePrintResult('banner\n{"type":"result"}'), /not clean JSON/);
  assert.throws(() => parsePrintResult('{"type":"assistant"}'), /type is "assistant"/);
});

test("e2e: request log lines by kind and time", () => {
  const jsonl = [
    '{"ts":"2026-10-20T10:00:00Z","kind":"memtree","ok":true}',
    '{"ts":"2026-10-20T09:00:00Z","kind":"memtree","ok":true}',
    '{"ts":"2026-10-20T10:00:01Z","kind":"messages"}',
    "{torn",
  ].join("\n");
  const lines = requestLogLines(jsonl, "memtree", Date.parse("2026-10-20T09:30:00Z"));
  assert.equal(lines.length, 1);
});

test("e2e: tree URLs are logged without their id", () => {
  assert.equal(redactUrl("https://app.polychat.co/m/AbCdEf123"), "https://app.polychat.co/m/…");
  assert.equal(redactUrl("nope"), "(not a URL)");
});

test("e2e: first messages are unique per run", () => {
  assert.notEqual(uniqueFirstMessage("t1", "1", "linux"), uniqueFirstMessage("t1", "2", "linux"));
});

test("e2e: journey lines, summary and exit code", () => {
  const results = [
    { journey: "install", name: "a", status: PASS },
    { journey: "first-run", name: "b", status: FAIL, detail: "x|y" },
    { journey: "model-turn", name: "c", status: SKIP },
  ];
  assert.deepEqual(journeyLines(results), [
    "PASS install: 1/1 passed",
    "FAIL first-run: 0/1 passed (first failure: b)",
    "SKIP model-turn: 0/1 passed, 1 skipped",
  ]);
  assert.equal(exitCode(results, ["install"], ["install"]), 1);
  const green = [results[0], results[2]];
  assert.equal(exitCode(green, ["install", "turn"], ["install", "turn"]), 0);
  assert.equal(exitCode(green, ["install", "turn"], ["install"]), 1);
  assert.equal(exitCode([results[2]], [], []), 1);
  const md = summaryMarkdown("T", results, ["turn"], "https://x/runs/1");
  assert.ok(md.includes("- FAIL phase turn did not finish"));
  assert.ok(md.includes("| FAIL | first-run | b | x\\|y |"));
});

test("e2e: version comparisons and the --version expectation", () => {
  assert.ok(versionAtLeast("1.0.28", "1.0.28"));
  assert.ok(versionAtLeast("1.1.0", "1.0.28"));
  assert.ok(!versionAtLeast("1.0.27", "1.0.28"));
  const good = { status: 0, stdout: "1.0.28 (Claude Code Infinite)\n2.1.304 (Claude Code)\n", stderr: "" };
  assert.deepEqual(versionProblems(good, "1.0.28"), []);
  const old = { status: 1, stdout: "", stderr: "A MemTree API key is required" };
  assert.equal(versionProblems(old, "1.0.28").length, 4);
});

test("e2e: public log text hides keys, emails, ids and payment link identities", () => {
  const body = "Payment required for e2e-test-a@polychat.co: https://app.polychat.co/payment?" +
    "user_id=0b3c8f1e-1111-2222-3333-444455556666&user_email=e2e-test-a@polychat.co&price_id=p " +
    "key sk-abcdefghijkl and secret123 tree https://app.polychat.co/m/AbCd123";
  const out = redactText(body, ["secret123"]);
  for (const leak of ["e2e-test-a", "0b3c8f1e", "sk-abcdefghijkl", "secret123", "AbCd123"]) {
    assert.ok(!out.includes(leak), `${leak} in ${out}`);
  }
  assert.ok(out.includes("user_id=***") && out.includes("price_id=p"));
});

test("e2e: the key is only sent to the MemTree server's own URLs", () => {
  assert.ok(isMemtreeUrl("https://app.polychat.co/m/x"));
  assert.ok(!isMemtreeUrl("https://evil.example/m/x"));
  assert.ok(!isMemtreeUrl("not a url"));
});

test("e2e: the target picks the server, ccc's mode word, the key's field and the paid check", () => {
  assert.deepEqual(e2eTarget(undefined), e2eTarget("production"));
  assert.deepEqual(e2eTarget(""), e2eTarget("production"));
  const prod = e2eTarget("production");
  assert.equal(prod.baseUrl, PROD_BASE_URL);
  assert.deepEqual(prod.cccArgs, []);
  assert.equal(prod.keyField, "polychatApiKey");
  assert.equal(prod.requirePaid, true);
  const staging = e2eTarget(" staging ");
  assert.equal(staging.baseUrl, STAGING_BASE_URL);
  assert.deepEqual(staging.cccArgs, ["staging"]);
  assert.equal(staging.keyField, "stagingPolychatApiKey");
  assert.equal(staging.requirePaid, false, "staging never 402s, so paid is not checked");
  assert.throws(() => e2eTarget("local"), /unknown E2E_TARGET/);
});
