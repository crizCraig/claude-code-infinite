/** Cooperative final-index preparation, covered by the background abort signal. */
import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Referenced } from "./image-refs.js";
import { stripCcSystemReminders, type Message } from "./turns.js";

export type FinalReplyReader = (signal?: AbortSignal) =>
  Message | undefined | Promise<Message | undefined>;

/**
 * `serialized` is what is sent: each message as `reference` makes it (stored images as
 * references, image-refs.ts), which `refs` lists; `messages` keeps the bytes.
 */
export async function prepareFinalMessages(
  messages: Message[], signal: AbortSignal,
  reference: (message: Message) => Referenced<Message> = (value) => ({ value, refs: [] })
): Promise<{
  messages: Message[]; retained: Message[]; key: string; serialized: string; refs: string[];
}> {
  const hash = createHash("sha256").update("[");
  const cleaned: Message[] = [], retained: Message[] = [], serialized: string[] = [];
  const refs: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    await yieldTurn(undefined, { signal });
    hash.update((i ? "," : "") + JSON.stringify(messages[i]));
    const [message] = stripCcSystemReminders([messages[i]]);
    if (message) {
      cleaned.push(message);
      retained.push(messages[i]);
      const sent = reference(message);
      refs.push(...sent.refs);
      serialized.push(JSON.stringify(sent.value));
    }
  }
  signal.throwIfAborted();
  return { messages: cleaned, retained, key: hash.update("]").digest("hex"),
    serialized: `[${serialized.join(",")}]`, refs };
}

export async function readFinalReply(reader: FinalReplyReader | undefined,
                                    signal: AbortSignal): Promise<Message | undefined> {
  await yieldTurn(undefined, { signal });
  if (!reader) return undefined;
  // An unreadable transcript is optional. Cancellation is not: do not send
  // a late request after exit or after a new main-lane request superseded it.
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("final index aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => reader(signal)).then(resolve, () => resolve(undefined))
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
