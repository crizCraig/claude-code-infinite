import { createHash } from "node:crypto";
/**
 * What Claude Code says about a request in its billing header, for telling
 * the main conversation apart from Claude Code's side requests (the auto-mode
 * security monitor, recaps, titles, …).
 *
 * Claude Code puts `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;
 * …` as the first system text block. Observed on 2.1.281: the main thread's
 * requests carry `cc_turn_origin=human;` and `cc_prompt_id=…;`, while the
 * security monitor's request carries neither.
 *
 * The request log (2026-09-24, 112 requests) showed a header without a turn
 * origin also on recaps and on background-notification turns, which carry
 * the full tool list and must keep MemTree. Only the security monitor sends
 * zero tools, so ``isClaudeCodeSideRequest`` requires all three.
 */

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
/** Characters of system prompt kept for auditing a suspected side request. */
export const SYSTEM_HEAD_CHARS = 120;

export interface ClaudeCodeRequestInfo {
  /** A Claude Code billing header was found in the system prompt. */
  billingHeader: boolean;
  ccVersion?: string;
  entrypoint?: string;
  /** `cc_turn_origin`, e.g. "human"; absent on side requests seen so far. */
  turnOrigin?: string;
  /** `cc_prompt_id` was present (the value itself is not logged). */
  promptId: boolean;
  /** Number of tool definitions sent; the main agent always sends its tools. */
  tools: number;
  /**
   * Header present but no turn origin: the shape of the security monitor.
   * Logged only, for now.
   */
  suspectedSideRequest: boolean;
  /**
   * Opening of the system prompt after the header, one line, only for a
   * suspected side request (e.g. "You are a security monitor for autonomous
   * AI coding agents."). Local log only.
   */
  systemHead?: string;
  /**
   * For a request with a header but no turn origin: the opening of its last
   * user message (reminders removed), its message count, and a short hash of
   * the session id. Recaps, /btw and background-notification turns share the
   * main system prompt and differ only here. Local log only.
   */
  lastUserHead?: string;
  messageCount?: number;
  sessionTag?: string;
}

export function describeClaudeCodeRequest(body: Record<string, any>): ClaudeCodeRequestInfo {
  const texts = systemTexts(body);
  let fields: Record<string, string> | undefined;
  const rest: string[] = [];
  for (const text of texts) {
    if (!fields && text.startsWith(BILLING_HEADER_PREFIX)) {
      const parsed = parseHeader(text.slice(BILLING_HEADER_PREFIX.length));
      fields = parsed.fields;
      if (parsed.rest.trim()) rest.push(parsed.rest);
    } else {
      rest.push(text);
    }
  }
  const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
  const info: ClaudeCodeRequestInfo = {
    billingHeader: fields !== undefined,
    promptId: fields?.cc_prompt_id !== undefined,
    tools,
    suspectedSideRequest: fields !== undefined && fields.cc_turn_origin === undefined,
  };
  if (fields?.cc_version) info.ccVersion = fields.cc_version;
  if (fields?.cc_entrypoint) info.entrypoint = fields.cc_entrypoint;
  if (fields?.cc_turn_origin) info.turnOrigin = fields.cc_turn_origin;
  if (info.suspectedSideRequest) {
    const head = oneLine(rest.join(" ")).slice(0, SYSTEM_HEAD_CHARS);
    if (head) info.systemHead = head;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    info.messageCount = messages.length;
    const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
    if (lastUser) {
      const text = oneLine(
        messageText(lastUser).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
      ).slice(0, SYSTEM_HEAD_CHARS);
      info.lastUserHead = text || `[${lastUserPartTypes(lastUser)}]`;
    }
  }
  return info;
}

/** A short, non-reversible tag grouping requests of one session in the log. */
export function sessionTag(sessionId: string | undefined): string | undefined {
  return sessionId ? createHash("sha256").update(sessionId).digest("hex").slice(0, 8) : undefined;
}

function lastUserPartTypes(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return typeof content;
  return [...new Set(content.map((p: any) => p?.type ?? typeof p))].join(",");
}

/** Text of the top-level `system` value, then of leading `role: system` messages. */
function systemTexts(body: Record<string, any>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object" && typeof item.text === "string") out.push(item.text);
      }
    }
  };
  add(body?.system);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (message?.role !== "system") break;
    add(message.content);
  }
  return out;
}

/** `key=value;` pairs from the start of the header; whatever follows is prompt text. */
function parseHeader(text: string): { fields: Record<string, string>; rest: string } {
  const fields: Record<string, string> = {};
  const pair = /^\s*([a-z_]+)=([^;\n]*);/;
  let remaining = text;
  for (let match = pair.exec(remaining); match; match = pair.exec(remaining)) {
    fields[match[1]] = match[2].trim();
    remaining = remaining.slice(match[0].length);
  }
  return { fields, rest: remaining };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Claude Code's own side request (the auto-mode security monitor): a billing
 * header, no turn origin, and no tools. The proxy forwards these untouched
 * and never involves MemTree or the main thread's route state.
 */
export function isClaudeCodeSideRequest(info: ClaudeCodeRequestInfo): boolean {
  return info.billingHeader && info.turnOrigin === undefined && info.tools === 0;
}

/**
 * Shape of the monitor's `<transcript>` block, checked on every side request
 * so a change in Claude Code's internal format shows up in the request log
 * before anything relies on it. Observed on 2.1.281: one user message holding
 * `<transcript>`, then one single-key JSON object per line (`{"user": ...}`,
 * `{"<ToolName>": <input>}`, `{"meta": ...}`), then `</transcript>` and the
 * grading instructions.
 */
export interface TranscriptShape {
  ok: boolean;
  /** Why the shape was not recognised; absent when ok. */
  reason?: "no-transcript" | "unclosed" | "bad-line" | "empty";
  lines: number;
  userLines: number;
  toolLines: number;
  metaLines: number;
  /** For a bad line: its 1-based index inside the block and its opening. */
  badLine?: number;
  sample?: string;
}

const TRANSCRIPT_OPEN = "<transcript>";
const TRANSCRIPT_CLOSE = "</transcript>";
const SAMPLE_CHARS = 80;

export function inspectMonitorTranscript(body: Record<string, any>): TranscriptShape {
  const shape: TranscriptShape = { ok: false, lines: 0, userLines: 0, toolLines: 0, metaLines: 0 };
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = messages
    .filter((m: any) => m?.role === "user")
    .map((m: any) => messageText(m))
    .find((t: string) => t.includes(TRANSCRIPT_OPEN));
  if (text === undefined) return { ...shape, reason: "no-transcript" };
  const start = text.indexOf(TRANSCRIPT_OPEN) + TRANSCRIPT_OPEN.length;
  const end = text.indexOf(TRANSCRIPT_CLOSE, start);
  if (end < 0) return { ...shape, reason: "unclosed" };
  const lines = text.slice(start, end).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    if (keys.length !== 1) {
      return { ...shape, reason: "bad-line", badLine: i + 1, sample: oneLine(line).slice(0, SAMPLE_CHARS) };
    }
    shape.lines++;
    if (keys[0] === "user") shape.userLines++;
    else if (keys[0] === "meta") shape.metaLines++;
    else shape.toolLines++;
  }
  if (shape.lines === 0) return { ...shape, reason: "empty" };
  return { ...shape, ok: true };
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (typeof p === "string" ? p : p?.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("");
}
