/** Crash-safe pending cumulative snapshots, scoped to one credential and service.
 * Each sequence has its own path so an acknowledgement cannot unlink a newer report. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { savingsReport } from './savings-report.js';
export class SavingsOutbox {
    directory;
    constructor(configDir, baseUrl, apiKey) {
        const scope = createHash('sha256').update(JSON.stringify([baseUrl.replace(/\/$/, ''), apiKey])).digest('hex');
        this.directory = path.join(configDir, 'pending-savings', scope);
    }
    restore() {
        const pending = new Map();
        let names;
        try {
            names = fs.readdirSync(this.directory);
        }
        catch {
            return pending;
        }
        for (const name of names) {
            if (!name.endsWith('.json'))
                continue;
            try {
                const file = path.join(this.directory, name);
                const st = fs.lstatSync(file);
                if (!st.isFile() || st.size > 2048)
                    continue;
                const report = savingsReport(JSON.parse(fs.readFileSync(file, 'utf8')));
                if (!report || this.file(report) !== file)
                    continue;
                const newer = pending.get(report.session_id);
                if (newer && newer.sequence > report.sequence)
                    this.remove(report);
                else {
                    if (newer)
                        this.remove(newer);
                    pending.set(report.session_id, report);
                }
            }
            catch { /* A sibling process may have acknowledged it. */ }
        }
        return pending;
    }
    save(report) {
        const tmp = path.join(this.directory, randomUUID() + '.tmp');
        try {
            fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(tmp, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
            fs.renameSync(tmp, this.file(report));
            return true;
        }
        catch {
            return false;
        }
        finally {
            try {
                fs.rmSync(tmp, { force: true });
            }
            catch { /* best effort */ }
        }
    }
    remove(report) {
        try {
            fs.rmSync(this.file(report), { force: true });
        }
        catch { /* Retry after restart. */ }
    }
    file(report) {
        return path.join(this.directory, report.session_id + '.' + report.sequence + '.json');
    }
}
//# sourceMappingURL=savings-outbox.js.map