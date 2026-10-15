import test from "node:test";
import assert from "node:assert/strict";
import { usageDashboardUrl } from "../dist/usage-link.js";
import { MemtreeClient } from "../dist/memtree.js";

test("usage dashboard URL follows the MemTree base URL of each environment", () => {
  // Production's API host serves the same app; the browser signs in on app.
  assert.equal(usageDashboardUrl("https://api.polychat.co"), "https://app.polychat.co/usage");
  assert.equal(usageDashboardUrl("https://app.polychat.co/"), "https://app.polychat.co/usage");
  assert.equal(
    usageDashboardUrl("https://polychat-staging-421312241218.us-west2.run.app"),
    "https://polychat-staging-421312241218.us-west2.run.app/usage"
  );
  assert.equal(usageDashboardUrl("http://localhost:8080"), "http://localhost:8080/usage");
  assert.equal(usageDashboardUrl("http://localhost:8080/"), "http://localhost:8080/usage");
});

test("usage dashboard URL is undefined for a base URL that is not http(s)", () => {
  assert.equal(usageDashboardUrl("not a url"), undefined);
  assert.equal(usageDashboardUrl("file:///etc/passwd"), undefined);
});

test("MemtreeClient exposes the usage dashboard for its own base URL", () => {
  const client = new MemtreeClient({ baseUrl: "https://api.polychat.co/", apiKey: "k" });
  assert.equal(client.usageDashboardUrl, "https://app.polychat.co/usage");
});
