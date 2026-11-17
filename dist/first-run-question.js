/** Optional account metadata, collected once per config directory; never session content. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { mayBePrintInvocation } from "./cli-args.js";
import { isInfoOnlyRun } from "./claude-plan-warning.js";
import { isCi } from "./install-ping.js";
import { firstRunAnswer } from "./diagnostics-schema.js";
export const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export const TYPE_AHEAD_MS = 400;
export const QUESTION_TIMEOUT_MS = 45_000;
export const PASTE_QUIET_MS = 100;
export class QuestionInterrupted extends Error {
}
export const FIRST_RUN_CHOICES = [
    "Long coding sessions", "Agents that run for hours", "Remembering past work",
    "Saving Claude usage", "Just curious",
];
// Plain text in every terminal, including NO_COLOR. One line, no follow-up questions.
export const FIRST_RUN_QUESTION = "\nOptional account metadata sent to MemTree; never added to your session.\n" +
    "What brings you to Claude Code Infinite? (Enter to skip; skips after 45 seconds)\n" +
    "  1) Long coding sessions  2) Agents that run for hours  3) Remembering past work\n" +
    "  4) Saving Claude usage   5) Just curious              or type your own answer\n> ";
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export async function askFirstRunQuestion(opts) {
    if (!opts.newInstall || !opts.stdinIsTty || !opts.stdoutIsTty || isCi(opts.env) ||
        mayBePrintInvocation(opts.args) || isInfoOnlyRun(opts.args) ||
        /^(1|true|yes|on)$/i.test(opts.env.CCC_NO_FIRST_RUN_QUESTION?.trim() ?? "") ||
        !opts.diagnostics.enabled)
        return;
    const file = join(opts.configDir, FIRST_RUN_QUESTION_FILE);
    try {
        mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
        // Claim before prompting: a concurrent launch, Ctrl+C, or a crash must not re-ask.
        writeFileSync(file, '{"status":"shown"}\n', { flag: "wx", mode: 0o600 });
    }
    catch {
        return;
    }
    const controller = new AbortController();
    let timer;
    let interrupted = false;
    let input = null;
    const now = opts.now ?? (() => performance.now());
    const shownAt = now();
    try {
        input = await Promise.race([
            opts.ask(FIRST_RUN_QUESTION, controller.signal),
            new Promise((resolve) => {
                timer = setTimeout(() => { controller.abort(); resolve(null); }, QUESTION_TIMEOUT_MS);
            }),
        ]);
        if (now() - shownAt <= TYPE_AHEAD_MS || /[\r\n]/.test(input ?? ""))
            input = null;
    }
    catch (error) {
        interrupted = error instanceof QuestionInterrupted;
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
    const raw = firstRunAnswer(input);
    const pick = raw?.match(/^([1-5])[.)]?$/);
    const answer = raw && (pick ? FIRST_RUN_CHOICES[Number(pick[1]) - 1] : raw);
    try {
        writeFileSync(file, JSON.stringify(answer ? { status: "answered", answer } :
            { status: "skipped" }) + "\n", { mode: 0o600 });
    }
    catch {
        // The exclusive claim still prevents any later prompt or resend.
    }
    if (interrupted)
        throw new QuestionInterrupted();
    if (answer) {
        opts.diagnostics.record("first_run_answer", { answer });
        opts.diagnostics.flushNow(); // existing authenticated transport, no retry or startup wait
    }
}
/** Own stdin only for this question. Drain paste bursts before returning it to Claude. */
export function readFirstRunAnswer(question, signal, input, output, now = () => performance.now()) {
    // Check here as well as at the call site: never attach readers to piped stdin.
    if (input.isTTY !== true || signal.aborted)
        return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const wasRaw = input.isRaw;
        const buffered = input.readableLength > 0;
        const shownAt = now();
        let skip = buffered;
        let text = "";
        let answer = null;
        let done = false;
        let quiet;
        let pasting = false;
        // Keep readline's persistent keypress decoder off the shared process.stdin.
        const lines = new PassThrough();
        const rl = createInterface({ input: lines, output, terminal: true });
        // Runs before readline, including for partial input without an Enter.
        const onData = (chunk) => {
            const incoming = chunk.toString();
            if (incoming.includes("\x03")) {
                finish(true);
                return;
            }
            text += incoming;
            if (now() - shownAt <= TYPE_AHEAD_MS)
                skip = true;
            // Normalize CRLF, but two lines or text following a newline is a paste.
            const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            if (/\n[\s\S]+/.test(normalized))
                skip = true;
            if (text.includes("\x1b[200~")) {
                skip = true;
                pasting = true;
            }
            if (text.includes("\x1b[201~"))
                pasting = false;
            // Bound memory even if a terminal streams input until the 45 s deadline.
            if (text.length > 4096) {
                skip = true;
                text = text.slice(-32);
            }
            // Discard rejected input without echoing it or growing readline's line buffer.
            if (!skip)
                lines.write(chunk);
            schedule();
        };
        const finish = (interrupt = false) => {
            if (done)
                return;
            done = true;
            clearTimeout(quiet);
            signal.removeEventListener("abort", onAbort);
            process.removeListener("SIGINT", onInterrupt);
            input.removeListener("data", onData);
            input.removeListener("end", onEnd);
            input.removeListener("error", onAbort);
            rl.close();
            lines.destroy();
            // Includes buffered bytes not yet delivered by the stream's next tick.
            while (input.read() !== null) { /* discard */ }
            input.setRawMode(wasRaw);
            input.pause();
            output.write("\x1b[?2004l");
            if (interrupt)
                reject(new QuestionInterrupted());
            else
                resolve(skip ? null : answer);
        };
        function schedule() {
            clearTimeout(quiet);
            if (!pasting && (skip || answer !== null)) {
                quiet = setTimeout(() => finish(), PASTE_QUIET_MS);
            }
        }
        const onAbort = () => { skip = true; finish(); };
        const onInterrupt = () => finish(true);
        const onEnd = () => { skip = true; finish(); };
        signal.addEventListener("abort", onAbort, { once: true });
        process.on("SIGINT", onInterrupt);
        rl.on("SIGINT", onInterrupt);
        rl.on("close", () => finish());
        rl.on("line", (line) => {
            if (answer !== null)
                skip = true;
            answer = line;
            schedule();
        });
        // Bracketed paste lets us wait for the end even when a paste spans slow chunks.
        // These are terminal mode controls, independent of NO_COLOR.
        output.write("\x1b[?2004h" + question);
        input.setRawMode(true);
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("error", onAbort);
        input.resume();
        schedule();
    });
}
//# sourceMappingURL=first-run-question.js.map