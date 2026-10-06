import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairStrandedResume, resumeSessionId } from "../dist/resume-repair.js";

const SESSION = "e32c1f3e-f811-468a-8d31-e4967cbf1219";

function response(id, model, usage, text = "ok") {
  return {
    type: "assistant",
    message: { id, model, role: "assistant", content: [{ type: "text", text }], usage },
  };
}

const buckets = (cacheRead, cacheCreation, output) => ({
  input_tokens: 2,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreation },
  output_tokens: output,
});

/** Claude Code 2.1.287's shape: the top-level totals plus per-iteration usage. */
const usage = (cacheRead, cacheCreation = 0, output = 100) => ({
  ...buckets(cacheRead, cacheCreation, output),
  iterations: [{ ...buckets(cacheRead, cacheCreation, output), type: "message" }],
});

/** Context as Claude Code counts it: the last message iteration when present. */
function countedTokens(u) {
  const last = u.iterations?.findLast((i) => i.type === "message") ?? u;
  return last.input_tokens + last.cache_read_input_tokens +
    last.cache_creation_input_tokens + last.output_tokens;
}

/** A projects dir holding one session transcript; returns paths and a cleanup. */
function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-resume-"));
  const projectsDir = path.join(root, "projects");
  const project = path.join(projectsDir, "-Users-me-src-app");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const options = {
    nativeOneMillionContext: true,
    claudeVersion: "2.1.288",
    isQuiescent: () => true,
    projectsDir,
    backupDir: path.join(root, "backups"),
    now: new Date("2026-10-02T18:30:00Z"),
  };
  return { file, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const readEntries = (file) =>
  fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("resumeSessionId reads --resume <id>, --resume=<id> and -r <id> only", () => {
  assert.equal(resumeSessionId(["--resume", SESSION]), SESSION);
  assert.equal(resumeSessionId([`--resume=${SESSION}`]), SESSION);
  assert.equal(resumeSessionId(["--model", "opus", "-r", SESSION]), SESSION);
  assert.equal(resumeSessionId(["--resume"]), undefined, "the picker form has no id");
  assert.equal(resumeSessionId(["--resume", "--model"]), undefined);
  assert.equal(resumeSessionId(["--resume", "../x"]), undefined, "ids name files");
  assert.equal(resumeSessionId(["--", "--resume", SESSION]), undefined);
  assert.equal(resumeSessionId(["--continue"]), undefined);
});

test("a session stranded past the window is lowered to half of it, with a backup", () => {
  // The 2026-10-02 shape: one response split over entries sharing its id,
  // then Claude Code's synthetic "context limit" message.
  const big = usage(26_037, 950_000, 1_399);
  const entries = [
    { type: "user", message: { role: "user", content: "hi" } },
    response("msg_old", "claude-opus-5-5", usage(400_000)),
    response("msg_last", "claude-opus-5-5", big, "part one"),
    response("msg_last", "claude-opus-5-5", big, "part two"),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } },
    response("msg_synth", "<synthetic>", usage(0, 0, 0)),
  ];
  const { file, options, cleanup } = fixture(entries);
  const original = fs.readFileSync(file, "utf-8");
  try {
    const result = repairStrandedResume(["--resume", SESSION], options);
    assert.equal(result.recordedTokens, 2 + 26_037 + 950_000 + 1_399);
    assert.equal(result.loweredTokens, 500_000);
    assert.equal(fs.readFileSync(result.backupPath, "utf-8"), original, "backup is the original");

    const after = readEntries(file);
    for (const index of [2, 3]) {
      const u = after[index].message.usage;
      assert.equal(countedTokens(u), 500_000 + 1_399, "Claude Code counts the lowered size");
      assert.equal(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 500_000);
      assert.equal(u.cache_creation.ephemeral_1h_input_tokens, 0);
      assert.equal(u.iterations[0].cache_creation.ephemeral_1h_input_tokens, 0);
      assert.equal(u.output_tokens, 1_399);
      assert.equal(after[index].message.content[0].text, entries[index].message.content[0].text);
    }
    for (const index of [0, 1, 4, 5]) assert.deepEqual(after[index], entries[index]);
  } finally {
    cleanup();
  }
});

test("a session that still fits, an unknown shape, or a missing transcript is left alone", () => {
  const cases = [
    [response("m", "claude-opus-5-5", usage(600_000))],
    [response("m", "claude-opus-5-5", {
      ...usage(990_000),
      iterations: [{ ...buckets(990_000, 0, 100), output_tokens: "many", type: "message" }],
    })],
  ];
  for (const entries of cases) {
    const { file, options, cleanup } = fixture(entries);
    const original = fs.readFileSync(file, "utf-8");
    try {
      assert.equal(repairStrandedResume(["--resume", SESSION], options), undefined);
      assert.equal(fs.readFileSync(file, "utf-8"), original);
      assert.equal(fs.existsSync(options.backupDir), false, "no backup without a change");
    } finally {
      cleanup();
    }
  }
  const { options, cleanup } = fixture([]);
  try {
    const other = "00000000-0000-0000-0000-000000000000";
    assert.equal(repairStrandedResume(["--resume", other], options), undefined);
  } finally {
    cleanup();
  }
});

test("the stranded size follows the model's window, not a fixed number", () => {
  const entries = [response("m", "claude-sonnet-4-5", usage(185_000))];
  const { file, options, cleanup } = fixture(entries);
  try {
    options.nativeOneMillionContext = false;
    const result = repairStrandedResume(["-r", SESSION], options);
    assert.equal(result.loweredTokens, 100_000, "a 200k model lowers to half its window");
    assert.equal(readEntries(file)[0].message.usage.input_tokens, 100_000);
  } finally {
    cleanup();
  }
});

test("a usage whose last iteration still records the stranded size is lowered too", () => {
  // The state an earlier repair left: top-level totals lowered, the iteration
  // Claude Code actually counts still at 977k.
  const u = usage(971_850, 5_933, 1_399);
  Object.assign(u, { input_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const { file, options, cleanup } = fixture([response("m", "claude-opus-5-5", u)]);
  try {
    const result = repairStrandedResume(["--resume", SESSION], options);
    assert.equal(result.recordedTokens, 2 + 971_850 + 5_933 + 1_399);
    assert.equal(countedTokens(readEntries(file)[0].message.usage), 500_000 + 1_399);
  } finally {
    cleanup();
  }
});

test("fitting sessions and uncertain transcript shapes are never repaired", () => {
  const variants = [
    usage(950_000),
    { ...usage(990_000), iterations: [{ ...buckets(990_000, 0, 100), type: "future_message" }] },
    { ...usage(990_000), iterations: [] },
    { ...usage(990_000), input_tokens: -1 },
  ];
  for (const u of variants) {
    const f = fixture([response("m", "claude-opus-5-5", u)]);
    try {
      const before = fs.readFileSync(f.file);
      assert.equal(repairStrandedResume(["-r", SESSION], f.options), undefined);
      assert.deepEqual(fs.readFileSync(f.file), before);
    } finally { f.cleanup(); }
  }
});

test("repair lowers only totals and the counted iteration and is idempotent", () => {
  const u = usage(990_000);
  const earlier = { ...buckets(700_000, 0, 10), type: "message" };
  const advisor = { ...buckets(400_000, 0, 10), type: "advisor_message" };
  u.iterations.unshift(earlier);
  u.iterations.push(advisor);
  const f = fixture([response("m", "claude-opus-5-5", u)]);
  try {
    const result = repairStrandedResume(["-r", SESSION], f.options);
    assert.ok(result);
    const after = readEntries(f.file)[0].message.usage;
    assert.deepEqual(after.iterations[0], earlier);
    assert.deepEqual(after.iterations[2], advisor);
    const repaired = fs.readFileSync(f.file);
    assert.equal(repairStrandedResume(["-r", SESSION], f.options), undefined);
    assert.deepEqual(fs.readFileSync(f.file), repaired);
  } finally { f.cleanup(); }
});

test("concurrent writers, changed snapshots and backup collisions skip without throwing", () => {
  for (const mode of ["writer", "snapshot", "backup", "lock", "partial", "version", "unknown-last"]) {
    const f = fixture([response("m", "claude-opus-5-5", usage(990_000))]);
    const realOpen = fs.openSync;
    let calls = 0;
    let collision;
    try {
      if (mode === "writer") f.options.isQuiescent = () => false;
      if (mode === "snapshot") f.options.isQuiescent = () => {
        if (++calls === 2) fs.appendFileSync(f.file, '{"type":"user"}\n');
        return true;
      };
      if (mode === "lock") fs.writeFileSync(`${f.file}.ccc-repair.lock`, "occupied");
      if (mode === "partial") fs.appendFileSync(f.file, '{"type":');
      if (mode === "version") fs.appendFileSync(f.file, JSON.stringify(response("new", "claude-future", usage(2_000_000))) + "\n");
      if (mode === "unknown-last") fs.appendFileSync(f.file, '{"type":"assistant","message":{"id":"new"}}\n');
      if (mode === "backup") fs.openSync = (name, flags, ...rest) => {
        if (String(name).startsWith(f.options.backupDir)) {
          collision = name;
          fs.writeFileSync(name, "existing backup");
          assert.equal(flags, "wx", "backup creation must be exclusive");
        }
        return realOpen(name, flags, ...rest);
      };
      const before = fs.readFileSync(f.file, "utf8");
      assert.equal(repairStrandedResume(["-r", SESSION], f.options), undefined, mode);
      assert.equal(fs.readFileSync(f.file, "utf8"), mode === "snapshot" ? before + '{"type":"user"}\n' : before, mode);
      if (collision) assert.equal(fs.readFileSync(collision, "utf8"), "existing backup");
    } finally { fs.openSync = realOpen; f.cleanup(); }
  }
});

test("exact installed refusal limit and conservative unknown-version threshold", () => {
  for (const [version, count, shouldRepair] of [
    ["2.1.288", 976_999, false], ["2.1.288", 977_000, true],
    ["future", 990_000, false], ["future", 1_000_000, true],
  ]) {
    const f = fixture([response("m", "claude-opus-5-5", usage(count - 102))]);
    f.options.claudeVersion = version;
    try {
      assert.equal(Boolean(repairStrandedResume(["-r", SESSION], f.options)), shouldRepair);
    } finally { f.cleanup(); }
  }
});

test("a writer after the exclusive backup was made prevents replacement", () => {
  const f = fixture([response("m", "claude-opus-5-5", usage(990_000))]);
  const original = fs.readFileSync(f.file, "utf8");
  let checks = 0;
  f.options.isQuiescent = () => {
    if (++checks === 3) {
      const backups = fs.readdirSync(f.options.backupDir);
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(f.options.backupDir, backups[0]), "utf8"), original);
      fs.appendFileSync(f.file, '{"type":"user"}\n');
    }
    return true;
  };
  try {
    assert.equal(repairStrandedResume(["-r", SESSION], f.options), undefined);
    assert.equal(fs.readFileSync(f.file, "utf8"), original + '{"type":"user"}\n');
    assert.equal(fs.existsSync(`${f.file}.ccc-repair.lock`), false);
    assert.equal(fs.readdirSync(path.dirname(f.file)).some(n => n.endsWith(".tmp")), false);
  } finally { f.cleanup(); }
});

test("successful input beyond an inferred window is never rewritten", () => {
  for (const [model, count, native] of [
    ["claude-sonnet-4-5", 300_000, false],
    ["claude-opus-5-5", 1_010_000, true],
  ]) {
    const f = fixture([response("m", model, usage(count))]);
    f.options.nativeOneMillionContext = native;
    try {
      const original = fs.readFileSync(f.file);
      assert.equal(repairStrandedResume(["-r", SESSION], f.options), undefined);
      assert.deepEqual(fs.readFileSync(f.file), original);
      assert.equal(fs.existsSync(f.options.backupDir), false);
    } finally { f.cleanup(); }
  }
});

test("transcript 1M signals and model overrides prevent a false 200k repair", () => {
  for (const [earlierModel, args] of [
    ["claude-sonnet-4-5[1m]", []],
    ["claude-sonnet-4-5", ["--model", "claude-sonnet-4-5[1m]"]],
    ["claude-sonnet-4-5", ["--model=claude-opus-5-5"]],
    ["claude-sonnet-4-5", ["--model", "opus"]],
    ["claude-sonnet-4-5", ["--model", "unknown-model"]],
  ]) {
    const f = fixture([
      response("earlier", earlierModel, usage(100_000)),
      response("m", "claude-sonnet-4-5", usage(185_000)),
    ]);
    try {
      const original = fs.readFileSync(f.file);
      assert.equal(repairStrandedResume(["-r", SESSION, ...args], f.options), undefined);
      assert.deepEqual(fs.readFileSync(f.file), original);
    } finally { f.cleanup(); }
  }
});

test("known extended windows repair only at their actual threshold", () => {
  for (const [model, earlierModel, args, count, expected] of [
    ["claude-opus-5-5", "claude-opus-5-5", [], 300_000, undefined],
    ["claude-sonnet-4-5", "claude-sonnet-4-5[1m]", [], 990_000, 500_000],
    ["claude-sonnet-4-5", "claude-sonnet-4-5", ["--model=claude-sonnet-4-5[1m]"], 990_000, 500_000],
  ]) {
    const f = fixture([
      response("earlier", earlierModel, usage(100_000)), response("m", model, usage(count)),
    ]);
    try {
      assert.equal(repairStrandedResume(["-r", SESSION, ...args], f.options)?.loweredTokens, expected);
    } finally { f.cleanup(); }
  }
});

test("the environment's model override is respected and unknown values skip", () => {
  const previous = process.env.ANTHROPIC_MODEL;
  for (const model of ["claude-sonnet-4-5[1m]", "opus", "unknown-model"]) {
    const f = fixture([response("m", "claude-sonnet-4-5", usage(185_000))]);
    try {
      process.env.ANTHROPIC_MODEL = model;
      const original = fs.readFileSync(f.file);
      assert.equal(repairStrandedResume(["-r", SESSION], f.options), undefined);
      assert.deepEqual(fs.readFileSync(f.file), original);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previous;
      f.cleanup();
    }
  }
});
