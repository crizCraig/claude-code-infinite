import { stripVTControlCharacters } from 'node:util';
import { terminalSupportsHyperlinks } from './hooks.js';
import { isSavingsSessionId } from './savings.js';

export interface SavingsView {
  net_usd: number | null;
  less_usage_percent: number | null;
  costs_complete: boolean;
  status_day?: string;
  progress_tokens: number;
  budget_tokens: number;
  url?: string;
}
/** Query this Claude Code process's ccc launcher (base-URL and HTTPS-proxy modes).
 * The launcher owns the authenticated MemTree client and caches server answers. */
export async function readSavingsView(id: unknown, env: NodeJS.ProcessEnv, get = fetch): Promise<SavingsView | undefined> {
  if (!isSavingsSessionId(id) || !env.CCC_SAVINGS_TOKEN) return;
  const origin = (env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === '1' && env.ANTHROPIC_BASE_URL)
    || env.CCC_MEMTREE_PROXY;
  if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return;
  try {
    const response = await get(origin + '/memtree/savings?session=' + id,
      {headers:{'x-ccc-savings-token':env.CCC_SAVINGS_TOKEN}, signal:AbortSignal.timeout(1500), redirect:'error'});
    if (response.ok) return await response.json() as SavingsView;
  } catch { /* A stopped launcher leaves the user's other status segments available. */ }
}

const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const wide = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;

export function visibleWidth(text: string): number {
  let width = 0;
  for (const {segment} of graphemes.segment(stripVTControlCharacters(text))) {
    if (/^[\p{Mark}\p{Cf}\p{Cc}]+$/u.test(segment)) continue;
    width += wide.test(segment) ? 2 : 1;
  }
  return width;
}

export function renderSavingsSegment(
  view: SavingsView | undefined, env: NodeJS.ProcessEnv = process.env, width = Infinity
): string {
  if (!view) return '';
  const net = view.net_usd;
  const url = safeUrl(view.url);
  if (view.costs_complete === true && typeof net === 'number' && Number.isFinite(net) &&
      net >= 0.005 && url) {
    const osc8 = env.CCC_STATUSLINE_LINK === 'osc8' ||
      (env.CCC_STATUSLINE_LINK !== 'url' && terminalSupportsHyperlinks(env, {isTTY:true}));
    const link = osc8 ? `\x1b]8;;${url}\x1b\\savings\x1b]8;;\x1b\\` : url;
    const amount = `$${net.toFixed(2)}`;
    const scope = view.status_day ? ' today UTC' : '';
    const dollars = `🌿 MemTree · ${amount} saved${scope}`;
    const percent = view.less_usage_percent;
    const detail = typeof percent === 'number' && Number.isFinite(percent) && percent > 0
      ? ` · ${percent < 1 ? '<1' : Math.min(100, Math.round(percent))}% less usage` : '';
    const full = `${dollars}${detail} · ${link}`;
    return [full, `${dollars} · ${link}`, dollars, `${amount} saved${scope}`, amount + scope]
      .find(segment => visibleWidth(segment) <= width) ?? '';
  }
  if (!(view.budget_tokens > 0) || !Number.isFinite(view.progress_tokens)) return '';
  const pct = Math.max(0, Math.min(100, Math.floor(100 * view.progress_tokens / view.budget_tokens)));
  const filled = Math.floor(pct / 10);
  const full = `🌿 MemTree [${'■'.repeat(filled)}${'□'.repeat(10-filled)}] ${pct}% to savings`;
  return [full, `🌿 MemTree ${pct}% to savings`, `${pct}% to savings`, `${pct}%`]
    .find(segment => visibleWidth(segment) <= width) ?? '';
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) return;
  try { const url = new URL(value);
    if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) return value;
  } catch { /* Not a URL. */ }
  return;
}
