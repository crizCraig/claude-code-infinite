import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FirstTreeMarker, FIRST_TREE_MARKER_FILE } from "../dist/first-tree.js";
import { MemtreeLinkStore } from "../dist/memtree-links.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ccc-first-tree-"));

test("a new user's first tree is first ever, once", () => {
  const dir = tempDir();
  const links = new MemtreeLinkStore(path.join(dir, "memtree-links.json"));
  // The session's own page is already stored by the time its Stop runs.
  links.put("session-1", { url: "https://x/m/1", index: "i", compressed: false });
  const marker = new FirstTreeMarker(links, path.join(dir, FIRST_TREE_MARKER_FILE));
  assert.equal(marker.isFirstEver("session-1"), true);
  marker.markShown("session-1");
  assert.equal(marker.isFirstEver("session-1"), false);
  assert.equal(marker.isFirstEver("session-2"), false);
  const written = JSON.parse(fs.readFileSync(path.join(dir, FIRST_TREE_MARKER_FILE), "utf-8"));
  assert.match(written.shownAt, /^\d{4}-/);
  // A second ccc process reads the same marker.
  assert.equal(new FirstTreeMarker(links, path.join(dir, FIRST_TREE_MARKER_FILE)).isFirstEver("s3"), false);
});

test("a user with pages from other sessions has seen trees before", () => {
  const dir = tempDir();
  const links = new MemtreeLinkStore(path.join(dir, "memtree-links.json"));
  links.put("older-session", { url: "https://x/m/0", index: "i", compressed: true });
  const marker = new FirstTreeMarker(links, path.join(dir, FIRST_TREE_MARKER_FILE));
  assert.equal(marker.isFirstEver("session-1"), false);
});

test("an unwritable config dir never throws", () => {
  const dir = tempDir();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "");
  const marker = new FirstTreeMarker(undefined, path.join(blocker, "sub", FIRST_TREE_MARKER_FILE));
  assert.doesNotThrow(() => marker.markShown("s"));
  assert.equal(typeof marker.isFirstEver("s"), "boolean");
});
