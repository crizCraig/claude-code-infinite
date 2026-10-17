// `chmod +x dist/cli.js` without a POSIX shell (npm uses cmd.exe on Windows,
// where the executable bit means nothing and npm writes its own .cmd shim).
import { chmodSync } from "node:fs";

if (process.platform !== "win32") chmodSync(new URL("../dist/cli.js", import.meta.url), 0o755);
