# PLAN: Don't Block on the First User Turn — Index Always, Compress Only After

> Refines the local proxy's compression decision
> (`plans/2026-06-09_PLAN_local_proxy_app.md`, "Compression decision" section and
> `src/proxy.ts` `handleMessages`). Client-only change in this repo; no server work required.

> **STATUS 2026-07-05: IMPLEMENTED (uncommitted — review pass pending).** All three
> deliverables landed:
>
> - **Turn classification** — `hasEarlierNonToolUserMessage` added to `src/turns.ts`;
>   `src/proxy.ts` `handleMessages` now three-way branches exactly per the table above
>   (first user turn = tool-turn path: background `index_only` POST + verbatim forward).
> - **Inline notices** — new `src/notices.ts`: marker constants, `stripNoticeBlocks`
>   (assistant-only, exact-envelope match, returns the same array identity when nothing
>   matched so untouched bodies stay byte-verbatim), `SseNoticeRewriter` (prelude
>   fabrication + index renumbering, end-of-turn append before `message_delta`/
>   `message_stop`), `appendNoticeToJsonBody` for non-streaming, `fabricatedPrelude`.
>   Strip pass wired into `/v1/messages` AND `count_tokens` on all paths before the dedupe
>   hash. `src/status.ts`, `src/statusline.ts`, and the `ccc-statusline` bin are removed;
>   README updated.
> - **Continuous transcript scrubber** — new `src/scrub.ts`: `fs.watch` watcher with
>   per-file offsets (new file ⇒ whole-file scan, the fork case), length-preserving
>   space-padded in-place pwrite patches of complete lines only, startup + exit sweeps
>   (rewrite + rename; also drops padding and now-empty notice-only lines). Wired into
>   `src/cli.ts` around the `claude` child lifecycle.
>
> **Verification (2026-07-05, CC 2.1.201, real `claude -p --model haiku` against mock
> MemTree — `npm run build`, 24 unit tests, and smoke scenarios a–e all pass):**
>
> - (a) First turn: only `index_only: true` MemTree calls; a recording front proxy
>   confirmed the forwarded Anthropic bodies were byte-identical (non-flattened) to what
>   CC sent.
> - (b) Two-user-turn conversation: exactly one blocking compression, on turn two; the
>   answer used the mock-compressed context; flattened body forwarded.
> - (c) Degraded alert: visible in CC output on compression failure; scrubbed from the
>   transcript in place (line space-padded, length preserved, all lines still parse);
>   stripped from the next forwarded request body on the wire; `claude --resume <id>`
>   from the patched transcript worked cleanly.
> - (d) ✨ prelude: fabricated at the 10s first-byte stall (mock upstream), upstream
>   answer streamed in after it with renumbered indexes, notice scrubbed from transcript.
> - (e) Thinking round-trip spike: a real signed thinking turn was recorded, a worst-case
>   history crafted (notice text block BEFORE the signed thinking block), and replayed
>   through the proxy with CC's own headers → Anthropic **200, accepted**; forwarded body
>   was notice-free with the signature preserved.
>
> **Spike results / findings (recorded per plan's residual-risk list):**
>
> - **CC munges the symlink-RESOLVED cwd** for its transcript dir (`/var/folders/...` ⇒
>   `-private-var-folders-...`). `projectTranscriptDir` calls `fs.realpathSync(cwd)`
>   first — without this the scrubber watches an empty wrong dir. Re-check on CC bumps.
> - **CC tolerates space-padded transcript lines**: resume from a patched (padded,
>   empty-content-shell) transcript worked; CC writes one line per assistant content
>   block and merges by message id, so a scrubbed shell contributes zero blocks.
> - **Negative control**: an UNSTRIPPED notice-before-thinking history replayed directly
>   to api.anthropic.com also returned **200** — the API is currently tolerant of the
>   feared prelude-before-thinking shape. Strip/scrub remains the safeguard since that
>   tolerance is non-contractual.
> - `-p`/SDK output shows the raw marker tags in the text (`<cc-infinite-notice>…`).
>   Per-design (marker is the contract), but a UX consideration for `-p` consumers.
>   Relatedly, `--output-format json`'s `.result` field is the LAST text block only, so
>   an appended end-of-turn notice becomes `.result`.
> - Fabricating the ✨ prelude drops the upstream `message_start` (we already sent a
>   synthetic one), losing its input-token usage numbers for that turn. Accepted cost.
>
> **Deviations from the plan text:**
>
> - Startup sweep covers only the CURRENT project's transcript dir, not "sessions from
>   other project dirs" — a notice left by a crashed session in project A is only swept
>   the next time `ccc` runs in project A. The continuous watcher + exit sweep make this
>   window small; revisit if it bites.
> - The ✨ timer arms only for `stream: true` requests (a fabricated SSE prelude is
>   meaningless on a JSON response); end-of-turn/degraded notices cover both shapes.

## Problem

The local proxy currently makes a blocking `/v1/context_memory` call on **every** real user
turn, including the very first message of a session. On the first turn there is nothing to
compress — the server has no index yet and returns the messages essentially as-is — so the
user pays a polychat round trip (worst case the full compress timeout — ~4s at the time of
this plan, since raised to 15s) of first-token
latency for a guaranteed no-op substitution. It also flattens a turn that didn't need
flattening, moving us away from byte-identical-to-vanilla on exactly the turns where vanilla
behavior is free.

## Decision

Two rules, replacing today's single `isUserTurn` branch:

1. **Every `/v1/messages` request keeps feeding the index.** Both tool turns AND the first
   user turn send the fire-and-forget background indexing POST (`index_only: true`,
   system-reminder-stripped, hash-deduped, off the response path). The index must keep pace
   with the conversation from message one so it's warm by the time the second user turn
   arrives.
2. **Block-and-substitute only on user turns after the first.** A "user turn after the
   first" is a request whose last message is a real user input (`isNonToolUserMessage`) AND
   whose message history contains at least one *earlier* real user input.

Note this is deliberately NOT a token-size threshold: even a small second turn should
compress (the server decides whether compression is worthwhile and can return messages
as-is), and even a huge first turn should not block (nothing is indexed yet regardless).

## Turn classification

For each POST /v1/messages body:

- `lastMsg` is not a real user input (tool_result wrapper, system-reminder-only, etc.)
  → **tool turn**: background index, forward verbatim. (Unchanged.)
- `lastMsg` is a real user input and it is the ONLY real user input in `messages`
  → **first user turn**: background index, forward verbatim. (New — was blocking.)
- `lastMsg` is a real user input and an earlier real user input exists
  → **followup user turn**: blocking compress + substitute, degrade to passthrough on
    failure. (Unchanged.)

Implementation: `messages.some(m, i < last, isNonToolUserMessage(m))` — reuse the existing
`isNonToolUserMessage` port in `src/turns.ts` (add a
`hasEarlierNonToolUserMessage(messages)` helper there, with tests alongside the audit-fix
cases: synthetic reminder messages and tool_result wrappers must not count as the "earlier
user input").

Nuances (consistent with the 2026-07-03 decisions in the parent plan):

- The "user stepped away" recap fork counts as a real user turn — so a recap fork on a
  conversation with prior user input will compress. Intentional, matches current behavior.
- A resumed session's first new user turn is NOT a "first user turn" — the transcript
  already contains earlier user inputs, so it compresses. Correct: the index likely exists
  from the prior run.
- Claude Code side-channel calls (topic detection etc.) that duplicate the main request are
  already hash-deduped in `MemtreeClient`; classification changes don't affect that.

## Inline alert delivery: inject-and-strip marked notices (decided 2026-07-05, v2)

Alerts must appear as inline messages in the transcript, not in the status line. Hook
`systemMessage` was considered (user-visible only per docs, installable via `--settings`)
but rejected for its timing tradeoffs: hooks fire only at event boundaries, so nothing can
appear mid-stall — exactly when the "✨" reassurance matters.

**Chosen mechanism: the proxy injects the notice into the response stream itself as
marker-wrapped assistant text, and strips those markers back out of every subsequent
request body before forwarding.** This works because the proxy sits on both directions of
the wire: the notice lands in Claude Code's UI and transcript like normal streamed text
(perfect timing control — emit at second 10 of a stall, or the instant compression fails),
and it never reaches the model because we remove it from replayed history before Anthropic
(or polychat indexing) ever sees it. This deliberately revisits the parent plan's "SSE
injection is off the table" rule — that rule assumed the injected text would pollute the
next turn's context; the strip pass is what removes that assumption.

Mechanics:

- **Marker format**: inject as a dedicated text content block whose text is exactly
  `<cc-infinite-notice>…notice text…</cc-infinite-notice>`. A whole dedicated block (never
  appended inside Anthropic's own text block) makes stripping exact: on request bodies,
  drop any assistant text block matching the marker envelope, and the surviving content is
  byte-identical to what Anthropic originally produced — important for replayed
  thinking-block signatures. Marker string is a stable public contract (resumed sessions
  strip correctly across client versions).
- **Streaming injection**: an SSE-rewriting layer in the proxy. For the mid-stall case
  (no upstream bytes yet), fabricate the stream prelude ourselves — `message_start`
  (synthetic id), `content_block_start`/`delta`/`stop` for the notice block — then when
  Anthropic's stream arrives, drop its `message_start` and renumber its content block
  indexes by +1, passing everything else (incl. `message_delta`/usage) through. For
  end-of-turn notices (degraded alert), append the notice block before `message_stop`
  instead — no prelude fabrication needed.
- **Non-streaming responses**: append the notice text block to `content` in the JSON body.
- **Strip pass**: runs on EVERY `/v1/messages` (and `count_tokens`) request body on all
  paths — compress, background-index, and passthrough — before hashing for dedupe (so
  hashes are stable whether or not a notice was present). Passthrough therefore becomes
  parse-strip-forward rather than byte-verbatim; the only bytes ever altered are ones we
  injected, which keeps the TOS posture intact (still: never touch auth, identity, or
  routing).
- **Transcript scrubbing (decided 2026-07-05; upgraded to continuous same day)**: notices
  are ephemeral timeline moments — they exist to explain a delay as it happens and are NOT
  wanted on resume. CC persists streamed content to its session transcript
  (`~/.claude/projects/<project>/<session>.jsonl`) and offers no don't-persist channel, so
  `ccc` scrubs them. Exit-only scrubbing misses live edge cases (fork/resume of an ongoing
  session from another terminal copies the notice into a NEW session file while the
  original still runs), so scrubbing is continuous:
  - **Watcher**: `fs.watch` on the project's transcript dir while the session runs
    (FSEvents on macOS — near-instant). On file change, scan only newly appended bytes for
    the marker (track per-file offsets); on new-file creation, scan the whole file — that's
    the fork case, since forking copies history (notice included) into a fresh .jsonl.
  - **Length-preserving in-place patch** (the reason continuous is safe): NO temp+rename
    while CC runs — rename swaps the inode under CC's open append handle and loses
    subsequent lines. Instead, re-serialize the affected line with the notice block
    removed, pad with trailing spaces to the original byte length, and pwrite it back at
    the same offset. Trailing whitespace is invisible to line-based JSON parsing; file
    size/inode never change; concurrent appends are untouched. Only patch complete
    (newline-terminated) lines — skip a tail line still being written.
  - **Backstop sweeps**: after `claude` exits and at every `ccc` startup (crashed sessions,
    watcher misses, sessions from other project dirs), where nothing is running so plain
    rewrite + atomic rename is fine; locate candidates by grepping for the marker.

    > **Amended 2026-07-06 — sweeps removed.** "Nothing is running" is unknowable: we
    > can't identify our own session's transcript (claude picks the session id), and an
    > mtime-quiet file can belong to a live-but-idle concurrent session that resumes
    > appending after the rename — silently losing the rest of its history. Since the
    > watcher's in-place patches (plus a byte-0 startup scan of pre-existing files and a
    > flush() pass at exit) already remove all notice *content*, the sweep only bought
    > cosmetic cleanup (space padding, empty shells — both harmless to CC) at the price
    > of a real data-loss window. Rewrite+rename is gone; in-place patching is the only
    > mechanism.
  On-disk notice lifetime shrinks to ~milliseconds, so resumes and forks are clean under
  BOTH `ccc` and vanilla `claude` — this eliminates the vanilla-resume failure (a "✨"
  prelude text block ahead of a thinking block can 400: the API requires replayed thinking
  turns to start with their thinking block) rather than merely mitigating it.

Alert triggers (now fully timer-capable again):

- **Degraded alert**: on blocking-compression failure, append
  "⚠ MemTree degraded — this turn ran uncompressed" to that turn's response. First user
  turns and background-index failures stay silent (no blocking call to degrade).
- **"✨" reassurance**: restored to the original timer design — if no first upstream byte
  within 10s after forwarding a compressed user turn, inject the fabricated prelude with
  "✨ Something special is happening — please wait…"; Anthropic's content then streams in
  after it. Never fires on first turns (they don't compress under this plan).

Residual risks / spike items:
- Verify CC renders a multi-text-block assistant message as expected and that `-p`/SDK
  output containing a notice block is acceptable (or gate injection to `stream: true`
  requests, which one-shot `-p` also uses — spike will tell).
- Verify signature-bearing (thinking) turns round-trip: inject → strip → Anthropic accepts
  the replayed history. The dedicated-block + exact-strip design is what makes this hold.
- Scrub-gap window: with the continuous watcher the on-disk lifetime is ~ms; remaining gap
  is watcher death + crash before any later `ccc` run (double fault). Defense-in-depth
  option if it ever bites: only inject the "✨" prelude when the request doesn't have
  thinking enabled. Keep notice text short and benign regardless.
- Verify scrubbed transcripts resume cleanly (`ccc` and vanilla) including a thinking turn
  that had a "✨" prelude injected, and that CC tolerates space-padded lines (it should —
  line-based JSON.parse — but verify /resume, fork, and `--resume <id>` against a patched
  file).
- Verify CC doesn't hold per-line byte offsets that padding would break (it re-reads files
  line-by-line today; re-check on CC version bumps since the padding contract depends on
  it).
- The status file and `ccc-statusline` bin are removed from the design (state the proxy
  needs is now in-process).

## Changes

1. `src/turns.ts`: add `hasEarlierNonToolUserMessage(messages: Message[]): boolean`
   (scan all but the last message with `isNonToolUserMessage`).
2. `src/proxy.ts` `handleMessages`: three-way branch per the classification table above.
   First-user-turn branch = the existing tool-turn branch (indexInBackground + forward
   verbatim).
3. Inline alerts: new `src/notices.ts` — marker constants, `injectNoticeBlock` (SSE
   prelude fabrication + index renumbering, end-of-turn append, non-streaming append) and
   `stripNoticeBlocks(messages)`; wire the strip pass into `handleMessages` (before
   hashing) and `count_tokens`; remove `src/status.ts` + `ccc-statusline`.
3b. Transcript scrubber: new `src/scrub.ts` — (a) continuous watcher (`fs.watch` on the
   project transcript dir, per-file offset tracking, length-preserving in-place line
   patches via pwrite, complete-lines-only) started by `src/cli.ts` alongside the proxy;
   (b) backstop sweep (rewrite + atomic rename, marker grep) run after `claude` exits and
   at startup before launching.
4. Tests/smoke: extend the mock-MemTree smoke script to assert the first `-p` turn produces
   an `index_only: true` call and a verbatim (non-flattened) Anthropic body, and that a
   two-user-turn conversation produces exactly one blocking compression call on turn two.
   Add the inject→strip round-trip spike (incl. a thinking/signature turn) from the alerts
   section.
5. Parent plan: update the "Compression decision" bullet and the alert-mechanism sections
   (inject-and-strip is now the decided mechanism; statusline and hook `systemMessage`
   are out).

## Risks

| Risk | Notes / mitigation |
|---|---|
| Giant first prompt (pasted file dump) goes to Anthropic uncompressed | Accepted: nothing is indexed yet, so blocking wouldn't have compressed it either. The index catches up in the background and the *next* user turn compresses. |
| First-turn indexing POST uploads the same bytes as the blocked call did | No regression — same payload, just off the response path now. Upload-bandwidth note in the parent plan still applies. |
| Misclassifying a followup as a first turn (synthetic user-role messages not recognized as real user inputs) | Earlier-turn scan uses the same audited `isNonToolUserMessage`; a missed synthetic shape errs toward passthrough (safe, vanilla-identical), not toward wrong substitution. |
