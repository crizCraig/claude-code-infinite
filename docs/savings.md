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

ccc uses measured upstream input on passthroughs and the original Count Tokens
result on rewrites. A missing original count leaves plain pending. On a
continuation the previous dispatch's message count separates earlier messages
from the append. ccc prices all earlier messages and the current request's
system, tools and settings as reads, including after edits, encoding changes,
retries, refusals or a long idle gap. A retry with no appended messages needs
only the measured total. For an append, the accounting worker can request a
count of the retained messages under the **current** framing after the response
finishes. Subtracting that boundary from the current total isolates the append.
An unavailable boundary leaves plain pending.

On a first send or a newly compacted prompt, the full modeled input is new.
New tokens covered by an eligible cache marker use the marked write duration.
Remaining new tokens use ordinary input pricing. The actual side always keeps
the response's measured buckets. Measured cache hits and ignored markers on an
identical passthrough also bound its plain price. Output is held equal across
the two sides.

Plain compacts when its modeled input exceeds the smaller of 80% of the
context window and the window minus reserved output. The model assumes free
compaction with a summary of up to 1,024 tokens (at most 10% of the ceiling)
and a 10% tail. It carries the removed-token count through subsequent requests,
including passthroughs. The compacted prefix is new once. Its next send is a
read. Window crossings use the full original input before compaction.

A per-account, per-session, per-lane cursor stores positions, removal bounds,
dispatch order and cache-duration metadata. It contains no transcript or
content digests. A dispatch updates the cursor before settlement, including a
429. A measured settlement can refine its own cursor while it is current.
Unobserved sends, including a launcher change or extra assistant turns, may
hide both a retry and a compaction. When that makes the retained size unknown,
the turn stays pending. On subsequent measured turns, ccc tracks the smallest
and largest possible removal. While those differ, it uses the shortest possible
input at the read rate, a lower bound even if an intervening send compacted.
A definite compaction brings the cursors back together.

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
is scoped by a digest of the service URL and credential. Before the upstream send,
the launcher writes a private in-flight segment with its turn ID, session, model
and dispatch time. At settlement it syncs the final record, atomically replaces
the in-flight segment and promotes it for delivery. A restarted launcher recovers
a dead writer’s segment even if the session has no further turns. An interrupted
dispatch carries null usage and the reason `interrupted_dispatch`. The
background sender can therefore remove individual acknowledged turns while another
process appends or drains its own records. The original record never changes.
Concurrent deliveries of the same ID are safe to replay.

The sender posts up to 50 turns to `/v1/ccc/savings/turns`. Only IDs in a readable
`acked_turn_ids` response are removed. The filename records the next eligible retry
time, starting at one minute and doubling to a maximum of 30 minutes. Missing
acknowledgements survive restarts. An invalid credential suspends the sender.
Savings reporting honors the existing diagnostics opt-outs. Uploads run in the background. A launcher worker maintains the private conversation cursor.

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
$0.050 charge. In the second row, the original input was counted at dispatch. The 429 costs zero in every settlement order. In the third,
the original prefix still measures 30,000 after the append takes the request to
31,000. Both sides include one output token in this row. All three nets are
negative and none qualifies for a savings email.

The terminal integration includes attributable main, agent, recap and passthrough
calls. The server can only price turns the client observed and delivered. Buffered
read/search charges can arrive after the turn. Periods are recomputed from the work's
UTC timestamps as further records and charges become available.
