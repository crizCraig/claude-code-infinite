const MAX_CACHE_BREAKPOINTS = 4;

type Slot = { blocks: any[]; index: number; message?: number; field?: "system" | "tools" };

/** Keep stored prefix messages byte-identical while fitting Anthropic's marker cap. */
export function capCacheBreakpoints(
  body: Record<string, any>,
  prefixLength: number,
  options: { preserveSystem?: boolean } = {}
): boolean {
  const slots = cacheSlots(body);
  const excess = slots.length - MAX_CACHE_BREAKPOINTS;
  if (excess <= 0) return true;
  const suffix = slots.filter((slot) => slot.message !== undefined && slot.message >= prefixLength);
  const latest = suffix.at(-1);
  const removable = [
    ...suffix.filter((slot) => slot !== latest),
    ...slots.filter((slot) => slot.field === "system" && !options.preserveSystem),
    ...slots.filter((slot) => slot.field === "tools"),
    ...(latest ? [latest] : []),
  ];
  // Refuse the candidate before changing anything if its protected part won't fit.
  if (removable.length < excess) return false;
  removeMarkers(body, removable.slice(0, excess));
  return true;
}

function cacheSlots(body: Record<string, any>): Slot[] {
  const slots: Slot[] = [];
  const add = (blocks: unknown, where: Omit<Slot, "blocks" | "index">) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, index) => {
      if (block && typeof block === "object" && block.cache_control) {
        slots.push({ blocks, index, ...where });
      }
    });
  };
  add(body.tools, { field: "tools" });
  add(body.system, { field: "system" });
  if (Array.isArray(body.messages)) {
    body.messages.forEach((message: any, index: number) => add(message?.content, { message: index }));
  }
  return slots;
}

/** Copy suffix objects as well: they can share immutable incoming request objects. */
function removeMarkers(body: Record<string, any>, removed: Slot[]): void {
  const indices = new Map<any[], Set<number>>();
  for (const slot of removed) {
    const set = indices.get(slot.blocks) ?? new Set<number>();
    set.add(slot.index);
    indices.set(slot.blocks, set);
  }
  const clean = (blocks: any[]) => blocks.map((block, index) => {
    if (!indices.get(blocks)?.has(index)) return block;
    const { cache_control: _ignored, ...rest } = block;
    return rest;
  });
  for (const field of ["system", "tools"] as const) {
    if (indices.has(body[field])) body[field] = clean(body[field]);
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message: any) => indices.has(message?.content)
      ? { ...message, content: clean(message.content) } : message);
  }
}
