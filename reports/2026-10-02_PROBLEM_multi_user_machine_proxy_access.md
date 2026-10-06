# Other users on a shared machine can use a running ccc proxy

Status: open (found 2026-10-02 during the MemTree key-leak fixes on
`fix/memtree-key-leaks`).

## The problem

`ccc` runs an HTTP proxy on `127.0.0.1:<random port>` (`src/proxy.ts`,
`server.listen(0, "127.0.0.1")`). The loopback interface is shared by every
account on the machine, and the proxy has no way to tell which account sent a
request. Every route acts with the user's saved MemTree key, held in the
proxy's memory:

- `GET /memtree/<id>[.json]`, `/memtree/current`, `/memtree/sessions`,
  `/memtree/search`: read the user's MemTree pages, list their sessions and
  search across their trees. A vector search is charged to the user.
- `POST /v1/messages` with an `x-claude-code-session-id` header: indexes and
  compresses whatever conversation the caller sends on the user's account
  (cost, and content mixed into their trees).

On a multi-user host (a shared Linux dev box, a jump host, a lab machine) any
other local account can find the port, e.g. with `ss -ltnp` or by scanning the
ephemeral range, and use these routes as the ccc user. This does not reveal the
key itself, but it gives the same access as the key for as long as the session
runs.

## What is already defended

- Web pages: requests from browsers on other sites and DNS-rebound hostnames
  are refused on every route (`isLocalCaller` in `src/proxy.ts`: `Host` must be
  a loopback name, `Origin` must be this exact host and port, and
  `Sec-Fetch-Site` must be `same-origin` or `none`).
- The key at rest: `~/.claude-code-infinite/config.json` is `0600` in a `0700`
  directory, and older configs are tightened when read (`src/config.ts`).
  Before this, it was world-readable on most Linux machines, which was a worse
  form of this same exposure.

Requests from another local account carry none of the browser headers and use a
loopback `Host`, so those checks cannot stop them.

## Who is affected

Only a machine where an untrusted user can log in while someone runs `ccc`. On
a single-user laptop, the only other local callers run as the same user, and
they can already read the key file, so the proxy grants them nothing new.

## Fix options

1. **Per-session secret (recommended).** At startup, generate a random token
   and require it on every request. Claude Code would carry it in the base URL
   path (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<token>`), and the MCP
   server and hooks would get it via env. The proxy would strip the prefix
   before routing. The cost is that every caller needs it. The documented "use
   the loopback relay" path for agents (the 401 page on polychat, the MemTree
   MCP tools) would have to read it from the inherited env, which both already
   do for the base URL.
2. **Unix domain socket** in a `0700` directory instead of a TCP port. The OS
   enforces the account boundary, but Claude Code's `ANTHROPIC_BASE_URL`
   needs an HTTP URL, so this does not work for the main path.
3. **Peer credential check** (match the connecting socket's UID via
   `/proc/net/tcp` on Linux or `lsof`). It is platform-specific, racy, and
   unavailable on macOS without elevated tools. Not recommended.

## Until it is fixed

On a shared machine, run `ccc` only when other users are untrusted-but-absent,
or accept that other local accounts can read your MemTree data while a session
is open.
