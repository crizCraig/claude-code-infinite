/**
 * `ccc desktop setup`'s files and registrations (desktop-command.ts): the service's state,
 * its certificate (mitm-ca.ts: a CA name-constrained to api.anthropic.com whose key is
 * dropped at once; only the leaf key is kept, 0600), the Bash env file, the launchd agent
 * and the user-scope `memtree` MCP server. The service itself is desktop-service.ts.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSessionCa } from "./mitm-ca.js";
import { UNREACHABLE_BLOCKING_LIMIT } from "./claude-env.js";
import { MEMTREE_MCP_SCRIPT } from "./memtree-mcp-config.js";
import { MEMTREE_MCP_SERVER_NAME } from "./memtree-mcp.js";
import { proxyUrlFor } from "./https-proxy-mode.js";
import { cccProxyRestoreLines, ifStill } from "./https-proxy-session.js";

export type DesktopMode = "production" | "staging" | "local";

const LAUNCHD_LABEL = "co.polychat.ccc-desktop";

export interface DesktopPaths {
  dir: string;
  /** The pasted NODE_EXTRA_CA_CERTS: the user's own extra CAs at setup, then ccc's CA. */
  caPem: string;
  /** ccc's CA certificate alone (public; its key was never kept). */
  caCert: string;
  /** The user's own extra CAs, for the service's own upstream TLS (only when there are some). */
  upstreamCa: string;
  leafPem: string;
  leafKey: string;
  state: string;
  bashEnv: string;
  log: string;
  plist: string;
}

export interface DesktopState {
  mode: DesktopMode;
  port: number;
  token: string;
  /** ISO times: the CA (and leaf) validity, for the rotation notice. */
  createdAt: string;
  notAfter: string;
  /** Setup registered the memtree MCP server, so compress calls may say the tools exist. */
  mcpRegistered?: boolean;
}

export function desktopPaths(configDir: string, mode: DesktopMode): DesktopPaths {
  const dir = path.join(configDir, mode === "production" ? "desktop" : `desktop-${mode}`);
  const label = mode === "production" ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}-${mode}`;
  return {
    dir,
    caPem: path.join(dir, "ca.pem"),
    caCert: path.join(dir, "ccc-ca.pem"),
    upstreamCa: path.join(dir, "upstream-ca.pem"),
    leafPem: path.join(dir, "leaf.pem"),
    leafKey: path.join(dir, "leaf-key.pem"),
    state: path.join(dir, "service.json"),
    bashEnv: path.join(dir, "bash-env.sh"),
    log: path.join(dir, "service.log"),
    plist: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`),
  };
}

export function desktopLaunchdLabel(mode: DesktopMode): string {
  return mode === "production" ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}-${mode}`;
}

/** The lines to paste into Desktop's environment editor (one KEY=value per line). */
export function desktopEnvLines(paths: DesktopPaths, state: DesktopState): string[] {
  return [
    `HTTPS_PROXY=${proxyUrlFor(state.port, state.token)}`,
    `NODE_EXTRA_CA_CERTS=${paths.caPem}`,
    ...Object.entries(PASTED_LIMITS).map(([name, value]) => `${name}=${value}`),
    `CLAUDE_ENV_FILE=${paths.bashEnv}`,
  ];
}

/** What terminal ccc sets for MemTree (claude-env.ts), pasted for Desktop sessions. */
const PASTED_LIMITS: Record<string, string> = {
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: UNREACHABLE_BLOCKING_LIMIT,
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "1000000000",
};

/**
 * Bash-tool commands get the session's env minus ccc's proxy and CA (else curl, Python
 * and others would fail TLS to api.anthropic.com), each only while it still holds ccc's
 * value (Claude Code's sandbox sets its own first; the token is matched by pattern, never
 * written). Programs started from Bash (a nested `claude -p`, an SDK script) aren't routed
 * through ccc, so they get Claude Code's own compaction back.
 */
export function desktopBashEnvScript(paths: DesktopPaths, state: DesktopState): string {
  return [
    "# ccc desktop: written by `ccc desktop setup`; sourced by Claude Code before each Bash command.",
    ...cccProxyRestoreLines(state.port, paths.caPem, {}),
    ...Object.entries(PASTED_LIMITS).map(([name, value]) => ifStill(name, value, `unset ${name}`)),
    "unset CLAUDE_ENV_FILE",
    "true",
    "",
  ].join("\n");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export function readDesktopState(paths: DesktopPaths): DesktopState | undefined {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8")) as DesktopState;
  } catch {
    return undefined;
  }
}

/** Setup rotates the CA when it expires within this. */
export const CA_ROTATE_BEFORE_MS = 30 * 24 * 3600_000;

/**
 * Make the CA and leaf, the token, the port and the Bash env file. A re-run keeps
 * the port and token (the pasted lines stay valid) unless `rotateToken`, and keeps
 * the CA (live sessions trust only the one they started with) unless `rotateCa`,
 * it is missing or unreadable, or it expires within CA_ROTATE_BEFORE_MS.
 */
export async function setupDesktopFiles(
  paths: DesktopPaths, mode: DesktopMode,
  opts: { rotateToken?: boolean; rotateCa?: boolean; userExtraCaPem?: string } = {}
): Promise<DesktopState & { caRotated: boolean }> {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.dir, 0o700);
  const previous = readDesktopState(paths);
  const now = Date.now();
  const write = (file: string, text: string, mode: number): void => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  };
  const caUsable = previous !== undefined && Date.parse(previous.notAfter) - now > CA_ROTATE_BEFORE_MS &&
    [paths.caCert, paths.leafPem, paths.leafKey].every((f) => fs.existsSync(f));
  const caRotated = opts.rotateCa === true || !caUsable;
  if (caRotated) {
    // The CA's key never leaves createSessionCa: it signs this one leaf and is dropped.
    const ca = createSessionCa();
    write(paths.leafKey, ca.leafKeyPem, 0o600);
    write(paths.leafPem, ca.leafCertPem, 0o600);
    write(paths.caCert, ca.caCertPem, 0o644);
  }
  // The pasted NODE_EXTRA_CA_CERTS replaces any the session would have had (a corporate
  // CA from the login shell): keep those first, as terminal proxy mode does.
  const extra = opts.userExtraCaPem?.trim() ?? "";
  const parts = [extra, fs.readFileSync(paths.caCert, "utf8").trim()];
  write(paths.caPem, `${parts.filter(Boolean).join("\n")}\n`, 0o644);
  // The service's own connections to Anthropic need those roots too (launchd gives it
  // none of the shell's env): the plist names this file when it exists (Codex r1 P2).
  if (extra) write(paths.upstreamCa, `${extra}\n`, 0o644);
  else fs.rmSync(paths.upstreamCa, { force: true });
  const state: DesktopState = {
    mode,
    port: previous?.port ?? await pickServicePort(),
    token: !opts.rotateToken && previous?.token ? previous.token : randomBytes(24).toString("hex"),
    createdAt: caRotated || !previous ? new Date(now).toISOString() : previous.createdAt,
    notAfter: caRotated || !previous ? new Date(now + 365 * 24 * 3600_000).toISOString() : previous.notAfter,
    ...(previous?.mcpRegistered ? { mcpRegistered: true } : {}),
  };
  write(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  write(paths.bashEnv, desktopBashEnvScript(paths, state), 0o600);
  return { ...state, caRotated };
}

export function writeDesktopState(paths: DesktopPaths, state: DesktopState): void {
  const { mode, port, token, createdAt, notAfter, mcpRegistered } = state;
  const tmp = `${paths.state}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ mode, port, token, createdAt, notAfter, mcpRegistered }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, paths.state);
}

/**
 * A fixed port for the pasted lines: below the macOS ephemeral range (49152+), so an
 * outgoing connection can't hold it when the service restarts. Free when chosen.
 */
async function pickServicePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 41000 + Math.floor(Math.random() * 7000);
    if (await portFree(port)) return port;
  }
  return freePort();
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** The launchd agent: `node <cli.js> [staging|local] desktop serve`, kept alive. */
export function launchdPlist(mode: DesktopMode, paths: DesktopPaths, cliPath: string): string {
  const args = [process.execPath, cliPath, ...(mode === "production" ? [] : [mode]), "desktop", "serve"];
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${desktopLaunchdLabel(mode)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(`${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>${
  fs.existsSync(paths.upstreamCa)
    ? `\n    <key>NODE_EXTRA_CA_CERTS</key><string>${esc(paths.upstreamCa)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ExitTimeOut</key><integer>45</integer>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(paths.log)}</string>
  <key>StandardErrorPath</key><string>${esc(paths.log)}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent(mode: DesktopMode, paths: DesktopPaths, cliPath: string): void {
  fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
  fs.writeFileSync(paths.plist, launchdPlist(mode, paths, cliPath), { mode: 0o644 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  spawnSync("launchctl", ["bootout", `${domain}/${desktopLaunchdLabel(mode)}`], { stdio: "ignore" });
  // bootout returns before the job is fully gone (it may take its ExitTimeOut to final-index);
  // wait for it to leave, then bootstrap, retrying the transient 5/37 errors.
  for (let i = 0; i < 200 && spawnSync("launchctl", ["print", `${domain}/${desktopLaunchdLabel(mode)}`], { stdio: "ignore" }).status === 0; i++) {
    spawnSync("sleep", ["0.25"]);
  }
  let last = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = spawnSync("launchctl", ["bootstrap", domain, paths.plist], { encoding: "utf8" });
    if (r.status === 0) return;
    last = `${r.status}: ${(r.stderr || "").trim()}`;
    spawnSync("sleep", ["0.25"]);
  }
  throw new Error(`launchctl bootstrap failed (${last})`);
}

export function uninstallLaunchAgent(mode: DesktopMode, paths: DesktopPaths): void {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  spawnSync("launchctl", ["bootout", `${domain}/${desktopLaunchdLabel(mode)}`], { stdio: "ignore" });
  fs.rmSync(paths.plist, { force: true });
}

/**
 * The `memtree` MCP server for every Claude Code on this account (Desktop
 * re-delivers ~/.claude.json's stdio servers to its sessions). It is inert
 * (no tools) unless the session's HTTPS_PROXY is a ccc proxy or it runs
 * under terminal ccc (memtree-mcp.ts desktopMcpTarget). Registered through
 * `claude mcp add-json --scope user`, never by editing ~/.claude.json directly.
 */
export function desktopMcpServerJson(): string {
  return JSON.stringify({
    type: "stdio",
    command: process.execPath,
    args: [MEMTREE_MCP_SCRIPT],
    env: { CCC_MEMTREE_MCP_DESKTOP: "1" },
    alwaysLoad: true,
  });
}

/** The file `claude mcp --scope user` edits: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function userClaudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/**
 * Who owns the user-scope `memtree` entry (read only; never written here). A file that
 * exists but can't be read or parsed is "other": ccc then touches nothing.
 */
export function userMcpOwner(claudeJsonPath = userClaudeJsonPath()): "none" | "ccc-desktop" | "other" {
  let config: { mcpServers?: Record<string, { env?: Record<string, string> }> };
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "none" : "other";
  }
  const entry = config.mcpServers?.[MEMTREE_MCP_SERVER_NAME];
  if (!entry) return "none";
  return entry.env?.CCC_MEMTREE_MCP_DESKTOP === "1" ? "ccc-desktop" : "other";
}

/**
 * Register (or refresh) ccc's entry. Someone else's `memtree` entry is left alone
 * (false, with the reason): the user decides.
 */
export function registerDesktopMcp(
  claudeCommand: string, env: NodeJS.ProcessEnv = process.env
): { ok: boolean; reason?: string } {
  const owner = userMcpOwner(userClaudeJsonPath(env));
  if (owner === "other") {
    return { ok: false, reason: "a user-scope MCP server named `memtree` that ccc didn't add already exists" };
  }
  if (owner === "ccc-desktop") {
    spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", MEMTREE_MCP_SERVER_NAME], { stdio: "ignore", env });
  }
  const r = spawnSync(claudeCommand, [
    "mcp", "add-json", "--scope", "user", MEMTREE_MCP_SERVER_NAME, desktopMcpServerJson(),
  ], { stdio: "inherit", env });
  return r.status === 0 ? { ok: true } : { ok: false, reason: `\`claude mcp add-json\` exited ${r.status}` };
}

/** Remove ccc's entry only, and only when no other ccc desktop mode still uses it. */
export function unregisterDesktopMcp(
  claudeCommand: string, otherModesInstalled: boolean, env: NodeJS.ProcessEnv = process.env
): void {
  if (otherModesInstalled || userMcpOwner(userClaudeJsonPath(env)) !== "ccc-desktop") return;
  spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", MEMTREE_MCP_SERVER_NAME], { stdio: "ignore", env });
}

