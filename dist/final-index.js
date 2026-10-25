/** Cooperative final-index preparation, covered by the background abort signal. */
import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { stripCcSystemReminders } from "./turns.js";
/**
 * `serialized` is what is sent: each message as `reference` makes it (stored images as
 * references, image-refs.ts), which `refs` lists; `messages` keeps the bytes.
 */
export async function prepareFinalMessages(messages, signal, reference = (value) => ({ value, refs: [] })) {
    const hash = createHash("sha256").update("[");
    const cleaned = [], retained = [], serialized = [];
    const refs = [];
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
export async function readFinalReply(reader, signal) {
    await yieldTurn(undefined, { signal });
    if (!reader)
        return undefined;
    // An unreadable transcript is optional. Cancellation is not: do not send
    // a late request after exit or after a new main-lane request superseded it.
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("final index aborted"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => reader(signal)).then(resolve, () => resolve(undefined))
            .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted)
            abort();
    });
}
//# sourceMappingURL=final-index.js.map