import type { ReadStream } from "node:tty";
import { prepareQuestionInput, type QuestionInput } from "./question-input.js";
import { type FirstRunAnswer } from "./diagnostics-schema.js";
import type { Diagnostics } from "./diagnostics.js";
import type { KeyCheck } from "./key-status.js";
export declare const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export declare const TYPE_AHEAD_MS = 400;
export declare const QUESTION_TIMEOUT_MS = 45000;
export declare const PASTE_QUIET_MS = 100;
export declare class QuestionInterrupted extends Error {
}
export declare const FIRST_RUN_QUESTION: string;
type Selection = FirstRunAnswer | QuestionInput;
interface QuestionOptions {
    newInstall: boolean;
    keyCheck: KeyCheck;
    configDir: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdinIsTty: boolean;
    stdoutIsTty: boolean;
    diagnostics: Pick<Diagnostics, "enabled" | "record" | "flushNow">;
    ask: (question: string, signal: AbortSignal) => Promise<Selection>;
}
export declare function canAskFirstRunQuestion(opts: Omit<QuestionOptions, "ask" | "keyCheck">): boolean;
/** Hold raw mode during startup waits so the terminal can't translate Enter or edit a line. */
export declare function keepQuestionInputRaw(input: ReadStream): (() => void) | undefined;
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export declare function askFirstRunQuestion(opts: QuestionOptions): Promise<QuestionInput | undefined>;
export declare function readFirstRunAnswer(question: string, signal: AbortSignal, input: ReadStream, output: NodeJS.WritableStream, { prepare, restoreRaw }?: {
    prepare?: typeof prepareQuestionInput;
    restoreRaw?: () => void;
}): Promise<Selection>;
export {};
//# sourceMappingURL=first-run-question.d.ts.map