/** Optional account metadata, collected once per config directory; never session content. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { mayBePrintInvocation } from "./cli-args.js";
import { isInfoOnlyRun } from "./claude-plan-warning.js";
import { isCi } from "./install-ping.js";
import { firstRunAnswer } from "./diagnostics-schema.js";
export const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export const TYPE_AHEAD_MS = 400;
export const QUESTION_TIMEOUT_MS = 45_000;
export const PASTE_QUIET_MS = 100;
// Coalesced reads and near-simultaneous reads are both common for unframed paste.
const TEXT_BURST_MS = 15;
export class QuestionInterrupted extends Error {
}
export const FIRST_RUN_CHOICES = [
    "Long coding sessions", "Agents that run for hours", "Remembering past work",
    "Saving Claude usage", "Just curious",
];
// Plain text in every terminal, including NO_COLOR.
export const FIRST_RUN_QUESTION = "\nOptional account metadata sent to MemTree; never added to your session.\n" +
    "What brings you to Claude Code Infinite? (Press a number, Enter or Esc to skip. Skips after 45 seconds.)\n" +
    "  1) Long coding sessions  2) Agents that run for hours  3) Remembering past work\n" +
    "  4) Saving Claude usage   5) Just curious              6) Other (type it)\n> ";
const OTHER_PROMPT = "Type your answer (Enter to send, Esc to skip): ";
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
    let interrupted = false;
    let answer;
    try {
        answer = firstRunAnswer(await opts.ask(FIRST_RUN_QUESTION, controller.signal));
    }
    catch (error) {
        interrupted = error instanceof QuestionInterrupted;
    }
    finally {
        controller.abort();
    }
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
/** Inspect framing even in discarded input. Keep only a possible marker prefix between reads. */
class BracketedPaste {
    active = false;
    prefix = "";
    consume(chunk) {
        const text = this.prefix + chunk;
        let framed = this.active || !!this.prefix;
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
            framed = true;
            this.active = !this.active;
            offset = index + marker.length;
        }
        return framed || !!this.prefix;
    }
}
export function readFirstRunAnswer(question, signal, input, output, now = () => performance.now()) {
    if (input.isTTY !== true || signal.aborted)
        return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const wasRaw = input.isRaw;
        const paste = new BracketedPaste();
        const decoder = new StringDecoder("utf8");
        // readline handles echo, wrapping and backspace on the screened text keys only.
        const lines = new PassThrough();
        const editor = createInterface({ input: lines, output, terminal: true });
        editor.setPrompt(OTHER_PROMPT);
        let step = "menu";
        let deadline;
        let quiet;
        let readyAt = Infinity;
        let done = false;
        let answer;
        function finish(value, interrupted = false) {
            if (done)
                return;
            done = true;
            clearTimeout(deadline);
            clearTimeout(quiet);
            input.pause();
            input.off("data", onData);
            input.off("end", skip);
            input.off("error", skip);
            signal.removeEventListener("abort", skip);
            process.off("SIGINT", interrupt);
            editor.close();
            lines.destroy();
            while (input.read() !== null) { /* discard buffered tail */ }
            input.setRawMode(wasRaw);
            output.write("\x1b[?2004l\n");
            if (interrupted)
                reject(new QuestionInterrupted());
            else
                resolve(value);
        }
        const skip = () => finish(null);
        const interrupt = () => finish(null, true);
        function show(next, prompt) {
            step = next;
            readyAt = Infinity;
            // A flowing stream also emits these reads to onData, which screens paste framing.
            while (input.read() !== null) { /* discard input queued before this prompt */ }
            if (done)
                return;
            clearTimeout(deadline);
            deadline = setTimeout(skip, QUESTION_TIMEOUT_MS);
            output.write(prompt, () => {
                readyAt = next === "menu" ? now() + TYPE_AHEAD_MS : -Infinity;
            });
        }
        function accept(key) {
            if (key === "\x1b") {
                skip();
                return;
            }
            const enter = key === "\r" || key === "\n";
            if (step === "menu") {
                if (enter)
                    skip();
                else if (key === "6")
                    show("text", "\n" + OTHER_PROMPT);
                else if (key && /^[1-5]$/.test(key))
                    finish(FIRST_RUN_CHOICES[Number(key) - 1]);
            }
            else if (step === "confirm") {
                finish(key?.toLowerCase() === "y" && answer ? answer : null);
            }
            else if (key === null || key === "\u2028" || key === "\u2029") {
                skip();
            }
            else if (enter) {
                answer = firstRunAnswer(editor.line);
                if (answer)
                    show("confirm", "\nSend this? (y/N) ");
                else
                    skip();
            }
            else if (key === "\x7f" || key === "\b") {
                editor.write(null, { name: "backspace" });
            }
            else if (!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(key) &&
                Array.from(editor.line).length < 200) {
                editor.write(key);
            }
        }
        function decode(chunk) {
            if (typeof chunk === "string")
                return chunk;
            // Menu and confirmation keys are ASCII. Count every byte there, even an
            // incomplete UTF-8 sequence adjacent to a digit or a confirmation key.
            if (step !== "text" || now() <= readyAt)
                return chunk.toString("latin1");
            const text = decoder.write(chunk);
            // A whole character followed by a partial character is already a burst.
            return text ? text + decoder.end() : "";
        }
        function onData(chunk) {
            const text = decode(chunk);
            if (text.includes("\x03")) {
                interrupt();
                return;
            }
            if (!text && !quiet)
                return;
            const framed = paste.consume(text);
            const early = now() <= readyAt;
            // A standalone Esc shares the first byte of a paste marker. Wait for quiet
            // before treating it as a key, and consume a framed paste through its end.
            const escape = text === "\x1b" && !paste.active && paste.prefix === text;
            const single = /^[\s\S]$/u.test(text);
            const key = !early && !quiet && single && (!framed || escape) ? text : null;
            clearTimeout(quiet);
            if (paste.active || paste.prefix.length > 1) {
                // Keep a split marker alive, even across longer gaps than a normal burst.
                return;
            }
            const delay = step === "text" && key && !["\r", "\n", "\x1b"].includes(key)
                ? TEXT_BURST_MS : PASTE_QUIET_MS;
            quiet = setTimeout(() => {
                quiet = undefined;
                if (!early)
                    accept(key);
            }, delay);
        }
        try {
            input.setRawMode(true);
            input.on("data", onData);
            input.once("end", skip);
            input.once("error", skip);
            signal.addEventListener("abort", skip, { once: true });
            process.on("SIGINT", interrupt);
            show("menu", "\x1b[?2004h" + question);
            if (!done)
                input.resume();
        }
        catch {
            skip();
        }
    });
}
//# sourceMappingURL=first-run-question.js.map