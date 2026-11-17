/** Optional account metadata, collected once per config directory; never session content. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mayBePrintInvocation } from "./cli-args.js";
import { isInfoOnlyRun } from "./claude-plan-warning.js";
import { isCi } from "./install-ping.js";
import { FIRST_RUN_CHOICES } from "./diagnostics-schema.js";
export const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export const TYPE_AHEAD_MS = 400;
export const QUESTION_TIMEOUT_MS = 45_000;
export const PASTE_QUIET_MS = 100;
export class QuestionInterrupted extends Error {
}
// Plain text in every terminal, including NO_COLOR.
export const FIRST_RUN_QUESTION = "\nOptional account metadata sent to MemTree; never added to your session.\n" +
    "What brings you to Claude Code Infinite? (Press a number to choose, or Enter or Esc to skip. Skips after 45 seconds.)\n" +
    "  1) Long coding sessions  2) Agents that run for hours  3) Remembering past work\n" +
    "  4) Saving Claude usage   5) Just curious              6) Other\n> ";
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export async function askFirstRunQuestion(opts) {
    if (!opts.newInstall || opts.keyCheck === "invalid" || !opts.stdinIsTty || !opts.stdoutIsTty ||
        isCi(opts.env) || mayBePrintInvocation(opts.args) || isInfoOnlyRun(opts.args) ||
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
    let interrupted = false;
    let answer = "skipped";
    try {
        const selection = await opts.ask(FIRST_RUN_QUESTION, controller.signal);
        answer = FIRST_RUN_CHOICES.find(choice => choice === selection) ?? "skipped";
    }
    catch (error) {
        interrupted = error instanceof QuestionInterrupted;
    }
    finally {
        controller.abort();
    }
    try {
        writeFileSync(file, JSON.stringify(answer !== "skipped" ? { status: "answered", answer } :
            { status: "skipped" }) + "\n", { mode: 0o600 });
    }
    catch {
        // The exclusive claim still prevents any later prompt or resend.
    }
    if (interrupted)
        throw new QuestionInterrupted();
    if (answer !== "skipped") {
        opts.diagnostics.record("first_run_answer", { answer });
        opts.diagnostics.flushNow(); // existing authenticated transport, no retry or startup wait
    }
}
/** Inspect framing even in discarded input. Keep only a possible marker prefix between reads. */
class BracketedPaste {
    active = false;
    prefix = "";
    /** Unframed bytes after the last marker, or empty inside a paste or a partial marker. */
    unframedTail(chunk) {
        const text = this.prefix + chunk;
        this.prefix = "";
        let offset = 0;
        while (offset < text.length) {
            const marker = this.active ? "\x1b[201~" : "\x1b[200~";
            const index = text.indexOf(marker, offset);
            if (index < 0) {
                const esc = text.lastIndexOf("\x1b");
                if (esc >= offset && text.length - esc < marker.length && marker.startsWith(text.slice(esc))) {
                    this.prefix = text.slice(esc);
                }
                break;
            }
            this.active = !this.active;
            offset = index + marker.length;
        }
        return this.active || this.prefix ? "" : text.slice(offset);
    }
}
export function readFirstRunAnswer(question, signal, input, output, now = () => performance.now()) {
    if (input.isTTY !== true || signal.aborted)
        return Promise.resolve("skipped");
    return new Promise((resolve, reject) => {
        const wasRaw = input.isRaw;
        const paste = new BracketedPaste();
        let readyAt = Infinity;
        let done = false;
        let quiet;
        let escape;
        const deadline = setTimeout(skip, QUESTION_TIMEOUT_MS);
        function finish(answer, interrupted = false) {
            if (done)
                return;
            done = true;
            clearTimeout(deadline);
            clearTimeout(quiet);
            clearImmediate(escape);
            input.pause();
            input.off("data", onData);
            input.off("end", skip);
            input.off("error", skip);
            signal.removeEventListener("abort", skip);
            process.off("SIGINT", interrupt);
            while (input.read() !== null) { /* discard buffered tail */ }
            input.setRawMode(wasRaw);
            output.write("\x1b[?2004l\n");
            if (interrupted)
                reject(new QuestionInterrupted());
            else
                resolve(answer);
        }
        function skip() { finish("skipped"); }
        function interrupt() { finish("skipped", true); }
        function onData(chunk) {
            // Keys and framing are ASCII. Count every byte, even partial UTF-8 next to a digit.
            const text = typeof chunk === "string" ? chunk : chunk.toString("latin1");
            if (text.includes("\x03")) {
                interrupt();
                return;
            }
            const burst = quiet !== undefined;
            clearTimeout(quiet);
            clearImmediate(escape);
            const tail = paste.unframedTail(text);
            if (!paste.active && paste.prefix === "\x1b") {
                // Esc can also start a bracketed paste. Let this input cycle deliver its suffix.
                escape = setImmediate(skip);
                return;
            }
            const early = now() <= readyAt;
            const enter = text === "\r" || text === "\n" || text === "\r\n";
            if ((enter || early) && /[\r\n]$/.test(tail)) {
                skip();
                return;
            }
            const pick = tail === text && !early && !burst && /^[1-6]$/.test(text)
                ? FIRST_RUN_CHOICES[Number(text) - 1] : undefined;
            // Only an isolated digit picks. A subsequent read cancels the pending selection.
            quiet = setTimeout(() => {
                quiet = undefined;
                if (pick)
                    finish(pick);
            }, PASTE_QUIET_MS);
        }
        try {
            input.setRawMode(true);
            input.on("data", onData);
            input.once("end", skip);
            input.once("error", skip);
            signal.addEventListener("abort", skip, { once: true });
            process.on("SIGINT", interrupt);
            output.write("\x1b[?2004h" + question, () => { readyAt = now() + TYPE_AHEAD_MS; });
            input.resume();
        }
        catch {
            skip();
        }
    });
}
//# sourceMappingURL=first-run-question.js.map