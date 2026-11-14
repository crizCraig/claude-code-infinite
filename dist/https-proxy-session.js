/**
 * One ccc session in HTTPS-proxy mode (https-proxy-mode.ts): its CA, proxy token and
 * temp files, the environment its Claude Code gets, and the Bash env file that gives
 * programs run from Claude Code's Bash tool what they see today under ccc.
 *
 * - The CA (mitm-ca.ts) is made fresh, in memory, at every start; only its public
 *   certificate goes to disk, in a 0700 dir of its own under ~/.claude-code-infinite/
 *   https-proxy/, removed when ccc exits (a startup sweep removes ones a killed ccc
 *   left, once their owner is gone). Not the system temp dir: it can hold hundreds of
 *   thousands of entries (a 200 ms sweep), and on Linux it is shared with other users.
 * - Claude Code gets `HTTPS_PROXY=http://ccc:<token>@127.0.0.1:<port>`, the bundle as
 *   NODE_EXTRA_CA_CERTS (the user's own extra CAs first), no ANTHROPIC_BASE_URL, and
 *   NO_PROXY without entries that would send api.anthropic.com past ccc.
 * - Bash commands source CLAUDE_ENV_FILE (bash-env.sh) first: it puts back the user's
 *   own proxy, CA and NO_PROXY values, each only while it still holds ccc's (Claude
 *   Code's sandbox sets its own before the file is sourced, and those must survive),
 *   and exports today's ANTHROPIC_BASE_URL and first-party marker, so scripts, SDK apps,
 *   `$ANTHROPIC_BASE_URL/memtree/...` and a nested ccc behave as in base-URL mode. The
 *   proxy token is never written to it: ccc's value is matched by pattern.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INTERCEPT_HOST, createSessionCa, sweepStaleSessionDirs, writeCaBundle } from "./mitm-ca.js";
import { PROXY_USER, proxyUrlFor } from "./https-proxy-mode.js";
import { HTTPS_PROXY_MODE_ENV } from "./https-proxy-eligibility.js";
import { getConfigDir } from "./config.js";
const NO_PROXY_VARS = ["NO_PROXY", "no_proxy"];
export function startHttpsProxySession(env, tracePath, root = path.join(getConfigDir(), "https-proxy")) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    sweepStaleSessionDirs(root);
    const ca = createSessionCa();
    const files = writeCaBundle(ca, userExtraCaPem(env), root);
    const proxyToken = randomBytes(24).toString("hex");
    const watch = new ModelCallWatch();
    return {
        proxyOptions: {
            ca: { leafCertPem: ca.leafCertPem, leafKeyPem: ca.leafKeyPem },
            proxyToken,
            ...(tracePath ? { tracePath } : {}),
            onModelCall: () => watch.modelCall(),
        },
        childFor: (port) => childFor(env, files, port, proxyToken),
        promptLine: () => watch.promptLine(),
        cleanup: files.cleanup,
    };
}
function childFor(env, files, port, proxyToken) {
    const noProxy = sanitizedNoProxy(env);
    const bashEnvPath = path.join(files.dir, "bash-env.sh");
    writeFileSync(bashEnvPath, bashEnvScript({
        parentEnv: env, port, bundlePath: files.bundlePath, noProxy,
    }), { mode: 0o600 });
    return {
        proxyUrl: proxyUrlFor(port, proxyToken),
        caBundlePath: files.bundlePath,
        bashEnvPath,
        noProxy,
    };
}
/** The user's NODE_EXTRA_CA_CERTS file, kept first in the bundle; "" when unreadable. */
function userExtraCaPem(env) {
    if (!env.NODE_EXTRA_CA_CERTS)
        return "";
    try {
        return readFileSync(env.NODE_EXTRA_CA_CERTS, "utf8");
    }
    catch {
        return ""; // Claude Code would have warned and ignored it too.
    }
}
/**
 * NO_PROXY / no_proxy for Claude Code: entries that would match api.anthropic.com
 * (`*`, `anthropic.com`, `.anthropic.com`, `*.anthropic.com`, the host itself, with or
 * without a port) are dropped, or Claude Code would bypass ccc. Only changed ones.
 */
export function sanitizedNoProxy(env) {
    const out = {};
    for (const name of NO_PROXY_VARS) {
        const value = env[name];
        if (value === undefined)
            continue;
        const entries = value.split(/[\s,]+/).filter(Boolean);
        const kept = entries.filter((entry) => !noProxyCoversIntercept(entry));
        if (kept.length !== entries.length)
            out[name] = kept.join(",");
    }
    return out;
}
function noProxyCoversIntercept(entry) {
    const host = entry.trim().toLowerCase()
        .replace(/:\d+$/, "").replace(/^\*/, "").replace(/^\./, "").replace(/\.$/, "");
    return host === "" || host === INTERCEPT_HOST || INTERCEPT_HOST.endsWith(`.${host}`);
}
/** The POSIX sh script Claude Code sources before each Bash command (see the header). */
export function bashEnvScript(input) {
    const { parentEnv, port, bundlePath, noProxy } = input;
    const restore = (name) => restoreLine(parentEnv, name);
    const ours = `http://${PROXY_USER}:*@127.0.0.1:${port}`;
    const lines = [
        // ccc removed https_proxy from Claude Code's env exactly when it set HTTPS_PROXY.
        `case "\${HTTPS_PROXY-}" in ${ours}) ${restore("HTTPS_PROXY")}; ${restore("https_proxy")};; esac`,
        ifStill("NODE_EXTRA_CA_CERTS", bundlePath, restore("NODE_EXTRA_CA_CERTS")),
        ...NO_PROXY_VARS.filter((name) => noProxy[name] !== undefined)
            .map((name) => ifStill(name, noProxy[name], restore(name))),
        restore("CLAUDE_ENV_FILE"), restore("CCC_MEMTREE_PROXY"), restore(HTTPS_PROXY_MODE_ENV),
        `export ANTHROPIC_BASE_URL=${shellQuote(`http://127.0.0.1:${port}`)}`,
        "export _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1",
    ];
    const userFile = parentEnv.CLAUDE_ENV_FILE;
    if (userFile) {
        lines.push(`if [ -r ${shellQuote(userFile)} ]; then . ${shellQuote(userFile)}; fi`);
    }
    return `${lines.join("\n")}\n`;
}
function ifStill(name, value, then) {
    return `if [ "\${${name}-}" = ${shellQuote(value)} ]; then ${then}; fi`;
}
function restoreLine(env, name) {
    const value = env[name];
    return value !== undefined ? `export ${name}=${shellQuote(value)}` : `unset ${name}`;
}
export function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
/**
 * Settings that change mid-session (a proxy in a settings `env`, the sandbox turned on)
 * can send Claude Code's model calls past ccc with no error. Two prompts with no model
 * call through ccc between them get one warning.
 */
export class ModelCallWatch {
    promptsWithoutCall = 0;
    warned = false;
    modelCall() {
        this.promptsWithoutCall = 0;
    }
    promptLine() {
        if (this.warned)
            return undefined;
        this.promptsWithoutCall++;
        if (this.promptsWithoutCall < 2)
            return undefined;
        this.warned = true;
        return MODEL_CALLS_MISSING;
    }
}
export const MODEL_CALLS_MISSING = "ccc: your last prompt's model calls didn't reach ccc, so MemTree isn't compressing this " +
    "session. A proxy or the Bash sandbox enabled in Claude Code's settings may be routing " +
    `them elsewhere: restart ccc, or run it with ${HTTPS_PROXY_MODE_ENV}=0.`;
//# sourceMappingURL=https-proxy-session.js.map