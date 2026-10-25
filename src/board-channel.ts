/**
 * `ccc --board`: the Command and Control board's channel server
 * (ccc-board's board_channel.py) in this session, so the messages Craig sends
 * on the board arrive as real user turns instead of `board.py wait` output.
 *
 * A Claude Code channel is an MCP server that pushes
 * `notifications/claude/channel` events; Claude Code shows each to the model
 * as a user turn wrapped in `<channel source="board" …>`. Claude Code
 * registers one only when the session names it: a custom (not
 * Anthropic-allowlisted) server needs
 * `--dangerously-load-development-channels server:<name>`, which opens a
 * one-keypress confirmation at startup, and only in an interactive session
 * (Claude Code ignores it with `-p`). It also needs Anthropic first-party
 * auth (a claude.ai login or Console key; ccc's local proxy keeps it), the
 * `tengu_harbor` feature flag, and, for a Team/Enterprise org,
 * `channelsEnabled`. Checked on Claude Code 2.1.310.
 *
 * So ccc adds the server and the flag only when asked (`--board` or
 * `--board=PATH`, a wrapper flag ccc consumes) and only for an interactive
 * session; a print run gets a one-line note instead. PATH (else
 * `CCC_BOARD_CHANNEL`, else `boardChannel` in ~/.claude-code-infinite/
 * config.json) is board_channel.py or the ccc-board checkout holding it. The
 * server runs under `python3` from its own `--mcp-config` file (not ccc's
 * memtree file, which a caller can turn off), with `CCC_BOARD_DIR` passed
 * through when set. Only the coordinator session should get board messages,
 * so nothing is automatic for other sessions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BOARD_CHANNEL_SERVER_NAME = "board";
export const BOARD_CHANNEL_SCRIPT = "board_channel.py";
export const BOARD_FLAG = "--board";
export const DEV_CHANNELS_FLAG = "--dangerously-load-development-channels";
export const BOARD_CHANNEL_ENV = "CCC_BOARD_CHANNEL";
const BOARD_DIR_ENV = "CCC_BOARD_DIR";
const PYTHON = "python3";

/** What `--board` asked for: off, on (path from env/config), or on with a path. */
export type BoardRequest = { on: false } | { on: true; path?: string };

export type BoardChannelPlan =
  | { register: true; script: string }
  | { register: false; note?: string };

/**
 * Whether ccc adds the board channel to this session, and the script it runs.
 * A note explains why a requested board was left out.
 */
export function planBoardChannel(
  request: BoardRequest,
  opts: { interactive: boolean; env: NodeJS.ProcessEnv; configPath?: string }
): BoardChannelPlan {
  if (!request.on) return { register: false };
  if (!opts.interactive) {
    return { register: false, note: "ccc: --board needs an interactive session (Claude Code "
      + "loads channels only there); not adding the board channel" };
  }
  const given = request.path ?? opts.env[BOARD_CHANNEL_ENV] ?? opts.configPath;
  if (!given) {
    return { register: false, note: `ccc: --board needs the ccc-board path: --board=PATH, `
      + `${BOARD_CHANNEL_ENV}, or "boardChannel" in ~/.claude-code-infinite/config.json` };
  }
  const script = boardChannelScript(given);
  if (!script) {
    return { register: false, note: `ccc: no ${BOARD_CHANNEL_SCRIPT} at ${given}; `
      + "not adding the board channel" };
  }
  return { register: true, script };
}

/** board_channel.py itself, or inside the given directory; undefined if absent. */
export function boardChannelScript(given: string): string | undefined {
  const resolved = path.resolve(given.replace(/^~(?=$|[\\/])/, os.homedir()));
  const script = isDirectory(resolved) ? path.join(resolved, BOARD_CHANNEL_SCRIPT) : resolved;
  return fs.existsSync(script) && !isDirectory(script) ? script : undefined;
}

/** The `--mcp-config` JSON naming the board's channel server. */
export function boardChannelMcpConfig(script: string, env: NodeJS.ProcessEnv): object {
  const boardDir = env[BOARD_DIR_ENV];
  return {
    mcpServers: {
      [BOARD_CHANNEL_SERVER_NAME]: {
        type: "stdio",
        command: PYTHON,
        args: [script, "--name", BOARD_CHANNEL_SERVER_NAME],
        ...(boardDir ? { env: { [BOARD_DIR_ENV]: boardDir } } : {}),
      },
    },
  };
}

export interface BoardChannelConfigFile {
  path: string;
  close(): void;
}

export function writeBoardChannelConfig(
  script: string,
  env: NodeJS.ProcessEnv,
  tempRoot: string = os.tmpdir()
): BoardChannelConfigFile {
  const dir = fs.mkdtempSync(path.join(tempRoot, "ccc-board-channel-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(boardChannelMcpConfig(script, env)), { mode: 0o600 });
  let closed = false;
  return {
    path: file,
    close() {
      if (closed) return;
      closed = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Prepend the config and the channel opt-in. `=` forms, because both options
 * are variadic and would otherwise swallow a following positional prompt.
 */
export function withBoardChannelArgs(args: readonly string[], configPath: string): string[] {
  return [
    `--mcp-config=${configPath}`,
    `${DEV_CHANNELS_FLAG}=server:${BOARD_CHANNEL_SERVER_NAME}`,
    ...args,
  ];
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface BoardChannelLaunch {
  args: string[];
  file: BoardChannelConfigFile | null;
}

/**
 * Claude's argv with the board channel added when `--board` asked for it and
 * it can run; a note on stderr when it cannot. Never stops the launch.
 */
export function addBoardChannel(
  args: readonly string[],
  request: BoardRequest,
  opts: { interactive: boolean; env: NodeJS.ProcessEnv; configPath?: string },
  warn: (line: string) => void = (line) => console.error(line)
): BoardChannelLaunch {
  const plan = planBoardChannel(request, opts);
  if (!plan.register) {
    if (plan.note) warn(plan.note);
    return { args: [...args], file: null };
  }
  try {
    const file = writeBoardChannelConfig(plan.script, opts.env);
    return { args: withBoardChannelArgs(args, file.path), file };
  } catch (err) {
    warn(`ccc: board channel not added: ${String(err)}`);
    return { args: [...args], file: null };
  }
}
