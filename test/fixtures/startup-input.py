"""Exercise the shipping CLI in an isolated terminal. Every HTTP call is intercepted."""
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import termios
from pathlib import Path

node, scenario = sys.argv[1:]
rejected = scenario.startswith("rejected-key")
drain_failed = scenario == "rejected-key-drain-unreadable"
first = "sk-" + "1" * 32
stale = "sk-" + "2" * 32
fresh = "sk-" + "3" * 32
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    for name in ["claude", "open", "xdg-open"]:
        path = root / name
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755)
    mock = root / "mock.mjs"
    mock.write_text("""
import fs from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
globalThis.fetch = async (url, init) => {
  const key = new Headers(init?.headers).get('authorization');
  if (key) fs.appendFileSync(process.env.HOME + '/sent', key + '\\n');
  if (url.endsWith('/status') && key === 'Bearer ' + process.env.REJECT) {
    process.stderr.write('CHECKING\\n');
    await wait(200);
    if (process.env.DRAIN_FAULT === 'drain-unreadable') process.env.BREAK_DRAIN = '1';
    return new Response('', {status:401});
  }
  if (url.endsWith('/status') && key === 'Bearer ' + process.env.ACCEPT) {
    process.stderr.write('CHECKING REPLACEMENT\\n');
    await wait(200);
  }
  return Response.json({paid:false});
};
""")
    master, slave = pty.openpty()
    env = {"HOME": directory, "PATH": directory, "CCC_NO_UPDATE_CHECK": "1",
           "DRAIN_FAULT": scenario.removeprefix("rejected-key-") if "drain-" in scenario else "",
           "REJECT": first if rejected else "", "ACCEPT": fresh if rejected else "",
           **{k: os.environ[k] for k in ("NO_COLOR", "FORCE_COLOR") if k in os.environ}}
    printing = scenario == "print-key"
    args = [node, "--import", str(mock)]
    if env["DRAIN_FAULT"]:
        args += ["--import", "./test/fixtures/tty-drain-fault.mjs"]
    args += ["dist/cli.js"] + (["-p", "hi"] if printing else [])
    proc = subprocess.Popen(args, env=env, stdin=slave,
                            stdout=subprocess.PIPE if printing else slave,
                            stderr=subprocess.PIPE if printing else slave)
    output = proc.stderr.fileno() if printing else master
    os.close(slave)
    screen = bytearray()
    transcript = bytearray()

    def until(token):
        while token not in screen:
            assert select.select([output], [], [], 3)[0], f"timed out waiting for {token!r}"
            chunk = os.read(output, 65536)
            assert chunk, f"exited waiting for {token!r}"
            screen.extend(chunk)
            transcript.extend(chunk)
        del screen[:screen.index(token) + len(token)]

    def stays_at_prompt(forbidden):
        while select.select([output], [], [], 0.15)[0]:
            chunk = os.read(output, 65536)
            assert chunk
            screen.extend(chunk)
            transcript.extend(chunk)
        assert forbidden not in screen, "queued text answered a prompt"

    def enter(line):
        os.write(master, line.encode() + b"\r")

    try:
        until(b"in your browser")
        enter("")
        until(b"paste it here")
        if scenario == "cancel-key":
            os.write(master, b"\x03")
        else:
            enter("  " + first + " " if printing else first)
        if rejected:
            until(b"CHECKING")
            os.write(master, ("\r" + stale + "\rreview files").encode())
        if rejected and not drain_failed:
            until(b"[q] quit")
            stays_at_prompt(b"new MemTree key and paste it here")
            # A key-shaped line in the same burst as the menu choice is stale too.
            enter("\r" + stale)
            until(b"new MemTree key and paste it here")
            stays_at_prompt(b"[q] quit")
            enter(fresh)
            until(b"CHECKING REPLACEMENT")
            enter(stale)  # The successful check hands off to an echoing payment prompt.
        if not printing and not drain_failed and scenario != "cancel-key":
            until(b"[q] quit")
            enter("q")
        # Keep draining redraws while ccc flushes its diagnostics and exits.
        while select.select([output], [], [], 3)[0]:
            try:
                chunk = os.read(output, 65536)
                transcript.extend(chunk)
                if not chunk:
                    break
            except OSError:
                break
        assert proc.wait(timeout=2) == 0
        assert termios.tcgetattr(master)[3] & termios.ECHO, "terminal echo was not restored"
        if scenario == "cancel-key":
            assert b"Error:" not in transcript and b"    at " not in transcript
            assert not (root / "sent").exists()
            sys.exit(0)
        if env["DRAIN_FAULT"]:
            assert b"INJECTED " + env["DRAIN_FAULT"].encode() in transcript
        assert all(key.encode() not in transcript for key in (first, stale, fresh)), "key echoed in output"
        if drain_failed:
            assert b"Cancelling the prompt" in transcript and b"[q] quit" not in transcript
            assert set((root / "sent").read_text().splitlines()) == {"Bearer " + first}
            sys.exit(0)
        if printing:
            assert proc.stdout.read() == b""
        sent = (root / "sent").read_text().splitlines()
        saved = json.loads((root / ".claude-code-infinite" / "config.json").read_text())
        assert saved["polychatApiKey"] == (fresh if rejected else first)
        assert set(sent) == {"Bearer " + k for k in ([first, fresh] if rejected else [first])}
    finally:
        proc.kill()
        proc.wait()
        os.close(master)
