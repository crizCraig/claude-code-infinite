# PLAN: Local Proxy App ("Claude Code Infinite") — Keep OAuth Tokens on the User's Machine

> **Repo note (moved here 2026-07-04):** this plan originated in the polychat server repo.
> `polychat/...` paths, `plans/...` links, and commit hashes refer to that repo — main
> checkout at `~/src/polychat`. Its `plans/2026-06-09_PLAN_local_proxy_app.md` is now a stub
> tracking the server-side obligations; the local app described here is built in THIS repo.

## Goal

Anthropic OAuth tokens should never leave the user's machine. Today, Claude Code is pointed
at polychat.co and sends the user's OAuth token in the `orig-bearer-token` header; the server
uses it transiently to call Anthropic (`anthropic_proxy.py`, `skip_billing=True`). Tokens are
never stored, but they do transit our infrastructure, and Anthropic requests originate from
our IPs with user tokens — the weakest point TOS-wise.

New architecture: ship a small local app. Claude Code proxies to it via `ANTHROPIC_BASE_URL=
http://127.0.0.1:<port>`. The local app calls polychat.co only for message compression
(the same way NanoGPT calls `/v1/context_memory`), then calls api.anthropic.com directly
with the locally-held OAuth token. Polychat never sees the token; Anthropic sees requests
from the user's own machine and IP, with the user's own token.

```
Today:
  Claude Code ──(messages + orig-bearer-token)──▶ polychat.co /cc/v1/messages ──▶ Anthropic

New:
  Claude Code ──▶ localhost local app
                     ├──(messages only, polychat API key)──▶ polychat.co /v1/context_memory
                     │◀──(compressed messages)──────────────┘
                     └──(compressed messages + local OAuth token)──▶ api.anthropic.com
```

## Second motivation: auth fidelity — mirror vanilla Claude Code exactly (added 2026-07-03)

A production incident (2026-07-03, mem-vs-nomem Minecraft A/B) exposed a whole failure class
in the current `ccc` env-var approach that this proxy eliminates:

- `ccc` copies the keychain OAuth token into `ANTHROPIC_AUTH_TOKEN` at launch. **Claude Code
  never refreshes that env var** — it treats it as an opaque static credential (its auto-
  refresh only applies to its own keychain-managed login). The token goes stale mid-/between-
  sessions → 401s. `ccc`'s launch-time `refreshOAuthToken` hack only protects session start,
  not long-running sessions — the common case for an infinite-agents product.
- Worse: with auth-token-mode credentials CC couldn't validate the subscription at resume,
  and its "default" model silently resolved to **Sonnet 4.5 instead of the plan default
  (Fable)**. A resumed session ran an entire task on the wrong model with no visible error.
  The vanilla thread (native claude.ai login), resumed minutes apart with identical settings,
  correctly stayed on Fable.

With this plan's design — set only `ANTHROPIC_BASE_URL`, never touch auth — CC keeps its
native login: token refresh, plan-default model resolution, and limit handling all behave
exactly like vanilla. "Mirror vanilla" is an explicit product requirement (we do not pin
models or rewrite them server-side), and native-auth pass-through is what makes it hold.

## What polychat.co keeps / loses

- Keeps: full message content (required for indexing/compression — this is the product).
- Loses: any sight of Anthropic OAuth tokens, and the Anthropic request/response wire traffic.
- Billing already works without token visibility: cost is derived from token counts, and the
  OAuth path is already `skip_billing=True`. Usage stats for the dashboard can be reported
  back by the local app (Phase 4).

## Relationship to context monitoring (separate plan)

The online context-monitoring plan (`~/src/polychat/plans/2026-06-21_PLAN_context_monitoring.md`,
polychat repo) builds **on top
of** this proxy — the local app is its interception point for fanning out the with-mem vs
no-mem legs, grading them, and routing to the winner. Kept as a **separate plan** on purpose:
this proxy has standalone value (keep OAuth local) and ships first; monitoring is research-
gated on grader validation and further out, and folding its "doubles calls per turn" story
into this plan's clean "we only reduce tokens" narrative would muddy the TOS pitch right when
we may be asking Anthropic for a nod.

What monitoring changes about this proxy (so the next agent isn't surprised):
- **Fan-out**: monitoring issues a second completion (+a grader call) per monitored turn,
  instead of this plan's single byte-identical forward. Both legs run on the user's OAuth
  (subagent-shaped); see the monitoring plan for the token economics and the "triggered, not
  blanket" guardrail that keep it defensible.
- **Buffer-then-commit streaming**: the user-facing stream is held while the first `n` tokens
  of each leg buffer and the grader decides; then the winner's in-flight stream is continued
  and the loser aborted. This is a distinct response-path mode, not transparent pass-through.
- **Latency**: that hold is *seconds* (generate `n` + grade), not the "hundreds of ms" the
  compression-only path assumes — see the updated latency risk row.

## TOS / prior-art positioning

### What the terms actually say (researched June 2026)

- **Consumer Terms §2** (effective Oct 8, 2025): "You may not share your Account login
  information, Anthropic API key, or Account credentials with anyone else." No
  storage-vs-transit distinction — transmitting the token to a remote server is sharing.
  https://www.anthropic.com/legal/consumer-terms
- **Claude Code legal & compliance docs** (updated Feb 19, 2026): OAuth "is designed to
  support ordinary use of Claude Code and other native Anthropic applications," and
  "Anthropic does not permit third-party developers to offer Claude.ai login or to route
  requests through Free, Pro, or Max plan credentials on behalf of their users." Enforcement
  "may [happen] without prior notice."
  https://code.claude.com/docs/en/legal-and-compliance
- **Support docs**: Anthropic "may at its discretion allow paid subscribers... to use certain
  third-party tools"; prohibited are tools that "misrepresent their identity to Anthropic's
  servers, attempt to route third-party traffic against subscription limits, or otherwise
  violate applicable terms." https://support.claude.com/en/articles/13189465
- **Enforcement history**: Jan 9, 2026 — Pro/Max OAuth tokens blocked outside official apps
  without notice (Anthropic eng: stopping tools "spoofing the Claude Code harness").
  Feb 19, 2026 — OpenCode removed Claude subscription auth citing "anthropic legal
  requests." Coverage attributes the crackdown to "token arbitrage": flat-rate subscriptions
  powering third-party harness workloads.
- **Sanctioned adjacent paths**: enterprise LLM gateways via `ANTHROPIC_BASE_URL` are a
  documented, supported Claude Code pattern (intercepting and sometimes altering traffic);
  and as of June 15, 2026 Agent SDK / `claude -p` subscription use is officially allowed via
  a monthly Agent SDK credit.

### Implications

- **Current `orig-bearer-token` implementation: explicit-violation risk.** Routing requests
  through user OAuth credentials on a remote server is the pattern named verbatim in the
  Feb 2026 docs and enforced against (OpenCode). This is the strongest argument for this
  plan — the local app removes that exposure entirely.
- **Local app: defensible, not formally blessed.** The case that it complies:
  - No credential sharing — the token never leaves the user's machine (§2 satisfied).
  - No identity misrepresentation — Claude Code *is* the client. We don't spoof its
    harness fingerprint; we pass its requests through with headers untouched. Most calls
    (tool turns, count_tokens, catch-all) forward verbatim. Only on user-input turns is the
    `messages` body compressed — the same intercept-and-alter shape as the documented
    enterprise gateway use of `ANTHROPIC_BASE_URL`, just running on localhost.
  - No subscription-limit arbitrage — usage stays the user's own ordinary Claude Code use.
    Compression *reduces* tokens per request (rtk-style savings Anthropic and users both
    benefit from), and restarting a large session no longer in KV cache becomes much
    cheaper and faster for Anthropic to serve. Incentives align with Anthropic's stated
    reason for the crackdown rather than against it.
  - Residual gray zone: "ordinary use of Claude Code and other native Anthropic
    applications" could be read narrowly, and Anthropic enforces technically without
    notice. The support docs' discretionary third-party allowance suggests proactively
    asking Anthropic for a nod is worthwhile before GA (Phase 3).
- rtk (rust token killer) is NOT proxy prior art — it's a PreToolUse hook compressing shell
  output locally, never touching the API or OAuth. It IS precedent for the value prop
  (token savings everyone appreciates). Proxy prior art: meridian (rynfar/meridian),
  achetronic/claude-oauth-proxy, raine/claude-code-proxy — though those replace or
  re-route auth, which we deliberately don't.
- Design rules that keep us on the right side: pass through the exact headers Claude Code
  sends (Authorization, anthropic-beta incl. `oauth-2025-04-20`, user-agent); never read,
  store, or refresh credentials ourselves if header pass-through works (Phase 1 open
  question); alter only message content, never auth, identity, or routing.

## Components

### 1. Local app (new repo or `local_app/` subdir)

A small HTTP server + launcher. Responsibilities:

- **Launcher** (`ccc` replacement): start the local server if not running, set
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, exec `claude` with passed-through args.
- **Endpoints** (mirror what Claude Code hits today against polychat — see
  `polychat/cc_api.py` in the polychat repo):
  - `POST /v1/messages` — the main path (compression + forward, SSE streaming pass-through).
  - `POST /v1/messages/count_tokens` — pass through to Anthropic (token counts must reflect
    the compressed payload Claude Code will actually send; may need to compress here too —
    match current `polychat/cc_api.py:375` behavior).
  - Catch-all — transparent pass-through to api.anthropic.com.
- **Auth to Anthropic**: pass through the `Authorization` header Claude Code sends.
  Claude Code owns token storage and refresh; we never persist it.
  - RESOLVED (Phase 1 spike, re-confirmed 2026-07-03 on claude-cli/2.1.200): Claude Code
    sends its OAuth bearer to a custom `ANTHROPIC_BASE_URL`. Keep the fallback path
    designed but unbuilt in case Anthropic gates this later: read the keychain the way
    `polychat/claude_code/bin/get_oauth_keycain.py` does (macOS: `security
    find-generic-password -s 'Claude Code-credentials'`; Linux: `~/.claude/.credentials.json`)
    and handle 401-expired by telling the user to re-auth in Claude Code.
- **Auth to polychat**: per-user polychat API key stored in local config
  (`~/.config/claude-code-infinite/config.json` or similar). `ccc login` flow to set it.
- **Compression decision** (mirror lazy compression, polychat commit fda9991): on tool-result turns,
  POST messages to polychat as a fire-and-forget background indexing call — no substitution,
  off the response path so it adds zero latency. This is required, not optional: indexing
  runs continuously (a compression every ~10k tokens of new input) so the index keeps pace
  with the agent during tool loops and is ready when the user turn arrives. The server keeps
  deciding when a new chunk warrants indexing (`check_and_trigger_indexing()`); the local
  app just keeps it fed. On real user turns, make a blocking `/v1/context_memory` call and
  substitute `processed_messages`. Port `is_non_tool_user_message()` locally only to choose
  between the two modes (background-index vs compress-and-substitute).
- **Failure mode**: if polychat.co is unreachable or returns an error, degrade to transparent
  pass-through (uncompressed) rather than breaking the user's session. Log a warning.
  - This includes polychat **payment/limit states**: a 402 from polychat must never block the
    Anthropic call (compression is the paid feature; the user's own OAuth call is not ours to
    gate). Observed 2026-07-03 on staging: `Payment required but payment disabled` warnings
    fired mid-agentic-run — with enforcement on, that would have killed the session mid-task.
    Degrade to pass-through and surface the upgrade prompt out-of-band instead.
- **Timeout fallback + user-visible alert**: treat slow polychat the same as down polychat —
  put a hard client-side timeout on the blocking user-turn `/v1/context_memory` call (budget:
  low single-digit seconds; tool-turn indexing POSTs are already fire-and-forget so only user
  turns need this) and fall back to transparent pass-through when it trips. The user must be
  *told* memtree is degraded — silent fallback means they think they're testing memory when
  they aren't (exactly the 2026-07-03 A/B confound, in a new costume). Requirement: an inline
  message in the Claude Code UI **that the model never sees** — injecting text into the SSE
  response is off the table because it lands in the transcript and pollutes the next turn's
  context (and the model would react to it). Candidate mechanisms to spike, in rough order:
  - **statusline** (`statusLine` command in settings.json): CC runs a user script that can
    read a status file the local app maintains (e.g. `~/.config/claude-code-infinite/status`)
    and render "⚠ memtree timing out — passthrough mode". Model never sees statusline content.
    The launcher can offer to install/wrap the statusline at `ccc login` time.
  - **hook `systemMessage`**: hook JSON output can surface a user-facing message; check
    whether any hook event fires reliably enough per-turn to piggyback on, and confirm the
    message stays out of model context.
  - **OS notification / terminal bell** from the local app: works with zero CC integration,
    but easy to miss and noisy; last resort or supplement.
  Also record fallback events in the usage report (Phase 4) so degraded sessions are visible
  on the dashboard after the fact.
- **Error responses & retry amplification**: return well-formed Anthropic-shaped error bodies
  on upstream failure. Observed 2026-07-03: against a 401-returning endpoint, `claude -p`
  retried ~9× and hung past 2 minutes rather than failing fast. Retries must not re-trigger
  polychat compression/indexing calls — dedupe work per unique request (e.g. by messages
  hash), not per HTTP attempt.
- **Turn detection nuances** (for the local `is_non_tool_user_message()` port): CC injects
  synthetic user-role messages that pass the current heuristic — the "user stepped away"
  recap prompt (plain text, no `<system-reminder>` tag), standalone system-reminder text
  messages, and tool_result blocks with a trailing reminder text block. Decision 2026-07-03:
  treating the recap fork as a real user turn is **intentional/accepted** (it saves Anthropic
  tokens and forks are handled well); the other shapes should be audited when porting.
- **Language/distribution**: decide in Phase 3. Candidates:
  - TypeScript/Node via npm (`npm i -g claude-code-infinite`) — Claude Code users already
    have Node; easiest distribution and SSE handling.
  - Rust single binary (brew tap + curl installer) — no runtime dependency, best cold-start.
  - Python via uvx/pipx — fastest to prototype (can share logic with the polychat repo), worst
    end-user distribution.
  Recommendation: prototype in Python inside the polychat repo (Phase 1–2), ship TypeScript
  or Rust for GA (Phase 3) in this repo.

### 2. Server changes (polychat repo)

- **Per-user API keys**: `/v1/context_memory` currently authenticates with the single
  `NANOGPT_POLYCHAT_API_KEY` env var and bills to a hard-coded NanoGPT user
  (`polychat/api.py:262`). Add polychat-issued per-user API keys:
  - New table (or extend `api_keys`) for polychat-issued keys: key hash, user_id, created_at,
    revoked_at. No foreign keys per repo convention.
  - Key issuance UI/endpoint on polychat.co dashboard; `ccc login` can open the browser and
    paste the key (or do a device-code flow later).
  - Resolve user from the API key instead of `x-openwebui-user-*` headers.
- **Context-memory endpoint parity with /cc**: the local app needs everything
  `process_context_memory()` does for the cc path (`polychat/memory/query_context_mem.py:30`):
  background indexing trigger, index-not-ready behavior (return messages as-is),
  `compression_stats`/`messages_hash` continuity, flattening
  (`flatten_to_single_user_message`). Audit `/v1/context_memory` vs `/cc/v1/messages`
  pre-forward logic and close any gaps — ideally both call the same function.
  Add a `client` field (e.g. `"cc-infinite"`) for analytics.
- **Usage reporting endpoint** (Phase 4): `POST /v1/usage_report` — local app posts model +
  token counts from Anthropic responses so the dashboard keeps showing real usage even
  though we no longer see Anthropic responses. Authenticated with the same API key;
  treat as untrusted/advisory (display only, never billing).
- **API versioning**: the context_memory request/response is now a public contract consumed
  by shipped client binaries. Version it (`/v1/`, additive changes only) and have the local
  app send its version in a header so old clients can be detected/warned.
- **Deprecation**: once the local app is GA, sunset the `orig-bearer-token` path in
  `polychat/cc_api.py`/`polychat/ccc_api.py` (return an error directing users to install the local app).

## Phases

### Phase 1 — Spike: transparent local proxy (no compression) ✅ DONE 2026-06-09
1. Minimal Python server in the polychat repo (`polychat/local_app/proxy_spike.py`): catch-all that
   forwards verbatim to api.anthropic.com with SSE streaming pass-through.
2. Launcher: just `ANTHROPIC_BASE_URL=http://127.0.0.1:8765 claude` for the spike; proper
   launcher is Phase 3.
3. **Both critical unknowns validated** (real `claude -p` session through the proxy):
   - (a) CONFIRMED — Claude Code sends its OAuth bearer (`Authorization: Bearer
     sk-ant-oat01-…`, 108 chars) to the custom base URL, with its full fingerprint:
     `user-agent: claude-cli/2.1.170 (external, sdk-cli)` and `anthropic-beta:
     claude-code-20250219,oauth-2025-04-20,…` (~11 flags). Header pass-through works —
     no keychain reading or token refresh handling needed in the local app.
   - (b) CONFIRMED — Anthropic returned 200 on all forwarded requests (both
     `text/event-stream` and `application/json`); session completed end-to-end with the
     expected reply and exit 0. No OAuth block when requests originate locally with
     headers intact.
   - RE-CONFIRMED 2026-07-03 with `claude-cli/2.1.200`: bare `ANTHROPIC_BASE_URL` (no auth
     env vars) still sends `Authorization: Bearer sk-ant-oa…` (115 chars) plus the full beta
     fingerprint (now ~11 flags incl. `fallback-credit-2026-06-01`,
     `prompt-caching-scope-2026-01-05`) and `?beta=true` query string. Forward the header set
     and query string verbatim — the flag list churns across CC versions, never reconstruct it.
   - Implementation gotcha: httpx auto-negotiates gzip — stream decoded bytes
     (`aiter_bytes()`) and strip `content-encoding`/`content-length` from forwarded
     response headers, or the client receives compressed bytes it can't parse.

### Phase 2 — Compression integration
1. Server: per-user API keys + `/v1/context_memory` parity audit (shared code path with /cc).
2. Local app: lazy-compression turn detection — fire-and-forget background indexing POSTs
   on tool turns (keeps the index current as the agent runs), blocking `/v1/context_memory`
   call with `processed_messages` substitution on user turns, degrade-to-passthrough on
   failure. Server may need an index-only mode on the endpoint (trigger indexing, skip
   computing/returning compressed messages) so tool-turn calls stay cheap.
3. `count_tokens` handling consistent with compressed payloads.
3b. Timeout fallback + degraded-mode alert: implement the user-turn timeout → passthrough
    path, and spike the model-invisible notification mechanisms (statusline file first, then
    hook `systemMessage`) — verify the chosen one truly never enters model context by
    inspecting the request bodies the proxy forwards afterward.
4. Dogfood: run the author's own sessions through it for a week; compare compression
   stats with the server-side path.

### Phase 3 — Packaging & onboarding
1. Pick GA language (TS/npm vs Rust binary), port the proxy.
2. `ccc login` onboarding (dashboard key paste), config file, port selection, auto-start.
3. Self-update or version check against a polychat endpoint (warn on stale client).
4. Docs + landing page install instructions.
5. Reach out to Anthropic for the discretionary third-party allowance (see TOS section) —
   the compression-reduces-their-costs framing is the pitch.

### Phase 4 — Usage reporting & cutover
1. `POST /v1/usage_report` + dashboard wiring.
2. Migration messaging for existing `orig-bearer-token` users; deprecation window; remove
   token transit from `polychat/cc_api.py`.

## Risks

| Risk | Notes / mitigation |
|---|---|
| Anthropic blocks the local app's requests | Phase 1 spike answers this first; keep requests byte-identical to Claude Code's except `messages`. If blocked, the whole approach (and the current server-side one) is dead — find out before building more. |
| Claude Code doesn't send OAuth to custom base URL | Fallback: keychain read (existing `polychat/claude_code/bin/get_oauth_keycain.py` approach) + local refresh handling. More credential surface, still never leaves the machine. |
| Extra latency (local hop + polychat round-trip) | Tool-turn indexing POSTs are fire-and-forget off the response path, so the turns that dominate add zero latency. Blocking compression call only on user turns, where hundreds of ms are acceptable. **Monitoring (separate plan) adds more**: buffer-then-commit holds the user stream for `time-to-generate-n + grade` (seconds) on monitored turns — gate it behind the paid tier / triggered cases, not every turn. |
| Fan-out doubles calls on the OAuth subscription (monitoring) | The monitoring plan runs two legs + a grader per monitored turn on the user's subscription. Mitigated by: legs are cheap (cached full-context leg + short mem leg, not 2× a big context), serving the mem-leg winner forward can be net-negative tokens vs baseline, and fan-out is *triggered* not blanket. Still a heavier ask than the pure proxy — fold it into the Phase-3 Anthropic conversation honestly. |
| Upload bandwidth (full history POSTed every tool turn) | Acceptable at first (mirrors what Claude Code sends today). If it matters, later send only messages since the last acked index ping. |
| Shipped-client contract drift | Version the API, client sends version header, server can return "please update" errors. |
| Index-not-ready first sessions | Same as today: return messages uncompressed until background index completes. |
| Users on Windows | Defer; Claude Code credential storage differs. Mac/Linux first. |
| 1M-context model variants (`[1m]` suffix) | Users can default to e.g. `claude-fable-5[1m]` (settings.json). Compression budgets currently hard-code `model_context_limit_tokens=200_000` (`polychat/cc_api.py`), and model-table lookups (pricing/priors/context sizes) may miss suffixed ids. Local app + server must strip/route the `[1m]` suffix and use the real window for budgeting. |
| OAuth-to-custom-base-URL gets gated by Anthropic later | Works as of 2026-07-03, but treat as unguaranteed (it's a token-exfiltration surface they may close). Fallback already planned: local keychain read (`polychat/claude_code/bin/get_oauth_keycain.py` pattern) — still never leaves the machine. Detect via 401s-with-valid-token or missing Authorization header and switch modes. |
