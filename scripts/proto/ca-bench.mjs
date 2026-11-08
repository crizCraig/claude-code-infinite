// PROTOTYPE (proto/https-proxy-rc): time the per-session CA + leaf (src/mitm-ca.ts) on this
// OS, check that Node's TLS accepts the leaf for api.anthropic.com and rejects a leaf the
// CA's name constraint forbids, and note whether an openssl binary is on PATH.
// Usage: node scripts/proto/ca-bench.mjs   (after npm run build)
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { cpus } from "node:os";

const t0 = performance.now();
const { createSessionCa, writeCaBundle } = await import("../../dist/mitm-ca.js");
const out = { node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, importMs: round(performance.now() - t0) };

for (const alg of ["ec", "rsa"]) {
  const a = performance.now();
  const ca = createSessionCa("api.anthropic.com", alg);
  const firstMs = performance.now() - a;
  const w = performance.now();
  const files = writeCaBundle(ca);
  const writeMs = performance.now() - w;
  files.cleanup();
  const n = alg === "ec" ? 50 : 15;
  const runs = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    createSessionCa("api.anthropic.com", alg);
    runs.push(performance.now() - s);
  }
  runs.sort((x, y) => x - y);
  out[alg] = { firstMs: round(firstMs), medianMs: round(runs[n >> 1]),
    p90Ms: round(runs[Math.floor(n * 0.9)]), maxMs: round(runs[n - 1]), writeBundleMs: round(writeMs) };
}
out.tlsAcceptsLeaf = await handshake(createSessionCa(), "api.anthropic.com");
out.tlsRejectsOtherHost = !(await handshake(createSessionCa("api.anthropic.com", "ec", "example.com"), "example.com"));
const ossl = spawnSync("openssl", ["version"], { encoding: "utf8" });
out.opensslOnPath = ossl.error ? false : (ossl.stdout || "").trim();
console.log(JSON.stringify(out, null, 1));

function round(v) { return Math.round(v * 100) / 100; }

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
