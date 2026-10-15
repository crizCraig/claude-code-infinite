# Count Tokens latency vs body size (2026-10-15)

Why: ccc counts a request with Anthropic's `/v1/messages/count_tokens` (the user's own
credentials) under one request-wide 3 s deadline. On the 17-27 MB image-heavy incident
bodies the count timed out, so after fix/token-estimate ccc retried and then refused with
the `/ccc:memtree-compact` hint. This measures how the endpoint behaves so the deadline can
scale with size (branch fix/count-deadline).

## Setup

- Craig's Mac, Wi-Fi (en0), to api.anthropic.com; Claude Code OAuth token (Max) as ccc
  forwards it; model `claude-opus-5-5`. Never printed or stored.
- Synthetic bodies only (`scripts/count-tokens-latency/`): Claude-Code-shaped tool turns of
  generated prose, code and tool-result JSON; "images" bodies carry ~98% of their bytes as
  2000x1250 random-noise PNGs (noise band sized to ~1.4 MB base64 each, smaller images for
  bodies under 2 MB). 3 runs per size (1 for the limit probes). ~120 requests, ~1.3 GB uploaded.
- `ms` is client-side wall time, request start to full response.

## Results

| body | bytes | input tokens | status | p50 ms | max ms (p90) |
|---|---:|---:|---|---:|---:|
| text 50 kB | 52,192 | 17,480 | 200 | 174 | 268 |
| text 500 kB | 510,488 | 183,749 | 200 | 207 | 390 |
| text 1 MB | 1,005,638 | 365,145 | 200 | 191 | 226 |
| text 2 MB | 2,051,013 | 749,302 | 200 | 422 | 754 |
| text 4 MB | 4,085,534 | 1,495,892 | 200 | 525 | 758 |
| text 8 MB | 8,155,200 | 2,989,803 | 200 | 815 | 895 |
| text 16 MB | 16,293,354 | 5,970,604 | 200 | 1,555 | 1,604 |
| text 27 MB | 27,482,862 | 10,070,072 | 200 | 2,489 | 2,616 |
| text 35 MB (n=1) | 34,603,471 | 12,676,949 | 200 | 3,131 | |
| text 49 MB (n=1) | 48,845,912 | 17,894,911 | 200 | 4,295 | |
| images 0.4 MB | 372,123 | 12,045 | 200 | 225 | 246 |
| images 1 MB | 951,055 | 20,801 | 200 | 195 | 224 |
| images 1.7 MB | 1,708,648 | 28,397 | 200 | 297 | 413 |
| images 3.3 MB | 3,256,833 | 43,962 | 200 | 538 | 1,170 |
| images 7.4 MB | 7,395,283 | 80,966 | 200 | 714 | 915 |
| images 16 MB | 16,000,415 | 73,778 | 200 | 1,356 | 1,392 |
| images 27 MB | 26,541,380 | 268,985 | 200 | 2,202 | 2,261 |
| images, 10% text, 27 MB | 27,057,066 | 978,846 | 200 | 2,136 | 2,365 |
| images 47 MB (n=1) | 47,171,263 | 475,476 | 200 | 3,938 | |
| images 63 MB (n=1) | 63,371,143 | 634,573 | 200 | 5,029 | |
| exactly 64 MiB (n=1) | 67,108,864 | 4,370,986 | 200 | 5,540 | |
| 64 MiB + 1 byte (n=1) | 67,108,865 | | 413 | 218 | |
| images 99 MB (n=1) | 98,746,515 | | 413 | 59 | |
| one fully random 2000x1250 PNG (10 MB base64) | 11,693,447 | 620,600 | 200 | 1,340 | |

Concurrency (all 200, no 429, no `retry-after`): 10 x 50 kB at once 250-337 ms each;
5 x 1 MB text 346-398 ms; 5 x 7.4 MB images (37 MB in flight) 845-1,648 ms.

## Findings

1. **Latency is upload-bound.** ~0.2 s fixed plus bytes at ~11-12 MB/s (~95 Mbit/s, this
   link's upload). At ~27 MB, 10.1M text tokens took 2.49 s and 0.27M image tokens 2.20 s:
   37x the tokens cost ~0.3 s. Text and image bodies of equal bytes take about equal time.
2. **No 400 for prompts over the window.** Count Tokens returns the count (200) far above
   the 1M window (17.9M tokens at 49 MB). Over-window bodies need no special case: the count
   proves they do not fit.
3. **Size limit: 64 MiB, on both endpoints.** 67,108,864 bytes is accepted, one more byte
   is `413 request_too_large`, answered from Content-Length in ~0.2 s without the upload.
   `/v1/messages` behaves the same at the edge (probed with an unknown model and with
   `max_tokens: -5`, so no inference ran: 31, 40, 50 MB and 64 MiB got the validation error,
   64 MiB + 1 got 413). The documented 32 MB Messages limit was not hit before validation;
   a billable request was not tried.
4. Count Tokens does not apply Messages' per-image limits (a 10 MB base64 image counted).
5. **Rate limits:** none hit at 10 concurrent counts; ccc already cools down on 429.
6. **Why 3 s failed on the incident:** 27 MB alone is ~2.2-2.6 s on a fast link (plus ccc's
   parse and re-serialize of the count body); on a 10 Mbit/s uplink it is ~22 s. And the
   3 s was wall-clock from the request's first count, so a compression between the planning
   count and the replacement's count spent it: the replacement was never counted.

## Chosen allowance (src/count-tokens.ts)

`allowance(bytes) = min(30 s, 3 s + 1 ms per kB)` — the 3 s base for small bodies, then the
upload time at 1 MB/s (8 Mbit/s), ~12x slower than measured here; 17 MB gets 20 s, 27 MB
and above get the 30 s cap. A fast count returns as soon as it is done, so the margin only
costs time when the count is genuinely slow or hung.

- Per request, shared by all its counts: the allowance is the largest counted body's, and
  is spent only while a count is in flight (time spent compressing between counts is not
  charged). Total added latency stays at most 30 s per request.
- Bodies over 64 MiB are never counted and are known not to fit natively: planning
  compresses them; delivery never forwards them.
- No learned upload rate: the allowance binds only on failure, so a faster link gains
  nothing from a tighter one, and below ~1 MB/s the 30 s cap binds first.
- No counting in parallel with compression: the count decides whether to compress (a count
  can turn "compress" into "pass"), compression is a billed MemTree call, and a count of the
  largest incident body is ~2.5 s on a fast link.
- Claude Code's own request timeout (`API_TIMEOUT_MS`, 600 s default) is well above the
  worst case of 30 s of counting plus a 120 s long compression.
- The request log's `countTokens` entries now carry `bytes` and `timeoutMs` beside
  `statusClass` and `ms`.
