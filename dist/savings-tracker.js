import { SavingsObservation } from './savings-turn.js';
import { randomUUID } from 'node:crypto';
import { isSavingsSessionId } from './savings.js';
/** Only Polychat's explicit session refusal supersedes a cached total. */
export function sessionSavingsResponse(id, status, body) {
    if (status !== 200 && status !== 404)
        return;
    const value = JSON.parse(body.toString("utf8"));
    if (status === 200)
        return value;
    if (value?.detail === "Session unavailable")
        return { session_id: id, costs_complete: false };
}
export class SavingsTracker {
    opts;
    scope = randomUUID();
    sessions = new Map();
    account;
    constructor(opts = {}) {
        this.opts = opts;
        this.account = opts.diagnostics?.savingsAccount;
    }
    /** Only a main conversation request updates the launcher's budget indicator. */
    progress(id, tokens, budget) {
        if (!isSavingsSessionId(id) || !(budget > 0) || !Number.isFinite(tokens))
            return;
        const session = this.session(id);
        session.progress = Math.max(0, Math.floor(tokens));
        session.budget = budget;
    }
    startTurn(id) {
        if (!isSavingsSessionId(id) || !this.account || this.account !== this.opts.diagnostics?.savingsAccount)
            return;
        const report = this.opts.diagnostics?.bindSavings();
        if (report)
            return new SavingsObservation(id.toLowerCase(), report, this.scope, this.opts.diagnostics?.savingsCacheDirectory);
    }
    /** Only upstream dispatches contribute an API turn. Billing records MemTree independently. */
    settle(observation, input, status) {
        return observation.settle(input, status);
    }
    /** Called only by the status line. One fetch per session per ten seconds, including failures. */
    async view(id) {
        if (!isSavingsSessionId(id))
            return;
        const session = this.session(id);
        const now = (this.opts.now ?? Date.now)();
        const owner = this.opts.diagnostics?.savingsAccount;
        if (owner && owner !== this.account)
            return;
        if (this.opts.diagnostics && !owner) {
            return { net_usd: null, less_usage_percent: null, costs_complete: false,
                progress_tokens: session.progress, budget_tokens: session.budget };
        }
        if (this.opts.fetchTotal && !session.pending && now >= session.refreshAt) {
            session.refreshAt = now + 10_000;
            session.pending = this.refresh(id, session).finally(() => { session.pending = undefined; });
        }
        if (session.pending) {
            let timer;
            try {
                await Promise.race([session.pending, new Promise(resolve => {
                        timer = setTimeout(resolve, 100);
                    })]);
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (this.account !== this.opts.diagnostics?.savingsAccount)
            return;
        return {
            ...(session.total ?? { net_usd: null, less_usage_percent: null, costs_complete: false }),
            progress_tokens: session.progress, budget_tokens: session.budget,
            url: this.opts.usageUrl && this.opts.usageUrl + '#savings',
        };
    }
    async refresh(id, session) {
        try {
            const value = await this.opts.fetchTotal(id);
            if (!value || typeof value !== 'object')
                return;
            const row = value;
            if (!isSavingsSessionId(row.session_id) || row.session_id.toLowerCase() !== id.toLowerCase() ||
                typeof row.costs_complete !== 'boolean')
                return;
            if (row.costs_complete && (typeof row.net_usd !== 'number' || !Number.isFinite(row.net_usd)))
                return;
            session.total = {
                costs_complete: row.costs_complete, net_usd: row.costs_complete ? row.net_usd : null,
                less_usage_percent: typeof row.net_percent === 'number' && Number.isFinite(row.net_percent)
                    ? row.net_percent : null,
            };
        }
        catch { /* Keep the last answer or show main-turn progress. */ }
    }
    session(id) {
        id = id.toLowerCase();
        let session = this.sessions.get(id);
        if (!session) {
            session = { progress: 0, budget: 1, refreshAt: 0 };
            this.sessions.set(id, session);
            if (this.sessions.size > 200)
                this.sessions.delete(this.sessions.keys().next().value);
        }
        return session;
    }
}
//# sourceMappingURL=savings-tracker.js.map