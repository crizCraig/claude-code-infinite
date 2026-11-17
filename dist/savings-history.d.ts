export interface SavingsReplay<T> {
    bodyKey?: (bytes: Buffer) => string;
    prefix(): {
        count: number;
        prompt: T;
        sameFrame: boolean;
    } | undefined;
    remember(count: number, prompt: T): void;
}
export declare class SavingsHistory<T> {
    private readonly lanes;
    request(lane: string, bytes: Buffer): SavingsReplay<T> | undefined;
}
//# sourceMappingURL=savings-history.d.ts.map