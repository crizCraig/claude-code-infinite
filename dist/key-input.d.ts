export type AskKeyLine = (question: string, output?: NodeJS.WriteStream) => Promise<string | null>;
/** Keep echo off from the first prompt through the last status check. */
export declare function withMutedKeyInput<T>(run: (ask: AskKeyLine) => Promise<T>): Promise<T>;
//# sourceMappingURL=key-input.d.ts.map