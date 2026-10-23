/**
 * Last-resort fit for a single tool result too large for the window even
 * after compression (polychat docs/context_memory_request_pipeline.md,
 * "Prepared compression"): keep its head and tail word for word and replace
 * the middle with a pointer to the full output, instead of refusing the
 * request. The full output is saved first (`saveFull`, tool-output-store.ts),
 * and the pointer names that file, which the model reads verbatim, page by
 * page, with Claude Code's own Read tool (MemTree indexes the conversation
 * too, but its tail read returns at most 40,000 characters of one message).
 */

/** Kept text is a multiple of this, so a slightly different overflow on the
 * next request usually produces the same bytes (a prompt-cache hit). */
const KEEP_QUANTUM_CHARS = 8_000;
/** Snap a cut to a line break within this distance, when there is one. */
const LINE_SNAP_CHARS = 2_000;
/** Never keep less of the result than this; below it there is nothing to show. */
const MIN_KEEP_CHARS = 2_000;
/** The head's share of what is kept (errors and summaries often end a log). */
const HEAD_SHARE = 0.5;

export interface TruncationPlan {
  /** The rewritten body; the input is never mutated. */
  body: Record<string, any>;
  /** Characters of the tool result texts shortened, and of them omitted. */
  originalChars: number;
  omittedChars: number;
  /** Where each shortened text was saved whole. */
  savedAt: string[];
}

/**
 * Shorten the tool result texts of the body's last message, largest first,
 * until the body loses at least `cutChars` characters (or every text worth
 * shortening keeps only the minimum), or null when there is none or
 * `saveFull` could not save one. `saveFull` stores a whole text, returns where.
 */
export function truncateToolResults(
  body: Record<string, any>,
  cutChars: number,
  saveFull: (text: string) => string | undefined
): TruncationPlan | null {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;
  let content: any[] = last.content;
  const plan = { originalChars: 0, omittedChars: 0, savedAt: [] as string[] };
  for (const site of toolTextSites(content)) {
    if (plan.omittedChars >= cutChars) break;
    const cut = shortenSite(site, cutChars - plan.omittedChars, saveFull);
    if (cut === null) continue;
    if (cut === undefined) return null;
    content = content.map((block: any, i: number) =>
      i === site.blockIndex ? withToolText(block, site.partIndex, cut.text) : block);
    plan.originalChars += site.text.length;
    plan.omittedChars += cut.omitted;
    plan.savedAt.push(cut.savedAt);
  }
  if (!plan.savedAt.length) return null;
  return { body: { ...body, messages: [...messages.slice(0, -1), { ...last, content }] }, ...plan };
}

/**
 * One text cut so it loses about `cutChars` (at most down to the minimum):
 * null when it is too short to shorten, undefined when it could not be saved.
 */
function shortenSite(
  site: ToolTextSite, cutChars: number, saveFull: (text: string) => string | undefined
): { text: string; omitted: number; savedAt: string } | null | undefined {
  const longest = pointerText(site.text.length, site.text.length, "").length + PATH_ALLOWANCE;
  const keep = keptChars(site.text.length, cutChars + longest);
  if (keep === null) return null;
  const savedAt = saveFull(site.text);
  if (savedAt === undefined) return undefined;
  const pointer = (omitted: number) => pointerText(omitted, site.text.length, savedAt);
  return { ...cutMiddle(site.text, keep, pointer), savedAt };
}

/** The pointer that stands for the omitted middle. */
export function pointerText(omittedChars: number, totalChars: number, savedAt: string): string {
  return `\n\n[… output truncated by MemTree to fit the context window: ` +
    `${omittedChars.toLocaleString("en-US")} of ${totalChars.toLocaleString("en-US")} ` +
    `characters omitted here. The full output is saved at ${savedAt}: read the omitted ` +
    `part with the Read tool (offset and limit) or search it with Grep …]\n\n`;
}

/** Room left in the pointer estimate for the saved file's path. */
const PATH_ALLOWANCE = 512;

interface ToolTextSite {
  blockIndex: number;
  /** Index of the text block inside an array `content`; -1 for string content. */
  partIndex: number;
  text: string;
  toolUseId?: string;
}

/** Every tool result text of `content`, largest first. */
function toolTextSites(content: any[]): ToolTextSite[] {
  const sites: ToolTextSite[] = [];
  content.forEach((block, blockIndex) => {
    if (block?.type !== "tool_result") return;
    for (const [partIndex, text] of toolTexts(block.content)) {
      sites.push({ blockIndex, partIndex, text, toolUseId: block.tool_use_id });
    }
  });
  return sites.sort((a, b) => b.text.length - a.text.length);
}

function toolTexts(content: unknown): Array<[number, string]> {
  if (typeof content === "string") return [[-1, content]];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, i): Array<[number, string]> =>
    part?.type === "text" && typeof part.text === "string" ? [[i, part.text]] : []);
}

function withToolText(block: any, partIndex: number, text: string): any {
  if (partIndex < 0) return { ...block, content: text };
  const parts = block.content.map((part: any, i: number) =>
    i === partIndex ? { ...part, text } : part);
  return { ...block, content: parts };
}

/**
 * Characters of the original to keep, quantized down; at least MIN_KEEP_CHARS
 * (a cut past that keeps the minimum, and the caller measures whether it is
 * enough); null when the result is too short to shorten at all.
 */
function keptChars(length: number, cut: number): number | null {
  if (length <= MIN_KEEP_CHARS * 2) return null;
  const keep = Math.floor((length - cut) / KEEP_QUANTUM_CHARS) * KEEP_QUANTUM_CHARS;
  return Math.max(MIN_KEEP_CHARS, keep);
}

function cutMiddle(
  text: string, keep: number, pointer: (omitted: number) => string
): { text: string; omitted: number } {
  const headEnd = safeBoundary(text, snapToLine(text, Math.floor(keep * HEAD_SHARE), -1));
  const tailStart = Math.max(headEnd,
    safeBoundary(text, snapToLine(text, text.length - (keep - headEnd), 1)));
  const omitted = tailStart - headEnd;
  return { text: text.slice(0, headEnd) + pointer(omitted) + text.slice(tailStart), omitted };
}

/** Move `at` to just after a nearby line break, toward `direction` first. */
function snapToLine(text: string, at: number, direction: -1 | 1): number {
  const from = Math.max(0, Math.min(text.length, at));
  const found = direction < 0
    ? text.lastIndexOf("\n", from - 1)
    : text.indexOf("\n", from);
  if (found < 0 || Math.abs(found - from) > LINE_SNAP_CHARS) return from;
  return found + 1;
}

/** Never split a UTF-16 surrogate pair. */
function safeBoundary(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
}
