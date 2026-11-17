/** Session-local serialization. Each contender owns a unique marker, so removing a
 * dead process's marker can never release a subsequent writer's lock. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isSavingsSessionId } from './savings.js';
function tryLocked(directory, id, update) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory())
        throw Error('Invalid savings directory');
    // This directory contains only currently contending writers. Keeping the empty
    // directory avoids racing another process between mkdir and marker creation.
    const lock = path.join(directory, '.savings-locks');
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(lock).isDirectory())
        throw Error('Invalid savings lock directory');
    const prefix = id.toLowerCase() + '.';
    const name = prefix + process.pid + '.' + randomUUID();
    const marker = path.join(lock, name);
    fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
    try {
        for (const other of fs.readdirSync(lock)) {
            if (other === name || !other.startsWith(prefix))
                continue;
            const pid = Number(other.slice(prefix.length).split('.')[0]);
            if (!Number.isSafeInteger(pid) || pid <= 0)
                throw Error('Invalid savings lock owner');
            try {
                process.kill(pid, 0);
            }
            catch (error) {
                if (error.code === 'ESRCH') {
                    fs.rmSync(path.join(lock, other), { force: true });
                    continue;
                }
            }
            return false;
        }
        update();
        return true;
    }
    finally {
        fs.unlinkSync(marker);
    }
}
export async function withSavingsLock(directory, id, update) {
    if (!isSavingsSessionId(id))
        return;
    while (!tryLocked(directory, id, update))
        await delay(5 + Math.random() * 20);
}
const nextPrune = new Map();
/** Directory-wide maintenance runs in the background, at most hourly. */
export function scheduleSavingsPrune(directory) {
    if ((nextPrune.get(directory) ?? 0) > Date.now())
        return;
    nextPrune.set(directory, Date.now() + 3_600_000);
    void prune(directory).catch(() => { });
}
async function prune(directory) {
    const names = await fs.promises.readdir(directory);
    for (const suffix of ['.savings.json', '.savings-view.json']) {
        const files = names.filter(name => name.endsWith(suffix) && isSavingsSessionId(name.slice(0, -suffix.length)));
        if (files.length <= 512)
            continue;
        const entries = await Promise.all(files.map(async (name) => {
            const file = path.join(directory, name);
            const stat = await fs.promises.lstat(file).catch(() => undefined);
            return { file, id: name.slice(0, -suffix.length), time: stat?.mtimeMs ?? 0 };
        }));
        entries.sort((a, b) => b.time - a.time);
        for (const entry of entries.slice(512)) {
            await withSavingsLock(directory, entry.id, () => {
                if (fs.lstatSync(entry.file, { throwIfNoEntry: false })?.mtimeMs === entry.time)
                    fs.unlinkSync(entry.file);
            });
        }
    }
}
//# sourceMappingURL=savings-storage.js.map