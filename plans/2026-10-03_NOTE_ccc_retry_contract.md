# Claude Code retry contract checked for route rebuild failures

Inspected the embedded JavaScript in the installed native executable
`~/.local/share/claude/versions/2.1.288` on 2026-10-03. These are version-specific
findings, not guarantees for future Claude Code releases. No API requests were made.

## Transient responses

The main query constructs its SDK client with `maxRetries:0` and uses its own
`Kle` retry loop. `lFe` selects 10 retries by default; ordinary environment overrides
are clamped to 15. Its `eWo` predicate retries HTTP statuses at least 500 unless
`x-should-retry:false` applies. HTTP 503 with `api_error` therefore retries.

`DL` calls `kC` with base 500ms, factor 2, cap 32,000ms and proportional positive
jitter of up to 25%. The first delays are 500–625ms, 1,000–1,250ms and
2,000–2,500ms; the maximum is 32–40 seconds. Integer `Retry-After` seconds sets
a minimum. `Retry-After:1` produces a first delay of one second. Ordinary retries
reject a calculated delay above 60 seconds.

HTTP 529 also retries, but has special behavior: background requests may stop
immediately, and some models switch fallback or stop after three consecutive
overloads. Watchdog mode can retry 529/429 indefinitely by decrementing the attempt
counter. Avoid 529 for this local failure; ccc must impose its own attempt and
rebuild-duration bounds instead of relying on Claude Code's defaults.

## Exhaustion response

Use HTTP 400, `invalid_request_error`, and `x-should-retry:false`, with a message
specific to ccc rebuild exhaustion. Avoid known recovery phrases such as
`overloaded_error`, `request_too_large`, `prompt is too long`, `context window`,
or the max-tokens/context-limit wording. The overload string check precedes the
retry header check.

A configured fallback model can still be tried after a generic non-retryable 400.
Keep the exhausted budget for the same session/lane/history across model changes;
switching models must not create another transient retry allowance. Do not describe
400 as a guarantee of zero further HTTP requests from Claude Code.

Do **not** use HTTP 413 as a terminal response. Although `Yjo` excludes 413 from
the retry loop's last-resort model fallback, outer recovery handles it:

- `dEt` recognizes every 413; the formatter emits error details beginning with
  `request_too_large:` for generic 413 responses.
- `$Zn` recognizes that literal; `Sne` and `CVn` classify the resulting error as
  recoverable.
- The outer query's `A || W` branch invokes `AVn` reactive compaction and can retry
  with changed history, even without a prompt-too-long message.

## Offline verification

Extracted only the pure `kC` and `DL` functions and evaluated them in a Node `vm`
context with deterministic random values 0 and 1. Verified all ten retry-delay
intervals, plus `Retry-After:1` (1,000ms initially) and `Retry-After:0` (500ms).
Inspected the main client's `maxRetries:0`, `Kle`, `eWo`, `lFe`, formatter and outer
recovery branches directly. Temporary evidence is in
`/tmp/claude-2.1.288-retry-evidence.txt` (including executable byte offsets) and
`/tmp/claude-2.1.288-retry-extract.txt`; these are investigation artifacts, not
runtime dependencies.
