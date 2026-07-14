// Cross-turn incremental prefix hashing: carry the sha256 state between turns
// so each turn pays canonical-serialization cost only for newly appended
// messages. Verification of "history didn't change under us" uses native
// JSON.stringify keys per preprocessed message: equal raw key => equal
// canonical bytes; any mismatch => full recompute (compaction, /resume edits).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { preprocessForHash, pyDumps, serverHashSequence } from "./hash_parity.mjs";

class IncrementalPrefixHasher {
  constructor() {
    this.rawKeys = [];      // JSON.stringify(preprocessed msg i) — compare keys
    this.state = null;      // sha256 state after consuming msgs 0..n-1 (no ']')
    this.prefixHashes = []; // prefixHashes[i] = hash of prefix 0..i
    this.stats = {};
  }

  // Returns hash_sequence (longest prefix first), same as serverHashSequence.
  update(messages) {
    let t = process.hrtime.bigint();
    const forHash = preprocessForHash(messages);
    const tPre = process.hrtime.bigint();

    const rawKeys = forHash.map((m) => JSON.stringify(m));
    let k = 0;
    const nCached = this.rawKeys.length;
    while (k < Math.min(rawKeys.length, nCached) && rawKeys[k] === this.rawKeys[k]) k++;
    const tCmp = process.hrtime.bigint();

    if (k < nCached) {
      // History rewritten before the cached frontier — start over.
      this.state = null;
      this.prefixHashes = [];
      k = 0;
    }
    if (this.state === null) {
      this.state = createHash("sha256").update("[");
    }
    for (let i = k; i < forHash.length; i++) {
      if (i) this.state.update(",");
      this.state.update(Buffer.from(pyDumps(forHash[i]), "utf-8"));
      const fork = this.state.copy();
      fork.update("]");
      this.prefixHashes[i] = fork.digest("hex");
    }
    this.prefixHashes.length = forHash.length;
    this.rawKeys = rawKeys;
    const tEnd = process.hrtime.bigint();

    this.stats = {
      resumedAt: k,
      hashed: forHash.length - k,
      preprocessMs: Number(tPre - t) / 1e6,
      compareMs: Number(tCmp - tPre) / 1e6,
      hashMs: Number(tEnd - tCmp) / 1e6,
      totalMs: Number(tEnd - t) / 1e6,
    };
    return [...this.prefixHashes].reverse();
  }
}

const { stored_hash, messages } = JSON.parse(
  readFileSync(new URL("./real_convo.json", import.meta.url), "utf-8")
);
const all = JSON.parse(JSON.stringify(messages)); // client-style round-trip

const hasher = new IncrementalPrefixHasher();
const fmt = (s) =>
  `resume@${s.resumedAt} (+${s.hashed} msgs)  pre=${s.preprocessMs.toFixed(1)}ms ` +
  `cmp=${s.compareMs.toFixed(1)}ms hash=${s.hashMs.toFixed(1)}ms  total=${s.totalMs.toFixed(1)}ms`;

// Turn 1 (cold): first 179 messages
hasher.update(all.slice(0, 179));
console.log(`turn 1 cold  : ${fmt(hasher.stats)}`);

// Turns 2-3: two messages appended each turn (typical tool loop)
hasher.update(all.slice(0, 181));
console.log(`turn 2 warm  : ${fmt(hasher.stats)}`);
const seq = hasher.update(all);
console.log(`turn 3 warm  : ${fmt(hasher.stats)}`);

// History rewritten (simulate /compact): drop a middle message
const rewritten = [...all.slice(0, 50), ...all.slice(51)];
hasher.update(rewritten);
console.log(`rewrite turn : ${fmt(hasher.stats)}  <- full recompute, as intended`);

// Correctness: warm result must equal one-shot replica AND the stored DB hash
const oneShot = serverHashSequence(all);
const seqOk = seq.length === oneShot.length && seq.every((h, i) => h === oneShot[i]);
console.log(`matches one-shot replica: ${seqOk}`);
console.log(`matches stored staging hash: ${seq[0] === stored_hash}`);
