import type { ReadStream } from "node:tty";
import type { Diagnostics } from "./diagnostics.js";
export declare const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export declare const TYPE_AHEAD_MS = 400;
export declare const QUESTION_TIMEOUT_MS = 45000;
export declare const PASTE_QUIET_MS = 100;
export declare class QuestionInterrupted extends Error {
}
export declare const FIRST_RUN_CHOICES: readonly ["Long coding sessions", "Agents that run for hours", "Remembering past work", "Saving Claude usage", "Just curious"];
export declare const FIRST_RUN_QUESTION: string;
interface QuestionOptions {
    newInstall: boolean;
    configDir: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdinIsTty: boolean;
    stdoutIsTty: boolean;
    diagnostics: Pick<Diagnostics, "enabled" | "record" | "flushNow">;
    ask: (question: string, signal: AbortSignal) => Promise<string | null>;
}
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export declare function askFirstRunQuestion(opts: QuestionOptions): Promise<void>;
export declare function readFirstRunAnswer(question: string, signal: AbortSignal, input: ReadStream, output: NodeJS.WritableStream, now?: () => number): Promise<string | null>;
export {};
//# sourceMappingURL=first-run-question.d.ts.map