import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_TREES_FOOTER,
  PROJECT_TREES_HEADER,
  ProjectTreesHint,
  formatProjectTrees,
  parseProjectTrees,
  projectIdentity,
  projectTreesHintFor,
} from "../dist/project-trees.js";

const tree = (session, day, title = `Work on ${session}`) => ({
  session_id: session,
  last_at: `2026-10-${day}T12:00:00+00:00`,
  title,
  tree: { request_id: `${session}-req`, ref: `${session}-req-v1-own` },
});

/** A hint over a scripted fetch: `answer(call)` is a body, a status, a promise, or throws. */
function scripted(answer, waitMs = 300) {
  const asked = [];
  const hint = new ProjectTreesHint(async (path) => {
    asked.push(path);
    const a = await answer(asked.length - 1);
    if (typeof a === "number") return { status: a, body: Buffer.from("{}") };
    return { status: 200, body: Buffer.from(JSON.stringify(a)) };
  }, "crizCraig/polychat", waitMs);
  return { hint, asked };
}

test("the block names up to five earlier trees, newest first, without the current session", () => {
  const trees = parseProjectTrees({
    trees: ["s1", "s2", "s3", "s4", "s5", "s6"].map((s, i) => tree(s, 20 - i)),
  });
  const block = formatProjectTrees(trees, "s2");
  const lines = block.split("\n");
  assert.equal(lines[0], PROJECT_TREES_HEADER);
  assert.equal(lines.at(-1), PROJECT_TREES_FOOTER);
  assert.deepEqual(lines.slice(1, -1), [
    "- 2026-10-20: Work on s1 (tree s1-req-v1-own)",
    "- 2026-10-18: Work on s3 (tree s3-req-v1-own)",
    "- 2026-10-17: Work on s4 (tree s4-req-v1-own)",
    "- 2026-10-16: Work on s5 (tree s5-req-v1-own)",
    "- 2026-10-15: Work on s6 (tree s6-req-v1-own)",
  ]);
  // Under ~600 tokens even with five long summaries (~4 chars per token).
  const long = parseProjectTrees({ trees: [1, 2, 3, 4, 5].map((i) => tree(`s${i}`, 10, "w ".repeat(400))) });
  const longBlock = formatProjectTrees(long, undefined);
  assert.ok(longBlock.length < 1_600, longBlock.length);
  assert.ok(longBlock.split("\n").every((line) => line.length < 260), "summaries cut to one short line");
  assert.equal(formatProjectTrees(parseProjectTrees({ trees: [tree("only", 1)] }), "only"), undefined);
  assert.equal(formatProjectTrees([], undefined), undefined);
});

test("malformed answers and entries are dropped", () => {
  assert.equal(parseProjectTrees(null), undefined);
  assert.equal(parseProjectTrees({ trees: "x" }), undefined);
  const parsed = parseProjectTrees({
    trees: [
      tree("ok", 1),
      { ...tree("bad-ref", 1), tree: { ref: "../../etc" } },
      { ...tree("no-title", 1), title: "  " },
      { ...tree("multi", 1), title: "line one\nline two" },
      "junk",
    ],
  });
  assert.deepEqual(parsed.map((t) => t.session_id), ["ok", "multi"]);
  assert.ok(formatProjectTrees(parsed, undefined).includes("line one line two"), "one line each");
});

test("the project is owner/repo when known, else the directory", () => {
  assert.equal(projectIdentity({ git_repo: "o/r", project_dir: "d" }), "o/r");
  assert.equal(projectIdentity({ project_dir: "d" }), "d");
  assert.equal(projectIdentity({}), undefined);
  assert.equal(projectIdentity(undefined), undefined);
});

test("the hint is on only for interactive sessions with search and read_node and a project", () => {
  const fetch = async () => ({ status: 200, body: Buffer.from("{}") });
  const all = ["search", "list", "read_node", "read_lines"];
  const meta = { git_repo: "o/r" };
  assert.ok(projectTreesHintFor(true, all, meta, {}, fetch));
  assert.equal(projectTreesHintFor(false, all, meta, {}, fetch), undefined, "print runs");
  assert.equal(projectTreesHintFor(true, ["search", "list"], meta, {}, fetch), undefined);
  assert.equal(projectTreesHintFor(true, all, {}, {}, fetch), undefined, "no project");
  assert.equal(projectTreesHintFor(true, all, meta, { CCC_PROJECT_TREES: "0" }, fetch), undefined);
});

test("contextFor uses the startup prefetch and asks for one more than it shows", async () => {
  const { hint, asked } = scripted(() => ({ trees: [tree("a", 19), tree("b", 18)] }));
  hint.prefetch();
  hint.prefetch();
  const block = await hint.contextFor("a");
  assert.equal(asked.length >= 1, true);
  const url = new URL(asked[0], "http://x");
  assert.equal(url.pathname, "/v1/memtree/project_trees");
  assert.equal(url.searchParams.get("project"), "crizCraig/polychat");
  assert.equal(url.searchParams.get("limit"), "6");
  assert.ok(block.includes("(tree b-req-v1-own)") && !block.includes("a-req"), block);
});

test("a slow, failed or old server adds nothing and never throws", async () => {
  for (const answer of [() => 404, () => 500, () => { throw new Error("offline"); }, () => ({ trees: [] })]) {
    const { hint } = scripted(answer);
    hint.prefetch();
    assert.equal(await hint.contextFor("s"), undefined);
  }
  let release;
  const { hint } = scripted(() => new Promise((resolve) => { release = resolve; }), 20);
  hint.prefetch();
  const started = Date.now();
  assert.equal(await hint.contextFor("s"), undefined, "does not wait past its bound");
  assert.ok(Date.now() - started < 1_000);
  release({ trees: [tree("late", 3)] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok((await hint.contextFor("s")).includes("late-req"), "a late answer serves the next start");
});

test("disable() stops the block (the session lost its memtree tools)", async () => {
  const { hint, asked } = scripted(() => ({ trees: [tree("a", 1)] }));
  hint.disable();
  hint.prefetch();
  assert.equal(await hint.contextFor("x"), undefined);
  assert.equal(asked.length, 0);
});
