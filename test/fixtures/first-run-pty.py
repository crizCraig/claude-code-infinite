"""Drive the real question and paused-session launcher using a terminal on both sides."""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import termios
import time

node, scenario = sys.argv[1:]
menu = b"What brings you"
marker = b"CLAUDE GOT "
payload = b"review \xc3\xa9 file 3\r"
paste = b"\x1b[200~6\r\x03\xff\x1b[201~\r"
program = """
import { askFirstRunQuestion, keepQuestionInputRaw, readFirstRunAnswer } from './dist/first-run-question.js';
import { runWithoutMemtree } from './dist/paused-session.js';
import { setTimeout as wait } from 'node:timers/promises';
const diagnostics = {enabled:true, record(){}, flushNow(){}, async flush(){}};
const restoreRaw = keepQuestionInputRaw(process.stdin);
process.stdout.write('STARTING\\n');
await wait(120);
const questionInput = await askFirstRunQuestion({
  configDir: process.argv[1], newInstall:true, keyCheck:null, args:[], env:{},
  stdinIsTty:true, stdoutIsTty:true, diagnostics,
  ask: (q,s) => readFirstRunAnswer(q,s,process.stdin,process.stdout,{restoreRaw}),
});
await runWithoutMemtree({claude:{command:process.execPath,source:'path'},
  claudeArgs:['--input-type=module','-e',process.argv[2]], interactive:true,
  diagnostics, autoUpdate:null, questionInput});
"""
child = """
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);
process.stdin.setRawMode(true);
let seen = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  seen = Buffer.concat([seen,chunk]);
  if (seen.length >= LENGTH) {
    console.log('CLAUDE GOT ' + seen.toString('hex'));
    process.exit(0);
  }
});
"""
data = paste if scenario.startswith("paste") else payload
if scenario == "cli-unpaid-quit-ahead":
    data = b"q\r"
queued_at_key = scenario in ("cli-paid", "cli-unpaid-ahead", "cli-unpaid-quit-ahead")
early = scenario in ("before", "guard", "cli-queued") or queued_at_key
launch_args = {"cli-debug": ["--debug"], "cli-staging": ["staging"], "cli-local": ["local"],
               "cli-resume": ["--resume"]}
no_menu = scenario in launch_args or scenario == "cli-no-python"
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
screen = bytearray()
with tempfile.TemporaryDirectory() as directory:
    receiver = child.replace("LENGTH", str(len(data)))
    args = [node, "--input-type=module", "-e", program, directory, receiver]
    env = os.environ.copy()
    config_dir = Path(directory)
    if scenario.startswith("cli"):
        # Exercise the shipping entry point, including the preceding readline key
        # and payment prompts. No browser, real account, or network access.
        root = Path(directory)
        for opener in ["open", "xdg-open"]:
            path = root / opener
            path.write_text("#!/bin/sh\nexit 0\n")
            path.chmod(0o755)
        claude = root / "claude"
        claude.write_text("#!" + node + "\n" +
                          "if (process.argv.includes('auth')) { console.log(JSON.stringify("
                          "{loggedIn:false,authMethod:'none'})); process.exit(0); }\n"
                          "if (process.argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }\n"
                          + ("console.log('CHILD STARTED'); process.exit(0);" if no_menu else receiver))
        claude.chmod(0o755)
        preload = root / "fetch.mjs"
        paid = scenario == "cli-paid"
        # The paid launcher needs a listening proxy address. The stand-in never
        # makes a request, so exercise its launch without opening a network port.
        preload.write_text("""
import { Server } from 'node:net';
Server.prototype.listen = function(port, host, ready) { queueMicrotask(ready); return this; };
Server.prototype.address = () => ({port: 12345});
globalThis.fetch = async () => Response.json({paid: PAID});
""".replace("PAID", str(paid).lower()))
        env = {"HOME": directory, "PATH": directory + os.pathsep + env["PATH"],
               "CCC_NO_UPDATE_CHECK": "1", "TERM": "xterm-256color",
               **{k: env[k] for k in ["NO_COLOR", "FORCE_COLOR"] if k in env}}
        args = [node, "--import", str(preload), "dist/cli.js"]
        args.extend(launch_args.get(scenario, []))
        if scenario == "cli-no-python":
            env["PATH"] = directory
        config_dir = root / ".claude-code-infinite"
    proc = subprocess.Popen(args, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)

    def until(token, seconds=4):
        deadline = time.monotonic() + seconds
        while token not in screen:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([master], [], [], left)[0]:
                raise AssertionError(f"waiting for {token!r}: {screen!r}")
            screen.extend(os.read(master, 65536))

    try:
        if scenario.startswith("cli"):
            until(b"in your browser")
            os.write(master, b"\r")
            until(b"paste it here")
            os.write(master, b"sk-" + b"1" * 32 + b"\r" + (data if queued_at_key else b""))
            if not queued_at_key:
                until(b"[q] quit")
                os.write(master, b"c\r" + (data if scenario == "cli-queued" else b""))
        else:
            until(b"STARTING")
        if no_menu:
            if scenario == "cli-resume":
                until(b"Press Enter to continue to Claude Code")
                os.write(master, b"\r")
            until(b"CHILD STARTED")
            assert proc.wait(timeout=3) == 0
            assert menu not in screen, screen
            if scenario == "cli-no-python":
                assert b"Install Python 3 on PATH" in screen
            if scenario in launch_args:
                assert not (config_dir / "first-run-question.json").exists()
            sys.exit(0)
        if scenario == "guard":
            until(b"\x1b[?2004h")
        elif not early:
            until(menu)
        if scenario == "answer-burst":
            os.write(master, b"3" + data)
        elif scenario == "cli-queued" or queued_at_key:
            pass  # already typed in the same write as the preceding response
        elif scenario in ("before", "paste"):
            os.write(master, data)
        elif scenario == "paste-split":
            for piece in [paste[:1], paste[1:7], paste[7:-1], paste[-1:]]:
                os.write(master, piece)
                time.sleep(0.16)
        else:
            os.write(master, data[:1])
            time.sleep(0.16)
            os.write(master, data[1:])
        until(marker + data.hex().encode())
        assert proc.wait(timeout=3) == 0
        if scenario.startswith("cli-unpaid-"):
            assert b"[q] quit" not in screen, screen
        assert termios.tcgetattr(master)[:4] == original[:4], "terminal modes were not restored"
        assert (menu in screen) == (not early), screen
        with (config_dir / "first-run-question.json").open() as claim:
            receipt = json.load(claim)
            if scenario == "answer-burst":
                assert receipt == {"status": "answered", "answer": "remember"}, receipt
            else:
                assert receipt == {"status": "skipped"}, receipt
    finally:
        proc.kill()
        proc.wait()
        os.close(master)
