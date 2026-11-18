"""First-run credential validation through the CLI's real readline prompt."""
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
from pathlib import Path

key = "sk-" + "1" * 32
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    for name in ("open", "xdg-open", "claude"):
        tool = root / name
        tool.write_text("#!/bin/sh\nexit 0\n")
        tool.chmod(0o755)
    mock = root / "fetch.mjs"
    mock.write_text("""
import fs from 'node:fs';
globalThis.fetch = async (url, init) => {
  const auth = new Headers(init?.headers).get('authorization');
  if (auth) fs.appendFileSync(process.env.HOME + '/sent', auth + '\\n');
  return Response.json({paid:false});
};
""")
    config = root / ".claude-code-infinite" / "config.json"
    sent = root / "sent"
    master, slave = pty.openpty()
    env = {"HOME": directory, "PATH": directory, "CCC_NO_DIAGNOSTICS": "1"}
    proc = subprocess.Popen([sys.argv[1], "--import", str(mock), "dist/cli.js", "-p", "hi"],
                            env=env, stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.close(slave)

    def wait_for(prompt):
        output = b""
        while prompt not in output:
            assert select.select([proc.stderr], [], [], 4)[0], f"timed out waiting for {prompt!r}"
            chunk = os.read(proc.stderr.fileno(), 65536)
            assert chunk, f"exited waiting for {prompt!r}"
            output += chunk

    try:
        wait_for(b"in your browser")
        os.write(master, b"\n")
        wait_for(b"paste it here")
        os.write(master, b"review files\n")
        wait_for(b"paste it here")
        assert not config.exists() and not sent.exists()
        os.write(master, ("  " + key + "  \n").encode())
        assert proc.wait(timeout=5) == 0
        assert json.loads(config.read_text())["polychatApiKey"] == key
        assert sent.read_text().splitlines() == ["Bearer " + key]
    finally:
        proc.kill()
        proc.wait()
        os.close(master)
