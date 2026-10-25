import type { Message } from "./turns.js";
export declare const IMAGE_REF_PREFIX = "memtree-image:sha256:";
/** Declared in x-client-features: this client reads STORED_IMAGES_FIELD. */
export declare const IMAGE_REFS_FEATURE = "image-refs";
/** Answer field: shas of the request's images the server stores. */
export declare const STORED_IMAGES_FIELD = "memtree_image_sha256s";
/** 409 detail field: references the server could not serve. */
export declare const MISSING_IMAGES_FIELD = "missing_image_sha256s";
/** The server's answer to references it cannot serve; the call is sent again with bytes. */
export declare const MISSING_IMAGES_STATUS = 409;
/** A message list as sent, and the shas it references (empty: nothing changed). */
export interface Referenced<T> {
    value: T;
    refs: string[];
}
export declare class ImageRefs {
    private known;
    private shaOf;
    private shaChars;
    private disabled;
    /** Whether calls may carry references at all (the server listed stored images). */
    get active(): boolean;
    /** Learn the stored images an answer lists; a server that lists none changes nothing. */
    noteAnswer(json: unknown): void;
    /** The server could not serve these (or, without a list, any): send bytes for them. */
    forget(shas: readonly string[]): void;
    /** The server refused references outright (an older or misconfigured server). */
    disable(): void;
    /** `messages` with each stored image as a reference; copy on write. */
    referenceMessages(messages: Message[]): Referenced<Message[]>;
    /** One message with each stored image as a reference; the same object if none is. */
    referenceMessage(message: Message): Referenced<Message>;
    private referenceBlocks;
    private referenceBlock;
    /** The image's sha when the server stores it and its base64 re-encodes identically. */
    private storedSha;
    private rememberSha;
}
/** The shas a refusal names (409 detail), or undefined when it names none. */
export declare function missingImageShas(bodyText: string): string[] | undefined;
/**
 * A 400 about references: "never" when this key may not send any (stop for the
 * process), "this" when only this request's were refused (too many: send its bytes).
 */
export declare function refusesImageRefs(status: number, bodyText: string): "never" | "this" | false;
/**
 * The server re-encodes the bytes it stores, so only base64 that decodes and re-encodes
 * to the same text may be referenced (padding included, no whitespace).
 */
export declare function isCanonicalBase64(data: string): boolean;
//# sourceMappingURL=image-refs.d.ts.map