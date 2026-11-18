# Windows Terminal startup checklist

Open a PowerShell tab in Windows Terminal on a test profile with the PR build of
`ccc`, Claude Code signed in, and no saved MemTree key. Have a valid MemTree key
with credit ready. Use the same project directory throughout.

- [ ] Run `ccc`, press Enter to open the key page, and press Ctrl+C at the paste
  prompt. PowerShell should return immediately with no stack trace. Run `ccc`
  again and confirm it still asks for a key.
- [ ] At the paste prompt, enter the dummy key
  `sk-00000000000000000000000000000000`. As soon as you press Enter, type
  `review files` and press Enter again. The dummy key should stay hidden. The
  rejection menu should wait for a fresh choice even though you typed ahead.
- [ ] Press Enter at the rejection menu. Wait for the new key prompt, then paste
  your valid key with a space at each end and press Enter. Confirm no key
  characters appeared on screen or in scrollback and that ccc reports the key
  was saved.
- [ ] Send `Remember the word apricot` in Claude Code. Check that Claude replies,
  then use `/exit`.
- [ ] Run `ccc --resume`, select that conversation, and ask which word you gave
  it. Check for `apricot`, then use `/exit`.
- [ ] Run `$reply = ccc -p "Reply with just OK"`, then `$LASTEXITCODE` and
  `$reply`. Expect exit code 0 and Claude's answer in the captured output.
  Both this run and the resumed run should use the saved key without prompting.
