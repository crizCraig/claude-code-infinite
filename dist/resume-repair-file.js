/** Conservative filesystem boundary for optional transcript repair. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
/** Possible writers include Claude binaries and JS runtimes; uncertainty skips repair. */
export function transcriptIsQuiescent(file) {
    try {
        const processes = execFileSync("ps", ["-axo", "pid=,comm="], {
            encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
        });
        if (!processes.trim())
            return false;
        for (const line of processes.trim().split("\n")) {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match)
                return false;
            if (Number(match[1]) === process.pid)
                continue;
            if (/(?:claude|(?:^|\/)(?:node|bun|deno)(?:\s|$))/i.test(match[2]))
                return false;
        }
        try {
            execFileSync("lsof", ["-t", "--", file], {
                timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
            });
            return false; // Any open descriptor means a possible writer.
        }
        catch (error) {
            return error?.status === 1 && !error.signal && error.stdout?.length === 0;
        }
    }
    catch {
        return false;
    }
}
export function replaceQuiescentTranscript(input) {
    const { file, original, snapshot, quiescent } = input;
    const lock = `${file}.ccc-repair.lock`;
    const temp = `${file}.ccc-${randomUUID()}.tmp`;
    let locked = false;
    let temporary = false;
    try {
        const lockFd = fs.openSync(lock, "wx", 0o600);
        locked = true;
        fs.closeSync(lockFd);
        if (!quiescent(file) || !unchanged(file, snapshot, original))
            return undefined;
        fs.mkdirSync(input.backupDir, { recursive: true });
        const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
        const backup = path.join(input.backupDir, `${input.sessionId}.${stamp}.${randomUUID()}.jsonl`);
        writeExclusive(backup, original, 0o600);
        const fd = fs.openSync(temp, "wx", Number(snapshot.mode & 511n));
        temporary = true;
        try {
            fs.writeFileSync(fd, input.replacement);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        if (!quiescent(file) || !unchanged(file, snapshot, original))
            return undefined;
        fs.renameSync(temp, file);
        temporary = false;
        return backup;
    }
    catch {
        return undefined;
    }
    finally {
        if (temporary)
            try {
                fs.unlinkSync(temp);
            }
            catch { /* best effort */ }
        if (locked)
            try {
                fs.unlinkSync(lock);
            }
            catch { /* best effort */ }
    }
}
function writeExclusive(file, contents, mode) {
    const fd = fs.openSync(file, "wx", mode);
    try {
        fs.writeFileSync(fd, contents);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
function unchanged(file, expected, original) {
    const actual = fs.lstatSync(file, { bigint: true });
    return actual.isFile() && actual.nlink === 1n &&
        ["ino", "dev", "size", "mtimeNs", "ctimeNs"].every(key => actual[key] === expected[key]) &&
        fs.readFileSync(file).equals(original);
}
//# sourceMappingURL=resume-repair-file.js.map