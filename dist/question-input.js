import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadStream } from "node:tty";
import { findPathExecutable } from "./claude-locate.js";
/**
 * readline normally reads a whole paste before the callback for its first Enter.
 * Limit the native read to one byte so closing a required startup prompt leaves
 * the following prompt text in the terminal for Claude.
 */
class StartupPromptStream extends ReadStream {
    // The startup guard owns raw mode across readline.close() and the next prompt.
    setRawMode() { return this; }
}
export function startupPromptInput() {
    if (process.platform === "win32")
        return undefined;
    let fd;
    try {
        fd = openSync("/dev/fd/0", constants.O_RDONLY | constants.O_NOCTTY);
        const input = new StartupPromptStream(fd, { onread: {
                buffer: Buffer.alloc(1),
                callback(size, buffer) {
                    input.emit("data", Buffer.from(buffer.subarray(0, size)));
                    return input.readableFlowing === true;
                },
            } });
        return input;
    }
    catch {
        if (fd !== undefined)
            closeSync(fd);
        return undefined;
    }
}
function posixPython() {
    if (process.platform === "win32")
        return undefined;
    return findPathExecutable("python3", process.platform, process.env, process.cwd());
}
const script = fileURLToPath(new URL("../scripts/question-input.py", import.meta.url));
/** Display the payment prompt at the queue check, before any subsequent input is read. */
export function showPaymentPromptIfClear(input, prompt) {
    const python = posixPython();
    if (input.readableLength)
        return "queued";
    if (!python)
        return "unavailable";
    const result = spawnSync(python, ["-I", "-S", script, "payment", prompt], {
        stdio: ["ignore", "inherit", "ignore", input], timeout: 2000,
    });
    return result.status === 0 ? "shown" : result.status === 42 ? "queued" : "unavailable";
}
/** The child keeps its own PID, inherited stdout/stderr, and a real terminal on fd 0. */
export async function prepareQuestionInput(input, guardMs) {
    const python = posixPython();
    if (!python)
        return undefined;
    const guard = input.readableLength ? -1 : guardMs;
    const helper = spawn(python, ["-I", "-S", script, String(guard)], {
        stdio: ["pipe", "pipe", "ignore", input],
    });
    const sink = helper.stdin;
    const reply = helper.stdout;
    const startup = setTimeout(close, guardMs + 2000);
    helper.once("error", close);
    let fd;
    let restore;
    let closed = false;
    function close() {
        if (closed)
            return;
        closed = true;
        process.off("exit", close);
        if (restore !== undefined) {
            input.unpipe(sink);
            input.pause();
            restore();
        }
        if (fd !== undefined)
            closeSync(fd);
        helper.kill();
    }
    process.once("exit", close);
    sink.on("error", close);
    try {
        let name = "";
        // The helper returns either "queued" or a PTY device name.
        for await (const chunk of reply) {
            name += chunk.toString();
            if (name.endsWith("\n"))
                break;
        }
        if (name === "queued\n") {
            close();
            return "queued";
        }
        if (closed)
            return undefined;
        fd = openSync(name.trimEnd(), constants.O_RDWR | constants.O_NOCTTY);
        return { fd, close, forward(prefix, restoreTerminal) {
                restore = restoreTerminal;
                sink.write(prefix);
                input.pipe(sink);
            } };
    }
    catch {
        close();
        return undefined;
    }
    finally {
        clearTimeout(startup);
    }
}
//# sourceMappingURL=question-input.js.map