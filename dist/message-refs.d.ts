import { type Message } from "./turns.js";
/** Declared in x-client-features: this client sends refs and reads STORED_MESSAGES_FIELD. */
export declare const MESSAGE_REFS_FEATURE = "message-refs";
/** Answer field: whether the request is stored, and what may not be named. */
export declare const STORED_MESSAGES_FIELD = "memtree_message_refs";
/** 409 detail field: the refs the server could not serve. */
export declare const MISSING_MESSAGES_FIELD = "missing_message_hashes";
export declare const MISSING_MESSAGES_STATUS = 409;
export declare const REF_KEY = "memtree_ref";
/** How long a conversation names no unacked messages after a 409 named every one it sent
 *  (deltas off on the server, a failed lookup): a too-big body is then not sent at all. */
export declare const UNCONFIRMED_PAUSE_MS: number;
/** Answer field key (in STORED_MESSAGES_FIELD): the stored JSON characters one request's refs
 *  may expand to on this server (polychat's MEMTREE_MAX_NAMED_MIB). */
export declare const MAX_NAMED_CHARS_KEY = "max_named_chars";
/** What the named messages may expand to (their JSON, images as bytes: an overestimate of
 *  what the server reads, which keeps images as refs): this share of the server's cap. */
export declare function namedCharsFor(serverChars: number): number;
/** The default: 30 MiB, under the old 32 MiB rebuild cap. */
export declare const MAX_NAMED_CHARS: number;
/** Base64 image characters the named messages may hold: the server resolves served images
 *  within its own 64 MiB (polychat MAX_RESOLVED_CHARS), whatever the text cap. */
export declare const MAX_NAMED_IMAGE_CHARS: number;
/** A message's ref as the server hashes it. `marks`: [path, position, value]. */
export interface Ref {
    digest: string;
    marks: unknown[][];
    header?: unknown;
    /** Length of the hashed JSON (the message without its marks and header). */
    chars: number;
}
/** A body as sent, and the hashes it names by ref (hex, in order). */
export interface Delta {
    messages: Message[];
    refs: string[];
    /** The named messages' JSON length: what the server rebuilds beyond the body. */
    namedChars?: number;
}
export declare class MessageRefs {
    readonly enabled: boolean;
    /** Per conversation (session and opening, as the server's scope): acked digests. */
    private acked;
    /** Per conversation: digests a 409 named (a hash the server never had, or computes
     *  differently): never acked again, so a mismatch costs one 409, not one per turn. */
    private never;
    /** Per conversation: 409s in a row that named every ref sent. */
    private allMissing;
    private off;
    private disabled;
    /** What one request's refs may expand to: the default until a server says its cap. A
     *  conversation past ~60 MB needs more, or its compress body can never be sent. */
    private namedChars;
    /** Per conversation: when it may name unacked messages again (UNCONFIRMED_PAUSE_MS). */
    private unconfirmedPaused;
    constructor(enabled: boolean);
    /** Whether calls declare message-refs (on, and not refused by the server for good). */
    get active(): boolean;
    /** `messages` with every acked message after the opening as a ref (none: the same list). */
    delta(sessionId: string | undefined, messages: Message[]): Delta;
    /**
     * Every message that may be stored named by ref, acked or not (except `exclude` and what a
     * 409 named before): for a body too big to send otherwise, as a fresh process's first call
     * of a long conversation, which has no acks. The server's 409 names what it lacks.
     */
    unconfirmedDelta(sessionId: string | undefined, messages: Message[], exclude?: ReadonlySet<string>): Delta;
    /** A 409 named every unacked message a call sent: name none for UNCONFIRMED_PAUSE_MS. */
    pauseUnconfirmed(sessionId: string | undefined, messages: Message[], now?: number): void;
    /** What one request's refs may expand to now (for tests and the request log). */
    get maxNamedChars(): number;
    /**
     * Learn what an answer to a call that sent `messages` (in full) lets the next one name.
     * `finalIndex`: the early answer to an exit index, which never carries the field.
     */
    noteAnswer(sessionId: string | undefined, messages: Message[], json: unknown, opts?: {
        finalIndex?: boolean;
        sentRefs?: number;
    }): void;
    /**
     * A refusal of a call that sent `messages` naming `refs` (hex): true when the call should
     * go again in full. A 409 names what is never named again in this conversation; two in a
     * row naming every ref end refs for it; a 400 about refs ends them all; a 400 about the
     * images the refs brought back only resends.
     */
    noteRefusal(sessionId: string | undefined, messages: Message[], refs: readonly string[], status: number, bodyText: string): boolean;
    /** The server's cap from any answer that carries the field (whatever its lane, trimmed
     *  bodies included: the cap is the server's, not a conversation's). */
    noteServerCap(json: unknown): void;
    /** A text-cap 400: the cap it names (a newer server), else the default (an older one). */
    private noteRefusedCap;
    /** The conversation `messages` belong to, while refs may be named for it. */
    private laneFor;
    /**
     * A partial 409 names hashes the server lacks or computes differently: never named
     * again. One naming every ref (a lookup that failed, the kill switch) only drops them
     * from the acks; two in a row end refs for the conversation.
     */
    private noteMissing;
    private forget;
    private remember;
}
/**
 * The reference client of the contract: acked messages as refs, except the opening (the
 * first message that is not system/developer and not only <system-reminder> blocks) and
 * everything before it that is not a system/developer message.
 */
export declare function buildDelta(messages: Message[], acked: {
    has(digest: string): boolean;
}, maxChars?: number): Delta;
/**
 * A message's ref as the server's store hashes it: sha256 of the compact JSON of the
 * message without its `cache_control` keys and, when `stripHeader` (no earlier message of
 * the request had one), without a system message's leading billing-header block.
 */
export declare function refFor(message: Message, stripHeader?: boolean): Ref | undefined;
/** The digests an answer's acks allow for `messages`, in the request's header order. */
export declare function ackedDigests(messages: Message[], acks: Record<string, unknown>, known?: ReadonlySet<string>): string[];
/** The hashes a 409 names, or undefined when it names none. */
export declare function missingMessageHashes(bodyText: string): string[] | undefined;
//# sourceMappingURL=message-refs.d.ts.map