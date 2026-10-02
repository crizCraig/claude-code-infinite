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

const usage = (cacheRead, cacheCreation = 0, output = 100) => ({
  input_tokens: 2,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreation },
  output_tokens: output,
});

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
  const big = usage(25_037, 950_000, 1_399);
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
    assert.equal(result.recordedTokens, 2 + 25_037 + 950_000 + 1_399);
    assert.equal(result.loweredTokens, 500_000);
    assert.equal(fs.readFileSync(result.backupPath, "utf-8"), original, "backup is the original");

    const after = readEntries(file);
    for (const index of [2, 3]) {
      const u = after[index].message.usage;
      assert.equal(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 500_000);
      assert.equal(u.cache_creation.ephemeral_1h_input_tokens, 0);
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
    [response("m", "claude-opus-5-5", { ...usage(990_000), output_tokens: "many" })],
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
  const entries = [response("m", "claude-x", usage(185_000))];
  const { file, options, cleanup } = fixture(entries);
  try {
    const result = repairStrandedResume(["-r", SESSION], options);
    assert.equal(result.loweredTokens, 100_000, "a 200k model lowers to half its window");
    assert.equal(readEntries(file)[0].message.usage.input_tokens, 100_000);
  } finally {
    cleanup();
  }
});
