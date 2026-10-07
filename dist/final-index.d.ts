import { type Message } from "./turns.js";
export type FinalReplyReader = (signal?: AbortSignal) => Message | undefined | Promise<Message | undefined>;
export declare function prepareFinalMessages(messages: Message[], signal: AbortSignal): Promise<{
    messages: Message[];
    retained: Message[];
    key: string;
    serialized: string;
}>;
export declare function readFinalReply(reader: FinalReplyReader | undefined, signal: AbortSignal): Promise<Message | undefined>;
//# sourceMappingURL=final-index.d.ts.map