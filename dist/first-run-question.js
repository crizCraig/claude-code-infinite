/** Optional account metadata, collected once per config directory; never session content. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareQuestionInput } from "./question-input.js";
import { isCi } from "./install-ping.js";
import { FIRST_RUN_CHOICES } from "./diagnostics-schema.js";
export const FIRST_RUN_QUESTION_FILE = "first-run-question.json";
export const TYPE_AHEAD_MS = 400;
export const QUESTION_TIMEOUT_MS = 45_000;
export class QuestionInterrupted extends Error {
}
// Plain text in every terminal, including NO_COLOR.
export const FIRST_RUN_QUESTION = "\nOptional account metadata sent to MemTree; never added to your session.\n" +
    "What brings you to Claude Code Infinite? (Press a number to choose, or Enter or Esc to skip. Skips after 45 seconds.)\n" +
    "  1) Long coding sessions  2) Agents that run for hours  3) Remembering past work\n" +
    "  4) Saving Claude usage   5) Just curious              6) Other\n> ";
export function canAskFirstRunQuestion(opts) {
    return (opts.platform ?? process.platform) !== "win32" && opts.newInstall &&
        opts.stdinIsTty && opts.stdoutIsTty && !isCi(opts.env) &&
        opts.args.length === 0 && opts.diagnostics.enabled &&
        !/^(1|true|yes|on)$/i.test(opts.env.CCC_NO_FIRST_RUN_QUESTION?.trim() ?? "");
}
/** Hold raw mode during startup waits so the terminal can't translate Enter or edit a line. */
export function keepQuestionInputRaw(input) {
    const wasRaw = input.isRaw;
    try {
        input.setRawMode(true);
    }
    catch {
        return undefined;
    }
    const restore = () => {
        process.off("exit", restore);
        if (input.isRaw !== wasRaw) {
            try {
                input.setRawMode(wasRaw);
            }
            catch { /* the terminal has closed */ }
        }
    };
    process.once("exit", restore);
    return restore;
}
/** Fail closed: inability to persist the claim means no question, never a startup failure. */
export async function askFirstRunQuestion(opts) {
    if (opts.keyCheck === "invalid" || !canAskFirstRunQuestion(opts))
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
    let handoff;
    try {
        const selection = await opts.ask(FIRST_RUN_QUESTION, controller.signal);
        const response = typeof selection === "object" ? selection : undefined;
        handoff = response?.input;
        const choice = response?.answer ?? selection;
        answer = FIRST_RUN_CHOICES.find(value => value === choice) ?? "skipped";
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
    return handoff;
}
export async function readFirstRunAnswer(question, signal, input, output, { platform = process.platform, prepare = prepareQuestionInput, restoreRaw } = {}) {
    if (platform === "win32" || !input.isTTY || signal.aborted)
        return "skipped";
    const rawMode = restoreRaw ?? keepQuestionInputRaw(input);
    if (!rawMode)
        return "skipped";
    const restore = rawMode;
    let guardEnds;
    let prepared;
    try {
        await new Promise((resolve, reject) => {
            output.write("\x1b[?2004h", error => error ? reject(error) : resolve());
        });
        guardEnds = performance.now() + TYPE_AHEAD_MS;
        // Provision a relay before consuming any bytes. Early input can usually
        // stay in the kernel for Claude to inherit on the original fd.
        prepared = await prepare(input, TYPE_AHEAD_MS) ?? "queued";
    }
    finally {
        if (!prepared) {
            output.write("\x1b[?2004l");
            restore();
        }
    }
    if (prepared === "queued") {
        output.write("\x1b[?2004l");
        return { input: { fd: process.stdin.fd, close: restore } };
    }
    const relay = prepared;
    return new Promise((resolve, reject) => {
        let displayed = false;
        let ready = false;
        let timer;
        let done = false;
        function finish(result, interrupted = false) {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            input.pause();
            input.off("data", onData);
            input.off("end", skip);
            input.off("error", skip);
            signal.removeEventListener("abort", skip);
            process.off("SIGINT", interrupt);
            if (typeof result === "string") {
                relay.close();
                restore();
            }
            output.write("\x1b[?2004l" + (displayed ? "\n" : ""));
            if (interrupted)
                reject(new QuestionInterrupted());
            else
                resolve(result);
        }
        function skip() { finish("skipped"); }
        function interrupt() { finish("skipped", true); }
        function onData(chunk) {
            // An Esc can begin a paste whose suffix arrives arbitrarily late. Hand
            // it to Claude immediately, without inspecting anything inside the frame.
            const key = chunk[0];
            if (ready && chunk.length === 1) {
                if (key === 3) {
                    interrupt();
                    return;
                }
                if (key === 13 || key === 10) {
                    skip();
                    return;
                }
            }
            if (ready && key >= 49 && key <= 54) {
                finish({ answer: FIRST_RUN_CHOICES[key - 49], input: relay });
                relay.forward(chunk.subarray(1), restore);
            }
            else {
                finish({ input: relay });
                relay.forward(chunk, restore);
            }
        }
        try {
            timer = setTimeout(() => {
                displayed = true;
                output.write(question, () => { ready = true; });
                timer = setTimeout(skip, QUESTION_TIMEOUT_MS);
            }, Math.max(0, guardEnds - performance.now()));
            input.on("data", onData);
            input.once("end", skip);
            input.once("error", skip);
            process.on("SIGINT", interrupt);
            signal.addEventListener("abort", skip, { once: true });
            if (signal.aborted)
                skip();
            else
                input.resume();
        }
        catch {
            skip();
        }
    });
}
//# sourceMappingURL=first-run-question.js.map