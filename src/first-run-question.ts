/** Optional account metadata, collected once per config directory; never session content. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mayBePrintInvocation } from "./cli-args.js";
import { isInfoOnlyRun } from "./claude-plan-warning.js";
import { isCi } from "./install-ping.js";
import { firstRunAnswer } from "./diagnostics-schema.js";
import type { Diagnostics } from "./diagnostics.js";

export const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export const FIRST_RUN_CHOICES = [
  "Long coding sessions", "Agents that run for hours", "Remembering past work",
  "Saving Claude usage", "Just curious",
] as const;
// Plain text in every terminal, including NO_COLOR. One line, no follow-up questions.
export const FIRST_RUN_QUESTION =
  "\nOptional account metadata sent to MemTree; never added to your session.\n" +
  "What brings you to Claude Code Infinite? (Enter to skip)\n" +
  "  1) Long coding sessions  2) Agents that run for hours  3) Remembering past work\n" +
  "  4) Saving Claude usage   5) Just curious              or type your own answer\n> ";

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
export async function askFirstRunQuestion(opts: QuestionOptions): Promise<void> {
  if (!opts.stdinIsTty || !opts.stdoutIsTty || isCi(opts.env) ||
      mayBePrintInvocation(opts.args) || isInfoOnlyRun(opts.args) ||
      /^(1|true|yes|on)$/i.test(opts.env.CCC_NO_FIRST_RUN_QUESTION?.trim() ?? "") ||
      !opts.diagnostics.enabled) return;

  const file = join(opts.configDir, FIRST_RUN_QUESTION_FILE);
  try {
    mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
    // Claim before prompting: a concurrent launch, Ctrl+C, or a crash must not re-ask.
    writeFileSync(file, '{"status":"shown"}\n', { flag: "wx", mode: 0o600 });
  } catch {
    return;
  }

  try {
    const raw = firstRunAnswer(await opts.ask(FIRST_RUN_QUESTION));
    const answer = raw && (/^[1-5]$/.test(raw) ? FIRST_RUN_CHOICES[Number(raw) - 1] : raw);
    try {
      writeFileSync(file, JSON.stringify(answer ? { status: "answered", answer } :
        { status: "skipped" }) + "\n", { mode: 0o600 });
    } catch {
      // The exclusive claim still prevents any later prompt or resend.
    }
    if (answer) {
      opts.diagnostics.record("first_run_answer", { answer });
      opts.diagnostics.flushNow(); // existing authenticated transport, no retry or startup wait
    }
  } catch {
    // A closed terminal or failed prompt must not prevent Claude from starting.
  }
}
