import type { FirstTreeIntro } from "./hooks.js";
import type { MemtreeLinkStore } from "./memtree-links.js";
export declare const FIRST_TREE_MARKER_FILE = "first-tree-shown.json";
export declare class FirstTreeMarker implements FirstTreeIntro {
    private readonly linkStore?;
    readonly filePath: string;
    constructor(linkStore?: Pick<MemtreeLinkStore, "hasOtherSession"> | undefined, filePath?: string);
    isFirstEver(sessionId: string | undefined): boolean;
    markShown(_sessionId: string | undefined): void;
}
//# sourceMappingURL=first-tree.d.ts.map