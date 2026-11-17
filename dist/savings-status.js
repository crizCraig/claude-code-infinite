/** Local-only status view. No network calls on Claude Code's status-line path. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { terminalSupportsHyperlinks } from './hooks.js';
import { statusLinkDir } from './status-link.js';
let writes = 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function readSavingsView(id, dir = statusLinkDir()) {
    if (typeof id !== 'string' || !ID.test(id))
        return;
    try {
        const file = path.join(dir, `${id}.savings-view.json`);
        if (fs.statSync(file).size > 4096)
            return;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return value && typeof value.costs_complete === 'boolean' &&
            Number.isFinite(value.progress_tokens) && Number.isFinite(value.budget_tokens) ? value : undefined;
    }
    catch {
        return;
    }
}
export function writeSavingsView(id, view, dir = statusLinkDir()) {
    if (!ID.test(id))
        return;
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${id}.savings-view.json`);
        const tmp = `${file}.${randomUUID()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(view), { mode: 0o600, flag: 'wx' });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
        if (++writes % 20 === 0) {
            const files = fs.readdirSync(dir).filter(name => /^[A-Za-z0-9_-]+\.savings-view\.json$/.test(name))
                .map(name => ({ file: path.join(dir, name), time: fs.statSync(path.join(dir, name)).mtimeMs }))
                .sort((a, b) => b.time - a.time);
            for (const entry of files.slice(512))
                fs.unlinkSync(entry.file);
        }
    }
    catch { /* Convenience display never breaks the proxy. */ }
}
export function visibleWidth(text) {
    // Our leaf emoji occupies two cells; combining marks/ZWJ and ANSI take none.
    return [...stripVTControlCharacters(text)].reduce((n, c) => n + (/\p{Mark}|\u200d/u.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 2 : 1), 0);
}
export function renderSavingsSegment(view, env = process.env, width = Infinity) {
    if (!view)
        return '';
    const net = view.net_usd;
    const url = safeUrl(view.url);
    if (view.costs_complete === true && typeof net === 'number' && Number.isFinite(net) &&
        net >= 0.005 && url) {
        const osc8 = env.CCC_STATUSLINE_LINK === 'osc8' ||
            (env.CCC_STATUSLINE_LINK !== 'url' && terminalSupportsHyperlinks(env, { isTTY: true }));
        const link = osc8 ? `\x1b]8;;${url}\x1b\\savings\x1b]8;;\x1b\\` : url;
        const dollars = `🌿 MemTree · $${net.toFixed(2)} saved`;
        const percent = view.less_usage_percent;
        const detail = typeof percent === 'number' && Number.isFinite(percent) && percent > 0
            ? ` · ${percent < 1 ? '<1' : Math.min(100, Math.round(percent))}% less usage` : '';
        const full = `${dollars}${detail} · ${link}`;
        return visibleWidth(full) <= width ? full : `${dollars} · ${link}`;
    }
    if (!(view.budget_tokens > 0) || !Number.isFinite(view.progress_tokens))
        return '';
    const pct = Math.max(0, Math.min(100, Math.floor(100 * view.progress_tokens / view.budget_tokens)));
    const filled = Math.floor(pct / 10);
    return `🌿 MemTree [${'■'.repeat(filled)}${'□'.repeat(10 - filled)}] ${pct}% to savings`;
}
function safeUrl(value) {
    if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value))
        return;
    try {
        const url = new URL(value);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
            return value;
    }
    catch { /* Not a URL. */ }
    return;
}
//# sourceMappingURL=savings-status.js.map