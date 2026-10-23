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
  /** Message index (in the body) of the truncated result. */
  messageIndex: number;
  toolUseId?: string;
  originalChars: number;
  omittedChars: number;
  /** Where the full output was saved. */
  savedAt: string;
}

/**
 * Truncate the largest text of a tool result in the body's last message so
 * the body loses at least `cutChars` characters (or keeps the minimum), or
 * null when it has none worth shortening or `saveFull` could not save it.
 * `saveFull` stores the whole text and returns where.
 */
export function truncateLargestToolResult(
  body: Record<string, any>,
  cutChars: number,
  saveFull: (text: string) => string | undefined
): TruncationPlan | null {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const messageIndex = messages.length - 1;
  const last = messages[messageIndex];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;
  const site = largestToolText(last.content);
  if (!site) return null;
  const longest = pointerText(site.text.length, site.text.length, "").length + PATH_ALLOWANCE;
  const keep = keptChars(site.text.length, cutChars + longest);
  if (keep === null) return null;
  const savedAt = saveFull(site.text);
  if (savedAt === undefined) return null;
  const pointer = (omitted: number) => pointerText(omitted, site.text.length, savedAt);
  const { text, omitted } = cutMiddle(site.text, keep, pointer);
  const content = last.content.map((block: any, i: number) =>
    i === site.blockIndex ? withToolText(block, site.partIndex, text) : block);
  return {
    body: { ...body, messages: [...messages.slice(0, -1), { ...last, content }] },
    messageIndex,
    ...(typeof site.toolUseId === "string" ? { toolUseId: site.toolUseId } : {}),
    originalChars: site.text.length,
    omittedChars: omitted,
    savedAt,
  };
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

function largestToolText(content: any[]): ToolTextSite | null {
  let best: ToolTextSite | null = null;
  content.forEach((block, blockIndex) => {
    if (block?.type !== "tool_result") return;
    for (const [partIndex, text] of toolTexts(block.content)) {
      if (!best || text.length > best.text.length) {
        best = { blockIndex, partIndex, text, toolUseId: block.tool_use_id };
      }
    }
  });
  return best;
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
