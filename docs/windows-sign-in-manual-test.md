# Windows sign-in: manual test script

For a tester on a fresh Windows 11 machine with a real Claude Pro (or Max) account. It
checks what CI can't: a real browser sign-in to a Claude account. About 30 minutes.

Never send passwords, your email address, API keys, or the file `requests.jsonl`. Crop or
blur your email and name in screenshots.

## Setup (note each answer for the report)

1. Windows version (Settings > System > About: "Edition" and "OS build").
2. Is your Windows user folder name non-English (for example `C:\Users\Максим` or
   `C:\Users\João`)? Is your Desktop/Documents in OneDrive?
3. Windows display language (Settings > Time & language > Language).
4. Is the Claude desktop app installed? (Start menu: "Claude".)
5. Install Node.js 22 or 24 LTS from https://nodejs.org (defaults).
6. Open **Windows Terminal** (or PowerShell). Run:
   ```
   npm install -g claude-code-infinite
   ```
   Then run `ccc --version`: it must be the version Craig named (1.0.32 or later).

## Test A: Claude Code not installed, not signed in

1. Run `ccc`. If it offers to install Claude Code, answer `y`, and paste the MemTree key
   Craig gave you when asked. Right after installing, ccc only says that Claude Code will
   ask you to sign in: **screenshot that**, close Claude Code (Ctrl+C twice) and go on.
2. Run `ccc` again (paste the key if asked).
3. **Screenshot 1:** the text ccc prints before Claude Code starts. Expected:
   ```
   Claude Code isn't signed in to a Claude plan yet. ccc needs Claude Pro or Max.
     - Have one? Choose "Claude account with subscription" when Claude Code asks, or run /login.
     - Don't have one? Get Pro at https://claude.ai/upgrade, then run /login.
   Your MemTree credit covers MemTree, not Claude itself.
   Press Enter to continue to Claude Code.
   ```
   Note whether ccc really waited for Enter.
4. Press Enter. Claude Code asks for a theme, then "Select login method".
   **Screenshot 2:** that screen.
5. Choose **1. Claude account with subscription**. Sign in in the browser. If the browser
   doesn't open, or the code doesn't paste, **screenshot it** and note what happened.
6. Back in the terminal, type `hello` and press Enter. **Screenshot 3:** Claude's answer.
7. Type `/exit`.

## Test B: signed in

1. Run `ccc` again. Expected: no sign-in message and no Enter prompt.
   **Screenshot 4:** the lines before Claude Code starts.
2. Send `hello`, then `/exit`.
3. Run this and copy only the `loggedIn`, `authMethod` and `subscriptionType` lines:
   ```
   claude auth status --json
   ```

## Test C: signed out again

1. Run `claude`, type `/logout`, then `/exit`.
2. Run `ccc`. Expected: the Test A message and the Enter prompt again.
   **Screenshot 5.**
3. Press Ctrl+C at the Enter prompt. Expected: ccc quits cleanly.

## Test D: other terminals (optional)

Repeat Test C step 2 in **Command Prompt** (cmd.exe) and in **PowerShell**
(not Windows Terminal). Screenshot each.

## Send back

- Screenshots 1–5 (email and name blurred), and the answers from Setup.
- The output of these commands. They hold only version numbers, a random install id and
  sign-in type names:
  ```
  ccc --version
  type %USERPROFILE%\.claude-code-infinite\install_id
  type %USERPROFILE%\.claude-code-infinite\claude-sign-in-state.json
  type %USERPROFILE%\.claude-code-infinite\claude-auth-seen
  ```
  (In PowerShell, use `$env:USERPROFILE` in place of `%USERPROFILE%`.)
- The three `claude auth status` lines from Test B.

With the install id, Craig can find this machine's ccc diagnostics: the sign-in check
result, which message was shown, how long ccc waited for Enter, and when sign-in completed.
