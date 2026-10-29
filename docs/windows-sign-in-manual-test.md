# Windows sign-in: manual test script

For Abdallah Soliman (or any tester) on a real Windows 10/11 machine with a Claude Pro or Max
account. It checks what CI can't: GitHub's `windows-latest` runner is Windows Server with no
browser sign-in and no Claude desktop app, so CI covers the code paths only, never a real
Claude account sign-in.

Two rounds, about 30 minutes each, plus a ~30-minute new-user walkthrough:

- **Round 1** reproduces the bug on ccc **1.0.31**: new Windows users are warned
  `unknown`, then never send a message.
- **Round 2** checks the fixed build (1.0.32 or later, or the GitHub build Craig names).
- **Part 3** goes through the whole setup as a brand-new user and critiques it.

Never send passwords, your email address, API keys, MemTree keys, or the files
`requests.jsonl` / `requests.jsonl.1` (they hold your project paths). Crop or blur your email
and name in every screenshot.

## Setup (note each answer for the report)

Run the commands in this section in **Command Prompt** (Start menu: "cmd"), even if you
use another terminal later: PowerShell reads `%USERPROFILE%` and `where` differently.

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
   `ccc --version` must say 1.0.32 or later (a GitHub build may still say 1.0.31: then
   check with Craig that you installed the commit he named).

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

## Part 3: the whole setup as a new user (about 30 minutes)

Craig wants your honest critique of the first-run experience, not only the sign-in bug.
Do it once the fixed version is published (1.0.32 or later), or with whatever version the
site's install command gives you, and note that version.

Start from zero:

1. In Command Prompt: `npm uninstall -g claude-code-infinite`, then
   `ren "%USERPROFILE%\.claude-code-infinite" .claude-code-infinite.old` (Craig's earlier
   test key is in it: don't send it).
2. Sign Claude Code out (`claude`, `/logout`, `/exit`). If you're willing, uninstall Claude
   Code too, so you see ccc's install offer: `npm uninstall -g @anthropic-ai/claude-code`
   if `where claude` showed an `npm` folder; if it showed `.local\bin\claude.exe`
   (Anthropic's installer), rename that file to `claude.exe.old`.
3. Use an email that has no polychat.co account yet (Craig can delete the test account
   afterwards), or ask Craig to reset yours.

Then go step by step, as if you had only heard of MemTree:

| Step | What to do |
|---|---|
| 1 | Open https://memtree.dev and find how to start. |
| 2 | Sign up at polychat.co (the site's sign-up link). |
| 3 | Find the MemTree key page and your key. |
| 4 | Find and run the install command the site gives you. |
| 5 | Run `ccc` for the first time: install Claude Code if ccc offers, then paste the key. |
| 6 | Sign Claude Code in with your Claude account. |
| 7 | Send your first message and get an answer. |
| 8 | Find your first MemTree link (ccc shows one; `/memtree-view` prints it) and open it. |

For **each step**, note (one or two lines is fine) and screenshot:

- what was **confusing** (wording, where to click, what to do next);
- what was **slow** (rough seconds or minutes);
- what was **missing** (information you had to guess);
- what was **broken** (errors, wrong text, a page that didn't load).

Finish with your **top 3 suggested improvements**: wording to change, steps that could
be removed or automated, and anything Windows-specific (PowerShell vs Command Prompt,
paths, antivirus or SmartScreen prompts, the browser not opening, copy and paste in the
terminal).

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
