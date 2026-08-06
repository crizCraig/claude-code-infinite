# Spec: brittleness audit of the Claude Code integration

**For:** an investigating agent with read access to `~/src/claude-code-infinite`
and to the installed Claude Code bundle.
**Deliverable:** `reports/brittleness-audit-<date>.md`
**Mode:** read-only investigation. Do not modify `src/`, do not upgrade or
downgrade Claude Code, do not publish anything.

---

## 1. The question

`ccc` wraps Claude Code by inserting a loopback proxy between the CLI and
`api.anthropic.com`, and by steering the CLI with environment variables, a
generated plugin, and a transcript scrubber. Several of those levers are
private, undocumented, or both — `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`
carries a leading underscore precisely because it is not a public contract.

**How much of ccc's behavior depends on things Anthropic never promised, and
what happens when each one changes?**

The naive version of this question is "count the private env vars." That
undercounts badly, and it also over-weights the cheapest failures. The real
question has three parts:

1. **Inventory** — every point where ccc depends on Claude Code behavior that
   isn't a published contract.
2. **Failure mode** — when that dependency breaks, does ccc crash, degrade
   loudly, or degrade *silently*?
3. **Repairability** — could an agent detect the break and fix it without a
   human, and what signal would it need?

Part 2 is where the value is. A dependency that breaks loudly costs an hour.
A dependency that silently stops working costs however long it takes to notice
that MemTree quietly stopped compressing — which, per the A/B benchmark, is a
real failure mode: when the index is cold the server returns messages as-is
and ccc falls back to passthrough. That is correct behavior for a cold index
and indistinguishable from a broken integration.

**Rank findings by silence, not by count.**

## 2. Seed inventory (verify; do not trust)

The following came from a shallow grep. Treat it as a starting point that is
probably incomplete and possibly wrong. Every row must be independently
confirmed, and the audit should find surfaces this list missed.

### Environment variables set on the Claude Code child (`src/claude-env.ts`)

| variable | status | what breaks if ignored |
|---|---|---|
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` | **private** (underscore prefix) | CLI treats the loopback proxy as a third-party gateway and suppresses native model capabilities, including 1M context windows. Silent: context budget shrinks, nothing errors. |
| `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` | undocumented | "Resume from summary" prompt reappears at 100k, inviting a `/compact` that defeats MemTree. Loud-ish (user sees a prompt) but easy to accept by reflex. |
| `DISABLE_AUTO_COMPACT` | semi-documented | Claude Code compacts underneath MemTree. Both systems then compress. Silent and confounding. |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | documented, *read* not set | MemTree's budget desynchronizes from the CLI's own accounting. Silent. |

### Other coupling surfaces

- **Wire format.** `/v1/messages`, `/v1/messages/count_tokens`, the
  `anthropic-beta` / `anthropic-version` headers, and ~10 SSE event names
  (`message_start`, `content_block_delta`, `input_json_delta`, …) that
  `proxy.ts` parses and re-emits.
- **Model-name literals.** At least 13 hardcoded `claude-*` strings across
  `src/`. Determine what each one gates — a stale family check that silently
  mis-routes is far worse than a stale entry in a display map.
- **macOS keychain.** `security find-generic-password -s "Claude Code-credentials"`
  in `keychain.ts` depends on an exact, undocumented service name.
- **Plugin and hooks.** `hooks.ts` generates a plugin declaring `Stop`,
  `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and conditionally
  `MessageDisplay`. Which of these are published hook events and which are
  inferred? `MessageDisplay` is already conditional — find out why.
- **Transcript format.** *Removed 2026-08-02.* `scrub.ts` used to watch and
  rewrite `~/.claude/projects/<munged-cwd>/*.jsonl` in place; investigation
  showed the contamination it cleaned (notices injected into assistant
  content) existed only in unpublished dev builds during 2026-07-05 →
  2026-07-14, so the scrubber and its transcript-file coupling were deleted.
  Verify no transcript-write coupling has crept back; the read-side residue
  (the request strip pass in `notices.ts`) remains and is in scope.
- **Process control.** `cli.ts` spawns `claude` by name and parses
  `claude --version` output.
- **Argument passthrough.** `.claudeArgs`, and any flags ccc injects or
  intercepts.

Also check for coupling this list has no category for: undocumented request
fields, response fields consumed but not part of the public schema, assumptions
about request ordering or concurrency, and anything in `splice.ts` /
`ab-routing.ts` that reconstructs CLI-internal state.

## 3. Method

**Step 0 — locate the installed bundle.** `which claude` resolves to a shim in
this environment, not the real CLI; the usual npm-global and `~/.claude/local`
paths came up empty. Find the actual `cli.js` before anything else. If it
cannot be found or is unreadable, say so plainly and mark every
"does-the-CLI-honor-this" question as unverified rather than assuming.

**Confirm each dependency against the bundle.** For every env var and magic
string, grep the CLI bundle for it. Three outcomes, and they mean different
things:
- *present and read* — the dependency is real and currently honored;
- *present but unused* — a vestige; ccc may be relying on a no-op;
- *absent* — either already broken, or the name is obfuscated by the bundler,
  which you must distinguish rather than guess between.

**Test the honoring, don't infer it.** Where feasible, run the CLI with and
without the variable and observe the difference in an actual request. This
benchmark has already been burned once by accepting a plausible reading of
control flow over an executed check; a claim that a variable "works" without
an observation behind it is not a finding.

**Use version history as the empirical base rate.** The archived transcripts in
`~/src/memtree-bench/runs/` span Claude Code `2.1.218` → `2.1.219` → `2.1.220`,
and `claude-env.ts` documents a behavior that appeared *in* 2.1.219 (the
100k resume-summary prompt). Over the versions you can observe: how often did a
dependency ccc relies on actually change? That converts "this feels fragile"
into a rate. If the observable window is too short to support a rate, say that
instead of manufacturing one.

**Check the test suite's coverage of each dependency.** `test/proxy.test.mjs`
is 5,278 lines. For each inventory row, determine whether a test would fail if
the dependency silently stopped working. Rows with no such test are the ones
that will fail silently in production — that is the single most actionable
column in the report.

## 4. Risk model

Score each dependency on four axes. Keep them separate; do not collapse them
into one number, because the mitigations differ per axis.

| axis | question |
|---|---|
| **Likelihood** | How often does this kind of thing change? Ground in observed version history where possible. |
| **Blast radius** | Crash, degraded output, wrong output, or silent loss of the entire value proposition? |
| **Detectability** | Would anyone notice within one session? Is there a test, an assertion, or a metric? |
| **Auto-repairability** | Could an agent fix this unsupervised — and what would it need to *detect* the break first? |

The interesting quadrant is **low detectability × high blast radius**. Lead the
report with it.

## 5. The agent-repair angle

Assume an agent can be pointed at this repo on every Claude Code release. That
changes what "brittle" means: a dependency that breaks often but is trivially
detectable and mechanically fixable may be cheaper to carry than one that
breaks rarely and fails silently.

For each dependency, answer:

- **What is the detection signal?** A failing test, a startup assertion, a
  ratio metric that goes flat, a missing string in the bundle, a schema
  mismatch? If there is no signal, the honest answer is "an agent cannot fix
  this because nothing tells it something broke" — and the recommendation is to
  *build the signal*, not to write the fix.
- **Is the repair mechanical or judgment-bound?** Adding a new model to a
  literal list is mechanical. Deciding whether a renamed private env var is a
  rename or a removal is judgment-bound.
- **What is the confident-wrong risk?** An agent that "fixes" a silent
  degradation by suppressing its symptom is worse than no agent. Flag any
  dependency where a plausible auto-fix could mask the failure instead of
  resolving it.

Conclude with a concrete proposal for a **release-canary suite**: the smallest
set of executable checks that, run against a new Claude Code version, would
catch the high-blast-radius silent failures. Specify what each check asserts
and what it costs to run. This is the deliverable most likely to be acted on.

## 6. Report format

1. **Verdict** — one paragraph. How brittle is this, and what is the dominant
   risk? Do not bury it.
2. **Inventory table** — every dependency, with the four risk scores and the
   evidence that confirmed it (bundle grep, executed test, or unverified).
3. **The silent-failure list** — dependencies whose breakage produces no error.
   Ranked. This is the core of the report.
4. **Base rate** — what version history actually shows about change frequency,
   with the observable window stated.
5. **Test-coverage gaps** — inventory rows with no test that would catch them.
6. **Release-canary proposal** — the checks worth building.
7. **Corrections** — anything in §2 of this spec that turned out to be wrong.
   The seed list is a hypothesis; contradicting it is a successful outcome.

## 7. Standards

- **Verify, don't trust.** Every claim needs an executed check, a bundle grep,
  or an explicit "unverified" label. No claim rests on reading control flow
  alone.
- **Distinguish "I could not confirm this" from "this is fine."** Unverifiable
  rows stay unverified in the table.
- **No fixes.** This audit produces a map, not a patch. If a fix is obvious,
  describe it in the report and leave the code alone.
- **No secrets.** `keychain.ts` reads real OAuth credentials. Confirm the
  service-name string and the call shape; never read, print, or log a
  credential value.
- **No network calls to production services** beyond what a normal Claude Code
  session already makes.
