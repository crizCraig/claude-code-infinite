import type { Diagnostics } from "./diagnostics.js";
export declare const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export declare const FIRST_RUN_CHOICES: readonly ["Long coding sessions", "Agents that run for hours", "Remembering past work", "Saving Claude usage", "Just curious"];
export declare const FIRST_RUN_QUESTION: string;
interface QuestionOptions {
    configDir: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdinIsTty: boolean;
    stdoutIsTty: boolean;
    diagnostics: Pick<Diagnostics, "enabled" | "record" | "flushNow">;
    ask: (question: string) => Promise<string | null>;
}
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export declare function askFirstRunQuestion(opts: QuestionOptions): Promise<void>;
export {};
//# sourceMappingURL=first-run-question.d.ts.map