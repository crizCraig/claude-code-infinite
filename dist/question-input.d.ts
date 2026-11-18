import { ReadStream } from "node:tty";
export interface QuestionInput {
    fd: number;
    close(): void;
}
export interface QuestionRelay extends QuestionInput {
    forward(prefix: Buffer, restoreTerminal: () => void): void;
}
export declare function startupPromptInput(): ReadStream | undefined;
/** Display the payment prompt at the queue check, before any subsequent input is read. */
export declare function showPaymentPromptIfClear(input: ReadStream, prompt: string): "shown" | "queued" | "unavailable";
/** The child keeps its own PID, inherited stdout/stderr, and a real terminal on fd 0. */
export declare function prepareQuestionInput(input: ReadStream, guardMs: number): Promise<QuestionRelay | "queued" | undefined>;
//# sourceMappingURL=question-input.d.ts.map