// The per-session CA for HTTPS-proxy mode (src/mitm-ca.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import tls from "node:tls";
import { createSessionCa, writeCaBundle } from "../dist/mitm-ca.js";

test("the leaf is for api.anthropic.com, signed by a CA constrained to it", () => {
  for (const alg of ["ec", "rsa"]) {
    const ca = createSessionCa("api.anthropic.com", alg);
    const caCert = new X509Certificate(ca.caCertPem);
    const leaf = new X509Certificate(ca.leafCertPem);
    assert.ok(caCert.ca, alg);
    assert.ok(!leaf.ca, alg);
    assert.ok(leaf.checkIssued(caCert) && leaf.verify(caCert.publicKey), alg);
    assert.equal(leaf.checkHost("api.anthropic.com"), "api.anthropic.com", alg);
    assert.equal(leaf.checkHost("example.com"), undefined, alg);
  }
});

test("TLS accepts the leaf for api.anthropic.com and rejects one the CA may not issue", async () => {
  assert.equal(await handshake(createSessionCa(), "api.anthropic.com"), true);
  assert.equal(await handshake(createSessionCa("api.anthropic.com", "ec", "example.com"), "example.com"),
    false);
});

test("the CA can't vouch for a subdomain of api.anthropic.com", async () => {
  const ca = createSessionCa("api.anthropic.com", "ec", "child.api.anthropic.com");
  assert.equal(await handshake(ca, "child.api.anthropic.com"), false);
});

test("the CA can't vouch for an IP address either (excluded subtrees)", async () => {
  const ca = createSessionCa("api.anthropic.com", "ec", "127.0.0.1");
  assert.equal(new X509Certificate(ca.leafCertPem).checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(await handshake(ca, undefined), false);
});

test("the bundle keeps the user's extra CAs, is owner-only, and is removed on cleanup", () => {
  const ca = createSessionCa();
  const userPem = createSessionCa().caCertPem;
  const files = writeCaBundle(ca, userPem);
  const text = readFileSync(files.bundlePath, "utf8");
  assert.ok(text.startsWith(userPem.trim()) && text.includes(ca.caCertPem.trim()));
  assert.ok(!text.includes("PRIVATE KEY"));
  if (process.platform !== "win32") assert.equal(statSync(files.bundlePath).mode & 0o077, 0);
  files.cleanup();
  assert.equal(existsSync(files.dir), false);
});

function handshake(ca, servername) {
  return new Promise((resolve) => {
    const server = tls.createServer({ cert: ca.leafCertPem, key: ca.leafKeyPem }, (s) => s.end("ok"));
    server.listen(0, "127.0.0.1", () => {
      const sock = tls.connect({ port: server.address().port, host: "127.0.0.1", servername,
        ca: [ca.caCertPem] }, () => { sock.end(); server.close(); resolve(true); });
      sock.on("error", () => { server.close(); resolve(false); });
    });
  });
}

test("the startup sweep removes only old session dirs whose owner is gone", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { sweepStaleSessionDirs, SESSION_DIR_PREFIX } = await import("../dist/mitm-ca.js");
  const root = mkdtempSync(join(tmpdir(), "ccc-sweep-test-"));
  const old = (Date.now() - 2 * 24 * 3600_000) / 1000;
  const make = (name, pid, ageSec) => {
    const dir = join(root, name);
    mkdirSync(dir);
    if (pid !== undefined) writeFileSync(join(dir, "owner.pid"), String(pid));
    if (ageSec) utimesSync(dir, ageSec, ageSec);
    return dir;
  };
  const deadOld = make(`${SESSION_DIR_PREFIX}dead`, 111, old);
  const liveOld = make(`${SESSION_DIR_PREFIX}live`, 222, old);
  const deadNew = make(`${SESSION_DIR_PREFIX}fresh`, 111);
  const noPidOld = make(`${SESSION_DIR_PREFIX}nopid`, undefined, old);
  const other = make("not-ours", 111, old);
  const removed = sweepStaleSessionDirs(root, Date.now(), (pid) => pid === 222);
  assert.equal(removed, 2);
  assert.equal(existsSync(deadOld), false);
  assert.equal(existsSync(noPidOld), false);
  for (const kept of [liveOld, deadNew, other]) assert.equal(existsSync(kept), true, kept);
  assert.equal(sweepStaleSessionDirs(join(root, "missing")), 0);
});

test("a bundle dir names its owner, so a sweep keeps it while ccc runs", () => {
  const files = writeCaBundle(createSessionCa());
  try {
    assert.equal(readFileSync(`${files.dir}/owner.pid`, "utf8"), String(process.pid));
  } finally {
    files.cleanup();
  }
});
