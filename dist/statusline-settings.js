/** Claude Code's effective status-line command. Stop checks metadata only until a
 * settings file changes. The once-only installer still edits just the user file. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { managedPreferencesFiles, managedSettingsDir, readTextFile, settingsArgs } from "./https-proxy-eligibility.js";
function parseSettings(text) {
    const obj = JSON.parse((text ?? "").replace(/^\uFEFF/, ""));
    if (obj === null || Array.isArray(obj) || typeof obj !== "object")
        throw Error("Invalid settings");
    return obj;
}
/** Missing files are normal, other stat/read failures leave the Stop link enabled. */
function stamp(file) {
    const s = fs.statSync(file, { throwIfNoEntry: false });
    return s ? `${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}` : "";
}
// Project settings are anchored at the launch directory. On Unix newer Claude
// versions also load local settings from the owned git root (the main checkout
// for linked worktrees). Never load policy from an unrelated parent project.
function rootLocalSettings(cwd, platform) {
    if (platform === "win32")
        return [];
    let root = cwd;
    while (!fs.existsSync(path.join(root, ".git"))) {
        const parent = path.dirname(root);
        if (root === parent)
            return [];
        root = parent;
    }
    const git = path.join(root, ".git");
    if (fs.statSync(git).isFile()) {
        const match = /^gitdir: (.+)$/m.exec(fs.readFileSync(git, "utf8"));
        if (!match)
            return [];
        const gitDir = path.resolve(root, match[1].trim());
        const commonFile = path.join(gitDir, "commondir");
        if (fs.existsSync(commonFile)) {
            const common = fs.readFileSync(commonFile, "utf8").trim();
            root = path.dirname(path.resolve(gitDir, common));
        }
    }
    if (root === cwd || root === os.homedir())
        return [];
    const uid = process.getuid?.();
    for (const entry of [root, path.join(root, ".git"), path.join(root, ".claude")]) {
        const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
        if (stat && (stat.uid !== uid || stat.isSymbolicLink()))
            return [];
    }
    return [path.join(root, ".claude", "settings.local.json")];
}
export function watchStatuslineSettings(user, options) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const platform = options.platform ?? process.platform;
    const argv = options.claudeArgs ?? [];
    const end = argv.indexOf("--");
    const args = end === -1 ? argv : argv.slice(0, end);
    const flag = settingsArgs(args).at(-1)?.trim();
    const inline = flag?.startsWith("{");
    const sources = new Set((settingsArgs(args, "--setting-sources").at(-1) ?? "user,project,local").split(","));
    const policyDir = options.managedDir ?? managedSettingsDir(platform);
    const dropDir = path.join(policyDir, "managed-settings.d");
    const basePolicy = path.join(policyDir, "managed-settings.json");
    const preferences = options.managedDir ? [] : managedPreferencesFiles(platform);
    const remote = path.join(path.dirname(user), "remote-settings.json");
    // These options change the working directory or which settings Claude loads.
    // A computed/host policy likewise cannot be inferred from its backing files.
    if (args.some(arg => /^(--bare|--safe-mode|--restricted|--worktree|-w)(=|$)/.test(arg))) {
        return () => undefined;
    }
    let local;
    let dropStamp;
    let drops = [];
    let previous;
    let effective;
    return () => {
        try {
            local ??= [
                ...(sources.has("user") ? [user] : []),
                ...(sources.has("project") ? [path.join(cwd, ".claude", "settings.json")] : []),
                ...(sources.has("local") ? [path.join(cwd, ".claude", "settings.local.json"), ...rootLocalSettings(cwd, platform)] : []),
            ];
            const dirStamp = stamp(dropDir);
            if (dirStamp !== dropStamp) {
                drops = dirStamp ? fs.readdirSync(dropDir).filter(name => !name.startsWith(".") && name.endsWith(".json"))
                    .sort().map(name => path.join(dropDir, name)) : [];
                dropStamp = dirStamp;
            }
            const files = [...local, ...(flag && !inline ? [path.resolve(cwd, flag)] : []),
                basePolicy, ...drops, ...preferences, remote];
            const stamps = files.map(stamp);
            const signature = JSON.stringify([dirStamp, stamps]);
            if (signature === previous)
                return effective;
            previous = signature;
            effective = undefined;
            // A cached remote policy can belong to another account or upstream. Only
            // the running Claude process knows whether that cache is in force.
            if (stamps.at(-1))
                return undefined;
            const values = new Map(files.map((file, i) => [file, stamps[i] ? parseSettings(readTextFile(file)) : {}]));
            const ordinary = local.map(file => values.get(file));
            if (flag)
                ordinary.push(inline ? parseSettings(flag) : values.get(path.resolve(cwd, flag)));
            const filePolicy = mergeSettings([basePolicy, ...drops].map(file => values.get(file)));
            // The first managed source with policy keys wins unless MDM requests merging.
            const mdm = preferences.map(file => values.get(file)).reverse().find(hasPolicyKeys);
            const policy = mdm?.managedSourcesBehavior === "merge" ? mergeSettings([filePolicy, mdm]) : mdm ?? filePolicy;
            const settings = mergeSettings([...ordinary, policy]);
            if (!policy.policyHelper && !policy.disableAllHooks &&
                (!(policy.allowManagedHooksOnly || settings.disableAllHooks) || policy.statusLine)) {
                effective = settings;
            }
            return effective;
        }
        catch {
            // Keep a malformed file's decision until its metadata changes.
            return undefined;
        }
    };
}
function hasPolicyKeys(settings) {
    return Object.keys(settings).some(key => key !== "managedSourcesBehavior" && key !== "wslInheritsWindowsSettings");
}
/** Keep just the fields that affect execution. Environment entries merge by key. */
function mergeSettings(layers) {
    const result = {};
    for (const layer of layers) {
        if (layer.statusLine !== undefined)
            result.statusLine = layer.statusLine;
        if (layer.disableAllHooks !== undefined)
            result.disableAllHooks = layer.disableAllHooks;
        if (layer.allowManagedHooksOnly !== undefined)
            result.allowManagedHooksOnly = layer.allowManagedHooksOnly;
        if (layer.policyHelper !== undefined)
            result.policyHelper = layer.policyHelper;
        if (layer.env)
            result.env = { ...result.env, ...layer.env };
    }
    return result;
}
//# sourceMappingURL=statusline-settings.js.map