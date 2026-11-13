export declare const REDACTION_VERSION = 2;
export declare const REDACTED_PREFIX = "[REDACTED:";
export type RedactionCounts = Record<string, number>;
export interface RedactOptions {
    /** Run the financial rules (default true, as polychat with MEMTREE_FINANCIAL_REDACTION). */
    financial?: boolean;
    /** The field key the text sits under ({"routing_number": "..."}): financial context. */
    context?: string;
}
/** Text with secrets replaced, and counts by kind. Secret-free text is returned as is. */
export declare function redact(text: string, options?: RedactOptions): {
    text: string;
    counts: RedactionCounts;
};
/**
 * Redact every string in a JSON-like value. A string under a secret-named key
 * ({"password": "..."}) is checked as that name's assigned value; every key is the
 * financial rules' context. Only base64 media payloads are kept as they are. Returns the
 * same object when nothing was redacted (so unchanged payloads stay identical).
 */
export declare function redactValue<T>(value: T, counts?: RedactionCounts, options?: {
    financial?: boolean;
}): T;
export declare function formatCounts(counts: RedactionCounts): string;
//# sourceMappingURL=secret-redaction.d.ts.map