export declare function withSavingsLock(directory: string, id: string, update: () => void): Promise<void>;
/** Directory-wide maintenance runs in the background, at most hourly. */
export declare function scheduleSavingsPrune(directory: string): void;
//# sourceMappingURL=savings-storage.d.ts.map