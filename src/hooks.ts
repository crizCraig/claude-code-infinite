/**
 * Display-only Claude Code hook support for MemTree notices.
 *
 * Notices must never be represented as Anthropic assistant content: Claude
 * Code can reuse that content for hidden requests such as away recaps. Modern
 * Claude Code releases provide MessageDisplay, whose output changes only the
 * rendered delta. Stop's top-level systemMessage is the fallback for turns
 * that never render text (for example, a tool-only response).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MESSAGE_DISPLAY_MIN_VERSION = "2.1.166";
export const DEFAULT_NOTICE_TTL_MS = 60 * 60 * 1000;
const ANSI_GREEN = "\x1b[32m";
const ANSI_DEFAULT_FOREGROUND = "\x1b[39m";

type NoticeText = string | (() => string);

interface ColorCapableStream {
  hasColors?: (count?: number, env?: NodeJS.ProcessEnv) => boolean;
}

/** Respect explicit monochrome settings and Node's platform color detection. */
export function terminalSupportsColor(
  env: NodeJS.ProcessEnv = process.env,
  stream: ColorCapableStream = process.stdout
): boolean {
  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) return false;
  if (env.TERM?.toLowerCase() === "dumb") return false;
  try {
    if (typeof stream.hasColors === "function") {
      return stream.hasColors(8, env);
    }
  } catch {
    // Unknown/custom stream: Claude Code itself still handles standard SGR.
  }
  return true;
}

interface PendingNoticePart {
  text: NoticeText;
  onDelivered?: () => void;
}

interface PendingNotice {
  createdAt: number;
  promptId?: string;
  prefix?: PendingNoticePart;
  suffix?: PendingNoticePart;
}

export interface MessageDisplayHookInput {
  hook_event_name: "MessageDisplay";
  session_id: string;
  turn_id: string;
  message_id: string;
  index: number;
  final: boolean;
  delta: string;
  prompt_id?: string;
  agent_id?: string;
}

export interface StopHookInput {
  hook_event_name: "Stop";
  session_id: string;
  stop_hook_active?: boolean;
  prompt_id?: string;
  agent_id?: string;
}

export interface UserPromptSubmitHookInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt: string;
  prompt_id?: string;
  agent_id?: string;
}

export interface SubagentLifecycleHookInput {
  hook_event_name: "SubagentStart" | "SubagentStop";
  session_id: string;
  agent_id: string;
  agent_type?: string;
  prompt_id?: string;
}

export type NoticeHookInput =
  | MessageDisplayHookInput
  | StopHookInput
  | UserPromptSubmitHookInput
  | SubagentLifecycleHookInput;

export type MessageDisplayHookOutput = {
  hookSpecificOutput: {
    hookEventName: "MessageDisplay";
    displayContent: string;
  };
};

export type StopHookOutput = { systemMessage: string };
export type NoticeHookOutput = MessageDisplayHookOutput | StopHookOutput;

/**
 * Single-session delivery queue. Claude Code serializes main-thread turns, so
 * one replaceable pending notice is sufficient. A new user request clears any
 * stale notice; tool-result requests deliberately do not.
 */
export class NoticeDeliveryQueue {
  private pending: PendingNotice | null = null;

  constructor(
    private readonly ttlMs = DEFAULT_NOTICE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly colorSuccess = terminalSupportsColor()
  ) {}

  /** Replace stale delivery state when a new main human prompt is submitted. */
  clearForUserRequest(): void {
    this.pending = null;
  }

  queuePrefix(
    text: NoticeText,
    onDelivered?: () => void,
    promptId?: string
  ): void {
    this.pending = {
      createdAt: this.now(),
      promptId,
      prefix: { text, onDelivered },
    };
  }

  queueSuffix(
    text: NoticeText,
    onDelivered?: () => void,
    promptId?: string
  ): void {
    this.pending = {
      createdAt: this.now(),
      promptId,
      suffix: { text, onDelivered },
    };
  }

  /**
   * Claim eligible notice parts atomically for one hook invocation. Subagent
   * hooks share the plugin but must never consume the main turn's notice.
   */
  claim(input: NoticeHookInput): NoticeHookOutput | null {
    if (input.agent_id !== undefined) return null;
    if (
      input.hook_event_name !== "MessageDisplay" &&
      input.hook_event_name !== "Stop"
    ) {
      return null;
    }
    const pending = this.freshPending();
    if (!pending) return null;
    if (
      pending.promptId !== undefined &&
      input.prompt_id !== undefined &&
      pending.promptId !== input.prompt_id
    ) {
      return null;
    }

    if (input.hook_event_name === "MessageDisplay") {
      const prefix = input.index === 0 ? pending.prefix : undefined;
      const suffix = input.final ? pending.suffix : undefined;
      if (!prefix && !suffix) return null;

      // Remove before callbacks or response construction so a reentrant/parallel
      // Stop hook cannot deliver the same notice a second time.
      if (prefix) delete pending.prefix;
      if (suffix) delete pending.suffix;
      this.dropIfEmpty(pending);
      markDelivered(prefix);
      markDelivered(suffix);

      let displayContent = input.delta;
      if (prefix) {
        // MessageDisplay exposes text rather than a structured style token.
        // Standard named-color SGR is interpreted by Claude Code on every
        // supported terminal (and stripped cleanly in monochrome/NO_COLOR).
        // Reset foreground only so surrounding renderer styles are preserved.
        const styled = this.styleSuccess(resolveNoticeText(prefix));
        displayContent = `${styled}\n${displayContent}`;
      }
      if (suffix) {
        const separator = displayContent && !displayContent.endsWith("\n") ? "\n" : "";
        displayContent = `${displayContent}${separator}${resolveNoticeText(suffix)}`;
      }
      return {
        hookSpecificOutput: {
          hookEventName: "MessageDisplay",
          displayContent,
        },
      };
    }

    const prefix = pending.prefix;
    const suffix = pending.suffix;
    if (!prefix && !suffix) return null;
    this.pending = null;
    markDelivered(prefix);
    markDelivered(suffix);
    const lines: string[] = [];
    if (prefix) lines.push(this.styleSuccess(resolveNoticeText(prefix)));
    if (suffix) lines.push(resolveNoticeText(suffix));
    return {
      systemMessage: lines.join("\n"),
    };
  }

  private styleSuccess(text: string): string {
    return this.colorSuccess
      ? `${ANSI_GREEN}${text}${ANSI_DEFAULT_FOREGROUND}`
      : text;
  }

  private freshPending(): PendingNotice | null {
    if (!this.pending) return null;
    if (this.now() - this.pending.createdAt > this.ttlMs) {
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  private dropIfEmpty(pending: PendingNotice): void {
    if (!pending.prefix && !pending.suffix && this.pending === pending) {
      this.pending = null;
    }
  }
}

function resolveNoticeText(part: PendingNoticePart): string {
  try {
    return typeof part.text === "function" ? part.text() : part.text;
  } catch {
    // A late metrics formatter must never break the display hook.
    return "";
  }
}

function markDelivered(part: PendingNoticePart | undefined): void {
  if (!part?.onDelivered) return;
  try {
    part.onDelivered();
  } catch {
    // UI delivery succeeded; accounting callbacks must not break the hook.
  }
}

/** Strictly validate the subset of Claude hook input that delivery relies on. */
export function parseNoticeHookInput(value: unknown): NoticeHookInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.session_id !== "string" || input.session_id.length === 0) {
    return null;
  }
  if (input.agent_id !== undefined && typeof input.agent_id !== "string") {
    return null;
  }
  if (input.prompt_id !== undefined && typeof input.prompt_id !== "string") {
    return null;
  }

  if (input.hook_event_name === "MessageDisplay") {
    if (
      typeof input.turn_id !== "string" ||
      typeof input.message_id !== "string" ||
      !Number.isInteger(input.index) ||
      (input.index as number) < 0 ||
      typeof input.final !== "boolean" ||
      typeof input.delta !== "string"
    ) {
      return null;
    }
    return input as unknown as MessageDisplayHookInput;
  }

  if (input.hook_event_name === "Stop") {
    if (
      input.stop_hook_active !== undefined &&
      typeof input.stop_hook_active !== "boolean"
    ) {
      return null;
    }
    return input as unknown as StopHookInput;
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    if (typeof input.prompt !== "string") return null;
    return input as unknown as UserPromptSubmitHookInput;
  }
  if (
    input.hook_event_name === "SubagentStart" ||
    input.hook_event_name === "SubagentStop"
  ) {
    if (typeof input.agent_id !== "string" || input.agent_id.length === 0) {
      return null;
    }
    if (input.agent_type !== undefined && typeof input.agent_type !== "string") {
      return null;
    }
    return input as unknown as SubagentLifecycleHookInput;
  }
  return null;
}

export interface SessionNoticePlugin {
  dir: string;
  close(): void;
}

/** Prepend the repeatable global option without disturbing any user argv. */
export function withSessionNoticePluginArgs(
  args: readonly string[],
  pluginDir: string
): string[] {
  return ["--plugin-dir", pluginDir, ...args];
}

/**
 * Build a minimal session-only plugin. --plugin-dir is repeatable, unlike
 * --settings (where Claude keeps only the final occurrence), so this composes
 * with all user settings and hooks.
 */
export function createSessionNoticePlugin(
  hookUrl: string,
  opts: { messageDisplay?: boolean; tempRoot?: string } = {}
): SessionNoticePlugin {
  const url = new URL(hookUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("notice hook URL must use randomized localhost HTTP endpoint");
  }

  const dir = fs.mkdtempSync(
    path.join(opts.tempRoot ?? os.tmpdir(), "ccc-notice-plugin-")
  );
  const manifestDir = path.join(dir, ".claude-plugin");
  const hooksDir = path.join(dir, "hooks");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  const hook = { type: "http", url: hookUrl, timeout: 5 };
  const hooks: Record<string, unknown> = {
    Stop: [{ hooks: [hook] }],
    UserPromptSubmit: [{ hooks: [hook] }],
    SubagentStart: [{ hooks: [hook] }],
    SubagentStop: [{ hooks: [hook] }],
  };
  if (opts.messageDisplay !== false) {
    hooks.MessageDisplay = [{ hooks: [hook] }];
  }

  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({
      name: "ccc-session-notices",
      version: "1.0.0",
      description: "Session-only display hooks for Claude Code Infinite",
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(hooksDir, "hooks.json"),
    JSON.stringify({ description: "Display MemTree state", hooks }),
    { mode: 0o600 }
  );

  let closed = false;
  return {
    dir,
    close() {
      if (closed) return;
      closed = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Return true only for known Claude versions that support MessageDisplay. */
export function supportsMessageDisplay(versionOutput: string): boolean {
  const match = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const current = match.slice(1, 4).map(Number);
  const minimum = MESSAGE_DISPLAY_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i];
  }
  return true;
}
