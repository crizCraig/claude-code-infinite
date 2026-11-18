// Read a package manager's launcher as data. Only the resolved JS file or native
// executable crosses the spawn boundary, even for Yarn Classic's shim-to-shim links.
import * as fs from "node:fs";
import { win32 as path } from "node:path";

export class ClaudeLocationError extends Error {}

interface ShimTarget {
  file: string;
  preferLocalNode: boolean;
}

const npmHeader = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
`;
const oldNpmHeader = "@ECHO off\nSETLOCAL\nCALL :find_dp0\n";
const oldNpmFooter = "\nENDLOCAL\nEXIT /b %errorlevel%\n:find_dp0\nSET dp0=%~dp0\nEXIT /b";
const npmNode = String.raw`IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
`;
const pathext = "SET PATHEXT=%PATHEXT:;.JS;=;%";
const npmJump = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ";
const berryPrefix = "@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @";

function absolute(file: string): boolean {
  return path.isAbsolute(file) && path.parse(file).root.length > 1;
}

// Resolve only the generated shim-directory references and fully qualified paths.
// In particular, win32.resolve must never supply the drive from the current directory.
function targetPath(shim: string, token: string): string | undefined {
  const relative = /^(?:%dp0%\\|%~dp0\\|\$basedir(?:_win)?\/)(.+)$/i.exec(token);
  if (relative) {
    const tail = relative[1];
    if (path.parse(tail).root) return undefined;
    return path.resolve(path.dirname(shim), tail);
  }
  return absolute(token) ? path.normalize(token) : undefined;
}

function npmBatch(body: string, native: boolean): boolean {
  const legacy = body.startsWith(oldNpmHeader) && body.endsWith(oldNpmFooter);
  if (!legacy && !body.startsWith(npmHeader)) return false;
  body = legacy ? body.slice(oldNpmHeader.length, -oldNpmFooter.length) : body.slice(npmHeader.length);
  body = body.trimStart();
  if (native) return body === "<entry> %*";
  const prog = '"%_prog%" <entry> %*';
  return body === npmNode + "  " + pathext + "\n)\n\n" + (legacy ? "" : npmJump) + prog ||
    body === npmNode + ")\n\n" + npmJump + "set PATHEXT=%PATHEXT:;.JS;=;% & " + prog;
}

function batchTarget(shim: string, body: string): ShimTarget | undefined {
  // Every forwarded branch must use the same quoted entry. Match the rest of
  // the batch file too: a custom wrapper's setup or fixed arguments matter.
  const token = /"([^"\r\n]+)" +%\*(?:\n|$)/.exec(body)?.[1];
  if (!token) return undefined;
  const pnpm = body.startsWith("@SETLOCAL\n");
  const berry = body.startsWith(berryPrefix);
  // npm initializes %dp0%. Classic and pnpm use %~dp0. Only pnpm and Berry
  // emit literal absolute targets, and Berry always emits one.
  if (absolute(token)) {
    if (!pnpm && !berry) return undefined;
  } else {
    const prefix = body.startsWith("@ECHO off\n") ? "%dp0%\\" : "%~dp0\\";
    if (berry || !token.startsWith(prefix)) return undefined;
  }
  const file = targetPath(shim, token);
  if (!file) return undefined;
  const js = /\.[cm]?js$/i.test(file);
  const native = /\.exe$/i.test(file);
  // Use one placeholder for the quoted entry, including when it appears in both branches.
  if (body.includes("<entry>")) return undefined;
  body = body.replaceAll('"' + token + '"', "<entry>").replace(/ +(?=<entry>|%\*)/g, " ");
  if ((js || native) && npmBatch(body, native)) return { file, preferLocalNode: js };

  // pnpm starts with SETLOCAL and optionally sets PATH and NODE_PATH. Classic
  // puts SETLOCAL in the fallback branch. Both generate a direct native form.
  if (pnpm) {
    body = body.slice("@SETLOCAL\n".length)
      .replace(/^@SET "PATH=[^"\n]+:%PATH%"\n/, "")
      .replace(/^@IF NOT DEFINED NODE_PATH \(\n  @SET "NODE_PATH=([^"\n]+)"\n\) ELSE \(\n  @SET "NODE_PATH=\1;%NODE_PATH%"\n\)\n/, "");
  }
  const local = '"%~dp0\\node.exe"';
  const branch = (nearby: string, fallback: string) =>
    "@IF EXIST " + nearby + " (\n  " + nearby + " <entry> %*\n) ELSE (\n" +
    (pnpm ? "" : "  @SETLOCAL\n") + "  @" + pathext + "\n  " + fallback + " <entry> %*\n)";
  if (js && body === branch(local, "node")) return { file, preferLocalNode: true };
  if (!pnpm && path.basename(file) === "claude" && body === branch('"%~dp0\\/bin/sh.exe"', "/bin/sh")) {
    return { file, preferLocalNode: false }; // Classic global link to its inner sh shim.
  }
  if (body === "@<entry> %*" && (native || /\.cmd$/i.test(file))) return { file, preferLocalNode: false };

  // Berry's makePathWrapper uses absolute paths. pnpm can also pin nodeExecPath.
  if (berry) body = body.slice(berryPrefix.length);
  else if (pnpm && body.startsWith("@")) body = body.slice(1);
  else return undefined;
  if (native && body === "<entry> %*") return { file, preferLocalNode: false };
  const node = /^"([^"\n]+)" <entry> %\*$/.exec(body)?.[1];
  if (js && node && absolute(node) && path.basename(node).toLowerCase() === "node.exe") {
    return { file, preferLocalNode: isAdjacentNode(shim, node) };
  }
  return undefined;
}

// Berry quotes its Windows paths in its extensionless sh companion. makePathWrapper
// escapes an apostrophe in the JS filename by closing and reopening single quotes.
function berryScript(shim: string, body: string): ShimTarget | undefined {
  const match = /^#!\/bin\/sh\nexec "([^"\n]+)" +(?:'([^\n]+)' +)?"\$@"$/.exec(body);
  if (!match || !absolute(match[1])) return undefined;
  if (!match[2]) {
    return /\.exe$/i.test(match[1]) ? { file: path.normalize(match[1]), preferLocalNode: false } : undefined;
  }
  const file = match[2].replaceAll("'\"'\"'", "'");
  if (!absolute(file) || !/\.[cm]?js$/i.test(file) || path.basename(match[1]).toLowerCase() !== "node.exe") return undefined;
  return { file: path.normalize(file), preferLocalNode: isAdjacentNode(shim, match[1]) };
}

function isAdjacentNode(shim: string, node: string): boolean {
  return path.relative(path.dirname(shim), node).toLowerCase() === "node.exe";
}

function scriptTarget(shim: string, body: string, powershell: boolean): ShimTarget | undefined {
  // cmd-shim and @zkochan/cmd-shim vary in their platform detection and pipeline
  // boilerplate. Require consistent targets across all argv-forwarding branches.
  if (powershell) {
    if (!body.startsWith("#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n")) return undefined;
  } else {
    const berry = berryScript(shim, body);
    if (berry) return berry;
    if (!body.startsWith("#!/bin/sh\n") || !/^(?:basedir=\$\(dirname |link="\$0")/m.test(body)) return undefined;
  }
  const forward = powershell ? " $args" : ' "$@"';
  const prefix = powershell ? /^(?:\$input \| )?& / : /^(?:exec +)?(?:NODE_PATH="[^"\n]*" +)?/;
  let result: ShimTarget | undefined;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.endsWith(forward) || line.startsWith("#")) continue;
    const call = line.slice(0, -forward.length).trimEnd().replace(prefix, "");
    const match = /^(?:(.+?) +)?"([^"\n]+)"$/.exec(call);
    if (!match) return undefined;
    const file = targetPath(shim, match[2]);
    if (!file || (result && path.relative(file, result.file) !== "")) return undefined;
    const runtime = match[1];
    let preferLocalNode: boolean = result?.preferLocalNode ?? false;
    if (!runtime) {
      if (!/\.exe$/i.test(file)) return undefined;
    } else if (!powershell && (runtime === '"/bin/sh"' || runtime === "/bin/sh" || runtime === '"$basedir//bin/sh"')) {
      if (path.basename(file) !== "claude") return undefined; // Classic's outer global shim.
    } else {
      if (!/\.[cm]?js$/i.test(file)) return undefined;
      if (/^"\$basedir\/node(?:\.exe|\$exe)?"$/.test(runtime) || runtime === '"$PROG_EXE"') {
        preferLocalNode = true;
      } else if (!/^(?:node(?:\.exe)?|"node\$exe")$/.test(runtime)) {
        const node = /^"([^"\n]+[\\/]node\.exe)"$/i.exec(runtime)?.[1];
        if (!node || !absolute(node)) return undefined;
        preferLocalNode = isAdjacentNode(shim, node);
      }
    }
    result = { file, preferLocalNode };
  }
  return result;
}

function windowsFileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** A missing target (including an inner shim) lets discovery try the next PATH candidate. */
export function resolveWindowsClaude(command: string, readFile = (f: string) => fs.readFileSync(f, "utf8"),
  isFile = windowsFileExists): { file: string; node?: string } | undefined {
  let file = command;
  const seen = new Set<string>();
  while (!/\.(?:exe|com|[cm]?js)$/i.test(file)) {
    if (!isFile(file)) return undefined;
    const batch = /\.(?:cmd|bat)$/i.test(file);
    const body = readFile(file).trim().replace(/\r\n/g, "\n");
    const target = batch ? batchTarget(file, body) : scriptTarget(file, body, /\.ps1$/i.test(file));
    if (!target || seen.has(file.toLowerCase()) || seen.size >= 32) {
      throw new ClaudeLocationError(`Unsupported Claude Code wrapper at ${file}. Install Claude Code with npm or the native installer, ` +
        "or set CCC_CLAUDE_PATH to the absolute path of claude.exe or the JavaScript entry.");
    }
    seen.add(file.toLowerCase());
    const localNode = path.join(path.dirname(file), "node.exe");
    file = target.file;
    if (!isFile(file)) return undefined;
    if (/\.[cm]?js$/i.test(file)) {
      return { file, node: target.preferLocalNode && isFile(localNode) ? localNode : process.execPath };
    }
  }
  if (path.basename(file).toLowerCase() === "cmd.exe") throw new ClaudeLocationError("Claude Code must be a native executable or JavaScript entry.");
  return /\.[cm]?js$/i.test(file) ? { file, node: process.execPath } : { file };
}
