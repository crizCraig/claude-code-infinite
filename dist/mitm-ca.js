/**
 * PROTOTYPE (proto/https-proxy-rc): a per-session certificate authority for
 * ccc's HTTPS-proxy mode, with no dependencies (node:crypto makes the keys and
 * signatures; this file writes the X.509 DER around them).
 *
 * Each ccc process makes a fresh CA and one leaf for api.anthropic.com, both
 * in memory. Only the CA *certificate* (public) is written to disk, in a 0700
 * temp dir, for the child's NODE_EXTRA_CA_CERTS. The CA carries a critical
 * nameConstraints extension permitting only api.anthropic.com, so even a
 * leaked key could not mint a trusted certificate for any other host.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const INTERCEPT_HOST = "api.anthropic.com";
/** Make a CA (name-constrained to `host`) and a leaf for `host`, all in memory. */
export function createSessionCa(host = INTERCEPT_HOST, alg = "ec", leafHost = host /* test-only */) {
    const caKeys = makeKeyPair(alg);
    const now = Date.now();
    const caName = name(`ccc session CA ${randomBytes(4).toString("hex")}`);
    const caSpki = spkiDer(caKeys.publicKey);
    const caKeyId = keyId(caSpki);
    const caCert = signCert({
        serial: serialNumber(), issuer: caName, subject: caName, spki: caSpki,
        notBefore: now - 24 * 3600_000, notAfter: now + 365 * 24 * 3600_000,
        extensions: caExtensions(host, caKeyId), signer: caKeys.privateKey, alg,
    });
    const leafKeys = makeKeyPair(alg);
    const leafSpki = spkiDer(leafKeys.publicKey);
    const leafCert = signCert({
        serial: serialNumber(), issuer: caName, subject: name(leafHost), spki: leafSpki,
        notBefore: now - 24 * 3600_000, notAfter: now + 365 * 24 * 3600_000,
        extensions: leafExtensions(leafHost, keyId(leafSpki), caKeyId, alg),
        signer: caKeys.privateKey, alg,
    });
    // The CA private key goes out of scope here: nothing can sign with it again.
    return {
        caCertPem: pem("CERTIFICATE", caCert),
        leafCertPem: pem("CERTIFICATE", leafCert),
        leafKeyPem: leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
}
/** Write the CA cert (public) bundle for NODE_EXTRA_CA_CERTS into a private temp dir. */
export function writeCaBundle(ca, userExtraCaPem = "") {
    const dir = mkdtempSync(join(tmpdir(), "ccc-ca-"));
    try {
        chmodSync(dir, 0o700);
    }
    catch { /* Windows: ACLs of the user temp dir apply */ }
    const bundlePath = join(dir, "ca-bundle.pem");
    const parts = [userExtraCaPem.trim(), ca.caCertPem.trim()].filter(Boolean);
    writeFileSync(bundlePath, `${parts.join("\n")}\n`, { mode: 0o600 });
    return { dir, bundlePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function signCert(spec) {
    const sigAlg = signatureAlgorithm(spec.alg);
    const tbs = seq(explicit(0, int(Buffer.from([2]))), int(spec.serial), sigAlg, spec.issuer, seq(time(spec.notBefore), time(spec.notAfter)), spec.subject, spec.spki, explicit(3, seq(...spec.extensions)));
    const signature = sign("sha256", tbs, spec.signer);
    return seq(tbs, sigAlg, bitString(signature));
}
function caExtensions(host, skid) {
    return [
        extension("2.5.29.19", true, seq(bool(true), int(Buffer.from([0])))), // CA, pathLen 0
        extension("2.5.29.15", true, Buffer.from([0x03, 0x02, 0x01, 0x06])), // keyCertSign, cRLSign
        // permitted: DNS api.anthropic.com; excluded: every IPv4 and IPv6 address (an unlisted
        // name form would otherwise be unconstrained, RFC 5280 4.2.1.10).
        extension("2.5.29.30", true, seq(tagged(0xa0, seq(tagged(0x82, Buffer.from(host)))), tagged(0xa1, Buffer.concat([
            seq(tagged(0x87, Buffer.alloc(8))), // 0.0.0.0/0
            seq(tagged(0x87, Buffer.alloc(32))), // ::/0
        ])))),
        extension("2.5.29.14", false, octet(skid)),
    ];
}
function leafExtensions(host, skid, akid, alg) {
    // digitalSignature (EC); digitalSignature + keyEncipherment (RSA).
    const usage = alg === "ec" ? [0x03, 0x02, 0x07, 0x80] : [0x03, 0x02, 0x05, 0xa0];
    return [
        extension("2.5.29.19", true, seq()),
        extension("2.5.29.15", true, Buffer.from(usage)),
        extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
        extension("2.5.29.17", false, seq(subjectAltName(host))),
        extension("2.5.29.14", false, octet(skid)),
        extension("2.5.29.35", false, seq(tagged(0x80, akid))),
    ];
}
/** dNSName, or iPAddress for a dotted IPv4 (only test leaves use one). */
function subjectAltName(host) {
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    return ipv4 ? tagged(0x87, Buffer.from(ipv4.slice(1).map(Number))) : tagged(0x82, Buffer.from(host));
}
function makeKeyPair(alg) {
    return alg === "ec"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
}
function signatureAlgorithm(alg) {
    return alg === "ec"
        ? seq(oid("1.2.840.10045.4.3.2")) // ecdsa-with-SHA256
        : seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00])); // sha256WithRSA
}
function spkiDer(key) {
    return key.export({ type: "spki", format: "der" });
}
/** RFC 5280 method 1 style: SHA-1 over the whole SPKI is fine for a key id. */
function keyId(spki) {
    return createHash("sha1").update(spki).digest();
}
function serialNumber() {
    const serial = randomBytes(16);
    serial[0] = (serial[0] & 0x7f) | 0x01; // positive, nonzero leading byte
    return serial;
}
function name(commonName) {
    return seq(set(seq(oid("2.5.4.3"), tagged(0x0c, Buffer.from(commonName, "utf8")))));
}
function extension(id, critical, value) {
    return critical ? seq(oid(id), bool(true), octet(value)) : seq(oid(id), octet(value));
}
function pem(label, der) {
    const body = der.toString("base64").match(/.{1,64}/g).join("\n");
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
// ------------------------------------------------------------------------ DER
function tagged(tag, content) {
    return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}
function length(n) {
    if (n < 0x80)
        return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v >>= 8)
        bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function seq(...items) { return tagged(0x30, Buffer.concat(items)); }
function set(...items) { return tagged(0x31, Buffer.concat(items)); }
function explicit(n, inner) { return tagged(0xa0 | n, inner); }
function octet(b) { return tagged(0x04, b); }
function bool(v) { return Buffer.from([0x01, 0x01, v ? 0xff : 0x00]); }
function bitString(b) { return tagged(0x03, Buffer.concat([Buffer.from([0]), b])); }
function int(b) {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && (b[i + 1] & 0x80) === 0)
        i++;
    const v = b.subarray(i);
    return tagged(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}
function oid(dotted) {
    const parts = dotted.split(".").map(Number);
    const out = [40 * parts[0] + parts[1]];
    for (const p of parts.slice(2)) {
        const enc = [p & 0x7f];
        for (let v = p >>> 7; v > 0; v >>>= 7)
            enc.unshift(0x80 | (v & 0x7f));
        out.push(...enc);
    }
    return tagged(0x06, Buffer.from(out));
}
/** UTCTime before 2050, GeneralizedTime after (RFC 5280 4.1.2.5). */
function time(ms) {
    const iso = new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
    const year = Number(iso.slice(0, 4));
    return year < 2050 ? tagged(0x17, Buffer.from(iso.slice(2))) : tagged(0x18, Buffer.from(iso));
}
//# sourceMappingURL=mitm-ca.js.map