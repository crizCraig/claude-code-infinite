# Candidate selection and refusal audit

Audit scope: every `src/` path that can discard a candidate, refuse a request, or
choose a body by size. Searches covered byte/token comparisons, budget/context
helpers, `400`/`413`/`503` responses, `fitsFallbackBudget`, `fitsNative`,
`routedBodyExceedsContext`, refusal writers, and candidate construction returns.
Function names below remain the reference when edits shift line numbers.

## Model-request admission and candidate selection

| Location | Decision and justification |
| --- | --- |
| `request-sizing.ts`: `measure`, `select`, `fitsNative` | Owns body-local measurement and final native-window admission, including output reservation. Exact counts override byte guesses; failed/disabled counting uses upward-rounded body bytes/4. |
| `request-sizing.ts`: `register`, `excludeFallback` | Registers owned candidate snapshots. The proxy excludes a superseded main route when it no longer matches the current stable prefix; this is structural eligibility, not a size-based veto. |
| `request-sizing.ts`: `estimateRequestTokens` | Supplies advisory learned/byte sizing. It does not itself refuse. |
| `proxy.ts`: request policy `fitsNative` | Registers and measures replacement bodies through `RequestSizing`. A ride remains eligible for bounded recovery. |
| `proxy.ts`: active tool-route handling, existing followup ride, `forkRoutedBody` | Corrected early byte-only exclusions: history-valid candidates are registered before advisory size checks and preserved for central selection. |
| `proxy.ts`: `planEdgeCompaction` | Registers validated stable prefixes before comparing size. Comparisons trigger compression or change the planner's preferred fallback; registered candidates remain available to final selection. |
| `proxy.ts`: `planToolCompaction` | Registers validated prefixes before comparing size. Budget/window comparisons trigger recovery; they do not authorize final refusal. |
| `proxy.ts`: `calibratedSizeExceedsWindow`, `calibratedSizeExceedsLimits`, `budgetCompaction` | Choose compression policy/target. They are advisory and cannot remove registered candidates from selection. |
| `proxy.ts`: `routedBodyExceedsContext` | Byte-based advisory helper. Valid only for planning/retry decisions after candidates have been retained; early admission uses were identified above. |
| `proxy.ts`: index readiness, retry-growth, cooldown and in-flight checks | Bound compression attempts. The eventual body still goes through `forwardRaw` and central selection. |
| `proxy.ts`: `forwardCompressed` and `recoverToolRouteMiss` replacement preflight | Use the request policy's centralized measurement. Rejected replacements remain registered so eligible alternatives can be considered. |
| `proxy.ts`: ordinary tool recovery's `compressedRaw.length >= ...` check | Changes route-installation/recovery outcome for no byte gain. Preflight has already registered the replacement; final selection can still choose it. It does not discard the candidate from admission. |
| `proxy.ts`: post-delivery byte-size/backoff check | Bounds future compression attempts; it does not reject the delivery or remove its candidate. |
| `proxy.ts`: `recoverLateCount` | **Corrected with approval:** removed the byte-growth rejection. Structurally valid late replacements reach central measurement and selection regardless of byte growth. Main/tool regressions verify that a 250 KB replacement counted at 120k wins over a 200 KB ride counted at 210k; the 300k original is not sent. |
| `proxy.ts`: `selectForwardCandidate` | Uses centralized measurements for late-recovery triggering, selects centrally, and logs the selected body's over-budget status. It calls the refusal writer only when no candidate fits. |
| `proxy.ts`: `refuseWholeRequest` | Writes the centrally selected failure; no independent size calculation. |
| `proxy.ts`: `forwardRaw`, `forwardAccepted` | Sends the selected body. Route installation and response attribution follow the chosen bytes. Upstream rejection is relayed, not independently predicted here. |
| `route-fallback.ts`: `fitsFallbackBudget` | Export retained for compatibility/tests; no production source caller. It is not a second active admission path. |
| `route-fallback.ts`: `RouteFallbackFailures.fail` | Produces bounded 503 retries followed by 400 only after central selection fails. Per-lane capacity limits retry bookkeeping, not input size. |

## Structural candidate validation

These exclusions concern whether a body is a valid representation of the request,
not whether its tokens fit. They intentionally precede candidate registration.

| Location | Justification |
| --- | --- |
| `proxy.ts`: `prefixMismatch`, `memoryRoutedToolBody`, `prefixRoutedBody`, `validToolRouteSuffix` | Validate session/epoch, system and history identity, rewind/fork boundaries, and tool-result adjacency. A mismatched prefix is not an eligible candidate. |
| `proxy.ts`: `buildCompressedBody` and compression-result handling | Require usable canonical flattened messages and successful serialization. Missing/malformed results cannot become request bodies. |
| `proxy.ts`: route ownership/installation guards and reservations | Prevent stale or concurrent requests from installing another lane's route. They do not veto an already selected fitting delivery. |
| `proxy.ts`: cache TTL ordering and prefix preservation | Prevent invalid provider cache-control ordering or mutation of protected prefix content. |
| `route-cache.ts`: `capCacheBreakpoints` | Enforces provider cache-marker validity while preserving protected prefix bytes. Marker count is not token-window admission. |
| `memtree.ts`: flatten, nonempty-message and retained-history checks | Reject malformed, empty, or semantically unusable compression results. The retained-text floor is history-integrity validation, not a native-window estimate. |

## Other comparisons and HTTP error paths

| Location | Justification |
| --- | --- |
| `memtree.ts`: `clientOverThreshold`/compression cache key | Determines whether compression requests can share a result. Unknown comparison budgets must distinguish differing hints; known budgets use the threshold bit. No direct forwarding admission. |
| `count-tokens.ts`: sample plausibility and `shouldCountTokens` | Validate calibration and schedule selective counts, never refuse model requests. |
| `count-tokens.ts`: response byte cap and integer validation | Bound response memory and reject invalid count results; failures resolve to fallback rather than request refusal. |
| `count-tokens.ts` and `memtree.ts`: timeouts/abort/cooldowns/cache bounds | Bound time, retries and memory. They leave candidate fallback/admission to the proxy. |
| `proxy.ts`: `handleNoticeHook` 413/400/405 | Local hook payload size, schema and method validation; not forwarded model input. |
| `proxy.ts`: 403/404 paths | Local hook/control authentication and unsupported local endpoints; not size-based refusal. |
| `proxy.ts`: MemTree passthrough handlers and `sendAnthropicError` 502 | Upstream transport/service failures; not token sizing. |
| `proxy.ts`: `handleCountTokens` | Routes Claude Code's explicit Count Tokens request over validated conversation structure. The count endpoint returns its own result; it does not apply the message-forwarding refusal policy. |
| `proxy.ts`: sample retention and selected-candidate attribution comparisons | Choose calibration samples for later requests, not the current body's admission. |
| `proxy.ts`, `notices.ts`: indexed-token comparisons, numeric usage checks, text/notice limits | Usage validation and display policy only. |
| `resume-repair.ts`: recorded size/window comparisons | Existing transcript-repair eligibility, not proxy candidate selection or HTTP refusal. |
| `memtree-tools.ts`, `memtree-finder.ts` | Tool/search snippets, result formatting, line counts and traversal bounds; no model-window admission. |
| `transcript-usage.ts`, `prompt-accounting.ts`, `reqlog.ts`, CLI option parsing | Telemetry, bounded state/logs and option validation; no alternate message admission gate. |

The additional late-recovery issue above was reproduced with local mock servers
before its approved fix. Both main and tool regressions failed first, then passed.
No live provider requests were used. Server branch files were not changed.
