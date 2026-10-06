# Deferred: prepare MemTree messages and transcript metadata together

Recorded during the scoped Ralph review at baseline `88f2815`, by user request.
Disposition: documented for later; not part of this review's implementation.

## Motivation

Compression obtains transcript usage and timestamps in the proxy, while background
indexing strips reminders and retains a parallel original-message list in the
MemTree client before invoking a timestamp callback. Session identity, agent
identity, and client metadata travel separately. The message-times fixes and the
`8773078` merge resolution illustrate the maintenance risk: a path can lose an
identity field or align metadata to a different message list.

## Proposed direction

Introduce a prepared request object containing the final messages, their mapping
to original messages, session and agent identity, client metadata, and transcript
metadata obtained from one snapshot. Compression and background indexing would
consume this object while retaining their distinct behavior. Resolve positional
metadata against the exact reminder-stripped message list being sent.

Affected areas: request preparation in `src/proxy.ts`, the client interface and
background indexing in `src/memtree.ts`, and `src/transcript-usage.ts`.

## Scope, risk, and verification

This is a medium-sized restructuring with moderate risk. Moving normalization can
change text matching, cache keys, and background behavior. Keep optional metadata
failures quiet and bounded, and preserve current session isolation and request
fallback behavior.

Use the existing offline mock-server tests to verify compression and background
indexing, split text blocks, reminder stripping, subagent transcripts, malformed
transcript records, missing or out-of-order times, and session attribution. Run
`npm test` and verify committed `dist/` matches a fresh build for each future fix.

The expected payoff is one testable alignment boundary and fewer opportunities
for identity or timestamps to diverge across request paths. This refactor is not
a prerequisite for fixing concrete defects in the scoped review. Broader proxy
routing changes remain outside this proposal.
