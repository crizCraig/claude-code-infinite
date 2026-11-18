// Inject a failure only on the nonblocking descriptor opened for the tty drain.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const { openSync, readSync, closeSync } = fs;
let drainFd;

function fail(operation, code) {
  if (process.env.DRAIN_FAULT === operation) {
    process.stderr.write("INJECTED " + operation + "\n");
    throw Object.assign(new Error(operation), { code });
  }
}

fs.openSync = (path, flags, ...args) => {
  if (typeof path !== "string" || !path.startsWith("/dev/") || !(flags & fs.constants.O_NONBLOCK))
    return openSync(path, flags, ...args);
  fail("drain-open-denied", "EACCES");
  drainFd = openSync(path, flags, ...args);
  return drainFd;
};
fs.readSync = (fd, ...args) => {
  if (fd === drainFd) fail("drain-read-error", "EIO");
  return readSync(fd, ...args);
};
fs.closeSync = fd => {
  closeSync(fd);
  if (fd === drainFd) {
    drainFd = undefined;
    fail("drain-close-error", "EIO");
  }
};
syncBuiltinESMExports();
