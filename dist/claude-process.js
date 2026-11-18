// All Claude launches, including the auth probe and resume, use this resolution.
import { spawn, spawnSync } from "node:child_process";
import { executablePath } from "./executable-path.js";
import { ClaudeLocationError, resolveWindowsClaude } from "./windows-claude-shim.js";
export function claudeInvocation(command, args, platform = process.platform, readFile, isFile) {
    executablePath(command, platform);
    if (platform !== "win32")
        return { command, args };
    const target = resolveWindowsClaude(command, readFile, isFile);
    if (!target)
        throw new ClaudeLocationError(`Claude Code's launcher target is missing: ${command}`);
    return target.node ? { command: target.node, args: [target.file, ...args] } : { command: target.file, args };
}
export function spawnClaude(command, args, options) {
    const job = claudeInvocation(command, args);
    return spawn(executablePath(job.command), job.args, { ...options, shell: false, windowsVerbatimArguments: false });
}
export function spawnClaudeSync(command, args, options) {
    const job = claudeInvocation(command, args);
    return spawnSync(executablePath(job.command), job.args, { ...options, shell: false, windowsVerbatimArguments: false });
}
//# sourceMappingURL=claude-process.js.map