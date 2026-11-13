import { type Message } from "./turns.js";
/** Declared in x-client-features: this client sends refs and reads STORED_MESSAGES_FIELD. */
export declare const MESSAGE_REFS_FEATURE = "message-refs";
/** Answer field: whether the request is stored, and what may not be named. */
export declare const STORED_MESSAGES_FIELD = "memtree_message_refs";
/** 409 detail field: the refs the server could not serve. */
export declare const MISSING_MESSAGES_FIELD = "missing_message_hashes";
export declare const MISSING_MESSAGES_STATUS = 409;
export declare const REF_KEY = "memtree_ref";
/** A message's ref as the server hashes it. `marks`: [path, position, value]. */
export interface Ref {
    digest: string;
    marks: unknown[][];
    header?: unknown;
}
/** A body as sent, and the hashes it names by ref (hex, in order). */
export interface Delta {
    messages: Message[];
    refs: string[];
}
export declare class MessageRefs {
    readonly enabled: boolean;
    private acked;
    private misses;
    private off;
    private disabled;
    constructor(enabled: boolean);
    /** `messages` with every acked message after the opening as a ref (none: the same list). */
    delta(sessionId: string | undefined, messages: Message[]): Delta;
    /** Learn what an answer to a call that sent `messages` (in full) lets the next one name. */
    noteAnswer(sessionId: string | undefined, messages: Message[], json: unknown): void;
    /**
     * A refusal of a call that named `refs` (hex): true when the call should go again in
     * full. A 409 forgets what it names; one naming every ref, or the session's
     * SESSION_MISSES_MAX-th, ends refs for the session; a 400 about refs ends them all.
     */
    noteRefusal(sessionId: string | undefined, refs: readonly string[], status: number, bodyText: string): boolean;
    private ackedFor;
    private remember;
}
/**
 * The reference client of the contract: acked messages as refs, except the opening (the
 * first message that is not system/developer and not only <system-reminder> blocks) and
 * everything before it that is not a system/developer message.
 */
export declare function buildDelta(messages: Message[], acked: ReadonlySet<string>): Delta;
/**
 * A message's ref as the server's store hashes it: sha256 of the compact JSON of the
 * message without its `cache_control` keys and, when `stripHeader` (no earlier message of
 * the request had one), without a system message's leading billing-header block.
 */
export declare function refFor(message: Message, stripHeader?: boolean): Ref | undefined;
/** The digests an answer's acks allow for `messages`, in the request's header order. */
export declare function ackedDigests(messages: Message[], acks: Record<string, unknown>): string[];
/** The hashes a 409 names, or undefined when it names none. */
export declare function missingMessageHashes(bodyText: string): string[] | undefined;
//# sourceMappingURL=message-refs.d.ts.map