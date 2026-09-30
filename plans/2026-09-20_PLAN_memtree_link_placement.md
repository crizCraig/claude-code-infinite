# PLAN: MemTree Link Placement — where and when the page link appears

> Follows the MemTree link work on branch `memtree-link` (uncommitted as of
> 2026-09-20 in this worktree and in `~/src/polychat-memtree-view`, branch
> `memtree-view`). Touchpoints: `src/hooks.ts` (`NoticeDeliveryQueue.setLink`),
> `src/proxy.ts` (`noteMemtreePage`, `installMemtreeLink`,
> `queueCompressionNotice`), `src/notices.ts`, and server-side
> `polychat/routes/memtree_view.py`, `polychat/usage_request_link.py`.
>
> **STATUS 2026-09-20: OPTION B IMPLEMENTED AS DEFAULT, SWITCH IN PLACE.**
> `CCC_MEMTREE_LINK=message|stop|success|off` (`src/cli-args.ts`,
> `ProxyOptions.memtreeLinkPlacement`). The trailer slot lives in
> `NoticeDeliveryQueue.setTrailer` (`src/hooks.ts`); the success-line link is
> still there behind `success`. Option C (after the recap) is not built.
> Decide after the TUI trial, then delete the losing placements.

## What exists today

Server (polychat):

- Every compress response carries two headers: `X-Polychat-Memtree-Url`, the
  page for *this* request in its short spelling
  `https://app.polychat.co/m/<12 hex of the request id>`; and
  `X-Polychat-Memtree-Index`, the `chat_memory.messages_hash` of the completed
  index the turn was compressed against. Index-only acks and uncompressed
  turns carry no index header.
- The page for a request shows the request's own tree once the history job has
  built it, and the served index's tree until then
  (`usage_requests.served_messages_hash`, migration `t4s5u6n7o8p9`). A link
  followed from the terminal therefore never lands on a "building" page for a
  compressed request. Rows without a served hash (first turn, pre-migration
  rows) still answer 202 building.
- `/m/<short id>` and `/usage/memtree/<uuid>` are the same page; both routers
  accept both spellings. Ambiguous short prefixes resolve to 404 rather than a
  guess.

Client (ccc):

- `noteMemtreePage` records `{url, index, sessionId, seq}` from every
  main-conversation compress that carried both headers. The newest by
  submission order wins.
- `NoticeDeliveryQueue.setLink` supplies `{key: index, link: url}`; the queue
  shows a link once per distinct key, appended to the green success line:
  `✓ MemTree · conversation optimized · <url>`. The URL is rendered bare after
  the SGR reset so Claude Code's linkifier does not swallow the escape.
- `queueCompressionNotice` queues the success line when index coverage grew
  *or* a link with a new key is pending. Turns that reuse the same index with
  flat coverage stay silent.
- Nothing is ever added to Anthropic response bytes; all of the above rides
  the `MessageDisplay` / `Stop` hook plugin.

Net effect: the link appears on the first compressed turn and again whenever a
newly finished index is first used. Otherwise the terminal shows nothing.

## The question

The success-line placement is quiet, which is what "once per new index" asked
for, but it has two costs seen in the TUI:

1. The link is at the *top* of a message (index 0 of `MessageDisplay`), so
   after a long answer it has scrolled away by the time the user wants it.
2. When a turn reuses the same index, nothing is printed, so the user has to
   scroll back to find the last link.

Two alternative placements were raised. The user wants to try them in the TUI
before deciding.

## Option A — keep the success line (current)

No change. Link once per new index, top of message, Stop fallback for
tool-only turns. Cheapest, quietest, already tested (`test/hooks.test.mjs`,
`test/proxy.test.mjs` "the first success line links the page…").

## Option B — link under every message, marked when new

Show `∞ MemTree · <url>` as a trailer under the **final** `MessageDisplay`
flush of each assistant message, with a `Stop` fallback when a turn renders no
text. The link is always the newest page for the session. When the key (index)
changed since the last trailer, mark it, e.g.

```
∞ MemTree · new index · https://app.polychat.co/m/ea18af90658b
```

and render the unchanged case dimmer:

```
∞ MemTree · https://app.polychat.co/m/ea18af90658b
```

Mechanics (the queue had this shape for a day on 2026-09-19 before the
success-line placement replaced it; nothing survives in git, but it is small):

- `NoticeDeliveryQueue.setTrailer(resolve)` returning `{key, link}`; claim on
  `input.final === true` for main-thread `MessageDisplay`, and on `Stop`. Keep
  `lastKey` to decide "new". Blank line before the trailer so it reads as a
  footer, not part of the answer.
- `MessageDisplay.final` is per *message*, not per turn. In a tool loop every
  intermediate text message ("Reading proxy.ts now.") gets a trailer. If that is
  too noisy, the sub-option is Stop-only: one trailer per turn, but rendered by
  Claude Code as a `Stop says:`-style system line rather than inline text.
  Both can be tried; see the switch below.
- The success line drops its link in this option (otherwise the first turn
  shows it twice).
- Immediate: the trailer appears the moment the message finishes, no waiting
  for the recap.

Cost: one extra line per assistant message, most of them identical. The "new"
marker is what makes the repetition tolerable.

## Option C — link after the away recap

Facts established from the Claude Code 2.1.278 binary (strings in
`~/.local/share/claude/versions/2.1.278`), since the docs do not cover it:

- The recap comes from a forked hidden query: `querySource:"away_summary"`,
  `forkLabel:"away_summary"`, `maxTurns:1`, `skipCacheWrite`,
  `skipTranscript`, tools denied. Its prompt is the string ccc already matches
  in `isAwaySummaryUserMessage`.
- The result joins every text block of the assistant reply, caps it at
  **400 characters** (`f=400`, truncating the end), then stores it as a
  transcript entry `{"type":"system","subtype":"away_summary","content":…}`
  with ` (disable recaps in /config)` appended for the first few recaps.
  Verified in a real transcript
  (`~/.claude/projects/-Users-craigquiter-src-polychat-memtree-view/*.jsonl`).
  A `system` entry is UI-only: not model content, not replayed on `--resume`.
- Because the forked query's messages never render, `MessageDisplay` does not
  fire for the recap, and no hook fires after it. `Stop` fires before it.

So hooks cannot reach the recap. The only way to put a link after it is for
the proxy to append a text block to the recap *response*:

- On an away-summary request (`isAwaySummary`, main lane) with a known page,
  forward as now but rewrite the response: an extra text block
  `\n∞ MemTree · <url>` before `message_stop` (SSE,
  `SseNoticeRewriter.endOfTurnNotice`) or appended to `content` (JSON,
  `appendNoticeToJsonBody`). Both helpers exist in `src/notices.ts`, unused.
- Length guard: count streamed recap characters; append only if
  `chars + link.length <= 400`, else skip. Otherwise Claude Code clips the URL.
- No `<cc-infinite-notice>` marker. The marker exists to strip notices out of
  assistant content on later requests; this content never becomes assistant
  content, and the marker would render literally.
- Always the latest link, no once-per-index rule: a recap is shown when the
  user was away, and the link belongs with it every time.

Costs: it re-introduces response rewriting for one hidden request and breaks
the README line "Notices are never added to Anthropic responses". Safe today by
the transcript evidence, but a future Claude Code change that fed recap text
back to the model would leak a URL line into context (low harm). The recap
component renders plain text, so the URL is probably not clickable inside it;
terminal URL detection still works. And it only helps when a recap happens
(user was away); it is not a general placement.

## Recommendation

Build the switch, try A and B in the TUI, decide, then delete the losers.
C is a separate decision: it can be added on top of A or B later, and needs
its own README wording.

## Implementation: a placement switch for the TUI trial

- `CCC_MEMTREE_LINK=success|message|stop|off` read in `src/cli.ts`, passed as
  `ProxyOptions.memtreeLinkPlacement` (default `success`, current behavior).
- `NoticeDeliveryQueue` gains the trailer slot from Option B alongside the
  existing success-line link; `installMemtreeLink` in `src/proxy.ts` wires
  one or the other from the option.
  - `success`: as today.
  - `message`: trailer on every final `MessageDisplay` + Stop fallback; success
    line plain.
  - `stop`: trailer on `Stop` only (one per turn); success line plain.
  - `off`: no link anywhere (header still logged in the reqlog).
- "New" marker: trailer text is `∞ MemTree · new index · <url>` when the key
  changed since the last trailer shown, else `∞ MemTree · <url>` in dim
  (`\x1b[2m…\x1b[22m` on the label only; the URL stays bare).
- Tests: extend `test/hooks.test.mjs` with the trailer claim rules (final-only,
  Stop fallback, new/unchanged marker, no double-show) and one proxy test per
  placement using the existing `pageHeaders` mock helper.
- README: document the env var as experimental until a placement is chosen.

Not in the trial: Option C. If wanted, implement after the trial as its own
change with the 400-char guard and README update.

## Deploy notes (unchanged by placement)

Server first: `./polychat/deploy/migrate.sh staging` (now previews pending
revisions and SQL before the y/n), then `polychat/deploy/deploy.sh staging`.
Then `node dist/cli.js staging` from this worktree. Production in the same
order; publish ccc only after the production server is live, or new ccc shows
no links until it is.
