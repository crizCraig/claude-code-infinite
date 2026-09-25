import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemtreeLinkStore } from "../dist/memtree-links.js";

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccc-links-")), "links.json");

test("store keeps the newest page per session, bounded, and survives a new process", () => {
  const file = tmpFile();
  const store = new MemtreeLinkStore(file, 2);
  assert.equal(store.get("s1"), undefined);
  store.put("s1", { url: "https://x/m/1", index: "i1", compressed: false });
  store.put("s1", { url: "https://x/m/2", index: "i2", compressed: true });
  assert.equal(new MemtreeLinkStore(file, 2).get("s1").url, "https://x/m/2");
  store.put("s2", { url: "https://x/m/3", index: "i3", compressed: true });
  store.put("s3", { url: "https://x/m/4", index: "i4", compressed: true });
  const reread = new MemtreeLinkStore(file, 2);
  assert.equal(reread.get("s3").index, "i4");
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8"))).length, 2);
});

test("store shrugs off a corrupt or hostile file", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  const store = new MemtreeLinkStore(file);
  assert.equal(store.get("s1"), undefined);
  fs.writeFileSync(file, JSON.stringify({ s1: { url: "javascript:alert(1)", index: "i", compressed: true, updatedAt: "x" } }));
  assert.equal(store.get("s1"), undefined, "only http(s) links come back");
  store.put("s2", { url: "https://x/m/1", index: "i", compressed: true });
  assert.equal(store.get("s2").url, "https://x/m/1");
});
