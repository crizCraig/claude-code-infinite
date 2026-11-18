// Minimal Windows npm global prefix with a JS bin and no node.exe beside the shim.
import fs from "node:fs";
import path from "node:path";

export function installNpmClaude(prefix, source) {
  const pkg = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { claude: "./cli.mjs" } }));
  fs.writeFileSync(path.join(pkg, "cli.mjs"), source);
  fs.writeFileSync(path.join(prefix, "claude.cmd"),
    '@node "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.mjs" %*\r\n');
}
