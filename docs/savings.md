# Session savings accounting

This is an estimated comparison with plain Claude Code, expressed in API-price
USD. It does not measure a Claude subscription bill. `src/savings.ts` is display
accounting only and never changes routing or context sizing.

For each successful forwarded response, take the original request snapshot before
MemTree transforms it. Price the plain counterfactual against actual Anthropic
response usage. Input, cache reads, five-minute writes, one-hour writes, and
output are distinct buckets. The aggregate creation count includes both creation
durations; it is not an additional bucket. Invalid, negative, fractional, or
inconsistent usage makes the session incomplete. A missing cache-duration split
uses the historical five-minute creation bucket; missing input/output is invalid.

The session arithmetic is:

```
PURE = cumulative plain API cost - cumulative actual API cost
       - authoritative MemTree compression API cost
NET  = PURE - authoritative MemTree user charges
Less Usage percent = 100 * NET / cumulative plain API cost
```

Compression API cost and MemTree charges come only from the authenticated server
snapshot. They are not reconstructed from client bytes, elapsed time, or local
estimates. An absent/incomplete snapshot, an unknown model, or missing actual
usage suppresses the monetary result rather than silently counting an expense as
zero. Negative savings remain negative. Actual and plain USD totals exclude the
server compression charge, so it is subtracted exactly once.

## Price policy

Base input rates were checked on 2026-11-17 against
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing):

| Model | Input USD / million tokens |
| --- | ---: |
| Opus 5.5 | 4 |
| Sonnet 5.5, 5 | 2 |
| Haiku 5.5 | 0.10 through 100,000 input tokens; 0.50 above |
| Fable/Mythos 5.2 | 8 |
| Fable/Mythos 5.1, 5 | 10 |
| Opus 5, 4.5, 4.6, 4.7, 4.8 | 5 |
| Opus 4, 4.1 | 15 |
| Sonnet 4, 4.5, 4.6 | 3 |
| Haiku 4.5 | 1 |

Fast-mode rates apply across the full context window. Both sides of the comparison use
the response's `usage.speed` when present and the request's `speed` otherwise. This
also prices a fast request served at standard speed on Opus 4.6 correctly.
[Anthropic fast-mode pricing](https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing)

| Fast model | Input USD / million | Output USD / million |
| --- | ---: | ---: |
| Fable 5.2, Mythos 5.2 | 16 | 80 |
| Opus 5.5 | 8 | 40 |
| Opus 5, Opus 4.8 | 10 | 50 |

Craig explicitly selected multipliers **1, 0.1, 1.25, 2, 5** for ordinary
input, cache reads, five-minute creation, one-hour creation, and output. This
comparison policy intentionally retains 0.1 even where current model pricing
lists a 0.05 cache-read multiplier. It is not a claim that every model's invoice
uses those multipliers. Unknown models are unpriced, never guessed from a nearby
model generation. Discounts, regional/provider differences, plan fees, and other
billing adjustments are outside this comparison.

## Plain Claude counterfactual

An unmodified request uses actual input usage (all input buckets summed) and
actual cache/output buckets on both sides, including above the simulated compaction
ceiling and after a previous compression. Only a delivered compressed context contributes
an API cost difference. The status line shows progress until the first such turn.
Snapshots from clients that did not record compression retain their cumulative counts
and sequence. Their historical monetary comparison is marked incomplete.
Modified requests use an exact
original Count Tokens value when supplied; otherwise the module divides prompt
string characters by four and rounds down. This modest estimate is deliberately
separate from the high safety token estimator used to decide whether requests
fit. Opaque images/documents/audio/video and base64 sources contribute zero to
the fallback estimate. This can understate their baseline expense. Estimates
remain estimates: four characters per token is not a tokenizer or a formal
lower bound, and language/code mixes can differ. The state counts estimated
turns for display. Callers must never pass a high safety sizing estimate as an
exact original count.

Plain context is finite. Each lane has a ceiling equal to the smaller of 80% of
the model window and the window minus reserved output. On crossing it, assume
free plain compaction and retain a summary of at most 1,024 tokens (at most 10%
of the ceiling), plus a 10% tail. Remember how much of the original transcript
was removed; subsequent append-only requests grow from that smaller context.
Another simulated threshold crossing compacts again. Observed edits or transcript replacement reset
the virtual removal. Request framing and changing Claude Code billing attribution
such as `cch` do not alter that conversation boundary. This deliberately inexpensive summary and free compaction
favor plain Claude; actual Claude Code's trigger, summary size, generation cost,
quality, and subsequent outputs can differ. The cumulative `window_crossings` counter counts observed original requests
whose input exceeds the full native model window; an early simulated compaction
at 80% does not increment it. No baseline request is priced as
an impossible unlimited context. Output tokens are held equal to the observed
response because alternate plain outputs cannot be measured.

Cache behavior follows [Anthropic's prompt-caching rules](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
Only explicit tool/system/content breakpoints, or the last cacheable block under
top-level automatic caching, create entries. Subsequent reads require a matching
previously written prefix within the twenty-block lookup range and its own
five-minute or one-hour TTL. Consecutive parallel tool calls count as one
lookback position, and consecutive tool results count as another. Mixed-duration writes occupy disjoint token ranges;
new one-hour coverage costs 2x and new five-minute coverage costs 1.25x. Reads
refresh an existing entry's duration. No controls means no modeled caching.
Model minimums are 512 tokens for newer 5-series models except Sonnet 5 (1,024),
2,048 for Opus 4.7, 4,096 for Opus 4.5/4.6 and Haiku 4.5, and 1,024 for the
remaining supported models.

Local cumulative SHA-256 hashes represent prefixes; model/lane changes isolate
entries. Prefix token positions use relative text weights, an approximation
even when the whole-prompt count is exact. First-observation actual reads can
establish warm original-prefix coverage. After a passthrough, the simulation gives
plain the benefit of observed cache coverage for its possible lifetime. An upstream
read of unknown age or duration is allowed up to one hour. This can lower the baseline. Synthetic compaction changes cache
identity and cannot inherit those reads; it must write new eligible entries
before reusing them. Hashes never leave the local accounting file.

The virtual compacted token minimum can omit original tool/system overhead,
which lowers the plain baseline; it is not an exact reconstruction of Claude's
compacted prompt. Consequently the comparison is an estimate, not a guaranteed
mathematical lower bound or a claim of identical task quality.

## Persistence and integration

`accountSavingsTurn(state, input)` returns immutable `{state, turn}`. Call it
once per successful, billable response. The tracker serializes settlements across processes
with private per-contender lock markers, reloads the latest state, then commits the new
sequence and totals by atomic rename. A process that encounters contention retries after
a randomized delay. Dead writers' unique markers can be removed safely.
Use a distinct `laneKey` for each agent conversation; main is the default.
Capture the original request before mutation. `requestModified` describes the
request actually forwarded. `contextWindow` is the active model window, and
`outputReserve` may override the original `max_tokens`. Optional
`progress_tokens` and `budget_tokens` preserve display progress.

`createSavingsState(sessionId)`, `loadSavingsState(directory, sessionId)`, and
`saveSavingsState(directory, state)` use UUID session identity. Loading and
saving fail closed without throwing; creating a state rejects a non-UUID.
Persistence uses an injected directory, private 0600 files, a 0700 newly created
directory, exclusive temporary-file creation, and atomic rename. Files larger
than 600 KB, symlinks, unexpected fields, malformed values, and foreign session
IDs are rejected. Hourly background maintenance retains the newest 512 session files of each kind
and rechecks a file's modification time under the session lock before deletion. Each
session holds at most 32 lanes and 128 prefix checkpoints per lane. Evicted lane
history loses its cache/compaction model; cumulative monetary totals survive.
A resumed session restores totals, completeness, sequence, and lane history.

No prompt, message, tool result, credential, or tool argument is persisted by
this module. Local hashes and model IDs are accounting metadata. Send only the
explicit server savings projection (schema, session_id, sequence, totals,
completeness, turns, crossings, actual token counts); never send local prefix
hashes or lane state. The UUID is needed to associate authoritative server costs
with the same session. The tracker validates it before bookkeeping, reporting or fetching costs.

Diagnostics stores the latest pending cumulative report per session in a private outbox,
scoped to the service URL and credential. A successful POST must acknowledge durable
storage (or an already-stored newer sequence) for the same UUID. The response contract is

```json
{"savings_stored":{"session_id":"12345678-1234-4123-8123-123456789abc","sequence":42}}
```

An ordinary diagnostics `202`, a missing body, or an older sequence keeps the report
pending for the next flush or launch. Each sequence has a distinct filename so an old
acknowledgement cannot delete a newer report.

Savings reuses the parsed request and the delivery planner's selected candidate. A
passthrough needs only observed usage. On large modified requests, the existing sizing
fingerprint also verifies the previous message bytes. Verified appends resume the prefix
hashes and text weights at the checkpoint and process new blocks. An edit rebuilds the
affected history. Cold or evicted checkpoints require a full observation. The local
replay cache holds hashes, weights and cache positions for up to 32 lanes.

## Worked example

At Sonnet's $3/million base input rate, one plain turn with 10,000 uncached input,
90,000 cache reads, 20,000 five-minute writes, 5,000 one-hour writes and 2,000 output
costs `(10000 + .1*90000 + 1.25*20000 + 2*5000 + 5*2000)*3/1e6 = $0.192`.
The ccc response reports 2,000 input, 30,000 reads, 4,000 five-minute writes,
1,000 one-hour writes and the same 2,000 output: `$0.066`. With `$0.010` recorded
compression API cost and `$0.016` MemTree charges, gross is `$0.116`, net is
`$0.100`, and estimated plan-usage reduction is `52.1%` (`.100/.192`).
These are synthetic arithmetic examples, not measurements from customer sessions.

The terminal integration includes attributable main, agent, recap, and passthrough
calls. A new request invalidates the current billing view until an authoritative
response arrives for the settled local generation. Local token totals update at
response completion; pending costs show progress. After the final turn, billing
refreshes are bounded to six further one-minute polls. Recorded read/search charges
can lag by about six minutes under the server's existing ledger. Reporting honors
all existing diagnostics opt-outs; retrieving the user's own costs remains available.
No historical turns before this feature began observing the session are reconstructed.
