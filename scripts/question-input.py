"""Provide a raw terminal fd for Claude when ccc has already read its first bytes."""
import fcntl
import os
import select
import sys
import termios
import tty

# fd 3 is the real terminal. During the guard, observe readiness without
# reading so even a partial line can be inherited directly by Claude.
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
