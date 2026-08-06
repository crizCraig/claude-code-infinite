# Spec: mitigating or eliminating brittleness in the Claude Code integration

**For:** an investigating agent with read access to `~/src/claude-code-infinite`
and to the installed Claude Code bundle.
**Deliverable:** `reports/brittleness-mitigation-<date>.md`
**Companion to:** `BRITTLENESS-AUDIT-SPEC.md`, which maps the fragile
dependencies. This spec decides what to do about them.
**Mode:** investigation with prototype spikes. Spikes live in the scratchpad or
a throwaway branch; nothing lands in `src/` or `main`. The deliverable is a
ranked roadmap, not a patch series.

---

## 1. The question

The audit asks "where does ccc depend on things Anthropic never promised, and
how silently does each one fail?" This spec asks the follow-up:

**For each fragile dependency, what is the cheapest intervention that either
removes the dependency or makes its failure loud — and which interventions are
worth building first?**

"Mitigate" is not one thing. There are six distinct strategy families, and
collapsing them into a generic "add tests" recommendation would waste the
audit. Evaluate every dependency against all six:

| family | what it does | example |
|---|---|---|
| **Eliminate** | Remove the coupling entirely by restructuring | Transcript scrubbing, deleted 2026-08-02 once shown to guard against contamination no released version ever produced |
| **Substitute** | Swap a private contract for a published one | A documented env var or setting that achieves what `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` does |
| **Detect** | Convert silent failure to loud failure | Startup fingerprint of the CLI bundle; runtime wire-shape assertions in the proxy |
| **Contain** | Bound the blast radius when it breaks anyway | Per-subsystem kill switches; a defined degrade-to-passthrough-with-notice policy |
| **Repair** | Make the break mechanically fixable by an agent | Version-bump playbook + canary suite an agent runs on each Claude Code release |
| **Upstream** | Get Anthropic to promise the thing | An issue asking to document the first-party-base-URL flag or stabilize hook event names |

The families are ordered by preference, not by feasibility. Eliminating a
dependency beats detecting its failure, which beats repairing it after the
fact. But the audit's ranking discipline carries over: **a cheap detector for a
silent high-blast-radius failure outranks an expensive elimination of a loud
one.** The goal is to empty the low-detectability × high-blast-radius quadrant
first, by whatever family does it cheapest.

## 2. Input contract

Use `reports/brittleness-audit-<date>.md` as the dependency inventory if it
exists. If it does not, fall back to §2 of `BRITTLENESS-AUDIT-SPEC.md` — but
then inherit that section's caveat: the seed list is a shallow grep, so verify
each row against the bundle before designing mitigations for it. Do not design
a mitigation for a dependency you have not confirmed is real; mitigating a
no-op is how vestiges accumulate.

Either way, the unit of work is one confirmed dependency, and the output is
one row per dependency in the mitigation table (§7).

## 3. Seed candidates (evaluate; do not assume they work)

These are starting hypotheses, one or more per coupling surface. Each must be
verified feasible — by reading the bundle, running the CLI, or checking
Anthropic's published docs — before it appears in the roadmap as anything
stronger than "unexplored."

### Detect: the proxy is a free observatory

ccc uniquely sits on the wire between the CLI and the API. That position makes
several detectors nearly free, because the evidence arrives in-band:

- **Wire-shape assertions.** `proxy.ts` already parses ~10 SSE event types and
  the `/v1/messages` schema. Add a (spike-only, for now) classifier: any event
  type, top-level field, or content-block type the proxy does not recognize
  increments a drift counter and emits a notice via `notices.ts`. Today an
  unknown event is presumably passed through silently — confirm that, because
  it is the difference between "drift detector is new capability" and "drift
  detector formalizes existing behavior."
- **Honoring checks from observed traffic.** Identify which env-var
  dependencies have an observable wire signature, and specify the assertion
  for each. Caveat found 2026-08-02: the highest-value target,
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, may have *no* wire signature —
  current native models use 1M with no suffix or beta header — so its
  honoring check lives in the next bullet, not on the wire.
- **Ask the CLI what it believes (verified against 2.1.220).** The bundle
  constructs a statusline payload containing
  `context_window: {context_window_size, current_usage, used_percentage,
  remaining_percentage}` plus `exceeds_200k_tokens` — the CLI volunteers its
  believed context window to an observer ccc can install. That enables three
  escalating responses to the first-party-flag risk:
  1. **Release canary (definitive honoring test).** Run the real CLI against
     a local stub server twice — with and without the flag — and diff the
     reported `context_window_size`. Honored → the runs differ (1M vs 200k on
     a native model behind a custom base URL); a release that ignores the
     flag reports 200k in both → canary fires. The stub also controls `usage`
     fields in its replies, so "a 500k-token session" is forged with numbers,
     not payloads. Executed observation, no production API calls.
  2. **Live per-session assertion.** Receive the payload during real
     sessions and compare `context_window_size` to MemTree's assumed budget;
     mismatch → loud notice. Catches de-wiring in production, not just at
     release time. Design constraint: `settings.statusLine` is a single slot
     the user may already occupy — investigate wrapping the user's command or
     obtaining the same payload via another hook surface before claiming
     this slot.
  3. **Sync instead of assert (containment that retires the risk).** If ccc
     reads the CLI's believed window live, MemTree can adopt it as the
     budget. A broken flag then degrades to consistent 200k budgeting with a
     notice — reduced capacity, but the silent desync (the actual harm) is
     structurally impossible. Evaluate this as the endgame: it converts the
     inventory's #1 silent failure into a loud, graceful downgrade.
- **MemTree liveness ratio.** The audit names the canonical silent failure:
  compression quietly stops and passthrough looks identical to cold-index
  behavior. Design the metric that distinguishes them — e.g., compression
  ratio over a sliding window once the index should be warm, with a threshold
  that triggers a notice. Specify what "should be warm" means concretely,
  because that is the whole problem.

### Detect: fingerprint the bundle for the private strings ccc depends on

The fingerprint idea: grep Claude Code's bundled `cli.js` for every private
string ccc depends on — the underscore env var,
`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`, the keychain service name, hook event
names. An absent string means a dependency was removed (or renamed) upstream,
and ccc should find that out loudly rather than degrade silently.

**Committed item: a CI fingerprint test that fires on each new Claude Code
release.** This is decided, not a candidate for §5 scoring — the spec's job is
to design it, and the only thing that can kill it is the bundling spike below.
Design requirements:

- **Trigger.** npm publishes no push notification, so "fires whenever a new
  Claude Code is released" means a scheduled workflow (frequent cron) that
  polls the registry for the latest stable dist-tag of the Claude Code package
  (verify the package name — the audit's Step 0 applies), compares it to the
  last version checked, and exits early on no change. Record the last-checked
  version somewhere durable (repo-committed marker, cache, or the workflow's
  own history) so each release is checked exactly once.
- **The check.** Download the release tarball (never a production API call —
  registry fetches only), locate the bundle, and assert every string in the
  manifest is present. Failure names each missing string and the ccc
  subsystem that depends on it, and must be impossible to miss: a red
  workflow at minimum; auto-filing an issue with the evidence attached is
  better, because a scheduled workflow's failure email is easy to ignore.
- **One manifest, not two lists.** The strings ccc sets/uses in `src/` and
  the strings CI greps for must come from a single source of truth (an
  exported manifest that both the source and the test import), or the lists
  will drift and the test will guard a stale inventory. The manifest should
  also carry, per string, the subsystem it gates and the expected failure
  mode if it vanishes — that is what makes the CI failure message actionable.
- **Also run on PRs** that touch the manifest, pinned to the last-known-good
  CLI version, so manifest edits are validated cheaply without waiting for
  the next release.
- **Relationship to the release playbook (§3 Repair).** This test is the
  playbook's trigger and its first canary: a new version appearing starts the
  run, and a fingerprint failure is the first diagnosis input the repair
  agent sees. Design them as one pipeline, not two.

**Secondary candidate: the same check at `ccc` startup.** CI catches the
breakage at release time, but a user's locally updated CLI can be ahead of
ccc's response to that CI failure. A startup fingerprint (cached by CLI
version hash so the multi-MB grep runs once per version, not per session)
closes that gap. This one *does* go through §5 scoring — its carry cost
(startup latency, a second place the manifest is consumed) may not be worth it
if the CI test plus a tested-version warning covers the window well enough.

Open questions the spike must answer before either variant is built:
- Does bundler minification/obfuscation preserve these strings? **Answered
  2026-08-02 for 2.1.220:** yes. The installed CLI is a Bun-compiled Mach-O
  binary at `~/.local/share/claude/versions/<version>` with the JS embedded;
  all dependency strings grep out intact — but only with `grep -a`
  (plain grep sees a binary and reports zero matches, a false-negative trap
  the implementation must avoid). One drift already caught: the keychain
  service name `Claude Code-credentials` is absent from 2.1.220. Re-verify
  string survival per release; a Bun packaging change could break it.
- False-alarm rate: a string can be present but dead. Fingerprinting detects
  *removals*, not de-wirings; state this limit in the design. The de-wiring
  case is covered by the behavioral checks above (stub-diff canary and the
  statusline `context_window` assertion), which test effects, not strings.

### Contain: version pinning and a degradation policy

- **Tested-version recording.** ccc already parses `claude --version`
  (`cli.ts`). Spike a scheme: ship a list of Claude Code versions the test and
  canary suites passed against; on an untested version, warn once (not fatally
  — auto-updating CLIs would make a hard pin unusable). Evaluate whether the
  warning should gate anything beyond display, now that no subsystem mutates
  CLI-owned files (transcript scrubbing was removed 2026-08-02).
- **Explicit degrade policy.** Enumerate ccc's subsystems (MemTree splicing,
  hooks/plugin, keychain, env steering) and specify for each: on
  detected failure, does it disable itself, degrade to passthrough, or abort
  the session? Every degrade path must emit a notice; the audit's core finding
  is that silent degradation is the dominant risk, so a containment design
  that degrades silently is not a mitigation, it is the disease.
- **Kill switches.** Which subsystems can already be disabled independently
  (`CCC_AUTO_COMPACT` exists as a pattern), and which would need one? A
  per-subsystem escape hatch is the cheapest possible containment and makes
  agent repair safer (an agent can disable a broken subsystem as a stopgap).

### Eliminate / Substitute: shrink the private surface

- **Transcript scrubbing — already eliminated (2026-08-02).** `scrub.ts`
  rewrote CLI-owned JSONL files in place to clean notices that pre-hooks dev
  builds injected into assistant content. Investigation showed no published
  npm version ever injected (the whole proxy is post-v1.0.11 work; injection
  existed only 2026-07-05 → 2026-07-14 in dev), so the scrubber was deleted
  outright — the riskiest coupling surface is gone. The `notices.ts` request
  strip pass is retained as the in-memory safety net for any stray legacy
  transcript. Nothing to investigate here beyond confirming no regression
  reintroduces transcript writes.
- **Env vars.** For each private/undocumented var, check current Claude Code
  docs and release notes for a public equivalent that has appeared since the
  var was adopted. These flags sometimes graduate; a substitution is free
  risk-removal. Checked 2026-08-02 for the first-party flag: no documented
  equivalent exists, and the flag appears in no official docs (per the
  LLM-gateway and env-var doc pages).
- **The HTTPS_PROXY alternative (checked 2026-08-02, unscored).** Claude Code
  documents support for standard proxy env vars (network-config docs). If ccc
  intercepted via `HTTPS_PROXY` instead of `ANTHROPIC_BASE_URL`, the CLI
  would still be addressing `api.anthropic.com` — first-party detection never
  triggers, and the private flag becomes unnecessary. The cost: proxied
  Anthropic traffic is TLS end-to-end, and ccc must *rewrite* request bodies,
  so this route requires local TLS interception — minting a per-install CA,
  trusting it via `NODE_EXTRA_CA_CERTS` (documented), and impersonating
  `api.anthropic.com` on the loopback. Trade-offs to score honestly: every
  mechanism involved is a public contract (vs. one private flag), and if the
  CLI ever adds certificate pinning it fails *loudly*, not silently — but it
  is far more machinery, touches user trust stores, can collide with
  corporate security tooling, and known CLI issues force an `http://` scheme
  for the proxy URL (TLS-in-TLS limitation). Score as the fallback that
  eliminates the flag if it ever disappears, against keeping the flag plus
  the behavioral canary and budget-sync above.
- **Hook events.** Determine which of the plugin's declared events
  (`Stop`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`,
  `MessageDisplay`) are documented public hook API and which are inferred.
  Documented events leave the inventory entirely; that shrinks the audit, not
  just the risk.
- **The architectural question.** Could the Claude Agent SDK (or another
  published extension surface) replace CLI-wrapping altogether? Scope this
  honestly: what would ccc lose (the user's own Claude Code UX, subscription
  auth, IDE integration?) and what fraction of the private surface would
  actually disappear? This is a direction-setting finding, not a roadmap item
  — do not let it crowd out the shippable mitigations, but do not skip it,
  because if the answer is "80% of the surface evaporates," everything else is
  triage.

### Repair: the release playbook

Assume an agent runs on every Claude Code release (the audit's §5 premise).
Design the loop end to end:

1. **Trigger** — the CI fingerprint test above: its registry poll notices the
   new version, and its pass/fail is the run's first input.
2. **Canary run** — execute the release-canary suite the audit proposes
   against the new version. This spec should refine that proposal into
   concrete checks with named assertions, using the audit's test-coverage-gap
   list as the requirements document. The fingerprint test is canary #1;
   the rest probe behavior a string-grep cannot (the de-wiring case).
3. **Diagnosis** — for each failing canary, is the fix mechanical (update a
   model list, a string, a threshold) or judgment-bound (a removed private
   flag with no replacement)? Mechanical fixes get a patch proposal;
   judgment-bound failures get an issue with the evidence attached.
4. **Guardrails** — the audit's confident-wrong warning is binding: the
   playbook must forbid "fixes" that suppress a detector's symptom. Encode
   that as a rule the repair agent can check (e.g., a patch may not modify
   canary assertions and source behavior in the same change).

### Upstream: asks worth making

For each private dependency, draft the concrete ask (document this var,
stabilize these event names, expose a supported "transparent relay" mode) and
assess plausibility from public evidence — release-note history, existing
issues, whether the flag already behaves like a quasi-public contract. An
accepted upstream ask is the only mitigation that permanently deletes risk,
but it has unbounded latency; roadmap items must not depend on one landing.

## 4. Method

1. **Confirm the inventory** (§2) — audit report if present, verified seed
   list otherwise.
2. **Sweep each dependency across all six families.** Most cells will be
   "not applicable" or "not worth it"; write those down anyway, because the
   next reader should see they were considered, not re-derive them.
3. **Spike the load-bearing unknowns.** A mitigation whose feasibility is
   unverified is a hypothesis, not a plan. The fingerprint spike (do strings
   survive bundling?) and the wire-signature check (does the flag have an
   observable effect?) are the two most likely to change the roadmap's shape —
   do them first. Spikes follow the audit's execution standard: an observed
   behavior, not a plausible reading of control flow.
4. **Score and rank** (§5).
5. **Write the roadmap** (§7).

## 5. Decision framework

Score each candidate mitigation on four axes. Keep them separate.

| axis | question |
|---|---|
| **Risk retired** | Which audit rows does it cover, and how much of the silent×high-blast quadrant does it empty? |
| **Build cost** | Hours to working, tested state — including the spike already done. |
| **Carry cost** | Ongoing burden: false alarms, startup latency, maintenance of the mitigation itself. A detector that cries wolf gets ignored and is worse than no detector. |
| **Failure symmetry** | If the mitigation itself breaks or is wrong, does it fail loud or silent? A silent detector is a second-order version of the original problem. |

Tie-breakers, in order: prefer mitigations that cover many rows over
single-row fixes; prefer detectors that use in-band evidence (the proxy's own
traffic) over out-of-band probes that can drift; prefer the family earlier in
the §1 table when costs are comparable.

## 6. Non-goals

- **No shipping.** Spikes prove feasibility; the roadmap proposes; humans (or
  a later, separately-scoped task) build.
- **No re-auditing.** If a dependency's risk scores look wrong while working
  through mitigations, note it in Corrections — do not fork into a second
  audit.
- **No speculative abstraction.** "Wrap every coupling in an adapter layer" is
  not a finding. Every roadmap item must name the audit rows it retires and
  the evidence its spike produced.

## 7. Report format

1. **Verdict** — one paragraph: the top three interventions by risk retired
   per unit cost, and whether the silent×high-blast quadrant can be fully
   emptied with detection alone or requires elimination work.
2. **Mitigation table** — one row per confirmed dependency × candidate
   mitigation: family, feasibility (spiked / docs-confirmed / unexplored),
   four scores, and the evidence.
3. **Ranked roadmap** — ordered list of build-worthy items. For each: what it
   is, audit rows retired, spike evidence, build cost, carry cost, and what
   its own failure looks like.
4. **Canary suite design** — the refined release-canary checks: each check's
   assertion, the dependency it guards, its cost, and its false-alarm mode.
5. **Release playbook** — the §3 repair loop, concrete enough that an agent
   could be pointed at it on the next Claude Code release.
6. **Upstream asks** — drafted, with plausibility assessments.
7. **Rejected candidates** — mitigations considered and dropped, with the
   axis that killed them.
8. **Corrections** — anything this spec or the audit asserted that the
   investigation contradicted.

## 8. Standards

- **Verify, don't trust.** Feasibility claims need a spike, a bundle grep, a
  doc citation, or an explicit "unexplored" label.
- **Spikes are disposable.** Scratchpad or throwaway branch only; nothing
  merges; the report captures what the spike learned, not the spike itself.
- **No secrets.** Same rule as the audit: `keychain.ts` touches real OAuth
  credentials — confirm shapes, never read or log values.
- **No network calls to production services** beyond what a normal Claude
  Code session already makes. Doc lookups against public documentation are
  fine.
- **Distinguish "cannot be mitigated" from "did not get to it."** An honest
  "this surface has no viable mitigation today" is a finding; an empty cell is
  not.
