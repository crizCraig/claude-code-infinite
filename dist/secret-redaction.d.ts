export declare const REDACTION_VERSION = 1;
export declare const REDACTED_PREFIX = "[REDACTED:";
export type RedactionCounts = Record<string, number>;
/** Text with secrets replaced, and counts by kind. Secret-free text is returned as is. */
export declare function redact(text: string): {
    text: string;
    counts: RedactionCounts;
};
/**
 * Redact every string in a JSON-like value; image/document parts are kept as they are.
 * Returns the same object when nothing was redacted (so unchanged payloads stay identical).
 */
export declare function redactValue<T>(value: T, counts?: RedactionCounts): T;
export declare function formatCounts(counts: RedactionCounts): string;
//# sourceMappingURL=secret-redaction.d.ts.map