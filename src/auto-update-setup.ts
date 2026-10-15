/**
 * Launch-time glue for auto-update.ts: decide what this interactive launch
 * does about an available update, what the SessionStart banner says now, and
 * when the background install starts (after Claude Code is up, never on the
 * startup path).
 */

import { spawn } from "node:child_process";
import {
  AUTO_UPDATE_DELAY_MS,
  AutoUpdateNotices,
  PACKAGE_DIR,
  detectInstallMethod,
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
import type { UpdateAvailable } from "./update-check.js";

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
  /** Start the planned install after `delayMs`; a no-op unless planned. */
  scheduleInstall(delayMs?: number, onResult?: (result: StartInstallResult) => void): void;
  /** One line naming the install method and the decision, for --debug. */
  debugLine: string;
}

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
      })
    : ({ action: "skip", reason: "no update available" } as const);
  const notices = new AutoUpdateNotices({
    currentVersion: opts.currentVersion,
    packageDir: method?.packageDir ?? packageDir,
    stateFile: files.stateFile,
    startedAt: now(),
    installedText: (version) => updateInstalledNoticeText(version, opts.color),
    hintText: (update) => updateNoticeText(update, opts.color),
  });
  if (decision.action === "installed") notices.markShown();
  return {
    decision,
    method,
    bannerUpdate: decision.action === "skip" ? opts.update : null,
    bannerInstalled: decision.action === "installed" ? decision.version : null,
    notices,
    scheduleInstall(delayMs = AUTO_UPDATE_DELAY_MS, onResult) {
      if (decision.action !== "install") return;
      const spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnLike);
      const timer = setTimeout(() => {
        const result = startAutoUpdateInstall({ decision, files, spawnImpl, env, now });
        onResult?.(result);
      }, delayMs);
      timer.unref();
    },
    debugLine: debugLine(method, decision),
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
  });
}

function debugLine(method: InstallMethod | null, decision: AutoUpdateDecision): string {
  const how = method ? `install method ${method.kind} (${method.detail})` : "no update to install";
  const what =
    decision.action === "install" ? `installing ${decision.version} in the background`
    : decision.action === "installed" ? `${decision.version} already installed, restart to use it`
    : `not installing: ${decision.reason}`;
  return `Auto-update: ${how}; ${what}`;
}
