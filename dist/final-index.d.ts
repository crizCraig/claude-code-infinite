import type { Referenced } from "./image-refs.js";
import { type Message } from "./turns.js";
export type FinalReplyReader = (signal?: AbortSignal) => Message | undefined | Promise<Message | undefined>;
/**
 * `serialized` is what is sent: each message as `reference` makes it (stored images as
 * references, image-refs.ts), which `refs` lists; `messages` keeps the bytes.
 */
export declare function prepareFinalMessages(messages: Message[], signal: AbortSignal, reference?: (message: Message) => Referenced<Message>): Promise<{
    messages: Message[];
    retained: Message[];
    key: string;
    serialized: string;
    refs: string[];
}>;
export declare function readFinalReply(reader: FinalReplyReader | undefined, signal: AbortSignal): Promise<Message | undefined>;
//# sourceMappingURL=final-index.d.ts.map