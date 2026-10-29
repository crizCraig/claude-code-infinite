/**
 * Claude Code's own answer to "am I signed in?": `claude auth status --json`
 * (Claude Code 2.x). Unlike the config-file guess in claude-auth.ts, it knows
 * where each OS keeps the credentials (macOS keychain, `.credentials.json` on
 * Linux and Windows), which env key or setting wins, and that nobody is signed
 * in at all, which the files cannot tell apart from "can't tell".
 *
 * Only four fields are read: loggedIn, authMethod, apiProvider and
 * subscriptionType (plus apiKeySource's name). The email, organization and
 * every other field are never parsed out or kept.
 */

import spawn from "cross-spawn";
import type { ApiKeySource, ClaudeAuthType, ClaudePlan } from "./claude-auth.js";
import { planFrom } from "./claude-auth.js";

/** How the probe went: answered, ran but said nothing usable, too slow, or no such command. */
export const AUTH_PROBE_RESULTS = ["ok", "failed", "timeout", "unsupported"] as const;
export type AuthProbeResult = (typeof AUTH_PROBE_RESULTS)[number];

/** A slow Windows npm shim starts node twice; Claude Code itself answers in ~0.1 s. */
export const AUTH_PROBE_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 64 * 1024;

export interface ClaudeAuthStatus {
  /** "none": Claude Code says nobody is signed in. */
  auth: ClaudeAuthType;
  plan: ClaudePlan;
  /** The API key's source by name, for an env key or apiKeyHelper. */
  keySource?: ApiKeySource;
  /** Claude Code's "Anthropic Console account" sign-in (API usage billing). */
  console: boolean;
}

export interface AuthProbe {
  result: AuthProbeResult;
  ms: number;
  status?: ClaudeAuthStatus;
}

export interface ProbeOptions {
  /** Arguments before `auth status --json` (tests run a script through node). */
  leadingArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
}

/** Run `claude auth status --json`; never throws or rejects, and is bounded by timeoutMs. */
export function probeClaudeAuthStatus(
  command: string, opts: ProbeOptions = {}
): Promise<AuthProbe> {
  const now = opts.now ?? Date.now;
  const started = now();
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (result: AuthProbeResult, status?: ClaudeAuthStatus): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ result, ms: Math.max(0, now() - started), ...(status ? { status } : {}) });
    };
    const child = startProbe(command, opts);
    const timer = setTimeout(() => {
      finish("timeout");
      child?.kill();
    }, opts.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS);
    if (!child) return finish("failed");
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
    });
    child.on("error", () => finish("failed"));
    child.on("close", () => {
      const status = parseAuthStatus(out, opts.env ?? process.env);
      finish(status ? "ok" : probeFailure(out), status);
    });
  });
}

/** The sign-in from `claude auth status --json` output, or undefined when it is not that. */
export function parseAuthStatus(
  stdout: string, env: NodeJS.ProcessEnv = process.env
): ClaudeAuthStatus | undefined {
  const json = jsonObject(stdout);
  if (!json || typeof json.loggedIn !== "boolean" || typeof json.authMethod !== "string") {
    return undefined;
  }
  const keySource = apiKeySource(json.apiKeySource);
  const consoleLogin = json.apiKeySource === "/login managed key";
  const base = { console: consoleLogin, ...(keySource ? { keySource } : {}) };
  // A signed-out cloud gateway is not "no Claude plan": ccc can't tell, so it doesn't say.
  if (!json.loggedIn) {
    return json.apiProvider === "firstParty" || json.apiProvider === undefined
      ? { auth: "none", plan: "unknown", ...base } : { auth: "unknown", plan: "unknown", ...base };
  }
  const cloud = cloudProvider(json.apiProvider);
  if (cloud) return { auth: cloud, plan: "unknown", ...base };
  if (json.authMethod === "oauth_token" && nonEmpty(env.ANTHROPIC_AUTH_TOKEN)) {
    // ANTHROPIC_AUTH_TOKEN wins over every other token in Claude Code: a bearer key.
    return { auth: "api_key", plan: "unknown", ...base, keySource: "ANTHROPIC_AUTH_TOKEN" };
  }
  return { ...authFromMethod(json.authMethod, json.subscriptionType), ...base };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startProbe(command: string, opts: ProbeOptions): ReturnType<typeof spawn> | undefined {
  try {
    return spawn(command, [...(opts.leadingArgs ?? []), "auth", "status", "--json"], {
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

/** Older Claude Code has no `auth` command: it prints help or an error, never JSON. */
function probeFailure(stdout: string): AuthProbeResult {
  return stdout.trim().startsWith("{") ? "failed" : "unsupported";
}

function authFromMethod(
  method: string, subscriptionType: unknown
): { auth: ClaudeAuthType; plan: ClaudePlan } {
  const type = typeof subscriptionType === "string" ? subscriptionType : undefined;
  if (method === "claude.ai") return { auth: "subscription", plan: planFrom(type, undefined) };
  // setup-token, a host-provided token, a token file or a profile login: a Claude login.
  if (method === "oauth_token") return { auth: "subscription", plan: "unknown" };
  if (method === "api_key" || method === "api_key_helper") {
    return { auth: "api_key", plan: "unknown" };
  }
  return { auth: "unknown", plan: "unknown" };
}

function cloudProvider(provider: unknown): ClaudeAuthType | undefined {
  if (provider === "bedrock" || provider === "vertex" || provider === "foundry") return provider;
  return undefined;
}

function apiKeySource(source: unknown): ApiKeySource | undefined {
  if (source === "ANTHROPIC_API_KEY" || source === "ANTHROPIC_AUTH_TOKEN") return source;
  if (source === "apiKeyHelper") return "apiKeyHelper";
  return undefined;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
