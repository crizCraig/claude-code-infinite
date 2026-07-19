/**
 * Turn detection and message-shaping helpers, ported from the polychat server
 * (memory/preserve_last_user_message.py, memory/v2/consume.py,
 * llm_api/extract_text.py) per plans/2026-06-09_PLAN_local_proxy_app.md.
 *
 * Audit notes vs the server heuristic (plan "Turn detection nuances"):
 * - A message containing ANY tool_result block is treated as a tool turn, even
 *   with trailing text blocks (Claude Code appends system-reminder text blocks
 *   after tool_results; the server's all-blocks-are-tool_results check counted
 *   those as user turns).
 * - Text is checked after stripping <system-reminder> tags, so standalone
 *   system-reminder messages are not user turns.
 * - The "user stepped away" recap prompt (plain text, no tag) intentionally
 *   counts as a real user turn for compression, but is separately recognized
 *   so no user-facing MemTree notice is queued for that hidden request.
 */

export type Message = Record<string, any>;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const BASH_INPUT_RE = /^<bash-input>[\s\S]*<\/bash-input>$/;
const BASH_OUTPUT_RE =
  /^<bash-stdout>[\s\S]*<\/bash-stdout><bash-stderr>[\s\S]*<\/bash-stderr>$/;

/** Distinctive stable prefix of Claude Code's hidden away-summary prompt. */
export const AWAY_SUMMARY_PROMPT_PREFIX =
  "The user stepped away and is coming back. Recap in under 40 words";

export function stripSystemReminderText(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, "").trim();
}

function contentHasRealText(content: any): boolean {
  if (typeof content === "string") {
    return stripSystemReminderText(content).length > 0;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string" && stripSystemReminderText(part)) {
        return true;
      }
      if (
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string" &&
        stripSystemReminderText(part.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasToolResultBlock(content: any): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) => part && typeof part === "object" && part.type === "tool_result"
    )
  );
}

/** True only for Claude Code's user wrapper carrying one or more tool results. */
export function isToolResultUserMessage(
  message: Message | undefined | null
): boolean {
  return (
    !!message &&
    message.role === "user" &&
    hasToolResultBlock(message.content)
  );
}

/** True if this is a real user instruction (not a tool-result wrapper or synthetic reminder). */
export function isNonToolUserMessage(message: Message | undefined | null): boolean {
  if (!message || message.role !== "user") return false;
  if (hasToolResultBlock(message.content)) return false;
  return contentHasRealText(message.content);
}

/** True only for Claude Code's hidden away-summary user request. */
export function isAwaySummaryUserMessage(
  message: Message | undefined | null
): boolean {
  if (!message || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") {
    return content.startsWith(AWAY_SUMMARY_PROMPT_PREFIX);
  }
  if (!Array.isArray(content)) return false;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
  return text.startsWith(AWAY_SUMMARY_PROMPT_PREFIX);
}

/** Concatenate plain text fields from a user message for hook correlation. */
export function userMessageText(message: Message | undefined | null): string {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: any) => {
      if (typeof part === "string") return part;
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

/**
 * Claude Code may append ambient role=system context after the human message.
 * Turn classification is based on the last conversation message, not that
 * trailing metadata.
 */
export function lastNonSystemMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "system") return messages[i];
  }
  return undefined;
}

/**
 * True for Claude Code's local `!command` replay shape. These commands do not
 * consistently emit UserPromptSubmit, but their stdout is followed by a real
 * main-thread completion (and therefore can legitimately own a display-only
 * MemTree notice). Keep the match strict so arbitrary unarmed API traffic does
 * not acquire notice ownership.
 */
export function isLocalBashCommandTurn(messages: Message[]): boolean {
  let outputIndex = messages.length - 1;
  while (outputIndex >= 0 && messages[outputIndex]?.role === "system") {
    outputIndex--;
  }
  if (outputIndex < 1) return false;
  const output = messages[outputIndex];
  if (
    output?.role !== "user" ||
    !BASH_OUTPUT_RE.test(userMessageText(output))
  ) {
    return false;
  }

  let inputIndex = outputIndex - 1;
  while (inputIndex >= 0 && messages[inputIndex]?.role === "system") {
    inputIndex--;
  }
  const input = messages[inputIndex];
  return (
    input?.role === "user" &&
    BASH_INPUT_RE.test(userMessageText(input))
  );
}

/**
 * True if any message before the effective last non-system message is a real
 * user input. Distinguishes the
 * first user turn (nothing indexed yet — don't block on compression) from
 * followup user turns (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 * Synthetic reminder messages and tool_result wrappers don't count, via the
 * same audited isNonToolUserMessage heuristic.
 */
export function hasEarlierNonToolUserMessage(messages: Message[]): boolean {
  let currentIndex = messages.length - 1;
  while (currentIndex >= 0 && messages[currentIndex]?.role === "system") {
    currentIndex--;
  }
  for (let i = 0; i < currentIndex; i++) {
    if (isNonToolUserMessage(messages[i])) return true;
  }
  return false;
}

/**
 * Remove Claude Code <system-reminder> snippets before sending messages to the
 * indexing endpoint (mirrors server strip_cc_system_reminders — reminders churn
 * on /resume and would cause indexing inconsistencies).
 */
export function stripCcSystemReminders(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      const cleaned = stripSystemReminderText(content);
      if (cleaned) result.push({ ...msg, content: cleaned });
    } else if (Array.isArray(content)) {
      const cleanedParts: any[] = [];
      for (const part of content) {
        const cleaned = stripPart(part);
        if (cleaned !== null) cleanedParts.push(cleaned);
      }
      if (cleanedParts.length) result.push({ ...msg, content: cleanedParts });
    } else {
      result.push(msg);
    }
  }
  return result;
}

function stripPart(part: any): any {
  if (typeof part === "string") {
    const cleaned = stripSystemReminderText(part);
    return cleaned ? cleaned : null;
  }
  if (part && typeof part === "object") {
    if (part.type === "text" && typeof part.text === "string") {
      const cleaned = stripSystemReminderText(part.text);
      return cleaned ? { ...part, text: cleaned } : null;
    }
    if (part.type === "tool_result") {
      const inner = part.content;
      if (typeof inner === "string") {
        const cleaned = stripSystemReminderText(inner);
        return { ...part, content: cleaned };
      }
      if (Array.isArray(inner)) {
        const cleanedInner = inner
          .map((p) => stripPart(p))
          .filter((p) => p !== null);
        return { ...part, content: cleanedInner };
      }
    }
  }
  return part;
}

function serializePart(part: any): string {
  try {
    return JSON.stringify(part, null, 2);
  } catch {
    return String(part);
  }
}

function extractTextForFlatten(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      if (part.text) parts.push(String(part.text));
    } else if (part.type === "thinking") {
      if (part.thinking) parts.push(String(part.thinking));
    } else {
      parts.push(serializePart(part));
    }
  }
  return parts.join("\n\n");
}

/**
 * Flatten processed (compressed) messages into a single user message, as if
 * starting a fresh conversation with full context. System messages are
 * excluded — the caller sends them via Anthropic's top-level system param.
 * Port of server flatten_to_single_user_message.
 */
export function flattenToSingleUserMessage(messages: Message[]): Message[] {
  const nonSystem = messages.filter((m) => (m.role ?? "user") !== "system");

  if (nonSystem.length === 1) {
    const text = extractTextForFlatten(nonSystem[0]);
    return [{ role: "user", content: text || "(no content)" }];
  }

  const parts: string[] = [];
  for (const msg of nonSystem) {
    const role = String(msg.role ?? "user").toUpperCase();
    const text = extractTextForFlatten(msg);
    if (text) parts.push(`[${role}]\n${text}`);
  }

  if (!parts.length) return [{ role: "user", content: "(no content)" }];
  return [{ role: "user", content: parts.join("\n\n") }];
}

/**
 * Build the message list sent to /v1/context_memory: the Anthropic top-level
 * `system` param becomes a leading system-role message (mirrors cc_api.py).
 */
export function messagesWithSystem(
  messages: Message[],
  system: string | any[] | undefined | null
): Message[] {
  const msgs = messages.map((m) => ({ ...m }));
  if (system != null && (typeof system === "string" ? system : system.length)) {
    msgs.unshift({ role: "system", content: system });
  }
  return msgs;
}

/** Context-window budget for compression; strips the `[1m]` long-context suffix. */
export function contextLimitForModel(model: string | undefined): number {
  if (model && model.includes("[1m]")) return 1_000_000;
  return 200_000;
}
