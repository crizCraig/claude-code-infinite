/** Display-only accounting: this class has no route authority. */
export declare class PromptAccounting {
    private readonly now;
    private records;
    constructor(now?: () => number);
    add(sessionId: string | undefined, id: string | undefined, text: string | undefined): void;
    hasId(id: string): boolean;
    capture(sessionId: string | undefined, message: any): (delivered: boolean) => void;
    pending(sessionId?: string): number;
    private expire;
}
//# sourceMappingURL=prompt-accounting.d.ts.map