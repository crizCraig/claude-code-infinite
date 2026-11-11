# MemTree for the Claude desktop app's Claude Code (Code tab)

Status: prototype on `proto/desktop-app` (worktree `~/src/ccc-desktop` on the mini, branched
from `proto/https-proxy-rc`), not for release. Asked by Craig 2026-11-10: many new users have
the Claude desktop app (with its built-in Claude Code) rather than the terminal `claude`, and
ccc only wraps the terminal one. Measured on Claude desktop 5.1231.0 (Homebrew cask, installed
to `~/Applications` on the mini), Claude Code 2.1.322 and Node 24.22.2 on macOS (Apple M5 Pro),
unless a line says otherwise.

## Recommendation

**Build it as an opt-in "ccc desktop" mode, macOS first: a small always-on ccc service
(a launchd agent) that is the HTTPS proxy of the desktop sessions the user points at it,
reusing the terminal HTTPS-proxy mode's interception code. The user pastes six lines into
one of Desktop's saved local environments, once.**

- It is the only route that exists. Desktop starts its own copy of Claude Code with
  `ANTHROPIC_BASE_URL` forced to api.anthropic.com and its own OAuth token in the env, so ccc
  can't be its base URL and can't wrap the process (section 1). What the Code tab does
  honour is `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`, as the terminal proxy mode uses.
- Remote Control should keep working, because the base URL stays api.anthropic.com. Through
  the service, the CLI gets past the first-party check and stops only at "requires a
  full-scope login token" (the mini runs on a setup-token). Desktop hands its sessions a
  full-scope token, so the remaining check needs Craig's signed-in Desktop (section 7).
- Verified with the CLI run the way Desktop runs it: model turns went through MemTree, the
  memory tools appeared and worked, the project was attached, and billing stayed on the
  subscription. Section 5 has the evidence.
- Install time: setup takes 0.05 s for the CA, token and files, plus 0.5-0.6 s to register
  the MCP server (`claude mcp add-json`). Adding the launchd agent is one `launchctl`
  call. There are no new dependencies, and terminal ccc is unchanged.
- Keep it opt-in. A user has to paste lines into Desktop, and a stopped service makes those
  sessions fail outright (section 6). Ship it after the terminal HTTPS-proxy mode, sharing
  its CA, interception and Bash-env code.

## 1. How the desktop app runs Claude Code

The evidence comes from the docs (code.claude.com/docs/en/desktop, settings, network-config,
remote-control) and from reading the app's bundled JS. Nothing was patched or run beyond
`asar extract` into a scratch directory.

| Question | Finding | Evidence |
|---|---|---|
| What runs a Code-tab session | Desktop's own Claude Code binary, downloaded to `~/Library/Application Support/Claude/claude-code/<version>/claude`, driven through the Agent SDK (stream-json). It is versioned separately from the terminal `claude`. | Docs ("runs its own copy of Claude Code, which has its own version number"); bundle: `path.join(app.getPath("userData"),"claude-code")` |
| Launch env (Desktop's builder, local sessions) | Starts from Desktop's process env plus login-shell parity variables (PATH, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, `CLAUDE_CONFIG_DIR`, ...). Then the user's saved env vars and the session environment's vars are applied. Last, Desktop's own block **wins**: `ANTHROPIC_BASE_URL=<apiHost>`, `CLAUDE_CODE_OAUTH_TOKEN=<Desktop's token>`, `CLAUDE_CODE_OAUTH_SCOPES`, `ANTHROPIC_API_KEY=""`, `ANTHROPIC_AUTH_TOKEN=""`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `API_TIMEOUT_MS=900000` and others. | Bundle (the `Veo`/`jeo` env builder in `index.chunk-C6mgT-OL.js`); docs ("Moving yours to a settings file doesn't help, because Claude Code ignores that value in a local session") |
| `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` | **Honoured.** Desktop doesn't set them. A saved local environment's vars are passed through unfiltered for local sessions. The filter list that does name the proxy and CA vars applies only when the CLI runs off this host (Cowork VM). Docs: "In a local, SSH, or WSL Code tab session signed in through claude.ai, you can set these variables and the proxy variables in any settings file" and "To use your own proxy or certificate value in a local session, add it to a saved local environment." | Bundle (`cliRunsOnThisHost ? e=>e : e.mp`); docs |
| Where saved environment vars live | Desktop's environment editor, stored encrypted with Electron `safeStorage` (Keychain key) in `ccd-environment-config` (`envVars`, `scopedEnvVars`). **ccc can't write them**, so the user pastes. | Bundle |
| Settings files | The same `~/.claude/settings.json`, `~/.claude.json`, project `.claude/` and managed settings as the CLI. **Shared with the terminal `claude`.** | Docs ("Desktop and CLI read the same configuration files") |
| MCP servers | `~/.claude.json` (user scope) and `.mcp.json` work. Desktop re-delivers `~/.claude.json`'s stdio servers to the session. `claude_desktop_config.json` servers are loaded into Code sessions too (and into Desktop chat). | Docs |
| Hooks and plugins | Hooks and skills from settings apply to both apps. Plugins install through Desktop's "Add plugins" (user/project/local scope). | Docs |
| A wrapper/launcher | Desktop supports an org "managed launcher" (`processWrapper` or `env.CLAUDE_CODE_PROCESS_WRAPPER`). It is read **only from managed settings**, and when used, Desktop sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (which turns off Remote Control) and treats the provider as host-managed. **Not usable for ccc.** | Bundle (`index.chunk-CjenqunC.js`) |
| Remote Control | It is a feature of the CLI binary, which Desktop turns on via a switch, `/remote-control`, or "Connect new sessions to Remote Control". It is unavailable when `ANTHROPIC_BASE_URL` points elsewhere, with API keys, or with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. A proxy alone doesn't disable it. | Docs; terminal proxy-mode plan (2026-11-08) |
| Sign-in | Desktop signs in on its own and passes its token as `CLAUDE_CODE_OAUTH_TOKEN`. That is separate from the terminal CLI's credentials. | Bundle; docs (403 troubleshooting) |

## 2. Options

| Option | Verdict | Why |
|---|---|---|
| **(a) Always-on ccc service as `HTTPS_PROXY`, env pasted into a saved local environment** | **Chosen** | Reaches only the sessions the user opts in, keeps Desktop's base URL (and /rc), keeps Desktop's sign-in and billing, and reuses ccc's proxy unchanged. |
| (a') Same service, env in `~/.claude/settings.json` `env` (automatic, no pasting) | Rejected for v1 (maybe later as an advanced flag) | The file is shared with every terminal `claude` and terminal ccc. All of them would go through the service, and `DISABLE_AUTO_COMPACT` would apply to plain `claude` with no MemTree behind it. A stopped service would break every Claude Code on the machine. Terminal ccc's proxy-mode checks would also see a settings-level proxy and fall back. |
| (b) Only install ccc's MCP server and hooks for Desktop | Rejected as the main route | No compression: Desktop sessions still hit Claude Code's own compaction and window. The memory tools could search other ccc sessions but would have no tree for the current one. Worth keeping only as a "search my ccc history from Desktop" extra. |
| (c) Wrap Desktop's CLI (launcher, replacing the downloaded binary, or a `PATH` trick) | Rejected | The launcher is managed-settings-only and disables Remote Control. Swapping the binary in Desktop's data folder means tampering with a checksummed, auto-updated file. Desktop doesn't use `PATH` to find its binary. |
| (d) `ANTHROPIC_BASE_URL` to ccc | Impossible | Desktop overrides it last. |
| (e) A Desktop extension (`.dxt`) or `claude_desktop_config.json` MCP | Not enough alone | Same as (b), and it also adds the tools to Desktop chat, which has no ccc session. |

## 3. Design (as prototyped)

Prototype files: `src/desktop-service.ts`, `src/desktop-command.ts`, small changes in
`src/memtree-mcp.ts`, `src/cli-args.ts` and `src/cli-main.ts`, plus
`test/desktop-service.test.mjs`. It reuses `src/mitm-ca.ts` and `src/https-proxy-mode.ts` from
the terminal prototype without changes.

`ccc [staging|local] desktop setup|env|status|serve|uninstall`:

1. **setup** writes `~/.claude-code-infinite/desktop[-<mode>]/` (0700):
   - `ca.pem`, the public CA, 0644.
   - `leaf.pem` and `leaf-key.pem`, 0600.
   - `service.json`, holding the port, token, mode and validity (0600).
   - `bash-env.sh`.

   It then installs `~/Library/LaunchAgents/co.polychat.ccc-desktop[-<mode>].plist`
   (`node <ccc>/dist/cli.js [mode] desktop serve`, RunAtLoad and KeepAlive) and starts it with
   `launchctl bootstrap gui/<uid>`. It registers the `memtree` MCP server at user scope through
   `claude mcp add-json` (the terminal `claude`, else Desktop's downloaded copy), never by
   editing `~/.claude.json` directly. Finally it prints the lines to paste:
   ```
   HTTPS_PROXY=http://ccc:<token>@127.0.0.1:<port>
   NODE_EXTRA_CA_CERTS=~/.claude-code-infinite/desktop/ca.pem
   DISABLE_AUTO_COMPACT=1
   CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=1000000000
   CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=1000000000
   CLAUDE_ENV_FILE=~/.claude-code-infinite/desktop/bash-env.sh
   ```
   (The real lines carry absolute paths.) A re-run keeps the port and token, so the pasted
   lines stay valid, and rotates the CA at the same path.
2. **serve** is the service. It is one loopback `http.Server` on the fixed port, with
   `attachHttpsProxyMode` from the terminal prototype:
   - CONNECT without the token gets 407.
   - `CONNECT api.anthropic.com:443` is TLS-terminated with the leaf.
   - Every other CONNECT is a blind tunnel.
   - WebSocket upgrades on api.anthropic.com are piped raw.

   Decrypted requests are routed like this:
   - `POST /v1/messages` and `/v1/messages/count_tokens` with `x-claude-code-session-id` go to
     **that session's own ccc proxy**. That is an ordinary `startProxy()` in the same process,
     on its own loopback port, made on the session's first request. The service forwards to
     it as plain HTTP, so each Desktop session gets exactly what a terminal ccc session gets.
     The session's project (git repo, branch, commit) comes from the "Primary working
     directory" line of Claude Code's system prompt. It is set once a request carries it
     (often not the first: title and quota calls lack it); `proxy.ts` reads
     `opts.projectMeta` per request.
   - Everything else (bridge and Remote Control, OAuth, telemetry, files, session-less model
     calls) goes to one shared "fallback" `startProxy()`, which passes it through verbatim
     (session-less model calls are `foreign`).
   - Loopback (not intercepted) requests need the token in `x-ccc-proxy-token`, and only
     `/memtree/*` (the MCP server's reads, routed by session id) and `/ccc-desktop/status`
     exist. The terminal ccc's other loopback routes (hooks, notices) aren't exposed.
   - A session with no request for 6 h is drained and closed. Its final index runs as at a
     terminal ccc exit.
3. **The MCP server** is registered once at user scope. Every Claude Code on the account
   sees that entry, so it is **inert unless the session is routed through ccc**. It has
   `CCC_MEMTREE_MCP_DESKTOP=1`, and `desktopMcpTarget` picks its target in this order:
   - the ccc proxy named by its own `HTTPS_PROXY` (with the token);
   - else `CCC_MEMTREE_PROXY`;
   - else a loopback `ANTHROPIC_BASE_URL` (terminal ccc in base-URL mode);
   - else no tools and no instructions.

   Every compress call sends `x-memtree-tools`, since the server is registered.
4. **Bash tool**: `CLAUDE_ENV_FILE=bash-env.sh` unsets `HTTPS_PROXY`/`https_proxy` and
   `NODE_EXTRA_CA_CERTS` while they hold ccc's values, so curl and Python reach
   api.anthropic.com directly. The token is never in the file: it is matched by pattern.
5. **uninstall** runs `launchctl bootout`, removes the plist, `claude mcp remove --scope user
   memtree` and the directory, then tells the user to delete the lines in Desktop. Until they
   do, those sessions can't reach the API (section 6).

## 4. Security

- **CA lifetime.** A per-session CA (the terminal design) isn't possible: the pasted
  `NODE_EXTRA_CA_CERTS` path must hold across sessions and service restarts. So:
  - The CA is made at setup, signs one leaf, and **its private key is discarded at once**.
    It is never written, so no one can mint another leaf with it.
  - The CA keeps the terminal design's name constraints: permitted `DNS:api.anthropic.com`;
    excluded `.api.anthropic.com` and all IPv4/IPv6. Bun, Node and OpenSSL all enforce
    them (tested in the 2026-11-08 plan).
  - Only the **leaf key** persists (0600, in a 0700 dir). It can impersonate
    api.anthropic.com only to processes that trust this CA, which are the opted-in Desktop
    sessions (and their Node children; Bash gets the CA removed).
  - An attacker who can read that file already runs as the user and can read Desktop's own
    token store, so the leaf key adds little.
  - Build step: keep the leaf key in the macOS Keychain (`security` with an ACL limited to
    the service's node) instead of a file, and in DPAPI on Windows.
- **Rotation.** Validity is 365 days. `ccc desktop setup` rotates both certificates in place
  and restarts the service. Sessions started before the rotation then fail TLS until
  restarted.
  - Building it: rotate only when the service restarts with no live sessions.
  - Or (better) keep the old CA in `ca.pem` next to the new one for a grace period. Then the
    old sessions keep working, as long as the service also keeps serving the old leaf until
    they are gone (it can't tell sessions apart before TLS, so the service would need both
    leaves and SNI can't choose). This is an open point: the simplest safe rule is
    "rotate at restart, warn 30 days before expiry in `ccc` and in the session banner".
- **Never in the system trust store.** Trust comes only through `NODE_EXTRA_CA_CERTS` in the
  pasted environment.
- **Local access.** The port is fixed and long-lived, so every route needs the token.
  CONNECT without the token gets 407. Loopback routes without the `x-ccc-proxy-token` header
  get 403. Both were measured; see section 5.
  - The token sits in Desktop's encrypted environment store and in `service.json` (0600).
  - Desktop's sessions, their MCP servers and hooks see it in their env, same as the
    terminal design.
  - `ccc desktop setup --rotate-token` replaces it (re-paste needed).
- **What ccc sees.** The same as the terminal proxy mode: model calls (as today) plus Claude
  Code's other api.anthropic.com traffic, relayed verbatim and not logged (the trace has
  method, path, status and User-Agent only). Other hosts (Datadog,
  bridge.claudeusercontent.com) are blind tunnels.
- **Billing.** Requests keep Desktop's `Authorization: Bearer` (its OAuth token). The request
  log shows `claudeAuth: subscription` on every routed turn. ccc never adds or swaps
  credentials.

## 5. Prototype evidence

The test drove Desktop's code path with the CLI. It used the terminal Claude Code 2.1.322 with
Desktop's launch env: `ANTHROPIC_BASE_URL=https://api.anthropic.com`,
`CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_OAUTH_TOKEN`, `API_TIMEOUT_MS=900000`
and empty API keys, plus the six pasted lines. It ran with an isolated `HOME` (only a staging
ccc key; its own `~/.claude.json`) and the staging MemTree. The service was run by hand,
not by launchd (below).

| Check | Result |
|---|---|
| Traffic reaches the service | `CONNECT api.anthropic.com:443` intercepted. `POST /v1/messages` came in with UA `claude-cli/2.1.322 (external, claude-desktop)`. Event logging and settings were passed through; Datadog was tunnelled blind. |
| Model turns get MemTree | Request log: `first-user` and `tool` turns on the main lane, upstream 200, background index calls 200. With a 40k test budget, the follow-ups made blocking MemTree compress calls (200, 5,580 memory chars) and were forwarded (`followup-noop`), the same as terminal proxy mode on a small session. Over 3 resumed turns, the model still answered "which files did I first ask you to cat" correctly. |
| Billing | `claudeAuth: subscription` on every turn; `contextWindow: 1000000` natively (no custom base URL). |
| Memory tools | The model listed `mcp__memtree__list`, `read_lines`, `read_node` and `search`. `list` returned the current session through the service, with the token header. |
| Project attached | Session log: `session be28f7a3 project crizCraig/claude-code-infinite@proto/desktop-app`. `mcp__memtree__list` showed that repo, branch and commit. |
| MCP inert elsewhere | Same `~/.claude.json` with the MemTree entry, but no ccc lines (Desktop's plain env): "none" for `mcp__*` tools. |
| Bash tool | Inside a routed session: `proxy=none ca=none`, `curl https://api.anthropic.com/v1/models` → 401, Python `urllib` → 401 (direct; no TLS failure). |
| Remote Control gate | `claude remote-control` under the Desktop env plus the ccc lines got past the first-party check to "Remote Control requires a full-scope login token" (expected with the mini's setup-token). |
| Token checks | CONNECT without the token → 407. `/memtree/sessions` without the token → 403. A non-`/memtree` loopback path with the token → 404. |
| launchd | The plist is generated and passes `plutil -lint`. **Not bootstrapped live**: the worker's permission classifier denied installing a launch agent on the mini, which is a persistence change. It needs Craig's go-ahead or his own run (section 7). |
| Tests | Full `npm test`: 1333 pass, 9 fail. The same 9 (`resume-repair`, `memtree-cache`) fail on the untouched `proto/https-proxy-rc` base on this machine. `test/desktop-service.test.mjs` (4 tests, all pass): cwd parsing, MCP target and inert mode, and an end-to-end service test against a fake upstream (407, TLS with the pinned CA, session routing with the original `Authorization`, verbatim passthrough, 403/404). |

Not checked yet, because they need Craig's signed-in Desktop: the real Desktop app running its
own downloaded binary through the service; Desktop's Remote Control switch; the
environment-editor UX; and a session started without the lines staying unchanged.

## 6. What breaks or changes

| Area | Effect | Handling |
|---|---|---|
| Service not running (crash, uninstall without removing the lines, node removed or upgraded) | Opted-in sessions fail every API call ("Unable to connect"); other sessions are unaffected | launchd KeepAlive. The plist pins the node path, so after an nvm/Homebrew node upgrade, `ccc` (terminal) should notice and rewrite it. `ccc desktop status`. The off switch is to pick a different environment in Desktop. |
| Sessions not started from the ccc environment | Unchanged; the MCP entry is inert | — |
| Terminal `claude` (plain) | Unchanged: it gets the inert MCP entry (no tools, a tiny node process per session) | Could be avoided only with a Desktop-only config path, and there isn't one besides `claude_desktop_config.json` (which also reaches Desktop chat). |
| Terminal ccc | Its own `--mcp-config` `memtree` and the user-scope one have the same name. Whichever Claude Code keeps, it reaches the same proxy (`desktopMcpTarget` falls back to `CCC_MEMTREE_PROXY` or the loopback base URL) | Check which wins when building, and keep ccc's flag config authoritative. |
| User already has a proxy or corporate CA | The pasted `HTTPS_PROXY` replaces theirs for those sessions: blind tunnels and ccc's upstream go direct | Same as terminal v1: setup detects a proxy in the env, settings or shell, warns, and doesn't offer the mode. The corporate CA can be bundled into `ca.pem` at setup. |
| MCP servers and hooks launched by the session | They inherit the proxy and CA: Node ones work; non-Node ones calling api.anthropic.com fail TLS (same as the terminal design, section 5 of the 2026-11-08 plan) | The same decision as the terminal design (a full CA bundle via `SSL_CERT_FILE`, or document it). |
| Claude Code's Bash sandbox | Same issue as terminal proxy mode: the sandbox's proxy forwards through ours with the token | Same handling as terminal v1 (detect and refuse at setup; later `sandbox.network.parentProxy`). |
| Desktop updates | It re-downloads its CLI; nothing ccc installed is touched. Breaks if Desktop ever forces `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` or filters them for local sessions | Daily e2e can't drive Desktop; add a check that greps a new Desktop build's env builder (cheap), or rely on users' reports via the service's "no intercepted /v1/messages" warning. |
| Cowork, SSH and cloud sessions in Desktop | Not covered (the CLI runs elsewhere; Cowork filters the proxy vars) | Out of scope. |
| ccc self-update | The service runs the installed ccc's `dist/cli.js`; an npm update replaces files under a running service | Restart the service on update (the auto-updater already knows ccc's paths); sessions keep their per-session proxies in memory until then. |

## 7. Windows

Desktop is the same Electron app with the same env builder. Saved environments and
`HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` work the same way (per the docs).

- **Service.** A per-user Scheduled Task at logon (`schtasks /create /sc onlogon /rl limited`)
  or a Startup-folder shortcut, running `node.exe ... desktop serve` hidden. No admin needed.
- **Keys.** The leaf key goes in DPAPI (`CryptProtectData`) or under `%LOCALAPPDATA%` with the
  user-only ACL.
- **Blocker, the same as the terminal design.** The PowerShell tool doesn't apply
  `CLAUDE_ENV_FILE` (non-`export` lines, and `/` or `\` values are dropped on Windows). So
  PowerShell commands keep the proxy and CA. Desktop on Windows defaults to PowerShell more
  often than terminal users do, so this matters more here.

  Options:
  - give children a full CA bundle (system roots + ours) via `SSL_CERT_FILE`,
    `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE`, so curl and Python trust the leaf and still
    work through the proxy;
  - or leave Windows out of v1.

  Recommendation: macOS first, then Windows once the CA-bundle approach is chosen for the
  terminal mode.

## 8. Install-time and UX

- `npm install`: +0 s (nothing at install).
- `ccc desktop setup`: 0.05 s for the files, 0.5-0.6 s for `claude mcp` (measured), and one
  `launchctl bootstrap`.
- The service's memory: 103 MB RSS measured after serving ~10 test sessions (Node baseline
  plus one in-process proxy per session; idle sessions are closed after 6 h).
- One manual step: paste six lines into Desktop's environment editor (Code tab →
  environment menu → add or edit a local environment). After that, new sessions in that
  environment get MemTree.
- To make it findable: terminal ccc already detects a Desktop-only machine
  (`claudeDesktopInstalled`) and today tells the user to install the CLI. It should offer
  `ccc desktop setup` instead. A first-run `npx claude-code-infinite desktop` path lets
  Desktop-only users skip the terminal `claude` entirely, since setup can use Desktop's
  downloaded CLI for `claude mcp`.
- Notices (the payment gate, "update available", session banners) have no terminal in
  Desktop. They should come through the SessionStart hook's `additionalContext` or the MCP
  instructions. This isn't in the prototype; the prototype skips ccc's key and payment check
  at service start.

## 9. Building it for real

1. Share code with the terminal HTTPS-proxy build:
   - one `mitm-ca.ts` (plus a "persistent leaf" variant);
   - one interception module;
   - one `bash-env` writer.
2. Service hardening:
   - key and payment checks at start, and again when the key changes;
   - the leaf key in the Keychain;
   - a rotation policy (section 4);
   - restart on ccc update;
   - rewrite the plist when node moves;
   - a "no intercepted `/v1/messages` while Desktop is active" warning;
   - a stale-session sweep.

   Also, forward intercepted requests to the session proxies with a marker, so they route
   like intercepted ones and never as loopback callers.
3. Setup checks:
   - an existing proxy, CA or sandbox (as terminal v1);
   - Desktop installed;
   - clipboard copy of the lines;
   - `ccc desktop status` showing sessions served in the last day.
4. Notices through hooks or MCP instructions instead of a terminal.
5. Tests:
   - the service with a fake upstream (started);
   - SSE streaming through the session proxy;
   - the upgrade path;
   - idle close;
   - plist/launchctl argv;
   - the MCP name clash with terminal ccc.
6. Windows (section 7), then dogfood, then announce.

## 10. What Craig needs to do to test it (needs his GUI login on the mini, or his laptop)

On the Mac where Desktop is signed in:

```bash
git -C ~/src/claude-code-infinite fetch origin proto/desktop-app
git -C ~/src/claude-code-infinite worktree add ~/src/ccc-desktop origin/proto/desktop-app   # on the mini it exists
cd ~/src/ccc-desktop && npm ci && npm run build
node dist/cli.js staging desktop setup        # or without `staging` for production MemTree
node dist/cli.js staging desktop status       # "service listening on 127.0.0.1:<port>"
```

1. Copy the six printed lines. In Desktop: Code tab → environment selector → add a local
   environment (e.g. "ccc"), paste the lines into **Environment variables**, and save.
2. Start a new local session from that environment in any git project. Ask "list the
   mcp__memtree tools you have", then do a few tool-using turns.
3. Check `/status` in the session for the Claude Code version Desktop runs, then:

   ```bash
   tail ~/.claude-code-infinite/desktop-staging/service.log
   ```

   Expect `session <id> proxy on :<port>` and `project <repo>@<branch>`. Then:

   ```bash
   tail -5 ~/.claude-code-infinite/desktop-staging/requests.jsonl
   ```

   Expect `first-user`/`tool` turns with `claudeAuth: subscription`.
4. Turn on **Remote Control** for that session (the switch, or `/remote-control`). Open it on
   the phone or claude.ai/code and send a message that uses a tool. Leave it idle for 5+
   minutes and send another. Note anything that fails.
5. Start a session from Desktop's default environment: it should behave as before, with no
   memtree tools.
6. Undo: `node dist/cli.js staging desktop uninstall`, then delete the "ccc" environment in
   Desktop.

To trace /rc: before step 1, run `launchctl setenv CCC_PROXY_TRACE /tmp/ccc-desktop-trace.jsonl`,
then `launchctl kickstart -k gui/$(id -u)/co.polychat.ccc-desktop-staging` (or run
`desktop serve` by hand in a terminal with that variable instead of launchd). Then grep the
trace for `bridge`, `connect_refused` and `tls_error`, as in the 2026-11-08 plan's section 7.
