// Read a package manager's launcher as data. Only the resolved JS file or native
// executable crosses the spawn boundary, even for Yarn Classic's shim-to-shim links.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { win32 as path } from "node:path";
export class ClaudeLocationError extends Error {
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
const npmNode = String.raw `IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
`;
const pathext = "SET PATHEXT=%PATHEXT:;.JS;=;%";
const npmJump = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ";
const berryPrefix = "@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @";
function absolute(file) {
    return path.isAbsolute(file) && path.parse(file).root.length > 1;
}
// Resolve only the generated shim-directory references and fully qualified paths.
// In particular, win32.resolve must never supply the drive from the current directory.
function targetPath(shim, token) {
    const relative = /^(?:%dp0%\\|%~dp0\\)(.+)$/i.exec(token);
    if (relative) {
        const tail = relative[1];
        if (path.parse(tail).root)
            return undefined;
        return path.resolve(path.dirname(shim), tail);
    }
    return absolute(token) ? path.normalize(token) : undefined;
}
function npmBatch(body, native) {
    const legacy = body.startsWith(oldNpmHeader) && body.endsWith(oldNpmFooter);
    if (!legacy && !body.startsWith(npmHeader))
        return false;
    body = legacy ? body.slice(oldNpmHeader.length, -oldNpmFooter.length) : body.slice(npmHeader.length);
    if (native)
        return body === "<entry> %*";
    const prog = '"%_prog%" <entry> %*';
    return body === "\n" + npmNode + "  " + pathext + "\n)\n\n" + (legacy ? "" : npmJump) + prog ||
        !legacy && body === "\n" + npmNode + ")\n\n" + npmJump + "set PATHEXT=%PATHEXT:;.JS;=;% & " + prog;
}
function batchTarget(shim, body) {
    // Every forwarded branch must use the same quoted entry. Match the rest of
    // the batch file too: a custom wrapper's setup or fixed arguments matter.
    const token = /"([^"\r\n]+)" +%\*(?:\n|$)/.exec(body)?.[1];
    if (!token)
        return undefined;
    const pnpm = body.startsWith("@SETLOCAL\n");
    const berry = body.startsWith(berryPrefix);
    // npm initializes %dp0%. Classic and pnpm use %~dp0. Only pnpm and Berry
    // emit literal absolute targets, and Berry always emits one.
    if (absolute(token)) {
        if (!pnpm && !berry)
            return undefined;
    }
    else {
        const prefix = body.startsWith("@ECHO off\n") ? "%dp0%\\" : "%~dp0\\";
        if (berry || !token.startsWith(prefix))
            return undefined;
    }
    const file = targetPath(shim, token);
    if (!file)
        return undefined;
    const js = /\.[cm]?js$/i.test(file);
    const native = /\.exe$/i.test(file);
    // Use one placeholder for the quoted entry, including when it appears in both branches.
    if (body.includes("<entry>"))
        return undefined;
    body = body.replaceAll('"' + token + '"', "<entry>").replace(/ +(?=<entry>|%\*)/g, " ");
    if ((js || native) && npmBatch(body, native))
        return { file, preferLocalNode: js };
    // pnpm starts with SETLOCAL and optionally sets PATH and NODE_PATH. Classic
    // puts SETLOCAL in the fallback branch. Both generate a direct native form.
    let nodePath;
    if (pnpm) {
        body = body.slice("@SETLOCAL\n".length).replace(/^@SET "PATH=[^"%\r\n]+:%PATH%"\n/, "");
        const block = /^@IF NOT DEFINED NODE_PATH \(\n  @SET "NODE_PATH=([^"%\r\n]+)"\n\) ELSE \(\n  @SET "NODE_PATH=([^"\r\n]+)"\n\)\n/.exec(body);
        if (block) {
            const [, paths, fallback] = block;
            const inheritedFirst = fallback === "%NODE_PATH%;" + paths;
            if (!paths.split(";").every(absolute) || (!inheritedFirst && fallback !== paths + ";%NODE_PATH%"))
                return undefined;
            nodePath = { paths, inheritedFirst };
            body = body.slice(block[0].length);
        }
    }
    const local = '"%~dp0\\node.exe"';
    const nodeBranch = "@IF EXIST " + local + " (\n  " + local + " <entry> %*\n) ELSE (\n" +
        (pnpm ? "" : "  @SETLOCAL\n") + "  @" + pathext + "\n  node <entry> %*\n)";
    if (js && body === nodeBranch)
        return { file, preferLocalNode: true, nodePath };
    if (body === "@<entry> %*" && (native || (!pnpm && path.basename(file).toLowerCase() === "claude.cmd"))) {
        return { file, preferLocalNode: false };
    }
    // Berry's makePathWrapper uses absolute paths. pnpm can also pin nodeExecPath.
    if (berry)
        body = body.slice(berryPrefix.length);
    else if (pnpm && body.startsWith("@"))
        body = body.slice(1);
    else
        return undefined;
    if (native && body === "<entry> %*")
        return { file, preferLocalNode: false };
    const node = /^"([^"\n]+)" <entry> %\*$/.exec(body)?.[1];
    if (js && node && absolute(node) && path.basename(node).toLowerCase() === "node.exe") {
        return { file, preferLocalNode: isAdjacentNode(shim, node), nodePath };
    }
    return undefined;
}
function isAdjacentNode(shim, node) {
    return path.relative(path.dirname(shim), node).toLowerCase() === "node.exe";
}
function windowsFileExists(file) {
    try {
        return fs.statSync(file).isFile();
    }
    catch {
        return false;
    }
}
// Both batch launchers and package manifests are small text files. Bind the
// size check and bounded read to the same descriptor, even if PATH is changing.
function readSmallFile(file) {
    const fd = fs.openSync(file, "r");
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 64 * 1024)
            throw new Error("Expected a small launcher or manifest");
        const bytes = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
            if (!n)
                break;
            offset += n;
        }
        if (offset === bytes.length)
            throw new Error("File grew while reading");
        return bytes.toString("utf8", 0, offset);
    }
    finally {
        fs.closeSync(fd);
    }
}
function isDeclaredBin(file, readFile, isFile) {
    // The nearest package owns this entry. Native packages put it under bin/.
    for (let dir = path.dirname(file); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
        if (path.basename(dir).toLowerCase() === "node_modules")
            break;
        const manifest = path.join(dir, "package.json");
        if (!isFile(manifest))
            continue;
        try {
            const pkg = JSON.parse(readFile(manifest));
            const bin = pkg?.bin?.claude;
            return pkg?.name === "@anthropic-ai/claude-code" && typeof bin === "string" &&
                !path.parse(bin).root && path.relative(file, path.resolve(dir, bin)) === "";
        }
        catch {
            return false;
        }
    }
    return false;
}
function unsupported(file) {
    return new ClaudeLocationError(`Unsupported Claude Code wrapper at ${file}. ` +
        "Install Claude Code with npm, pnpm, Yarn or the native installer, " +
        "or set CCC_CLAUDE_PATH to the absolute path of claude.exe or the JavaScript entry.");
}
function isNativeInstall(file, env, home) {
    const key = Object.keys(env).find(k => k.toUpperCase() === "USERPROFILE");
    const profile = (key && env[key]) || home;
    return absolute(profile) && path.relative(file, path.join(profile, ".local", "bin", "claude.exe")) === "";
}
/** A missing target (including an inner shim) lets discovery try the next PATH candidate. */
export function resolveWindowsClaude(command, readFile = readSmallFile, isFile = windowsFileExists, env = process.env, home = homedir()) {
    if (/\.[cm]?js$/i.test(command))
        return { file: command, node: process.execPath }; // Explicit override.
    if (/\.exe$/i.test(command) && path.basename(command).toLowerCase() !== "cmd.exe")
        return { file: command };
    let shim = command;
    const seen = new Set();
    while (/\.(?:cmd|bat)$/i.test(shim) && !seen.has(shim.toLowerCase()) && seen.size < 32) {
        seen.add(shim.toLowerCase());
        if (!isFile(shim))
            return undefined;
        let body;
        try {
            body = readFile(shim);
        }
        catch {
            throw unsupported(command);
        }
        const target = batchTarget(shim, body.replace(/\r\n/g, "\n").replace(/\n$/, ""));
        if (!target)
            throw unsupported(command);
        const file = target.file;
        if (!isFile(file))
            return undefined;
        if (/\.cmd$/i.test(file)) {
            shim = file;
            continue;
        }
        if (isNativeInstall(file, env, home))
            return { file };
        if (!isDeclaredBin(file, readFile, isFile))
            throw unsupported(command);
        if (path.basename(file).toLowerCase() === "claude.exe")
            return { file };
        if (!/\.[cm]?js$/i.test(file))
            throw unsupported(command);
        const local = path.join(path.dirname(shim), "node.exe");
        const node = target.preferLocalNode && isFile(local) ? local : process.execPath;
        if (!target.nodePath)
            return { file, node };
        const key = Object.keys(env).find(k => k.toUpperCase() === "NODE_PATH") ?? "NODE_PATH";
        const inherited = env[key];
        const { paths, inheritedFirst } = target.nodePath;
        const value = !inherited ? paths : inheritedFirst ? inherited + ";" + paths : paths + ";" + inherited;
        return { file, node, env: { ...env, [key]: value } };
    }
    throw unsupported(command);
}
//# sourceMappingURL=windows-claude-shim.js.map