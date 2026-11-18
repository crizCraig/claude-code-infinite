// Minimal Windows npm global prefix with a JS bin and no node.exe beside the shim.
import fs from "node:fs";
import path from "node:path";

// Both fixtures are verbatim npm cmd-shim output, with LF in the repository.
export function npmShimText(target) {
  const native = target.endsWith(".exe");
  const fixture = native ? "./npm-native-shim.cmd" : "./npm-node-shim.cmd";
  const original = "node_modules\\@anthropic-ai\\claude-code\\" + (native ? "claude.exe" : "cli.mjs");
  return fs.readFileSync(new URL(fixture, import.meta.url), "utf8")
    .replace(original, target).replaceAll("\n", "\r\n");
}

export function installNpmClaude(prefix, source) {
  const pkg = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "./cli.mjs" } }));
  fs.writeFileSync(path.join(pkg, "cli.mjs"), source);
  fs.writeFileSync(path.join(prefix, "claude.cmd"),
    npmShimText("node_modules\\@anthropic-ai\\claude-code\\cli.mjs"));
}
