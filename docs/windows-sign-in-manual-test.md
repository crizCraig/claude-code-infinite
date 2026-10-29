# Windows sign-in: manual test script

For Abdallah Soliman (or any tester) on a real Windows 10/11 machine with a Claude Pro or Max
account. It checks what CI can't: GitHub's `windows-latest` runner is Windows Server with no
browser sign-in and no Claude desktop app, so CI covers the code paths only, never a real
Claude account sign-in.

Two rounds, about 30 minutes each:

- **Round 1** reproduces the bug on ccc **1.0.31**: new Windows users are warned
  `unknown`, then never send a message.
- **Round 2** checks the fixed build (1.0.32 or later, or the GitHub build Craig names).

Never send passwords, your email address, API keys, MemTree keys, or the files
`requests.jsonl` / `requests.jsonl.1` (they hold your project paths). Crop or blur your email
and name in every screenshot.

## Setup (note each answer for the report)

1. Windows edition and build: Settings > System > About ("Edition", "OS build").
2. Windows display language: Settings > Time & language > Language (e.g. Arabic, English).
3. Your Windows user folder: run `echo %USERPROFILE%` in Command Prompt. Does the name have
   non-English letters (e.g. `C:\Users\عبدالله`, `C:\Users\João`)? Send only yes/no and the
   script (Arabic, Cyrillic, accented Latin...), not the name.
4. Is your user folder, Desktop or Documents in OneDrive? (`echo %USERPROFILE%` and
   `echo %APPDATA%`: does either path contain `OneDrive`?) Yes/no.
5. Is the **Claude desktop app** installed? (Start menu: "Claude".) Yes/no.
6. How is **Claude Code** installed, if at all? Run `where claude` in Command Prompt and send
   the folder names only (e.g. `...\AppData\Roaming\npm\claude.cmd` = npm,
   `...\.local\bin\claude.exe` = Anthropic's installer, `...\WinGet\...` = winget). "Not
   found" is also an answer.
7. Node.js version: `node --version` (install 22 or 24 LTS from https://nodejs.org if
   missing).
8. Which terminal you use: Windows Terminal, PowerShell or Command Prompt.

To start clean for each round, sign Claude Code out first if it is installed: run `claude`,
type `/logout`, then `/exit`.

## Round 1: reproduce on 1.0.31

1. `npm install -g claude-code-infinite@1.0.31`, then `ccc --version` (must say 1.0.31).
2. Run `ccc`. Paste the MemTree key Craig gave you when asked. If it offers to install
   Claude Code, answer `y`.
3. **Screenshot R1-1:** everything ccc prints before Claude Code's screen appears (scroll
   up if needed). Expected on 1.0.31: a one-line warning that may flash by and be covered
   by Claude Code's screen.
4. **Screenshot R1-2 onwards: every sign-in screen** Claude Code shows (theme, "Select login
   method", the browser page, the code-paste step, "Login successful" or any error).
   Choose **"Claude account with subscription"**. If the browser doesn't open or the code
   doesn't paste, screenshot that and note what happened.
5. Type `hello` and press Enter. **Screenshot** Claude's answer, or whatever appears instead.
6. `/exit`. Run `claude auth status --json` and copy only the `loggedIn`, `authMethod` and
   `subscriptionType` lines.
7. Send the "Files to send" below, labelled Round 1.

## Round 2: the fixed build

1. Sign Claude Code out (`claude`, `/logout`, `/exit`).
2. Install the build Craig names, e.g. `npm install -g claude-code-infinite@1.0.32`, or
   from GitHub: `npm install -g github:crizCraig/claude-code-infinite#<commit>`.
   `ccc --version` must say 1.0.32 or later.

### Test A: not signed in

1. Run `ccc`. **Screenshot R2-1.** Expected, and ccc waits for Enter:
   ```
   Claude Code isn't signed in to a Claude plan yet. ccc needs Claude Pro or Max.
     - Have one? Choose "Claude account with subscription" when Claude Code asks, or run /login.
     - Don't have one? Get Pro at https://claude.ai/upgrade, then run /login.
   Your MemTree credit covers MemTree, not Claude itself.
   Press Enter to continue to Claude Code.
   ```
   (Right after ccc installs Claude Code itself, it only says that Claude Code will ask
   you to sign in: screenshot that, close it with Ctrl+C twice, and run `ccc` again.)
2. Press Enter. **Screenshot every sign-in screen** as in Round 1, step 4, choosing
   "Claude account with subscription".
3. Send `hello`. **Screenshot** Claude's answer. `/exit`.

### Test B: signed in

1. Run `ccc`. Expected: no sign-in message, no Enter prompt. **Screenshot R2-2.**
2. Send `hello`, then `/exit`. Copy the three `claude auth status --json` lines.

### Test C: signed out again, and quitting

1. `claude`, `/logout`, `/exit`. Run `ccc`: the Test A message and Enter prompt again.
   **Screenshot R2-3.**
2. Press Ctrl+C at the prompt. Expected: ccc quits cleanly.

### Test D: API billing (optional)

Only if you also have an Anthropic Console (API) account: `/login` and choose "Anthropic
Console account". Then `ccc`. Expected: a message that Claude Code is signed in for API
billing (that account is billed per token) and how to switch with `/login`; ccc does not
wait. **Screenshot.** Then `/login` back to your Claude account.

### Test E: other terminals (optional)

Repeat Test C step 1 in **Command Prompt** and in **PowerShell** (not Windows Terminal).
Screenshot each.

## Sign-in bug, or a credit problem?

| You see | What it is |
|---|---|
| ccc says not signed in, but `claude auth status --json` says `"loggedIn": true` (or the reverse) | **The sign-in bug.** Send everything below. |
| No ccc message, sign-in looked fine, but `hello` gets no answer | **Probably the sign-in bug.** Send everything below. |
| `MemTree is paused`, a payment link, or a `402` | **MemTree credit**, not sign-in: tell Craig, he can add credit. Claude itself still works. |
| `Credit balance is too low` | Claude Code is signed in with an **Anthropic Console (API)** account that has no API credit. Not ccc's bug: `/login` and choose "Claude account with subscription". |
| A rate limit ("usage limit reached") | Your Claude plan's limit, not a bug. |

## Files to send (each round)

These hold only version numbers, a random install id and sign-in type names:

```
ccc --version
claude --version
type %USERPROFILE%\.claude-code-infinite\install_id
type %USERPROFILE%\.claude-code-infinite\claude-sign-in-state.json
type %USERPROFILE%\.claude-code-infinite\claude-auth-seen
```

(In PowerShell use `$env:USERPROFILE` in place of `%USERPROFILE%`; a file that doesn't
exist is also an answer.) Plus the Setup answers, the screenshots, and the
`claude auth status` lines.

With the install id Craig can find this machine's ccc diagnostics (no content): the sign-in
check's result and time, which message was shown, how long ccc waited for Enter, when the
sign-in completed, and how long until the first request.
