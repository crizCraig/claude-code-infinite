import { SavingsObservation } from './savings-turn.js';
import type { Diagnostics } from './diagnostics.js';
import { SavingsHistory } from './savings-history.js';
import type { SavingsView } from './savings-status.js';
import { accountSavingsTurn, createSavingsState, isSavingsSessionId,
  type SavingsPromptCheckpoint, type SavingsState, type SavingsTurnInput } from './savings.js';

interface Session {
  baseline: SavingsState;
  progress: number;
  budget: number;
  refreshAt: number;
  pending?: Promise<void>;
  total?: Pick<SavingsView, 'net_usd' | 'less_usage_percent' | 'costs_complete'>;
}
interface SavingsTrackerOptions {
  usageUrl?: string;
  diagnostics?: Pick<Diagnostics, 'savingsAccount' | 'bindSavings'>;
  fetchTotal?: (sessionId: string) => Promise<unknown>;
  now?: () => number;
}

export class SavingsTracker {
  readonly history = new SavingsHistory<SavingsPromptCheckpoint>();
  private readonly sessions = new Map<string, Session>();

  private readonly account?: object;
  constructor(private readonly opts: SavingsTrackerOptions = {}) {
    this.account = opts.diagnostics?.savingsAccount;
  }

  /** Only a main conversation request updates the launcher's budget indicator. */
  progress(id: unknown, tokens: number, budget: number): void {
    if (!isSavingsSessionId(id) || !(budget > 0) || !Number.isFinite(tokens)) return;
    const session = this.session(id);
    session.progress = Math.max(0, Math.floor(tokens));
    session.budget = budget;
  }

  startTurn(id: unknown): SavingsObservation | undefined {
    const enabled = () => this.account !== undefined && this.account === this.opts.diagnostics?.savingsAccount;
    if (!isSavingsSessionId(id) || !enabled()) return;
    const report = this.opts.diagnostics?.bindSavings();
    if (report) return new SavingsObservation(id.toLowerCase(), enabled, report);
  }

  /** Settle once. A request refused locally has no upstream timestamp to report. */
  settle(observation: SavingsObservation, input: SavingsTurnInput, status: number): void {
    if (observation.closed) return;
    observation.closed = true;
    if (input.nowMs === undefined) return;
    try {
      const session = this.session(observation.sessionId);
      const success = status >= 200 && status < 300;
      // A conclusive upstream request rejection used zero tokens. Network failures,
      // timeouts and server errors leave the actual bill unknown.
      const usage = [400, 401, 403, 404, 413, 422, 429].includes(status)
        ? {input_tokens:0, output_tokens:0} : undefined;
      const measured = success ? input : {...input, requestModified:false, usage};
      const {state, turn} = accountSavingsTurn(session.baseline, measured);
      if (success && turn.actual_tokens) session.baseline = state;
      const model = input.model ?? (input.request as {model?: string})?.model;
      observation.report({
        turn_id:observation.id, session_id:observation.sessionId,
        requested_at:new Date(input.nowMs).toISOString(), expected_memtree_calls:observation.calls,
        model, fast_mode:turn.fast_mode, actual:turn.actual_tokens ?? null,
        plain:turn.actual_tokens ? turn.plain_tokens : null, window_crossing:success && turn.window_crossing,
      });
    } catch { /* Accounting never determines request delivery. */ }
  }

  /** Called only by the status line. One fetch per session per ten seconds, including failures. */
  async view(id: unknown): Promise<SavingsView | undefined> {
    if (!isSavingsSessionId(id)) return;
    const session = this.session(id);
    const now = (this.opts.now ?? Date.now)();
    const owner = this.opts.diagnostics?.savingsAccount;
    if (owner && owner !== this.account) return;
    if (this.opts.diagnostics && !owner) {
      return {net_usd:null, less_usage_percent:null, costs_complete:false,
        progress_tokens:session.progress, budget_tokens:session.budget};
    }
    if (this.opts.fetchTotal && !session.pending && now >= session.refreshAt) {
      session.refreshAt = now + 10_000;
      session.pending = this.refresh(id, session).finally(() => { session.pending = undefined; });
    }
    if (session.pending) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([session.pending, new Promise<void>(resolve => {
          timer = setTimeout(resolve, 100);
        })]);
      } finally { clearTimeout(timer); }
    }
    if (this.account !== this.opts.diagnostics?.savingsAccount) return;
    return {
      ...(session.total ?? {net_usd:null, less_usage_percent:null, costs_complete:false}),
      progress_tokens:session.progress, budget_tokens:session.budget,
      url:this.opts.usageUrl && this.opts.usageUrl + '#savings',
    };
  }

  private async refresh(id: string, session: Session): Promise<void> {
    try {
      const value = await this.opts.fetchTotal!(id);
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      if (!isSavingsSessionId(row.session_id) || row.session_id.toLowerCase() !== id.toLowerCase() ||
          typeof row.costs_complete !== 'boolean') return;
      if (row.costs_complete && (typeof row.net_usd !== 'number' || !Number.isFinite(row.net_usd))) return;
      session.total = {
        costs_complete:row.costs_complete, net_usd:row.costs_complete ? row.net_usd as number : null,
        less_usage_percent:typeof row.net_percent === 'number' && Number.isFinite(row.net_percent)
          ? row.net_percent : null,
      };
    } catch { /* Keep the last answer or show main-turn progress. */ }
  }

  private session(id: string): Session {
    id = id.toLowerCase();
    let session = this.sessions.get(id);
    if (!session) {
      session = {baseline:createSavingsState(), progress:0, budget:1, refreshAt:0};
      this.sessions.set(id, session);
      if (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value!);
    }
    return session;
  }
}
