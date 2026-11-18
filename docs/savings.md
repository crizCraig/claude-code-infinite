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
GROSS = sum of each turn's plain API cost minus actual API cost
NET   = GROSS - all recorded MemTree user charges for the period
Less Usage percent = 100 * NET / cumulative plain API cost
```

The server dates turns by upstream dispatch and charges by when MemTree did the
work. Unpriced usage leaves the estimate pending. Signed losses reduce totals.

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

The launcher records upstream dispatch time in a private directory scoped to the
service, credential, session and conversation lane. Launchers sharing that directory
use the most recent preceding dispatch, even if its response has not settled.
A completed checkpoint holds prefix hashes, token counts and virtual compaction
state. Each writer updates only its own file. Prefix positions use relative text
weights even when the whole-prompt count is exact.

Warmth uses the gap since the previous dispatch and the TTL on each eligible
breakpoint of the original request. At exactly the TTL the prefix has expired.
If the predecessor time is unavailable, the fallback is the median observed gap
for that lane. The main median is **10,278.5 ms** (278 samples, one-hour TTL).
The agent median is **6,624.5 ms** (182 samples, five-minute TTL). These are
fixed calibrations from the two retained local ccc request logs through
2026-11-17 UTC. Select numeric `coldCache.gapMs` records, group by `routeLane`,
sort the gaps in milliseconds and take the middle value or average the middle
pair. These November 15–16 samples measure time from the lane's prior upstream
send to arrival of its next request.

Away recaps had no recorded `coldCache` samples. Their fallback is **1,986,285
ms** (33 min 6 s). In the same logs, group successful away messages by launcher
PID and difference consecutive request start estimates (`ts - totalMs`) in
time order. The median covers 113 gaps from 15 launchers, November 4–16. A known
gap always supersedes the calibration. In particular, an unknown away gap is
cold for a five-minute breakpoint and warm for a one-hour breakpoint.

When a warm predecessor has no prefix checkpoint, estimate the reusable history
through the input preceding the latest assistant reply, capped at the cacheable
breakpoint. The new reply and follow-up still require writes. Observed reads can
also establish reusable coverage. A synthetic compaction starts a new cache.

The virtual compacted token minimum can omit original tool/system overhead,
which lowers the plain baseline; it is not an exact reconstruction of Claude's
compacted prompt. Consequently the comparison is an estimate, not a guaranteed
mathematical lower bound or a claim of identical task quality.

## Turn log and delivery

An attributable upstream response produces a new UUID and one immutable record.
The UTC timestamp comes from upstream dispatch. The launcher validates the session
UUID and copies only the model, fast-mode flag, native-window crossing flag and the
five plain and actual token buckets. Missing final usage is represented by null. A definitive, nonbillable
upstream rejection records zero on both sides. Cancellation before upstream
dispatch produces no API turn. MemTree billing handles compression, indexing,
reads and searches independently, including work completing after cancellation.

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
Savings reporting honors the existing diagnostics opt-outs. Uploads run in the background. The launcher reads and writes the local dispatch
checkpoint on a best-effort basis.

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
1,000 one-hour writes and the same 2,000 output: `$0.066`. Gross savings are `$0.126`. With `$0.016` billed by MemTree for work
in the period, net savings are `$0.110`, or `57.3%` of plain cost (`.110/.192`).
These are synthetic arithmetic examples, not measurements from customer sessions.

The terminal integration includes attributable main, agent, recap and passthrough
calls. The server can only price turns the client observed and delivered. Buffered
read/search charges can arrive after the turn. Periods are recomputed from the work's
UTC timestamps as further records and charges become available.
