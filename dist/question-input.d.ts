import { ReadStream } from "node:tty";
export interface QuestionInput {
    fd: number;
    close(): void;
}
export interface QuestionRelay extends QuestionInput {
    forward(prefix: Buffer, restoreTerminal: () => void): void;
}
export declare function startupPromptInput(): ReadStream | undefined;
/** The child keeps its own PID, inherited stdout/stderr, and a real terminal on fd 0. */
export declare function prepareQuestionInput(input: ReadStream, guardMs: number): Promise<QuestionRelay | "queued" | undefined>;
/** Windows can inspect the console input queue in place. Claude inherits it directly. */
export declare function readWindowsQuestion(question: string, signal: AbortSignal, guard: number, quiet: number, timeout: number): Promise<number | null>;
//# sourceMappingURL=question-input.d.ts.map