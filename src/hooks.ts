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
/** Trailer labels; kept here so hooks.ts stays free of notices.ts imports. */
export const TRAILER_LABEL = "∞ MemTree ·";
export const TRAILER_NEW_LABEL = "∞ MemTree · new index ·";
export const DEFAULT_NOTICE_TTL_MS = 60 * 60 * 1000;
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DEFAULT_FOREGROUND = "\x1b[39m";
const ANSI_DIM = "\x1b[2m";
const ANSI_NORMAL_INTENSITY = "\x1b[22m";
const STARTUP_NOTICE_FILE = "startup-notice.json";

type NoticeText = string | (() => string);
/**
 * Resolves the link appended to the success line for a session at claim
 * time, or undefined when there is none. Evaluated lazily so the newest
 * value (for example a MemTree page whose index finished during the tool
 * loop) is what the user sees. The link is rendered unstyled after the
 * styled text: Claude Code linkifies bare URLs and would swallow a trailing
 * SGR reset into the link text.
 */
type LinkResolver = (sessionId: string | undefined) => SuccessLink | undefined;

/** A link to show on the success line, shown once per distinct `key`. */
export interface SuccessLink {
  /** What makes this link news — e.g. the index it stands for, not its URL. */
  key: string;
  link: string;
}

/**
 * Where the trailer (`∞ MemTree · <link>`) is shown: under every finished
 * assistant message (with Stop as the fallback for a turn that rendered no
 * text), or on Stop only, once per turn.
 */
export type TrailerPlacement = "message" | "stop";

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
  private link: LinkResolver | null = null;
  /** Key of the last link shown; the same key is not repeated. */
  private lastLinkKey: string | null = null;
  private trailer: LinkResolver | null = null;
  private trailerPlacement: TrailerPlacement = "message";
  /** Key of the last trailer shown; a different key is announced as new. */
  private lastTrailerKey: string | null = null;
  /** Whether a trailer was rendered under a message since the last Stop. */
  private trailerShownThisTurn = false;

  constructor(
    private readonly ttlMs = DEFAULT_NOTICE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly color = terminalSupportsColor()
  ) {}

  /** Replace stale delivery state when a new main human prompt is submitted. */
  clearForUserRequest(): void {
    this.pending = null;
  }

  /**
   * Install the per-session link that rides the success line, shown once per
   * change: `<success text> · <link>`. Unlike prefix/suffix notices it is
   * not per-prompt; it describes the conversation's current state whenever a
   * success line is next shown.
   */
  setLink(resolve: LinkResolver | null): void {
    this.link = resolve;
  }

  /** Whether the next success line would carry a link not shown before. */
  linkPending(sessionId: string | undefined): boolean {
    return this.resolveLink(sessionId) !== undefined;
  }

  /**
   * Install the trailer: the newest link for the session, shown after every
   * message (or on every Stop), the first time under a new `key` marked as
   * new. Not once-per-key like the success-line link: the point is that the
   * link is always at the bottom of the screen.
   */
  setTrailer(
    resolve: LinkResolver | null,
    placement: TrailerPlacement = "message"
  ): void {
    this.trailer = resolve;
    this.trailerPlacement = placement;
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
    if (input.hook_event_name === "MessageDisplay") {
      return this.claimForDisplay(input);
    }
    if (input.hook_event_name !== "Stop") return null;

    const pending = this.freshPending();
    const matched =
      pending && this.promptMatches(pending, input.prompt_id) ? pending : null;
    const prefix = matched?.prefix;
    const suffix = matched?.suffix;
    // Stop is the turn's last hook: the trailer lands here when the turn
    // rendered no message to carry it ("message"), or always ("stop").
    const trailerDue =
      this.trailerPlacement === "stop" || !this.trailerShownThisTurn;
    const trailer = trailerDue ? this.renderTrailer(input.session_id) : undefined;
    this.trailerShownThisTurn = false;
    if (!prefix && !suffix && trailer === undefined) return null;
    if (prefix || suffix) this.pending = null;
    markDelivered(prefix);
    markDelivered(suffix);
    const lines: string[] = [];
    if (prefix) lines.push(this.renderSuccess(prefix, input.session_id));
    if (suffix) lines.push(this.styleWarning(resolveNoticeText(suffix)));
    if (trailer !== undefined) lines.push(trailer);
    return {
      systemMessage: lines.join("\n"),
    };
  }

  private claimForDisplay(
    input: MessageDisplayHookInput
  ): NoticeHookOutput | null {
    const pending = this.freshPending();
    const matched =
      pending && this.promptMatches(pending, input.prompt_id) ? pending : null;
    const prefix = matched && input.index === 0 ? matched.prefix : undefined;
    const suffix = matched && input.final ? matched.suffix : undefined;
    const trailer =
      input.final && this.trailerPlacement === "message"
        ? this.renderTrailer(input.session_id)
        : undefined;
    if (trailer !== undefined) this.trailerShownThisTurn = true;
    if (!prefix && !suffix && trailer === undefined) return null;

    // Remove before callbacks or response construction so a reentrant/parallel
    // Stop hook cannot deliver the same notice a second time.
    if (prefix) delete matched!.prefix;
    if (suffix) delete matched!.suffix;
    if (matched) this.dropIfEmpty(matched);
    markDelivered(prefix);
    markDelivered(suffix);

    let displayContent = input.delta;
    if (prefix) {
      // MessageDisplay exposes text rather than a structured style token.
      // Standard named-color SGR is interpreted by Claude Code on every
      // supported terminal (and stripped cleanly in monochrome/NO_COLOR).
      // Reset foreground only so surrounding renderer styles are preserved.
      const styled = this.renderSuccess(prefix, input.session_id);
      displayContent = `${styled}\n${displayContent}`;
    }
    if (suffix) {
      const separator = displayContent && !displayContent.endsWith("\n") ? "\n" : "";
      const styled = this.styleWarning(resolveNoticeText(suffix));
      displayContent = `${displayContent}${separator}${styled}`;
    }
    if (trailer !== undefined) {
      // A blank line keeps the trailer apart from the answer above it.
      const separator = displayContent && !displayContent.endsWith("\n") ? "\n" : "";
      displayContent = `${displayContent}${separator}\n${trailer}`;
    }
    return {
      hookSpecificOutput: {
        hookEventName: "MessageDisplay",
        displayContent,
      },
    };
  }

  private promptMatches(
    pending: PendingNotice,
    promptId: string | undefined
  ): boolean {
    return (
      pending.promptId === undefined ||
      promptId === undefined ||
      pending.promptId === promptId
    );
  }

  private styleSuccess(text: string): string {
    return this.style(text, ANSI_GREEN);
  }

  /** Warnings get the same own-line treatment as success, in yellow. */
  private styleWarning(text: string): string {
    return this.style(text, ANSI_YELLOW);
  }

  /**
   * The success line, with the session's not-yet-shown link (if any) after
   * a separator — `✓ … optimized · <link>`. Claiming the link here marks it
   * shown, so it rides exactly one success line.
   */
  private renderSuccess(
    prefix: PendingNoticePart,
    sessionId: string | undefined
  ): string {
    const text = resolveNoticeText(prefix);
    const link = this.resolveLink(sessionId);
    if (link === undefined) return this.styleSuccess(text);
    this.lastLinkKey = link.key;
    return `${this.styleSuccess(`${text} ·`)} ${link.link}`;
  }

  /** The link if its key changed since last shown, without marking it. Resolver failures never break a hook. */
  private resolveLink(sessionId: string | undefined): SuccessLink | undefined {
    if (!this.link) return undefined;
    let link: SuccessLink | undefined;
    try {
      link = this.link(sessionId);
    } catch {
      return undefined;
    }
    return link?.link && link.key && link.key !== this.lastLinkKey ? link : undefined;
  }

  /**
   * The trailer line for this session, or undefined when there is no link.
   * The first time a key is seen the label says so in green; afterwards the
   * label is dim. The URL stays bare either way (linkifier-safe). Rendering
   * marks the key as seen. Resolver failures never break a hook.
   */
  private renderTrailer(sessionId: string | undefined): string | undefined {
    if (!this.trailer) return undefined;
    let link: SuccessLink | undefined;
    try {
      link = this.trailer(sessionId);
    } catch {
      return undefined;
    }
    if (!link?.link || !link.key) return undefined;
    const isNew = link.key !== this.lastTrailerKey;
    this.lastTrailerKey = link.key;
    const label = isNew
      ? this.styleSuccess(TRAILER_NEW_LABEL)
      : this.styleDim(TRAILER_LABEL);
    return `${label} ${link.link}`;
  }

  private styleDim(text: string): string {
    return this.color ? `${ANSI_DIM}${text}${ANSI_NORMAL_INTENSITY}` : text;
  }

  private style(text: string, sgr: string): string {
    return this.color ? `${sgr}${text}${ANSI_DEFAULT_FOREGROUND}` : text;
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
  opts: {
    messageDisplay?: boolean;
    tempRoot?: string;
    /** Session banner, rendered by Claude Code under a "SessionStart:… says:" label. */
    startupMessage?: string;
  } = {}
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
  if (opts.startupMessage) {
    // SessionStart accepts only `command`/`mcp_tool` hooks — never `http` —
    // so the banner is baked into a static file the command simply cats. It
    // must NOT be `echo`'d: sh and zsh expand backslash escapes, turning the
    // JSON's \n into a raw newline and silently corrupting the payload.
    fs.writeFileSync(
      path.join(hooksDir, STARTUP_NOTICE_FILE),
      JSON.stringify({ systemMessage: opts.startupMessage }),
      { mode: 0o600 }
    );
    hooks.SessionStart = [
      {
        // A compaction continues the same conversation; only real session
        // starts (fresh, --resume, /clear) re-show the banner.
        matcher: "startup|resume|clear",
        hooks: [
          {
            type: "command",
            command: `cat ${singleQuoteForShell(
              path.join(hooksDir, STARTUP_NOTICE_FILE)
            )}`,
            timeout: 5,
          },
        ],
      },
    ];
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

/**
 * POSIX single-quoting: everything inside is literal, and an embedded quote is
 * spliced in as '\''. The mkdtemp path is ours, but quoting keeps a hostile
 * TMPDIR from turning the hook command into arbitrary shell.
 */
function singleQuoteForShell(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
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
