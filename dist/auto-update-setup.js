/**
 * Launch-time glue for auto-update.ts: decide what this interactive launch
 * does about an available update, what the SessionStart banner says now, and
 * when the background install starts (after Claude Code is up, never on the
 * startup path; on Windows only as ccc exits, see auto-update.ts).
 */
import { spawn } from "node:child_process";
import { AUTO_UPDATE_DELAY_MS, AutoUpdateNotices, PACKAGE_DIR, detectInstallMethod, isLinkedInstall, manualUpdateCommand, liveLockSince, planAutoUpdate, readInstalledVersion, readUpdateState, startAutoUpdateInstall, updateFiles, } from "./auto-update.js";
import { updateInstalledNoticeText, updateNoticeText } from "./notices.js";
import { UPGRADE_COMMAND } from "./update-check.js";
/** The banner's ending for a Windows update that installs as ccc exits. */
export const WINDOWS_ON_EXIT_TEXT = "installs when you exit ccc";
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
        : { action: "skip", reason: "no update available", code: "no-update" };
    const platform = opts.platform ?? process.platform;
    const windows = platform === "win32";
    const command = method ? manualUpdateCommand(method.kind) : undefined;
    const withCommand = (update) => command && command !== UPGRADE_COMMAND ? { ...update, command } : update;
    // Windows installs as ccc exits: say so now, since nothing installs during the session.
    const onExitBanner = windows && decision.action === "install" && opts.update
        ? { ...opts.update, command: WINDOWS_ON_EXIT_TEXT }
        : null;
    let started = false;
    const start = (onResult) => {
        if (decision.action !== "install" || started)
            return;
        started = true;
        const spawnImpl = opts.spawnImpl ?? spawn;
        const result = startAutoUpdateInstall({
            decision, files, spawnImpl, env, now, platform,
            ...(windows ? { waitForPid: opts.pid ?? process.pid } : {}),
        });
        onResult?.(result);
    };
    const notices = new AutoUpdateNotices({
        currentVersion: opts.currentVersion,
        packageDir: method?.packageDir ?? packageDir,
        stateFile: files.stateFile,
        startedAt: now(),
        installedText: (version) => updateInstalledNoticeText(version, opts.color),
        hintText: (update) => updateNoticeText(withCommand(update), opts.color),
    });
    if (decision.action === "installed")
        notices.markShown();
    return {
        decision,
        method,
        bannerUpdate: decision.action === "skip" && opts.update ? withCommand(opts.update) : onExitBanner,
        bannerInstalled: decision.action === "installed" ? decision.version : null,
        notices,
        scheduleInstall(delayMs = AUTO_UPDATE_DELAY_MS, onResult) {
            if (decision.action !== "install" || windows)
                return;
            setTimeout(() => start(onResult), delayMs).unref();
        },
        installOnExit(onResult) {
            if (windows)
                start(onResult);
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
        scriptPath: opts.scriptPath,
    });
}
function debugLine(method, decision) {
    const how = method ? `install method ${method.kind} (${method.detail})` : "no update to install";
    const what = decision.action === "install" ? `installing ${decision.version} in the background`
        : decision.action === "installed" ? `${decision.version} already installed, restart to use it`
            : isLinkedInstall(method?.kind ?? "unknown") ? "skipped: linked install"
                : `not installing: ${decision.reason}`;
    return `Auto-update: ${how}; ${what}`;
}
//# sourceMappingURL=auto-update-setup.js.map