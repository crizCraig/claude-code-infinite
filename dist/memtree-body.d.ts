/**
 * The body of a MemTree call: image references (image-refs.ts) and a hard size limit.
 *
 * MemTree is served over HTTP/1 by Cloud Run, which refuses request bodies over
 * 32 MiB (a 413 before the server sees anything), so a body over MAX_MEMTREE_BODY_BYTES
 * is never sent. An index call is sent with its oldest inline images replaced by a
 * text placeholder until it fits (indexing loses those images, the session goes on);
 * a compress call is not sent at all and the turn degrades as on any failed compress.
 */
import { type ImageRefs, type Referenced } from "./image-refs.js";
import type { Message } from "./turns.js";
/** Under Cloud Run's 32 MiB HTTP/1 limit, with room for headers and rounding. */
export declare const MAX_MEMTREE_BODY_BYTES: number;
export declare const IMAGE_OMITTED_TEXT = "[image omitted by ccc: the MemTree upload was over its size limit]";
/** What the limit did to a call: sent with images dropped, or not sent. */
export interface BodyLimitNote {
    action: "trimmed" | "skipped";
    /** The body's size before anything was dropped. */
    requestBytes: number;
    imagesDropped: number;
}
export interface PlannedBody {
    /** The JSON to send; undefined when nothing that fits could be built. */
    payload?: string;
    /** Shas sent as references (a 409 then asks for their bytes). */
    refs: string[];
    limit?: BodyLimitNote;
}
/**
 * `body` with its messages as sent: stored images as references when `imageRefs` is
 * given, then, over `limitBytes`, an index call's oldest images dropped. `serialized`
 * is the messages' JSON already made (with references from the same `imageRefs`).
 */
export declare function planMemtreeBody(args: {
    body: Record<string, unknown>;
    messages: Message[];
    serialized?: Referenced<string>;
    imageRefs?: ImageRefs;
    indexOnly: boolean;
    limitBytes?: number;
}): PlannedBody;
/** `body` (without messages) as JSON, with `messagesJson` as its `messages`. */
export declare function withMessagesJson(body: Record<string, unknown>, messagesJson: string): string;
/**
 * `messages` with inline images, oldest first, replaced by IMAGE_OMITTED_TEXT until
 * at least `excessBytes` are saved; copy on write. References cost nothing and stay.
 */
export declare function dropOldestImages(messages: Message[], excessBytes: number): {
    messages: Message[];
    dropped: number;
};
//# sourceMappingURL=memtree-body.d.ts.map