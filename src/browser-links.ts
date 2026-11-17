/** Browser link cutover ships with this release; a process restart can roll it back. */
export const LEGACY_BROWSER_LINKS = process.env.CCC_LEGACY_BROWSER_LINKS === "1";

export const BROWSER_APP_BASE = LEGACY_BROWSER_LINKS
  ? "https://app.polychat.co" : "https://app.memtree.dev";
export const KEY_BROWSER_URL = LEGACY_BROWSER_LINKS
  ? "https://polychat.co/auth?memtree=true&utm_source=ccc"
  : "https://app.memtree.dev/key?utm_source=ccc";
export const PRICING_BROWSER_URL = LEGACY_BROWSER_LINKS
  ? "https://polychat.co/pricing" : "https://app.memtree.dev/pricing";
