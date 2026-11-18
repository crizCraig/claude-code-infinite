# Session savings accounting

This is an estimated comparison with plain Claude Code, expressed in API-price
USD. It does not measure a Claude subscription bill. `src/savings.ts` is display
accounting only and never changes routing or context sizing.

ccc uses the original Claude request and the delivered response to estimate a plain
counterfactual. Polychat prices the ordinary input, cache reads, five-minute writes,
one-hour writes and output independently for each side. The aggregate creation count includes both creation
durations; it is not an additional bucket. Invalid, negative, fractional, or
inconsistent usage marks that turn incomplete. When the creation total is null or absent, two measured duration counts supply the total. A missing cache-duration split
uses the historical five-minute creation bucket. A stream can supply input on the
start or final delta. A complete duration split on the delta supplies its creation total even when the start reported zero.

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

An unmodified request measures the original input directly. For a modified
request, ccc uses the original Count Tokens value when available. Otherwise it
retains known token boundaries and estimates the remaining text at four
characters per token. Opaque media and base64 sources add zero to that estimate.
Token density varies by language and content.

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

Plain pays the read rate for every matching prefix it has sent in this
conversation lane. A long gap, a 429, an intervening edit, or a cold compressed
request can all precede a plain read. New tokens covered by an eligible cache
marker use the duration requested on the original prompt. Other new tokens
use ordinary input pricing. The actual side uses the delivered response’s
measured buckets. On a passthrough those measurements also bound the price
of the identical original request.

A fully counted prefix keeps its token boundary when text is appended. Where
an interior boundary is unknown, ccc prices ambiguous overlap as reads up to
the nearest measured upper bound. It promotes new tokens to a more expensive
write tier only through a known boundary. A final marker covers the entire
input. These choices can under-credit savings.

The worker records plain sends at dispatch, including refused and in-flight
requests. Before forwarding, the launcher announces the send with a private
empty file. A concurrent launcher can then assume reads while the first
worker is still hashing the request. The private history contains cumulative block digests, token
boundaries, send times and requested durations scoped by account, session and
lane. Restarts can reuse that history. Incomplete or legacy history favors a
read when an earlier send is possible. Settlement supplies measured usage for
the immutable report. A definitive nonbillable refusal costs zero on both sides.

Two optional admin diagnostics count floor reads whose last send was longer ago
than that send’s TTL and record the longest such gap in whole seconds. An
unmarked send has zero TTL. Zero indicates no qualifying gap and null indicates
missing evidence. For example, a known gap can accompany a null token count
when the boundary between two durations was never measured. Neither field
affects pricing.

The virtual compacted token minimum can omit original tool/system overhead,
which lowers the plain baseline; it is not an exact reconstruction of Claude's
compacted prompt. Consequently the comparison is an estimate, not a guaranteed
mathematical lower bound or a claim of identical task quality.

## Turn log and delivery

An attributable upstream response produces a new UUID and one immutable record.
The UTC timestamp comes from upstream dispatch. The launcher validates the session
UUID and records the model, fast-mode flag, native-window crossing flag,
five plain and actual token buckets, and the two numeric floor diagnostics. Missing final usage is represented by null. A definitive, nonbillable
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
Savings reporting honors the existing diagnostics opt-outs. Uploads run in the background. A launcher worker hashes the original request and maintains the private send history.

## Status line

The hook uses a launcher-scoped token to ask its loopback proxy for the current session view. The proxy
fetches the authenticated server session total with a ten-second cache. It combines
that value with the main conversation's local progress toward its compression budget.
An offline refresh can reuse the last known value. An explicit session-unavailable
response clears it. Missing, incomplete and nonpositive
results use the progress display. The status line budgets terminal cells and drops the
percentage first on narrow terminals.

## Worked example

Each row prices the affected turn at Sonnet 4.6 rates, then subtracts $0.050
in MemTree charges. Previously billed setup turns are outside each row. A
passthrough that establishes the initial measured write costs the same on both
sides.

| Round 7 turn | Plain input | ccc input | Plain USD | Actual USD | Net USD |
| --- | --- | --- | ---: | ---: | ---: |
| Stable compressed request after ten minutes | 31,000 reads | 2,000 five-minute writes | 0.009300 | 0.007500 | **−0.048200** |
| Rewrite overlapping a 429 | 30,000 reads | 2,000 ordinary | 0.009000 | 0.006000 | **−0.047000** |
| Low-density append | 30,000 reads and 1,000 five-minute writes | 900 ordinary | 0.012765 | 0.002715 | **−0.039950** |

In the first row, 30,000 plain tokens had a one-hour marker and 1,000 had a
five-minute marker. The diagnostic flags only the latter 1,000 at a 600-second
gap. Including the intermediate compressed turn adds another $0.001800
gross, making the full three-dispatch sequence **−$0.046400** with the same
$0.050 charge. In the second row, the 429 costs zero in every settlement order. In the third,
the original prefix still measures 30,000 after the append takes the request to
31,000. Both sides include one output token in this row. All three nets are
negative and none qualifies for a savings email.

The terminal integration includes attributable main, agent, recap and passthrough
calls. The server can only price turns the client observed and delivered. Buffered
read/search charges can arrive after the turn. Periods are recomputed from the work's
UTC timestamps as further records and charges become available.
