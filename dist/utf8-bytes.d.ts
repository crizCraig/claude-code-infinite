/** The UTF-8 bytes of text as a byte string (the same string when it is ASCII). */
export declare function toBytes(text: string): string;
/** The text of a byte string made by toBytes (markers inserted between characters). */
export declare function fromBytes(data: string): string;
/** ASCII-only lowercase (Python bytes.lower): other bytes keep their values and offsets. */
export declare function asciiLower(value: string): string;
/** The characters of a byte string decoded as UTF-8, skipping invalid bytes (Python's
 * decode("utf-8", "ignore"): no surrogates, no overlong forms). */
export declare function decodeIgnore(data: string): string[];
//# sourceMappingURL=utf8-bytes.d.ts.map