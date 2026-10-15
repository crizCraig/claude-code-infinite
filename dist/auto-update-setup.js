/**
 * Launch-time glue for auto-update.ts: decide what this interactive launch
 * does about an available update, what the SessionStart banner says now, and
 * when the background install starts (after Claude Code is up, never on the
 * startup path).
 */
import { spawn } from "node:child_process";
import { AUTO_UPDATE_DELAY_MS, AutoUpdateNotices, PACKAGE_DIR, detectInstallMethod, liveLockSince, planAutoUpdate, readInstalledVersion, readUpdateState, startAutoUpdateInstall, updateFiles, } from "./auto-update.js";
import { updateInstalledNoticeText, updateNoticeText } from "./notices.js";
export function setupAutoUpdate(opts) {
    const env = opts.env ?? process.env;
    const packageDir = opts.packageDir ?? PACKAGE_DIR;
    const now = opts.now ?? Date.now;
    const files = updateFiles(opts.configDir);
    const method = opts.update ? detectMethod(opts, env, packageDir) : null;
    const decision = method
        ? planAutoUpdate({
            update: opts.update,
            method,
            state: readUpdateState(files.stateFile),
            env,
            config: opts.config,
            now: now(),
            installedVersion: readInstalledVersion(method.packageDir),
            lockHeldSince: liveLockSince(files.lockDir, now()),
        })
        : { action: "skip", reason: "no update available" };
    const notices = new AutoUpdateNotices({
        currentVersion: opts.currentVersion,
        packageDir: method?.packageDir ?? packageDir,
        stateFile: files.stateFile,
        startedAt: now(),
        installedText: (version) => updateInstalledNoticeText(version, opts.color),
        hintText: (update) => updateNoticeText(update, opts.color),
    });
    if (decision.action === "installed")
        notices.markShown();
    return {
        decision,
        method,
        bannerUpdate: decision.action === "skip" ? opts.update : null,
        bannerInstalled: decision.action === "installed" ? decision.version : null,
        notices,
        scheduleInstall(delayMs = AUTO_UPDATE_DELAY_MS, onResult) {
            if (decision.action !== "install")
                return;
            const spawnImpl = opts.spawnImpl ?? spawn;
            const timer = setTimeout(() => {
                const result = startAutoUpdateInstall({ decision, files, spawnImpl, env, now });
                onResult?.(result);
            }, delayMs);
            timer.unref();
        },
        debugLine: debugLine(method, decision),
    };
}
function detectMethod(opts, env, packageDir) {
    return detectInstallMethod({
        packageDir,
        env,
        platform: opts.platform,
        uid: opts.uid ?? process.getuid?.(),
    });
}
function debugLine(method, decision) {
    const how = method ? `install method ${method.kind} (${method.detail})` : "no update to install";
    const what = decision.action === "install" ? `installing ${decision.version} in the background`
        : decision.action === "installed" ? `${decision.version} already installed, restart to use it`
            : `not installing: ${decision.reason}`;
    return `Auto-update: ${how}; ${what}`;
}
//# sourceMappingURL=auto-update-setup.js.map