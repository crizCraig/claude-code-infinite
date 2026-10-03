import { stripSystemReminderText } from "./turns.js";

interface PromptRecord { id?: string; text?: string; sessionId?: string; createdAt: number }

const SESSION_PROMPT_LIMIT = 32;
const TOTAL_PROMPT_LIMIT = 4096;
const PROMPT_TTL_MS = 10 * 60_000;

/** Display-only accounting: this class has no route authority. */
export class PromptAccounting {
  private records: PromptRecord[] = [];
  constructor(private readonly now = Date.now) {}

  add(sessionId: string | undefined, id: string | undefined, text: string | undefined): void {
    this.expire();
    const sameSession = this.records.filter((item) => item.sessionId === sessionId);
    if (sameSession.length >= SESSION_PROMPT_LIMIT) {
      this.records.splice(this.records.indexOf(sameSession[0]), 1);
    }
    // Also bound process-wide state when one proxy observes many sessions.
    if (this.records.length >= TOTAL_PROMPT_LIMIT) this.records.shift();
    this.records.push({ sessionId, id, text, createdAt: this.now() });
  }

  hasId(id: string): boolean {
    this.expire();
    return this.records.some((item) => item.id === id);
  }

  capture(sessionId: string | undefined, message: any): (delivered: boolean) => void {
    this.expire();
    const texts = new Set(deliveredTexts(message).map(normalizeDeliveryText).filter(Boolean));
    const candidates = new Set(this.records.filter((item) => item.sessionId === sessionId &&
      texts.has(normalizeDeliveryText(item.text ?? ""))));
    let settled = false;
    return (delivered) => {
      if (settled) return;
      settled = true;
      if (!delivered) return;
      // Select the oldest still-pending snapshot record at settlement. Two
      // concurrent deliveries can then retire two duplicates, while neither
      // may consume a hook record that arrived after its request started.
      this.expire();
      this.records = this.records.filter((item) =>
        !candidates.has(item) || !texts.delete(normalizeDeliveryText(item.text ?? "")));
    };
  }

  pending(sessionId?: string): number {
    this.expire();
    return this.records.filter((item) => item.sessionId === sessionId).length;
  }

  private expire(): void {
    this.records = this.records.filter((item) => this.now() - item.createdAt < PROMPT_TTL_MS);
  }
}

function deliveredTexts(message: any): string[] {
  if (message?.role !== "user") return [];
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part: any) => {
    if (typeof part === "string") return [part];
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
}

function normalizeDeliveryText(text: string): string {
  return stripSystemReminderText(text).replace(/\s+/g, " ").trim();
}
