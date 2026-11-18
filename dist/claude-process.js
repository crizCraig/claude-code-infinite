// All Claude launches, including the auth probe and resume, use this resolution.
import { spawn, spawnSync } from "node:child_process";
import { executablePath } from "./executable-path.js";
import { ClaudeLocationError, resolveWindowsClaude } from "./windows-claude-shim.js";
export function claudeInvocation(command, args, platform = process.platform, readFile, isFile, env = process.env) {
    executablePath(command, platform);
    if (platform !== "win32")
        return { command, args };
    const target = resolveWindowsClaude(command, readFile, isFile, env);
    if (!target)
        throw new ClaudeLocationError(`Claude Code's launcher target is missing: ${command}`);
    if (!target.node)
        return { command: target.file, args };
    return { command: target.node, args: [target.file, ...args], ...(target.env && { env: target.env }) };
}
export function spawnClaude(command, args, options) {
    const job = claudeInvocation(command, args, process.platform, undefined, undefined, options.env);
    return spawn(executablePath(job.command), job.args, { ...options, env: job.env ?? options.env, shell: false, windowsVerbatimArguments: false });
}
export function spawnClaudeSync(command, args, options) {
    const job = claudeInvocation(command, args, process.platform, undefined, undefined, options.env);
    return spawnSync(executablePath(job.command), job.args, { ...options, env: job.env ?? options.env, shell: false, windowsVerbatimArguments: false });
}
//# sourceMappingURL=claude-process.js.map