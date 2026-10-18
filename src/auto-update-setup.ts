/**
 * Launch-time glue for auto-update.ts: decide what this interactive launch
 * does about an available update, what the SessionStart banner says now, and
 * when the background install starts (after Claude Code is up, never on the
 * startup path; on Windows only as ccc exits, see auto-update.ts).
 */

import { spawn } from "node:child_process";
import {
  AUTO_UPDATE_DELAY_MS,
  AutoUpdateNotices,
  PACKAGE_DIR,
  detectInstallMethod,
  manualUpdateCommand,
  liveLockSince,
  planAutoUpdate,
  readInstalledVersion,
  readUpdateState,
  startAutoUpdateInstall,
  updateFiles,
  type AutoUpdateConfig,
  type AutoUpdateDecision,
  type InstallMethod,
  type SpawnLike,
  type StartInstallResult,
} from "./auto-update.js";
import { updateInstalledNoticeText, updateNoticeText } from "./notices.js";
import { UPGRADE_COMMAND, type UpdateAvailable } from "./update-check.js";

export interface AutoUpdateSetupOptions {
  update: UpdateAvailable | null;
  currentVersion: string;
  config: AutoUpdateConfig;
  configDir: string;
  color: boolean;
  env?: NodeJS.ProcessEnv;
  packageDir?: string;
  now?: () => number;
  spawnImpl?: SpawnLike;
  platform?: NodeJS.Platform;
  uid?: number;
  /** process.argv[1], to see an `npm link` through the bin (detectInstallMethod). */
  scriptPath?: string;
  /** This process (Windows: the runner waits for it to exit). */
  pid?: number;
  /** Test-only: the Node (and so npm) the runner uses. */
  execPath?: string;
}

export interface AutoUpdateSetup {
  decision: AutoUpdateDecision;
  /** Detected only when there is an update to act on. */
  method: InstallMethod | null;
  /** The banner's hint line: shown unless an install is about to run. */
  bannerUpdate: UpdateAvailable | null;
  /** The banner's "✔ installed" line, when an earlier install already landed. */
  bannerInstalled: string | null;
  /** The SessionStart line for later hooks in this process (proxy option). */
  notices: AutoUpdateNotices;
  /**
   * Start the planned install after `delayMs`; a no-op unless planned, and on
   * Windows, where it starts in installOnExit instead.
   */
  scheduleInstall(delayMs?: number, onResult?: (result: StartInstallResult) => void): void;
  /**
   * Windows: start the planned install now, as ccc exits; the runner waits for
   * this process to be gone. A no-op elsewhere or unless planned.
   */
  installOnExit(onResult?: (result: StartInstallResult) => void): void;
  /** One line naming the install method and the decision, for --debug. */
  debugLine: string;
}

/** The banner's ending for a Windows update that installs as ccc exits. */
export const WINDOWS_ON_EXIT_TEXT = "installs when you exit ccc";

export function setupAutoUpdate(opts: AutoUpdateSetupOptions): AutoUpdateSetup {
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
    : ({ action: "skip", reason: "no update available", code: "no-update" } as const);
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  const command = method ? manualUpdateCommand(method.kind) : undefined;
  const withCommand = (update: UpdateAvailable): UpdateAvailable =>
    command && command !== UPGRADE_COMMAND ? { ...update, command } : update;
  // Windows installs as ccc exits: say so now, since nothing installs during the session.
  const onExitBanner = windows && decision.action === "install" && opts.update
    ? { ...opts.update, command: WINDOWS_ON_EXIT_TEXT }
    : null;
  let started = false;
  const start = (onResult?: (result: StartInstallResult) => void) => {
    if (decision.action !== "install" || started) return;
    started = true;
    const spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnLike);
    const result = startAutoUpdateInstall({
      decision, files, spawnImpl, env, now, platform, execPath: opts.execPath,
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
  if (decision.action === "installed") notices.markShown();
  return {
    decision,
    method,
    bannerUpdate: decision.action === "skip" && opts.update ? withCommand(opts.update) : onExitBanner,
    bannerInstalled: decision.action === "installed" ? decision.version : null,
    notices,
    scheduleInstall(delayMs = AUTO_UPDATE_DELAY_MS, onResult) {
      if (decision.action !== "install" || windows) return;
      setTimeout(() => start(onResult), delayMs).unref();
    },
    installOnExit(onResult) {
      if (windows) start(onResult);
    },
    debugLine: debugLine(method, decision, windows),
  };
}

function detectMethod(
  opts: AutoUpdateSetupOptions,
  env: NodeJS.ProcessEnv,
  packageDir: string
): InstallMethod {
  return detectInstallMethod({
    packageDir,
    env,
    platform: opts.platform,
    uid: opts.uid ?? process.getuid?.(),
    scriptPath: opts.scriptPath,
  });
}

function debugLine(
  method: InstallMethod | null,
  decision: AutoUpdateDecision,
  windows: boolean
): string {
  const how = method ? `install method ${method.kind} (${method.detail})` : "no update to install";
  const what =
    decision.action === "install"
      ? (windows ? `installs ${decision.version} when ccc exits`
        : `installing ${decision.version} in the background`)
    : decision.action === "installed" ? `${decision.version} already installed, restart to use it`
    : decision.code === "linked-install" ? "skipped: linked install"
    : `not installing: ${decision.reason}`;
  return `Auto-update: ${how}; ${what}`;
}
