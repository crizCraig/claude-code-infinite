import type { ReadStream } from "node:tty";
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
interface QuestionOptions {
    newInstall: boolean;
    keyCheck: KeyCheck;
    configDir: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdinIsTty: boolean;
    stdoutIsTty: boolean;
    diagnostics: Pick<Diagnostics, "enabled" | "record" | "flushNow">;
    ask: (question: string, signal: AbortSignal) => Promise<FirstRunAnswer>;
}
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export declare function askFirstRunQuestion(opts: QuestionOptions): Promise<void>;
export declare function readFirstRunAnswer(question: string, signal: AbortSignal, input: ReadStream, output: NodeJS.WritableStream, now?: () => number): Promise<FirstRunAnswer>;
export {};
//# sourceMappingURL=first-run-question.d.ts.map