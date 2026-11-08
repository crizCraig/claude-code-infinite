# HTTPS-proxy mode: Remote Control (/rc) in ccc sessions

Status: prototype on `proto/https-proxy-rc` (worktree `~/src/ccc-rc-proxy`), not for release.
Asked by Craig 2026-11-08 ("yeah let's try it. tell me how long it extends install time as
well"). Everything below was measured on Claude Code 2.1.319 (Bun 1.4.4), Node 24.22.2, macOS
(Apple M5 Pro), unless a line says otherwise.

## Recommendation

**Build it, opt-in first (macOS and Linux; Windows, Claude Code's Bash sandbox and
settings-level proxy/CA config stay in today's mode until their gaps are solved), with a
per-session CA instead of a per-install one.**

- Remote Control works in principle: with ccc as Claude Code's `HTTPS_PROXY` instead of its
  `ANTHROPIC_BASE_URL`, `/remote-control` shows up in a ccc session and its eligibility
  check gets past the first-party gate. Model calls still go through MemTree (first, tool
  and follow-up turns all checked against staging). The one thing not yet checked is a live
  bridge session, which needs a full-scope `claude auth login` (steps at the end).
- Install time: **unchanged**. Nothing happens at install. Each session start makes a fresh
  ECDSA P-256 CA and leaf: 1.9-3.5 ms inside ccc here; 2-9 ms for the generation alone
  on the CI runners (plus a one-off 6-15 ms module load). No new dependency. The npm
  tarball grows by 10.5 KB.
- Security: better than the proposed per-install CA. The CA key exists only in the ccc
  process's memory for one session and is never written to disk. The CA is name-constrained
  to the DNS name `api.anthropic.com` with every IP address excluded, so even a leaked key
  can't vouch for any other host name, subdomains included (Claude Code enforces this for
  other names; Node and OpenSSL for subdomains) or IP address (Node
  and OpenSSL enforce this; Bun not yet tested for IPs). Nothing persists, so nothing
  needs revocation, rotation or Windows ACLs.
- Ship it behind a switch (`CCC_HTTPS_PROXY_MODE=1`, later a config key). It falls back to
  today's base-URL mode when the user already has a proxy, proxy/CA settings in Claude
  Code's settings, the Bash sandbox, or Windows (see "Existing users"). Make it
  the default after Craig's end-to-end /rc check and a week of dogfooding. A side benefit
  argues for making it the default eventually: Claude Code no longer needs the internal
  first-party override (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`); it reaches ccc through
  `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`, both documented for corporate proxies. (ccc's
  other env overrides, such as the blocking limit and resume threshold, are unchanged, and
  Bash commands still get the first-party variable, as today, for nested `claude` runs.)

## 1. Validation (what was unknown, and what was observed)

| Question | Result | Evidence |
|---|---|---|
| Does `/rc` need `ANTHROPIC_BASE_URL` unset? | Yes, confirmed | `claude remote-control` with `ANTHROPIC_BASE_URL=http://127.0.0.1:9` + the assume-first-party var: "Remote Control is only available when using Claude via api.anthropic.com ... (_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL does not apply to Remote Control.)" |
| Does `HTTPS_PROXY` alone pass the first-party gate? | Yes | Same command with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` and no base URL: it gets to the next check, "Remote Control requires a full-scope login token" (this Mac mini runs on a setup-token). Vanilla `claude` gives the same message. |
| Under real ccc, interactive | `/remote-control` appears and runs | PTY-driven `ccc staging`. Today's mode: "Unknown command: /remote-control". Proxy mode: listed as "Control this session from your phone or claude.ai/code", and running it stops only at the full-scope-token check. |
| Does Claude Code honour `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` for api.anthropic.com? | Yes | All of its api.anthropic.com traffic arrived as `CONNECT api.anthropic.com:443` and completed TLS against the session CA. Seen decrypted: `/v1/messages` (200), `/api/claude_code/policy_limits`, `/api/claude_code/settings`, `/api/claude_cli/bootstrap`, `/api/event_logging/v2/batch`, `/api/eval/sdk-*`, `/mcp-registry/v0/servers`. Datadog (`http-intake.logs.us5.datadoghq.com`) was tunnelled blind. |
| `CLAUDE_CODE_HTTPS_PROXY` instead of `HTTPS_PROXY`? | No | With only that variable set, nothing reached the proxy (model calls went direct). `HTTPS_PROXY` is required. |
| Do model calls still reach MemTree? | Yes | staging, `requests.jsonl`: first-user turn forwarded 200 with background index ok; tool turn 200; a `--continue` follow-up made a blocking MemTree compress call (200, 1225 memory chars) and forwarded it (`followup-noop`, 200). Claude Code reported `contextWindow: 1000000` natively. |
| Does Claude Code (Bun/BoringSSL) enforce the CA's nameConstraints? | Yes | A leaf for `localhost` signed by a CA constrained to api.anthropic.com: "Unable to connect to API (PERMITTED_VIOLATION)", and the test server saw 0 requests. Control (a CA constrained to localhost): 7 requests reached it. Node/OpenSSL also reject (`openssl verify`: "permitted subtree violation"). An IP-address leaf is rejected too, after review r1 added excluded subtrees for all IPv4/IPv6 (`openssl verify`: "excluded subtree violation"; Node TLS rejects; `test/mitm-ca.test.mjs`). |
| Does Claude Code send proxy credentials on CONNECT? | Yes | With `HTTPS_PROXY=http://ccc:<token>@127.0.0.1:<port>`, all 11 CONNECTs carried the matching `Proxy-Authorization: Basic`. Its CONNECTs carry no User-Agent (only `host`, `proxy-connection`). |
| What do programs started from Bash see? | Fixed via `CLAUDE_ENV_FILE` (Bash tool only; see section 5 for hooks, status lines, MCP, PowerShell) | Without a fix, `curl` and Python `urllib` to api.anthropic.com failed (`SSL certificate problem` / `CERTIFICATE_VERIFY_FAILED`), because they inherited `HTTPS_PROXY` but not our CA. With `CLAUDE_ENV_FILE` (Claude Code sources it before every Bash command) restoring the user's own proxy and CA variables and today's `ANTHROPIC_BASE_URL`, the probe's output matched today's mode line for line: curl/urllib/node 401 direct, `$ANTHROPIC_BASE_URL/v1/models` 401 via ccc's foreign passthrough. |
| Bridge traffic through the proxy | Not observed yet | It needs a full-scope login. The binary shows `/v1/environments/bridge`, `.../work/poll`, `.../ack`, `/worker/events/stream` (SSE), and an SSE/POST transport. The prototype forwards all of these verbatim (`passThroughStreaming` streams SSE) and pipes any WebSocket upgrade raw to api.anthropic.com. Also unverified: whether Bun's WebSocket client (used for `wss://bridge.claudeusercontent.com`, created with the proxy URL) sends the proxy token on its CONNECT; if it doesn't, ccc answers 407 (traced as `connect_refused`). |

How the probes were run: an isolated `HOME` (holding only a staging ccc key) and
`CLAUDE_CONFIG_DIR`, with the token from `~/.claude-token.env`. The orchestrator's login and
ccc config were not touched.

## 2. Design (as prototyped)

Prototype files: `src/mitm-ca.ts`, `src/https-proxy-mode.ts`, plus small hooks into
`src/proxy.ts`, `src/claude-env.ts` and `src/cli-main.ts`. It is turned on with
`CCC_HTTPS_PROXY_MODE=1`. `CCC_PROXY_TRACE=<file>` logs CONNECT targets and each intercepted
request's method, path, status and User-Agent (no other header values, no bodies).

1. **Session CA** (`mitm-ca.ts`, no dependencies). `node:crypto` makes the P-256 keys and
   signatures; about 200 lines (with comments) write the X.509 DER around them. The CA has
   `basicConstraints CA:TRUE, pathlen:0`, `keyUsage keyCertSign`, critical
   `nameConstraints` (permitted `DNS:api.anthropic.com`; excluded `DNS:.api.anthropic.com`
   (its subdomains, which a permitted DNS name would otherwise include), `IP:0.0.0.0/0` and
   `IP:::/0`, since RFC 5280 leaves unlisted name forms unconstrained), and is valid for 365 days from
   yesterday (a session can run for weeks; the key dies with the process anyway). The leaf
   has SAN `api.anthropic.com` and EKU serverAuth. The CA key is a local variable: it is
   never exported, stored or reused.
2. **Trust for the child only.** The CA *certificate* (public) is written into a fresh
   `mkdtemp` directory (0700) as `ca-bundle.pem` (0600). The user's existing
   `NODE_EXTRA_CA_CERTS` file comes first in the bundle, so corporate CAs keep working. The
   child gets `NODE_EXTRA_CA_CERTS=<bundle>`. Nothing goes into the system trust store or
   keychain. The directory is removed on exit.
3. **Claude Code's env**: `HTTPS_PROXY=http://ccc:<per-session token>@127.0.0.1:<port>`, no
   `ANTHROPIC_BASE_URL`, no `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, `https_proxy`
   removed, `CCC_MEMTREE_PROXY=http://127.0.0.1:<port>` (the MemTree MCP server already
   prefers it), `CLAUDE_ENV_FILE=<dir>/bash-env.sh`. The other ccc settings (auto-compact
   off, blocking limit, resume threshold) are unchanged.
4. **The loopback server takes CONNECT** (`https-proxy-mode.ts`, attached to the existing
   `http.Server`):
   - A CONNECT without the session token gets 407, so other local users and programs can't
     use the tunnel or the interception.
   - `CONNECT api.anthropic.com:443`: reply 200, wrap the socket in a server
     `tls.TLSSocket` (leaf cert, ALPN http/1.1), and `server.emit("connection", tlsSocket)`.
     The same server parses the decrypted requests. `handleRequest` sees the socket is
     intercepted and routes only `POST /v1/messages` and `POST /v1/messages/count_tokens`
     to the MemTree handlers. Every other path (bridge, sessions, files, telemetry, OAuth
     profile) goes to `passThroughStreaming`, verbatim. The loopback-only routes (hooks,
     `/memtree/*`) are not reachable over this path.
   - Any other CONNECT: a blind TCP tunnel. ccc never decrypts it.
   - A WebSocket upgrade on an intercepted stream is piped raw over a new TLS connection to
     api.anthropic.com.
5. **Bash keeps today's environment** (`bash-env.sh`, sourced by Claude Code before each
   Bash-tool command). It puts back the user's own `HTTPS_PROXY`, `https_proxy` and
   `NODE_EXTRA_CA_CERTS` (or unsets them) **only while each still holds ccc's value**
   (`case "${HTTPS_PROXY-}" in http://ccc:*@127.0.0.1:<port>)`, so the token itself is
   never written to the file; `https_proxy`, which ccc removed from Claude Code's env, is
   restored in the same branch). Claude Code's Bash sandbox sets its own proxy and CA before
   the file is sourced, and those survive (checked by sourcing the generated file under
   sandbox-like values). It also restores `CLAUDE_ENV_FILE`, `CCC_MEMTREE_PROXY` and
   `CCC_HTTPS_PROXY_MODE` to the user's values, exports today's
   `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and
   `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, then sources a `CLAUDE_ENV_FILE` the user
   already had (only if it is readable, as Claude Code itself does). So scripts, SDK apps, `$ANTHROPIC_BASE_URL/memtree/...` (the guidance
   polychat's MemTree pages give agents) and a nested ccc started from Bash behave as
   today, and none of them sees the proxy token. (Claude Code caches an env file's
   content; the `. <user file>` line makes the user's file re-read on each command
   instead, which is harmless.)

## 3. Numbers (Craig's ask)

### Install time

**+0 s.** Nothing runs at `npm install` or in postinstall, and there are no new
dependencies. The only cost is per session (next table). A per-install CA, as first
proposed, would add the same few ms once, at first run, plus a key file to protect. Install
time stays at 0 either way.

### Per-session CA + leaf (what each ccc start pays)

"cold" is a fresh `node` process: module import plus the first `createSessionCa()`. "warm"
is the median of later calls in the same process.

| Machine | Node | EC P-256 cold (import + create) | EC warm | RSA-2048 first / median / max |
|---|---|---|---|---|
| macOS, Apple M5 Pro (this Mac mini) | 24 | 1-4 ms + 2.1-2.4 ms | 0.16 ms | 25-70 / 38-57 / 75-114 ms |
| macOS runner, Apple M1 (virtual) | 24 | 8-11 ms + 4.5-7.6 ms | 0.43 ms | 174 / 129 / 277 ms |
| macOS runner | 20 | 6-7 ms + 4.0-4.3 ms | 0.51 ms | 437 / 351 / 631 ms |
| Ubuntu runner, AMD EPYC 9V74 | 24 | 7 ms + 4.0-7.1 ms | 0.45 ms | 46 / 96 / 166 ms |
| Ubuntu runner | 20 | 7 ms + 3.6-3.7 ms | 0.67 ms | 300 / 261 / 514 ms |
| Windows runner, AMD EPYC 7763 | 24 | 12-14 ms + 7.8-9.0 ms | 0.75 ms | 183 / 127 / 188 ms |
| Windows runner, Xeon 8370C | 20 | 14-15 ms + 6.5-6.7 ms | 0.98 ms | 855 / 422 / 1138 ms |

The runner rows come from GitHub Actions (`.github/workflows/proto-ca-bench.yml` on the
scratch branch, runs 42521788414 and 42521852178). They are measured, not estimated.
Writing the bundle file adds 0.2-0.3 ms. In ccc itself, `[ccc proto] session CA ready in`
printed 1.9-3.5 ms here. **Use ECDSA P-256.** RSA-2048 costs 25-1100 ms per session and buys
nothing: Claude Code and Node both accept P-256.

### Dependency and package size

| Option | Dependency | Package delta | Notes |
|---|---|---|---|
| **Built-in DER writer (prototype)** | none | tarball 607,214 → 617,674 B (**+10.5 KB**); unpacked +38 KB incl. source maps | ECDSA and RSA, nameConstraints, runs on Node ≥ 20 everywhere |
| node-forge 1.3 | +1 package | +1.7 MB unpacked (59 files) | RSA only (no ECDSA certificates): 51 ms median / 114 ms first here |
| openssl shell-out | system binary | 0 | 30 ms (EC, 3 processes) / 67 ms (RSA) here. Not on PATH on most Windows machines (the runners have it through Git for Windows); LibreSSL on stock macOS differs in flags; one more failure mode |
| @peculiar/x509 | +several packages | ~1 MB+ | WebCrypto-based. Not measured, since the built-in writer made it unnecessary |

## 4. Security review

- **CA key handling.** The key is generated in memory per ccc process, signs one leaf,
  goes out of scope, and is never written anywhere, so there is no 0600 file to protect,
  no Windows ACL question and no backup or iCloud copy. The leaf key is held in memory
  only, in the TLS context. Only public certificates and `bash-env.sh` go to disk (0700 dir, 0600 files).
  `bash-env.sh` holds no ccc secret, but it does copy the user's own `HTTPS_PROXY` value,
  which may carry corporate proxy credentials (in v1 proxy mode is off when one is set). A
  crashed session leaves just that public cert behind, which is harmless; a startup sweep
  of `ccc-ca-*` dirs older than a day can tidy them.
- **Never in a system trust store.** Trust comes only through `NODE_EXTRA_CA_CERTS` in the
  child's env, which reaches Claude Code and Node processes it starts directly (MCP servers,
  hooks). Bash commands get the user's original value back.
- **Interception scope.** Only `CONNECT api.anthropic.com:443` carrying the session token is
  decrypted. Every other host is a blind TCP tunnel. The nameConstraints extension makes this
  hold in the certificate itself: a stolen session CA key still can't mint a trusted
  certificate for any other DNS name (Bun and OpenSSL both enforce it, as tested above), for
  a subdomain of api.anthropic.com (excluded subtree after Codex r1; `openssl verify`
  rejects `child.api.anthropic.com`, Node TLS too, in `test/mitm-ca.test.mjs`; Claude Code
  still accepts the exact-host leaf, checked live) or
  for any IP address (tested with OpenSSL and Node; Bun not yet tested for IPs). The Remote Control WebSocket goes to `bridge.claudeusercontent.com`
  (from the binary), so it is tunnelled blind; the upgrade path on api.anthropic.com is
  only a fallback.
- **What ccc newly sees.** Decrypted in memory, it now also sees Claude Code's non-model
  api.anthropic.com traffic: Remote Control bridge and session events, file uploads,
  telemetry and settings fetches. ccc already sees the OAuth bearer on every `/v1/messages`.
  These paths are forwarded verbatim and never logged (the debug trace records method, path,
  status and User-Agent only), and `CCC_CAPTURE_DIR` captures only message bodies, as before. The privacy
  note in the README should say that ccc relays this traffic.
- **Local attackers.** The loopback port is reachable by other local users, as today. The
  407 token stops them using the tunnel or the interception. Other routes are unchanged.
  The token is in Claude Code's env, which only the same user (or root) can read.
- **Revocation and rotation.** Nothing outlives the session, so there is nothing to revoke.
  Rotation happens on every start.
- **Windows.** No private material on disk, so no ACL work. The bundle goes to the user's
  `%TEMP%`, which is per-user by default. **But the PowerShell tool gets none of the Bash
  fix** (from the 2.1.319 binary): it applies an env file only when every line is a plain
  `export NAME=value` (ccc's has `case`, `unset` and `.` lines), and on Windows it drops
  any value containing `/` or `\`, which covers `ANTHROPIC_BASE_URL` and every CA path.
  PowerShell commands would keep the token proxy and session CA and lose
  `ANTHROPIC_BASE_URL`, breaking non-Node calls to api.anthropic.com and the
  `$env:ANTHROPIC_BASE_URL/memtree` guidance. So **Windows stays in base-URL mode in v1**,
  until a mechanism that reaches PowerShell is found. Git Bash and the long-session
  workflow still need checking before Windows is turned on.

## 5. Existing users: what changes or breaks

| Area | Effect | Handling |
|---|---|---|
| Bash-tool programs (macOS, Linux), sandbox off | None: probe output identical to today's mode | `CLAUDE_ENV_FILE` (2.5) |
| Claude Code's Bash sandbox on | The env-file logic keeps the sandbox's own proxy/CA values (checked by sourcing the file under sandbox-like values). **But the sandbox's proxy forwards upstream through Claude Code's own `HTTPS_PROXY` when no `sandbox.network.parentProxy` is set (2.1.319 binary, review r2), with the token, so ccc accepts it.** Sandboxed calls to api.anthropic.com then hit the interception and fail TLS, and the sandbox's resolved-address check (it blocks names resolving to private/metadata addresses) is documented as not applying to connections routed through a parent proxy, so proxy mode would switch it off. | **v1: stay in base-URL mode when the sandbox is enabled in any settings scope at startup** (settings files and a `--settings` argument passed through ccc). That check is startup-only: `/sandbox` mid-session, a hot-reloaded settings edit, or server-delivered managed settings (ccc sees those only as `/api/claude_code/settings` through the interception) can turn the sandbox on later. So before default-on, prefer the robust fix: pass `sandbox.network.parentProxy` through `--settings`, pointing at a tunnel-only token that ccc never intercepts and that applies a private-address check (this also covers mid-session enables); until then, warn and ask for a restart when a watched settings file turns the sandbox on. |
| A user's own `CLAUDE_ENV_FILE` | Kept | Restored for Bash and sourced at the end of ccc's file. SessionStart/Setup/CwdChanged/FileChanged hooks get their own env files from Claude Code (under session-env), sourced after this one, so they are unaffected. |
| Command hooks, the status line command, and MCP servers started by Claude Code | Not Bash-tool commands, so the env file doesn't apply: they inherit `HTTPS_PROXY` (with the token) and the session CA. Node ones work (Node's fetch/https ignore `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY` or a proxy library is used, so they go direct). **Non-Node ones that call api.anthropic.com fail TLS: e.g. a status line or hook that curls `https://api.anthropic.com/api/oauth/usage`, or a Python MCP server using the API.** Other hosts work through the blind tunnel. | Name status lines and hooks in the README note; `CCC_HTTPS_PROXY_MODE=0` is the escape. Option when building: give children a full CA bundle (system roots + user extras + session CA) via `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE`, which makes curl and Python work too. Decide before making it the default. |
| User already has `HTTPS_PROXY`/`https_proxy` (corporate proxy) | Blind tunnels and ccc's own upstream would go direct, bypassing that proxy | **v1: stay in base-URL mode** and say once that /rc needs it off. Today ccc's upstream ignores proxies too, so those users mostly can't use ccc now. A later version can chain CONNECT through the user's proxy. |
| `NODE_EXTRA_CA_CERTS` set in a Claude Code `settings.json` `env` block (Claude Code's own TLS error text tells corporate users to put it there) | Settings env is applied over the process env, replacing ccc's bundle path: Claude Code no longer trusts the session CA and **every model call fails TLS** (loud, not silent) | Same detection as the next row: stay in base-URL mode. |
| Proxy set in Claude Code's `settings.json` `env` (user, project, local or managed), not the shell | Those values override the process env, so Claude Code would send its traffic to that proxy instead of ccc: **model calls skip MemTree with no error** | Detection must also read the settings `env` blocks (`HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`), at startup only (the same mid-session and managed-settings caveat as the sandbox row); and ccc should warn at runtime if no intercepted `/v1/messages` arrives while Claude Code is clearly active. Not in the prototype. |
| `NO_PROXY`/`no_proxy` covering api.anthropic.com (`*`, `.anthropic.com`, ...) | Claude Code would bypass ccc, so model calls skip MemTree silently | Strip matching entries from the child's `NO_PROXY`; `bash-env.sh` restores the user's value. (Not in the prototype.) |
| User's `NODE_EXTRA_CA_CERTS` | Kept | Prepended to the bundle; restored for Bash |
| `/memtree/*` and the MemTree MCP tools | Unchanged | MCP uses `CCC_MEMTREE_PROXY`; Bash has `ANTHROPIC_BASE_URL` |
| Nested ccc / `insideCccSession` | A ccc started from Bash sees today's two variables and the user's original `CLAUDE_ENV_FILE`/`CCC_*` values, so it runs as it would today (in proxy mode only if the user exported `CCC_HTTPS_PROXY_MODE=1`), with its own env file and no chaining to the outer one (fixed after review r1) | none |
| Attachment uploads | Previously went to the base URL (ccc, passthrough); now to api.anthropic.com through the interception (passthrough) | none |
| Claude Code's telemetry to api.anthropic.com | Now relayed through ccc verbatim, where before it went direct | Disclosure only |
| 1M context / first-party features | Native: Claude Code sees no custom base URL | Keep the assume-first-party var only in base-URL mode |
| Shutdown | Intercepted requests are normal tracked requests and drain as today. Blind tunnels and upgrade pipes are raw sockets that keep `server.close()` waiting: an orphaned MCP server holding a tunnel would block ccc's exit indefinitely (review r1 measured it) | Fixed in the prototype: blind tunnels (no ccc work in them) are destroyed when drain starts, intercepted sockets at the drain deadline. Test it when building. |
| `claude remote-control` (server mode, spawning sessions) | Not supported under ccc: it refuses ccc's `--mcp-config` placed before the verb | Out of scope; in-session `/rc` is the target |
| If Anthropic ever pins certs, or drops `NODE_EXTRA_CA_CERTS`/`HTTPS_PROXY` support | Model calls would fail outright instead of degrading | Both are documented enterprise features, so this is unlikely. The daily e2e should run proxy mode once it is the default. |

## 6. Building it for real (after Craig's /rc check)

1. A `CCC_HTTPS_PROXY_MODE` switch (or config `httpsProxyMode`), default off. It is ignored,
   with a one-line notice, when the parent env sets a proxy; when any Claude Code settings
   `env` block sets a proxy, `NO_PROXY` or `NODE_EXTRA_CA_CERTS`; when the Bash sandbox is
   enabled in any settings scope or `--settings`; and on Windows. (A parent-env
   `NODE_EXTRA_CA_CERTS` is fine: it is prepended to the bundle. These checks run at
   startup; see the sandbox row for mid-session changes.)
2. `NO_PROXY` sanitizing; a runtime warning when no intercepted `/v1/messages` arrives;
   sweeping stale `ccc-ca-*` dirs at startup; README privacy and "Remote Control"
   sections; the hooks/status-line decision above.
3. Prototype clean-ups: replace the module-level `baseUrlForBash`/`rewriteBashEnv` globals;
   let `upgradeToUpstream` follow `upstreamOrigin` so fake-upstream tests cover it; scope
   the `upgrade` listener so a non-intercepted loopback request with an `Upgrade` header
   (e.g. h2c) isn't destroyed (Node 24.9+ `shouldUpgradeCallback`, or answer it normally).
4. Tests: claudeChildEnv in both modes (token, no base URL, `CLAUDE_ENV_FILE` chaining,
   quoting); proxy integration with a fake upstream (407 without the token, blind tunnel
   bytes untouched, intercepted `/v1/messages` takes the MemTree path, other paths pass
   through verbatim including SSE and upgrades, the loopback-only routes unreachable over
   the intercepted path); `mitm-ca` (already in `test/mitm-ca.test.mjs`).
5. Windows: a mechanism for the PowerShell tool, then CI with Git Bash `CLAUDE_ENV_FILE`, plus one long-session run in proxy mode.
6. Default on (macOS/Linux) after a week of dogfooding; then the daily e2e covers proxy mode.

## 7. End-to-end /rc check for Craig (needs a full-scope login)

Use the laptop, or any machine where `claude auth status` shows a claude.ai login (not a
setup-token) and `CLAUDE_CODE_OAUTH_TOKEN` is not exported in the shell.

```bash
git -C ~/src/claude-code-infinite fetch origin proto/https-proxy-rc
git -C ~/src/claude-code-infinite worktree add ~/src/ccc-rc-proxy origin/proto/https-proxy-rc
cd ~/src/ccc-rc-proxy && npm ci && npm run build
cd ~/src/<any project>
date -u +%Y-%m-%dT%H:%M:%SZ   # launch time, for step 4
CCC_HTTPS_PROXY_MODE=1 CCC_PROXY_TRACE=/tmp/ccc-rc-trace.jsonl node ~/src/ccc-rc-proxy/dist/cli.js
```

1. In the session, type `/remote-control`. Expect the QR code / link (today's ccc says
   "Unknown command").
2. Open it on the phone or claude.ai/code. Send a message that uses a tool (e.g. "list the
   files here"). The reply should stream on both sides.
3. Leave it idle for 5+ minutes, then send another message from the phone (tests the long
   poll / SSE through the proxy).
4. In another terminal:
   `grep -c '"path":"/v1/environments/bridge"' /tmp/ccc-rc-trace.jsonl` (expect ≥ 1),
   `grep -c '"target":"bridge.claudeusercontent.com:443"' /tmp/ccc-rc-trace.jsonl` (the
   Remote Control WebSocket; expect ≥ 1 if /rc connected), and
   `grep -E '"ev":"(connect_refused|upgrade|tls_error|tunnel_error)"' /tmp/ccc-rc-trace.jsonl`.
   Any `connect_refused` means a Claude Code client didn't send the proxy token (the /rc
   WebSocket is the untested one). `tls_error`/`tunnel_error` resets around exit are
   harmless; ones while /rc is failing are the clue.
   Then check that the turns got MemTree, not just the proxy. A request without Claude
   Code's session header is logged as `"kind":"messages"` too, but as `foreign` with no
   MemTree, and a follow-up can come out `followup-degraded`. While the session runs, note
   its pid (`pgrep -f ccc-rc-proxy/dist/cli.js`), then:
   `node ~/src/ccc-rc-proxy/scripts/proto/rc-check.mjs --pid <pid> --since <launch time, UTC ISO>`
   It keeps only that ccc's records since launch and lists each model turn with how ccc
   classified it, interleaved with the MemTree calls. It exits 1 on any foreign,
   unparseable, degraded, refused, client-closed, no-flatten or unknown turn, a non-200
   upstream, or a failed MemTree call (other than the final index cut short at exit). The
   security monitor and away-recap requests are listed as `aux` (healthy, no MemTree call
   by design). Expect exit 0, with the phone turns' timestamps among the `ok` lines. This
   checks classification; the log has no id tying a turn to its own MemTree call, so read
   the MemTree lines alongside (an `ok` compress or index next to each phone turn) rather
   than as proof per turn.
5. Exit, then check `ls -d ${TMPDIR:-/tmp}/ccc-ca-*` (the session's dir should be gone).
6. Send `/tmp/ccc-rc-trace.jsonl` back. It holds paths (which include
   environment and session ids, not secrets), statuses, CONNECT targets with header names,
   and User-Agents; no header values or bodies.
