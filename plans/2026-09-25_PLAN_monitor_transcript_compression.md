# PLAN: Compress the security monitor's transcript once it nears the window

**Status (2026-09-25): deferred, nothing built.** Today ccc forwards the
monitor verbatim (`turnType: "side-request"`, `src/cc-request.ts`,
`isClaudeCodeSideRequest` + `inspectMonitorTranscript`). This plan says when
and how to start compressing it.

## Why not now

- The monitor request (auto mode's security classifier) carries the session as
  one `<transcript>` user message: one single-key JSON object per line,
  `{"user": …}`, `{"<ToolName>": <input>}`, `{"meta": …}`. No assistant text
  and no tool results.
- Measured 2026-09-25 on an ~11.8 MB main session: monitor body ~1.1 MB,
  ~473k tokens, well under 1M.
- It already caches well: the transcript is append-only, so each call read
  ~472k cached tokens and wrote only a few hundred.
- Sending it through MemTree was pure cost ($1.21 passthrough + $0.18 index per
  call) and wiped the main tool loop's route. Both are fixed by the skip.

## Trigger

Start compressing when the monitor body's estimated tokens
(`approxInputTokens` in `requests.jsonl`) exceed **70% of the model's context
limit** (`contextLimitForModel`). Below that, forward verbatim: the monitor
should judge real history whenever it fits.

Watch for it:

```bash
python3 - <<'EOF'
import json, os
for l in open(os.path.expanduser("~/.claude-code-infinite/logs/requests.jsonl")):
    r = json.loads(l)
    if r.get("turnType") == "side-request":
        print(r.get("ts"), r.get("approxInputTokens"), (r.get("usage") or {}).get("cache_read_input_tokens"))
EOF
```

## Design (when triggered)

1. **Boundary.** Find where the main lane's last compressed route
   (`state.lastMainRoute`) keeps history verbatim. Anchor on text, as
   `polychat/memtree_coverage.py` does: the first `{"user": …}` line whose
   text matches the first human turn in the route's verbatim tail.
2. **Rewrite.** Replace the transcript lines before the boundary with the main
   route's memory text (already held by ccc, no MemTree call), as one
   `{"meta": "earlier history, summarized: …"}` line or a separate text block
   before `<transcript>`. Keep every line from the boundary on verbatim.
3. **Cache.** Put a `cache_control` breakpoint after the summarized block. It
   changes only when the main thread recompresses, so monitor calls within a
   turn keep hitting the cache.
4. **Never call MemTree** for the monitor. No index, no Context-Memory charge.
5. **Fail open.** Any parse failure, a missing anchor, or no main route:
   forward verbatim and log why.

## Format-change logging (built, 2026-09-25)

Every request shaped like the monitor (billing header, no `cc_turn_origin`,
zero tools) gets `transcript: {ok, reason, badLine, sample, lines,
userLines, toolLines, metaLines}` in its log line. `ok: false` means the
format did not match (`no-transcript`, `unclosed`, `bad-line`, `empty`), the
request was handled the old way, and stderr carries a warning. The rewrite
would add `reason: "no-anchor"` for a boundary it cannot place.

## Tradeoffs

- The monitor judges older history from summaries once compressed. Recent
  instructions and actions stay verbatim.
- The transcript format is internal to Claude Code. The logging above catches
  changes before they cost anything.
