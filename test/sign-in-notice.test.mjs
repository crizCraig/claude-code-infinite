// What ccc says about Claude Code's sign-in before Claude Code starts (sign-in-notice.ts),
// and the diagnostics that show whether users then signed in.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import {
  NOT_SIGNED_IN_LINES,
  SIGN_IN_STATE_FILE,
  SIGN_IN_WARNING_KINDS,
  SignInTracker,
  apiBillingText,
  presentSignInNotice,
  readSignInState,
  signInNotice,
  waitForEnter,
} from "../dist/sign-in-notice.js";
import { SIGN_IN_WARNING_KINDS as SCHEMA_KINDS, sanitizeEvent } from "../dist/diagnostics-schema.js";

const ok = (auth, plan = "unknown", extra = {}) =>
  ({ result: "ok", ms: 90, status: { auth, plan, console: false, ...extra } });
const failed = { result: "timeout", ms: 5000 };
const noFallback = { auth: "unknown", plan: "unknown" };
const input = (probe, extra = {}) => ({
  probe, fallback: noFallback, creditRefused: false, override: undefined, color: false, ...extra,
});

test("the agreed not-signed-in text", () => {
  assert.deepEqual([...NOT_SIGNED_IN_LINES], [
    "Claude Code isn't signed in to a Claude plan yet. ccc needs Claude Pro or Max.",
    "  - Have one? Choose \"Claude account with subscription\" when Claude Code asks, or run /login.",
    "  - Don't have one? Get Pro at https://claude.ai/upgrade, then run /login.",
    "Your MemTree credit covers MemTree, not Claude itself.",
  ]);
  for (const line of NOT_SIGNED_IN_LINES) assert.ok(line.length <= 100, line);
});

test("not signed in (Claude Code says so): the full message, held until Enter", () => {
  const notice = signInNotice(input(ok("none")));
  assert.equal(notice.kind, "not_signed_in");
  assert.equal(notice.pause, true);
  assert.deepEqual(notice.lines, [...NOT_SIGNED_IN_LINES]);
  // Even with a stale subscription sighting or a login the files still name.
  const stale = signInNotice(input(ok("none"), { fallback: { auth: "subscription",
    plan: "max", seen: "subscription", subscriptionLogin: true } }));
  assert.equal(stale.kind, "not_signed_in");
});

test("a Claude plan: nothing to say", () => {
  for (const plan of ["pro", "max", "max_20x", "team", "enterprise", "unknown"]) {
    assert.equal(signInNotice(input(ok("subscription", plan))), undefined, plan);
  }
  for (const cloud of ["bedrock", "vertex", "foundry"]) {
    assert.equal(signInNotice(input(ok(cloud), { creditRefused: true })), undefined, cloud);
  }
});

test("API billing is said without blocking, and repeated inside Claude Code", () => {
  const consoleLogin = signInNotice(input(ok("api_key", "unknown", { console: true })));
  assert.equal(consoleLogin.kind, "api_billing");
  assert.equal(consoleLogin.pause, false);
  assert.match(consoleLogin.lines[0], /Anthropic Console account.*per token.*MemTree credit.*\/login/);
  assert.equal(consoleLogin.sessionLine, consoleLogin.lines[0]);
  const envKey = signInNotice(input(ok("api_key", "unknown", { keySource: "ANTHROPIC_API_KEY" })));
  assert.match(envKey.lines[0], /^ANTHROPIC_API_KEY is set, so Claude bills that API key.*unset it/);
  // The key is new: Claude Code asks first, and No is the way to a plan.
  const asks = signInNotice(input(ok("api_key", "unknown", { keySource: "ANTHROPIC_API_KEY" }),
    { override: { source: "ANTHROPIC_API_KEY", asks: true } }));
  assert.match(asks.lines[0], /if Claude Code asks whether to use it, Yes bills.*answer No/);
  assert.match(apiBillingText("apiKeyHelper", false), /remove apiKeyHelper from settings\.json/);
  // A free Claude account bills like an API account.
  const free = signInNotice(input(ok("subscription", "free")));
  assert.equal(free.kind, "api_billing");
  assert.match(free.lines[0], /Claude account without Pro or Max.*claude\.ai\/upgrade/);
  assert.doesNotMatch(free.lines[0], /Console/);
});

test("a key that beats a Claude login on file gets the override line, not API billing", () => {
  const notice = signInNotice(input(ok("api_key", "unknown", { keySource: "ANTHROPIC_AUTH_TOKEN" }),
    { override: { source: "ANTHROPIC_AUTH_TOKEN", asks: false },
      fallback: { auth: "api_key", plan: "unknown", subscriptionLogin: true } }));
  assert.equal(notice.kind, "key_override");
  assert.match(notice.lines[0], /^ANTHROPIC_AUTH_TOKEN is set, so Claude Code bills that API key/);
});

test("an earlier credit refusal is repeated unless a paid plan shows now", () => {
  const reminded = signInNotice(input(ok("subscription", "unknown"), { creditRefused: true }));
  assert.equal(reminded.kind, "credit_reminder");
  assert.match(reminded.lines[0], /^Last time, Anthropic refused.*MemTree credit covers MemTree/);
  assert.equal(signInNotice(input(ok("subscription", "max"), { creditRefused: true })), undefined);
  // Signed out since: the sign-in message is the one that helps.
  assert.equal(signInNotice(input(ok("none"), { creditRefused: true })).kind, "not_signed_in");
  const named = signInNotice(input(ok("api_key"), { creditRefused: true,
    override: { source: "ANTHROPIC_AUTH_TOKEN", asks: false } }));
  assert.match(named.lines[0], /ANTHROPIC_AUTH_TOKEN is set, and it beats \/login/);
});

test("Claude Code could not be asked: the config files decide, and nothing blocks", () => {
  const unknown = signInNotice(input(failed));
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.pause, false);
  assert.deepEqual(unknown.lines, [...NOT_SIGNED_IN_LINES]);
  assert.equal(signInNotice(input(failed, { fallback: { auth: "subscription", plan: "unknown" } })),
    undefined);
  assert.equal(signInNotice(input(failed, { fallback: { auth: "api_key", plan: "unknown" } })).kind,
    "api_billing");
  assert.equal(signInNotice(input(failed, { fallback: { auth: "unknown", plan: "unknown",
    seen: "subscription" } })), undefined);
  // An answer ccc doesn't know falls back the same way.
  assert.equal(signInNotice(input(ok("unknown"))).kind, "unknown");
});

test("colour wraps each line", () => {
  const notice = signInNotice(input(ok("none"), { color: true }));
  for (const line of notice.lines) assert.match(line, /^\x1b\[33m.*\x1b\[39m$/);
});

test("Enter continues; Ctrl+C or closed input quits; the wait is timed", async () => {
  let t = 1000;
  const now = () => t;
  const stdin = new PassThrough();
  const out = new PassThrough();
  let shown = "";
  out.on("data", (c) => { shown += c; });
  const waiting = waitForEnter(stdin, out, now);
  t = 4500;
  stdin.write("\n");
  assert.deepEqual(await waiting, { ms: 3500, quit: false });
  assert.match(shown, /Press Enter to continue to Claude Code\./);
  const closed = new PassThrough();
  const quitting = waitForEnter(closed, new PassThrough(), now);
  closed.end();
  assert.equal((await quitting).quit, true);
});

test("presenting: printed to stderr, waited for only when interactive, recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-present-"));
  const events = [];
  const record = (name, fields) => events.push({ name, ...fields });
  const tracker = new SignInTracker(dir, () => {});
  const notice = signInNotice(input(ok("none")));
  let waits = 0;
  const wait = async () => { waits++; return { ms: 1234, quit: false }; };
  const write = process.stderr.write;
  let err = "";
  process.stderr.write = (c) => { err += c; return true; };
  try {
    assert.equal(await presentSignInNotice(notice,
      { interactive: true, auth: "none", record, tracker, wait }), true);
    assert.equal(await presentSignInNotice(notice,
      { interactive: false, auth: "none", record, tracker, wait }), true);
    assert.equal(await presentSignInNotice(notice, { interactive: true, auth: "none", record,
      tracker, wait: async () => ({ ms: 5, quit: true }) }), false);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(waits, 1);
  assert.equal(err, `${NOT_SIGNED_IN_LINES.join("\n")}\n`.repeat(3));
  assert.deepEqual(events, [
    { name: "no_plan_warning", auth: "none", kind: "not_signed_in", waited_ms: 1234 },
    { name: "no_plan_warning", auth: "none", kind: "not_signed_in" },
    { name: "no_plan_warning", auth: "none", kind: "not_signed_in", waited_ms: 5 },
  ]);
});

test("print mode: the message goes to stderr, stdout stays Claude Code's", () => {
  const script = [
    "import { signInNotice, printSignInNotice } from './dist/sign-in-notice.js';",
    "const probe = { result: 'ok', ms: 1, status: { auth: 'none', plan: 'unknown', console: false } };",
    "printSignInNotice(signInNotice({ probe, fallback: { auth: 'unknown', plan: 'unknown' },",
    "  creditRefused: false, override: undefined, color: false }));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", cwd: new URL("..", import.meta.url),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `${NOT_SIGNED_IN_LINES.join("\n")}\n`);
});

test("signed in at a later launch: reported once, with the time since the warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-signin-"));
  let t = 1_000_000;
  const now = () => t;
  const events = [];
  const first = new SignInTracker(dir, (e) => events.push(e), now);
  first.started("none");
  first.warned();
  assert.deepEqual(readSignInState(dir), { auth: "none", warnedAt: 1_000_000 });
  t += 60_000;
  const second = new SignInTracker(dir, (e) => events.push(e), now);
  second.started("none"); // still not signed in: the warning time is kept
  assert.deepEqual(readSignInState(dir), { auth: "none", warnedAt: 1_000_000 });
  t += 120_000;
  const third = new SignInTracker(dir, (e) => events.push(e), now);
  third.started("subscription");
  assert.deepEqual(events, [
    { from: "none", auth: "subscription", where: "between_starts", since_warning_ms: 180_000 },
  ]);
  assert.deepEqual(readSignInState(dir), { auth: "subscription" });
  new SignInTracker(dir, (e) => events.push(e), now).started("subscription");
  assert.equal(events.length, 1, "a subscriber's later launches report nothing");
});

test("signed in during the session: the first request's sign-in reports it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-signin-mid-"));
  let t = 5_000;
  const events = [];
  const tracker = new SignInTracker(dir, (e) => events.push(e), () => t);
  tracker.started("none");
  tracker.warned();
  t = 65_000;
  assert.equal(tracker.sinceWarningMs(), 60_000);
  tracker.requestAuth("subscription");
  tracker.requestAuth("subscription");
  tracker.requestAuth("api_key");
  assert.deepEqual(events, [
    { from: "none", auth: "subscription", where: "mid_session", since_warning_ms: 60_000 },
  ]);
  // A Console sign-in mid-session is reported too (from none), by its request's auth.
  const dir2 = mkdtempSync(join(tmpdir(), "ccc-signin-mid2-"));
  const events2 = [];
  const t2 = new SignInTracker(dir2, (e) => events2.push(e), () => 0);
  t2.started("none");
  t2.requestAuth("api_key");
  assert.deepEqual(events2, [{ from: "none", auth: "api_key", where: "mid_session" }]);
  // No warning this launch: nothing to time.
  assert.equal(new SignInTracker(mkdtempSync(join(tmpdir(), "x-")), () => {}).sinceWarningMs(),
    undefined);
});

test("from unknown (Claude Code couldn't be asked) nothing is reported; warnedAt survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-signin-unknown-"));
  let t = 1000;
  const events = [];
  const a = new SignInTracker(dir, (e) => events.push(e), () => t);
  a.warned(); // no probe answer: state "unknown"
  a.requestAuth("subscription");
  assert.deepEqual(events, [], "a subscriber whose probe failed did not just sign in");
  const dir2 = mkdtempSync(join(tmpdir(), "ccc-signin-keep-"));
  const b = new SignInTracker(dir2, (e) => events.push(e), () => t);
  b.started("none");
  b.warned();
  b.requestAuth("api_key"); // reported (from none), and the warning time is kept
  assert.equal(readSignInState(dir2).warnedAt, 1000);
  t = 9000;
  new SignInTracker(dir2, (e) => events.push(e), () => t).started("subscription");
  // A new process: the later switch from API billing to a plan is its own report, timed.
  assert.deepEqual(events.map((e) => [e.where, e.from, e.since_warning_ms]),
    [["mid_session", "none", 0], ["between_starts", "api_key", 8000]]);
  assert.equal(readSignInState(dir2).warnedAt, undefined);
});

test("a key that beats a plan login is printed but not recorded as a sign-in warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-override-"));
  const events = [];
  const notice = signInNotice(input(ok("api_key", "unknown", { keySource: "ANTHROPIC_AUTH_TOKEN" }),
    { override: { source: "ANTHROPIC_AUTH_TOKEN", asks: false },
      fallback: { auth: "api_key", plan: "unknown", subscriptionLogin: true } }));
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await presentSignInNotice(notice, { interactive: true, auth: "api_key",
      record: (n) => events.push(n), tracker: new SignInTracker(dir, () => {}) }), true);
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(events, []);
  assert.equal(readSignInState(dir), undefined);
});

test("the state file holds a type name and a time only, and bad files are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-signin-file-"));
  const tracker = new SignInTracker(dir, () => {}, () => 42);
  tracker.started("api_key");
  tracker.warned();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, SIGN_IN_STATE_FILE), "utf8")),
    { auth: "api_key", warnedAt: 42 });
  writeFileSync(join(dir, SIGN_IN_STATE_FILE), "not json");
  assert.equal(readSignInState(dir), undefined);
  writeFileSync(join(dir, SIGN_IN_STATE_FILE), '{"auth":"sk-ant-oat01-x"}');
  assert.equal(readSignInState(dir), undefined);
  new SignInTracker(join(dir, "no", "such"), () => {}).started("none"); // never throws
});

test("diagnostics: the new events keep only their allowlisted values", () => {
  assert.deepEqual([...SCHEMA_KINDS], [...SIGN_IN_WARNING_KINDS]);
  assert.deepEqual(sanitizeEvent("claude_auth_probe", { result: "timeout", ms: 5000 }, 1),
    { name: "claude_auth_probe", t: 1, result: "timeout", ms: 5000 });
  assert.deepEqual(sanitizeEvent("claude_auth_probe", { result: "ada@example.com" }, 1),
    { name: "claude_auth_probe", t: 1 });
  assert.deepEqual(sanitizeEvent("sign_in_completed", { from: "none", auth: "subscription",
    where: "mid_session", since_warning_ms: 60_000, email: "ada@example.com" }, 1),
  { name: "sign_in_completed", t: 1, from: "none", auth: "subscription", where: "mid_session",
    since_warning_ms: 60_000 });
  assert.deepEqual(sanitizeEvent("first_request", { status: 200, since_warning_ms: 9000 }, 1),
    { name: "first_request", t: 1, status: 200, since_warning_ms: 9000 });
});
