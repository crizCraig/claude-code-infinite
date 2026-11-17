import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function links(legacy) {
  const env = { ...process.env };
  delete env.CCC_LEGACY_BROWSER_LINKS;
  if (legacy) env.CCC_LEGACY_BROWSER_LINKS = "1";
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { KEY_PAGE_URL } from './dist/key-page.js';
    import { usageDashboardUrl } from './dist/usage-link.js';
    import { FALLBACK_SUBSCRIBE_URL } from './dist/payment-gate.js';
    console.log(JSON.stringify([KEY_PAGE_URL, usageDashboardUrl('https://api.polychat.co'),
      usageDashboardUrl('http://localhost:8080'), FALLBACK_SUBSCRIBE_URL]));
  `], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" }));
}

test("release browser links and explicit process rollback preserve local routing", () => {
  assert.deepEqual(links(false), ["https://app.memtree.dev/key?utm_source=ccc",
    "https://app.memtree.dev/usage", "http://localhost:8080/usage", "https://app.memtree.dev/pricing"]);
  assert.deepEqual(links(true), ["https://polychat.co/auth?memtree=true&utm_source=ccc",
    "https://app.polychat.co/usage", "http://localhost:8080/usage", "https://polychat.co/pricing"]);
});
