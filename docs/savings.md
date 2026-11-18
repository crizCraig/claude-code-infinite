# Session savings accounting

This is an estimated comparison with plain Claude Code, expressed in API-price
USD. It does not measure a Claude subscription bill. `src/savings.ts` is display
accounting only and never changes routing or context sizing.

ccc uses the original Claude request and the delivered response to estimate a plain
counterfactual. Polychat prices the ordinary input, cache reads, five-minute writes,
one-hour writes and output independently for each side. The aggregate creation count includes both creation
durations; it is not an additional bucket. Invalid, negative, fractional, or
inconsistent usage marks that turn incomplete. A missing cache-duration split
uses the historical five-minute creation bucket; missing input/output is invalid.

Polychat computes each session and reporting period using the same formula.

```
PURE = cumulative plain API cost - cumulative actual API cost
       - authoritative MemTree compression API cost
NET  = PURE - authoritative MemTree user charges
Less Usage percent = 100 * NET / cumulative plain API cost
```

Polychat prices both sets of buckets, subtracts its recorded compression costs and
MemTree charges, and returns the session estimate. An unknown bucket or price, or
incomplete charge coverage, suppresses the monetary claim. Signed values are retained
for period arithmetic.

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
Modified requests use an exact
original Count Tokens value when supplied; otherwise the module divides prompt
string characters by four and rounds down. This modest estimate is deliberately
separate from the high safety token estimator used to decide whether requests
fit. Opaque images/documents/audio/video and base64 sources contribute zero to
the fallback estimate. This can understate their baseline expense. Estimates
remain estimates: four characters per token is not a tokenizer or a formal
lower bound, and language/code mixes can differ. Callers must never pass a high safety sizing estimate as an
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
quality, and subsequent outputs can differ. The `window_crossing` flag indicates that the original input exceeded the full native model window. No baseline request is priced as
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
before reusing them. The launcher keeps these hashes in memory.

The virtual compacted token minimum can omit original tool/system overhead,
which lowers the plain baseline; it is not an exact reconstruction of Claude's
compacted prompt. Consequently the comparison is an estimate, not a guaranteed
mathematical lower bound or a claim of identical task quality.

## Turn log and delivery

An attributable upstream response produces a new UUID and one immutable record.
The UTC timestamp comes from upstream dispatch. The launcher validates the session
UUID and copies only the model, fast-mode flag, native-window crossing flag and the
five plain and actual token buckets. ccc also records the number of attributable
MemTree submissions expected to produce usage rows. It tags those submissions with
the turn UUID. A definite pre-work validation or authentication rejection removes
that submission from the expected count. Detached work has its own server timestamp.
Missing final usage is represented by null. A definitive, nonbillable upstream
rejection records zero on both sides. If a request ends before Claude dispatch
with outstanding MemTree submissions, ccc records the `not_dispatched` outcome,
turn and session IDs, first submission time and expected call count. Polychat
counts the corresponding MemTree charges and assigns zero API usage to both sides.
The plain-cache simulation retains bounded, per-lane observations in launcher memory.
A resumed process starts its cache simulation from the evidence available on that turn.

Each account log is a directory of private one-line JSONL segments. The directory
is scoped by a digest of the service URL and credential. A writer exclusively creates a private segment, appends one line and syncs it. Readers
consume only newline-terminated records. The
background sender can therefore remove individual acknowledged turns while another
process appends or drains its own records. The original record never changes.
Concurrent deliveries of the same ID are safe to replay.

The sender posts up to 50 turns to `/v1/ccc/savings/turns`. Only IDs in a readable
`acked_turn_ids` response are removed. The filename records the next eligible retry
time, starting at one minute and doubling to a maximum of 30 minutes. Missing
acknowledgements survive restarts. An invalid credential suspends the sender.
Savings reporting honors the existing diagnostics opt-outs. A failing disk or an
unreachable service cannot hold up the upstream request.

## Status line

The hook asks its launcher's loopback proxy for the current session view. The proxy
fetches the authenticated server session total with a ten-second cache. It combines
that value with the main conversation's local progress toward its compression budget.
An offline refresh can reuse the last known value. Missing, incomplete and nonpositive
results use the progress display. The status line budgets terminal cells and drops the
percentage first on narrow terminals.

## Worked example

At Sonnet's $3/million base input rate, one plain turn with 10,000 uncached input,
90,000 cache reads, 20,000 five-minute writes, 5,000 one-hour writes and 2,000 output
costs `(10000 + .1*90000 + 1.25*20000 + 2*5000 + 5*2000)*3/1e6 = $0.192`.
The ccc response reports 2,000 input, 30,000 reads, 4,000 five-minute writes,
1,000 one-hour writes and the same 2,000 output: `$0.066`. With `$0.010` recorded
compression API cost and `$0.016` MemTree charges, gross is `$0.116`, net is
`$0.100`, and estimated plan-usage reduction is `52.1%` (`.100/.192`).
These are synthetic arithmetic examples, not measurements from customer sessions.

The terminal integration includes attributable main, agent, recap and passthrough
calls. The server can only price turns the client observed and delivered. Buffered
read/search charges can arrive after the turn. Periods are recomputed from the work's
UTC timestamps as further records and charges become available.
