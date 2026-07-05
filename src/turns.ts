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
 *   counts as a real user turn (decision 2026-07-03).
 */

export type Message = Record<string, any>;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

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

/** True if this is a real user instruction (not a tool-result wrapper or synthetic reminder). */
export function isNonToolUserMessage(message: Message | undefined | null): boolean {
  if (!message || message.role !== "user") return false;
  if (hasToolResultBlock(message.content)) return false;
  return contentHasRealText(message.content);
}

/**
 * True if any message BEFORE the last is a real user input. Distinguishes the
 * first user turn (nothing indexed yet — don't block on compression) from
 * followup user turns (plans/2026-07-05_PLAN_first_user_turn_nonblocking.md).
 * Synthetic reminder messages and tool_result wrappers don't count, via the
 * same audited isNonToolUserMessage heuristic.
 */
export function hasEarlierNonToolUserMessage(messages: Message[]): boolean {
  for (let i = 0; i < messages.length - 1; i++) {
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
