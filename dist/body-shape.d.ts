/** Below this a body is never anchored (its plain bound is small): no parse, no hashing. */
export declare const SHAPE_MIN_BYTES: number;
export interface BodyShape {
    /** Hash of the body without `messages` (system, tools, thinking, ...; cache_control out). */
    frame: string;
    /** One hash per message, in order. */
    messages: string[];
}
/** The body's shape; undefined when it is small or not a JSON request with messages. */
export declare function bodyShape(body: Buffer): BodyShape | undefined;
/** The shape already worked out for `body`, if any; never computes one. */
export declare function knownShape(body: Buffer): BodyShape | undefined;
/** Remember `shape` for another copy of the same bytes. */
export declare function rememberShape(body: Buffer, shape: BodyShape | undefined): void;
/** Digest of the frame and the first `count` messages; undefined past the end. */
export declare function prefixDigest(shape: BodyShape, count: number): string | undefined;
//# sourceMappingURL=body-shape.d.ts.map