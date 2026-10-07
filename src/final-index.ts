/** Cooperative final-index preparation, covered by the background abort signal. */
import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { stripCcSystemReminders, type Message } from "./turns.js";

export type FinalReplyReader = (signal?: AbortSignal) =>
  Message | undefined | Promise<Message | undefined>;

export async function prepareFinalMessages(messages: Message[], signal: AbortSignal): Promise<{
  messages: Message[]; retained: Message[]; key: string; serialized: string;
}> {
  const hash = createHash("sha256").update("[");
  const cleaned: Message[] = [], retained: Message[] = [], serialized: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    await yieldTurn(undefined, { signal });
    hash.update((i ? "," : "") + JSON.stringify(messages[i]));
    const [message] = stripCcSystemReminders([messages[i]]);
    if (message) {
      cleaned.push(message);
      retained.push(messages[i]);
      serialized.push(JSON.stringify(message));
    }
  }
  signal.throwIfAborted();
  return { messages: cleaned, retained, key: hash.update("]").digest("hex"),
    serialized: `[${serialized.join(",")}]` };
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
