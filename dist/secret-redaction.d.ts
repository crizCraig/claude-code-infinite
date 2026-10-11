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
/** CCC_REDACT_POLYCHAT=on: redact everything ccc sends to Polychat (opt-in for now). */
export declare function polychatRedactionEnabled(env?: NodeJS.ProcessEnv): boolean;
/** A pre-serialized JSON value, redacted; the same string when it holds no secret. */
export declare function redactSerializedJson(serialized: string, counts: RedactionCounts): string;
export declare function formatCounts(counts: RedactionCounts): string;
//# sourceMappingURL=secret-redaction.d.ts.map