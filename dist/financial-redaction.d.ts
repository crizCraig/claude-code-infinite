export declare const CARD = "card_number";
export declare const ROUTING = "bank_routing";
export declare const IBAN = "iban";
export declare const ACCOUNT = "bank_account";
export declare const SSN = "ssn";
export declare const FINANCIAL_KINDS: string[];
export type Span = [start: number, end: number, kind: string];
/** Non-overlapping [start, end, kind] spans of financial details in a byte string. */
export declare function financialSpans(data: string): Span[];
/** financialSpans of a field value whose key ("routing_number"...) is context. */
export declare function spansWithContext(data: string, context: string): Span[];
//# sourceMappingURL=financial-redaction.d.ts.map