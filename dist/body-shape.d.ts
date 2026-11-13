/** Below this a body is never anchored (its plain bound is small): no parse, no hashing. */
export declare const SHAPE_MIN_BYTES: number;
export interface BodyShape {
    /** Hash of the body without `messages` (system, tools, thinking, ...). */
    frame: string;
    /** One hash per message, in order. */
    messages: string[];
    /** Each message's canonical JSON length (UTF-8 bytes, as the per-model ratios assume). */
    sizes: number[];
    /** Each message's inline image base64 characters (within its size). */
    imageChars: number[];
    /**
     * The body asks Anthropic to edit its input (context_management, compaction): a count or
     * usage may describe the edited input, so it never anchors a size (review r2 P3).
     */
    serverEdits: boolean;
    /** Each inline base64 image's dimensions (undefined when unreadable), in order. */
    imageDims: Array<[number, number] | undefined>;
    /**
     * The body holds something the anchor cannot bound: a message block outside
     * MESSAGE_BLOCKS (a document, a URL or file image, search results, server tool blocks, an
     * upload), a request field outside FRAME_FIELDS (mcp_servers) or a tool that is not a
     * custom one. Such a body never anchors a size (Codex r4-r7 P1s).
     */
    unanchorable: boolean;
    /**
     * Index of the last message holding a tool_reference (Anthropic expands it into the
     * tool's definition, past its bytes); -1 when none. Fine in the sampled part, which
     * Anthropic counted expanded; one appended disables the anchor.
     */
    lastExpanding: number;
    /**
     * Canonical bytes of the frame fields left out of the hash because Claude Code rewrites
     * them every turn (UNHASHED_FIELDS): an anchored bound charges them in full each time, on
     * top of the sample's count, which already held their earlier version (errs high).
     */
    unhashedBytes: number;
}
/** The body's shape; undefined when it is small or not a JSON request with messages. */
export declare function bodyShape(body: Buffer): BodyShape | undefined;
/** The shape already worked out for `body`, if any; never computes one. */
export declare function knownShape(body: Buffer): BodyShape | undefined;
/** Remember `shape` for another copy of the same bytes. */
export declare function rememberShape(body: Buffer, shape: BodyShape | undefined): void;
/** Digest of the frame and the first `count` messages; undefined past the end. */
export declare function prefixDigest(shape: BodyShape, count: number): string | undefined;
/** Canonical text bytes (images left out) of messages [from, to). */
export declare function textBytes(shape: BodyShape, from: number, to?: number): number;
//# sourceMappingURL=body-shape.d.ts.map