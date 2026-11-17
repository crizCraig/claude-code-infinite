/** Proxy settlement adapter: local totals first; authoritative billing refresh in background. */
import { createSavingsState, accountSavingsTurn, loadSavingsState, saveSavingsState,
  isSavingsSessionId, savingsSummary, type SavingsTurnInput, type SavingsState, type SavingsPromptCheckpoint,
  type AuthoritativeSavingsCosts } from './savings.js';
import { SavingsHistory } from './savings-history.js';
import { scheduleSavingsPrune, withSavingsLock } from './savings-storage.js';
import { statusLinkDir } from './status-link.js';
import { writeSavingsView } from './savings-status.js';
import type { DiagnosticsRecorder } from './diagnostics.js';

export interface SavingsTrackerOptions {
  dir?: string;
  usageUrl?: string;
  diagnostics?: DiagnosticsRecorder;
  fetchCosts?: (sessionId: string) => Promise<unknown>;
}
export class SavingsTracker {
  readonly history = new SavingsHistory<SavingsPromptCheckpoint>();
  private readonly states = new Map<string, SavingsState>();
  private readonly epochs = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly remote = new Map<string, AuthoritativeSavingsCosts>();
  private readonly dir: string;
  constructor(private readonly opts: SavingsTrackerOptions = {}) {
    this.dir = opts.dir ?? statusLinkDir();
  }

  /** Invalidate the previous billing view before this turn can start new MemTree work. */
  begin(id: string, progress?: number, budget?: number): void {
    if (!isSavingsSessionId(id)) return;
    try {
      const state = this.get(id);
      const saved = loadSavingsState(this.dir, id);
      if (saved && saved.sequence > state.sequence) Object.assign(state, saved);
      if (progress !== undefined) state.progress_tokens = Math.max(0, Math.floor(progress));
      if (budget !== undefined) state.budget_tokens = Math.max(1, Math.floor(budget));
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      this.active.set(id, (this.active.get(id) ?? 0) + 1);
      this.remote.delete(id);
      this.publish(state);
    } catch { /* Unsupported session identifiers never name files. */ }
  }

  async settle(id: string, input: SavingsTurnInput): Promise<void> {
    if (!isSavingsSessionId(id)) return;
    try {
      await withSavingsLock(this.dir, id, () => {
        const local = this.get(id);
        const previous = loadSavingsState(this.dir, id) ?? local;
        const {state} = accountSavingsTurn(previous, input);
        if (!saveSavingsState(this.dir, state)) throw Error('Savings state write failed');
        this.endAttempt(id);
        // A helper can settle while a main request is still showing provisional progress.
        const view = this.active.get(id) && input.progress_tokens === undefined && local.sequence === previous.sequence
          ? {...state, progress_tokens:local.progress_tokens, budget_tokens:local.budget_tokens} : state;
        this.states.set(id, view);
        this.opts.diagnostics?.reportSavings?.(state);
        this.publish(view);
      });
      scheduleSavingsPrune(this.dir);
      this.refresh(id);
    } catch { this.endAttempt(id); }
  }

  cancel(id: string): void {
    if (!isSavingsSessionId(id)) return;
    this.endAttempt(id);
    this.refresh(id);
  }

  private endAttempt(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.active.set(id, Math.max(0, (this.active.get(id) ?? 0) - 1));
    this.remote.delete(id);
  }

  private get(id: string): SavingsState {
    let state = this.states.get(id);
    if (!state) {
      state = loadSavingsState(this.dir, id) ?? createSavingsState(id);
      this.states.set(id, state);
      if (this.states.size > 200) {
        const oldest = this.states.keys().next().value!;
        this.states.delete(oldest); this.epochs.delete(oldest); this.remote.delete(oldest);
        this.active.delete(oldest);
        clearTimeout(this.timers.get(oldest)); this.timers.delete(oldest);
      }
    }
    return state;
  }

  private publish(state: SavingsState): void {
    const summary = savingsSummary(state, this.active.get(state.session_id) ? undefined : this.remote.get(state.session_id));
    writeSavingsView(state.session_id, {...summary, less_usage_percent:summary.net_percent,
      progress_tokens:state.progress_tokens ?? 0, budget_tokens:state.budget_tokens ?? 1,
      url:this.opts.usageUrl ? `${this.opts.usageUrl}#savings` : undefined}, this.dir);
  }

  private refresh(id: string, attempt = 0): void {
    if (!isSavingsSessionId(id) || !this.opts.fetchCosts || this.inFlight.has(id) || this.active.get(id)) return;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const epoch = this.epochs.get(id);
    this.inFlight.add(id);
    void this.opts.fetchCosts(id).then(value => withSavingsLock(this.dir, id, () => {
      if (this.epochs.get(id) !== epoch || !this.states.has(id)) return;
      const state = this.states.get(id)!;
      if ((loadSavingsState(this.dir, id)?.sequence ?? 0) !== state.sequence) return;
      const costs = validCosts(value);
      if (costs) this.remote.set(id, costs);
      this.publish(state);
    })).catch(() => {}).finally(() => {
      this.inFlight.delete(id);
      if (this.epochs.get(id) !== epoch) {
        this.refresh(id);
        return;
      }
      // Bounded background refresh lets late index/billing rows catch up on the final turn.
      if (attempt < 6 && this.states.has(id)) {
        const timer = setTimeout(() => this.refresh(id, attempt + 1), 60_000);
        timer.unref(); this.timers.set(id, timer);
      }
    });
  }
}
function validCosts(value: unknown): AuthoritativeSavingsCosts | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (typeof v.costs_complete !== 'boolean') return;
  for (const k of ['memtree_charged_usd','compression_api_usd']) {
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k]) || v[k] < 0) return;
  }
  return {costs_complete:v.costs_complete,memtree_charged_usd:v.memtree_charged_usd as number,
    compression_api_usd:v.compression_api_usd as number};
}
