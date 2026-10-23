/**
 * npm install ping: when npm installs ccc (its postinstall), one anonymous
 * "installed" diagnostics event, so polychat can see installs that never run
 * (polychat docs/install_funnel.md).
 *
 * What is sent: the ccc version, Node version, OS, CPU architecture, how it
 * was installed (npm global, local, npx, ...), whether this machine already
 * had an install id, and that install id: the same random id ccc's
 * diagnostics use later (diagnostics.ts), so an install joins its first run.
 * No key, no paths, no env values.
 *
 * Skipped under every diagnostics opt-out (CCC_NO_DIAGNOSTICS, DO_NOT_TRACK,
 * DISABLE_TELEMETRY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "diagnostics":
 * false), in CI, for `npm install` inside a ccc checkout, and for ccc's own
 * background updates. Never fails or slows the install for long: one POST
 * with a 2 s timeout, every error swallowed, and the process always exits 0.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_UPDATE_ENV } from "./auto-update.js";
import { DIAGNOSTICS_PATH, FIRST_RUN_PENDING_FILE, INSTALL_ID_FILE, diagnosticsEnabled, readOrCreateInstallId, } from "./diagnostics.js";
import { DIAGNOSTICS_SCHEMA, sanitizeContext, sanitizeEvent, threePartVersion, } from "./diagnostics-schema.js";
export const INSTALL_PING_TIMEOUT_MS = 2_000;
export const INSTALL_PING_URL = `https://api.polychat.co${DIAGNOSTICS_PATH}`;
const CLIENT_NAME = "cc-infinite";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Set to anything but 0/false on CI services (the `ci-info` list, abridged). */
const CI_FLAGS = ["CI", "CONTINUOUS_INTEGRATION"];
/** Present only on a CI service. */
const CI_MARKERS = [
    "BUILD_NUMBER", "RUN_ID", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TRAVIS",
    "JENKINS_URL", "TF_BUILD", "TEAMCITY_VERSION", "CODEBUILD_BUILD_ID", "BITBUCKET_BUILD_NUMBER",
    "APPVEYOR", "DRONE", "SEMAPHORE", "NETLIFY", "VERCEL", "HEROKU_TEST_RUN_ID", "CI_NAME",
];
/** Send the ping (or say why not). Never throws. */
export async function runInstallPing(opts = {}) {
    try {
        const env = opts.env ?? process.env;
        const packageDir = opts.packageDir ?? fileURLToPath(new URL("..", import.meta.url));
        const configDir = opts.configDir ?? join(homedir(), ".claude-code-infinite");
        const skip = skipReason(env, packageDir, configDir);
        if (skip)
            return skip;
        const body = installBody(env, packageDir, configDir, opts);
        await (opts.fetchImpl ?? fetch)(opts.url ?? INSTALL_PING_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json", "x-client": CLIENT_NAME,
                "x-client-version": packageVersion(packageDir) ?? "unknown",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(INSTALL_PING_TIMEOUT_MS),
        });
        return "sent";
    }
    catch {
        return "failed";
    }
}
/** Why this install sends nothing, or null to send. */
export function skipReason(env, packageDir, configDir) {
    if (!diagnosticsEnabled(env, readConfig(configDir)))
        return "opted-out";
    if (isCi(env))
        return "ci";
    if (env[AUTO_UPDATE_ENV])
        return "auto-update";
    if (isDevInstall(env, packageDir))
        return "dev-install";
    return null;
}
/** The exact batch the ping sends (polychat's /v1/ccc/diagnostics schema 1). */
export function installBody(env, packageDir, configDir, opts = {}) {
    const platform = opts.platform ?? process.platform;
    const root = platform !== "win32" &&
        ((opts.uid ?? process.getuid?.()) === 0 || env.SUDO_UID !== undefined);
    const install = root ? existingInstallId(configDir) : installIdForPing(configDir);
    const method = root ? "root" : installMethod(env, packageDir);
    const context = sanitizeContext({
        ccc_version: threePartVersion(packageVersion(packageDir) ?? ""),
        node: threePartVersion(process.versions.node), os: platform, arch: process.arch,
        install_method: method,
    });
    const fields = install.created === undefined ? {} : { new_install: install.created };
    const event = sanitizeEvent("installed", fields, (opts.now ?? Date.now)());
    return { schema: DIAGNOSTICS_SCHEMA, install_id: install.id, context, events: [event] };
}
/** npm-global, npx, local, or another package manager's global (from npm's own env). */
export function installMethod(env, packageDir) {
    const p = packageDir.split(sep).join("/").toLowerCase();
    if (p.includes("/_npx/"))
        return "npx";
    const agent = (env.npm_config_user_agent ?? "").split("/")[0];
    if (agent === "pnpm" || agent === "yarn" || agent === "bun")
        return agent;
    if (/\/\.?volta\//.test(p))
        return "volta";
    if (env.npm_config_global === "true")
        return "npm-global";
    return "local";
}
export function isCi(env) {
    if (CI_FLAGS.some((name) => {
        const value = env[name];
        return value !== undefined && !/^(0|false|no|off|)$/i.test(value.trim());
    }))
        return true;
    return CI_MARKERS.some((name) => env[name] !== undefined);
}
/** `npm install` run inside a ccc checkout (its own dependencies), or a git checkout. */
export function isDevInstall(env, packageDir) {
    if (existsSync(join(packageDir, ".git")))
        return true;
    const initCwd = env.INIT_CWD;
    return initCwd !== undefined && samePath(initCwd, packageDir);
}
/** The install id (created, with the first-run marker, when missing); random when unwritable. */
function installIdForPing(configDir) {
    const install = readOrCreateInstallId(configDir);
    if (install === null)
        return { id: randomUUID() };
    if (install.created) {
        try {
            writeFileSync(join(configDir, FIRST_RUN_PENDING_FILE), "\n", { mode: 0o600 });
        }
        catch {
            // ccc's first launch then just doesn't record first_run.
        }
    }
    return install;
}
/** Under sudo nothing is written (a root-owned config folder would break ccc later). */
function existingInstallId(configDir) {
    try {
        const id = readFileSync(join(configDir, INSTALL_ID_FILE), "utf-8").trim();
        if (UUID_RE.test(id))
            return { id, created: false };
    }
    catch {
        // None readable: a one-off id that joins nothing.
    }
    return { id: randomUUID() };
}
function readConfig(configDir) {
    try {
        const parsed = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function packageVersion(packageDir) {
    try {
        const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")).version;
        return typeof version === "string" ? version : null;
    }
    catch {
        return null;
    }
}
function samePath(a, b) {
    const real = (p) => {
        try {
            return realpathSync(p);
        }
        catch {
            return resolve(p);
        }
    };
    const norm = (p) => (process.platform === "win32" ? real(p).toLowerCase() : real(p));
    return norm(a) === norm(b);
}
/** postinstall entry: run, then exit 0 whatever happened, at most ~2.5 s later. */
export function main() {
    setTimeout(() => process.exit(0), INSTALL_PING_TIMEOUT_MS + 500).unref();
    void runInstallPing().finally(() => process.exit(0));
}
//# sourceMappingURL=install-ping.js.map