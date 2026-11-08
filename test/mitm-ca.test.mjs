// PROTOTYPE (proto/https-proxy-rc): the per-session CA in src/mitm-ca.ts.
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
