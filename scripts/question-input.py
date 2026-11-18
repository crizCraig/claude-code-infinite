"""Provide a raw terminal fd for Claude when ccc has already read its first bytes."""
import fcntl
import os
import select
import sys
import termios
import tty

# fd 3 is the real terminal. During the guard, observe readiness without
# reading so even a partial line can be inherited directly by Claude.
if sys.argv[1] == "payment":
    if select.select([3], [], [], 0)[0]:
        sys.exit(42)  # Reserved for observed input, distinct from helper failures.
    # Show the choices before returning control to Node. Bytes typed while
    # this helper exits can then legitimately answer the visible prompt.
    sys.stdout.write(sys.argv[2])
    sys.stdout.flush()
    sys.exit(0)

guard = int(sys.argv[1])
if guard >= 0 and select.select([3], [], [], guard / 1000)[0]:
    print("queued", flush=True)
    sys.exit(0)

master, slave = os.openpty()
tty.setraw(slave, termios.TCSANOW)
size = fcntl.ioctl(3, termios.TIOCGWINSZ, bytes(8))
fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
print(os.ttyname(slave), flush=True)
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    view = memoryview(chunk)
    while view:
        view = view[os.write(master, view):]
