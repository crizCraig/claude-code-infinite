#!/usr/bin/env node
/**
 * Emails a failed e2e run's link (and, through an email-to-SMS gateway address, texts it)
 * with Resend. GitHub's own "run failed" email is the baseline; this adds recipients.
 *
 *   E2E_RESEND_API_KEY  Resend key (sending access) - without it this prints and exits 0
 *   E2E_ALERT_TO        comma-separated recipients, e.g. "you@x.com,5551234567@vtext.com"
 *   E2E_ALERT_FROM      a sender on a domain verified in Resend
 *   E2E_ALERT_SUBJECT   subject line
 *   E2E_ALERT_BODY      body text (the run link is appended)
 */
const key = process.env.E2E_RESEND_API_KEY?.trim();
const to = (process.env.E2E_ALERT_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const from = process.env.E2E_ALERT_FROM?.trim();
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";
const subject = process.env.E2E_ALERT_SUBJECT || "e2e daily checks failed";
const text = `${process.env.E2E_ALERT_BODY || subject}\n\n${runUrl}\n`;

if (!key || !to.length || !from) {
  console.log("No alert email: set E2E_RESEND_API_KEY, E2E_ALERT_TO and E2E_ALERT_FROM to add one.");
  process.exit(0);
}
const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ from, to, subject, text }),
  signal: AbortSignal.timeout(30_000),
});
console.log(`Alert email: HTTP ${res.status}`);
process.exit(res.ok ? 0 : 1);
