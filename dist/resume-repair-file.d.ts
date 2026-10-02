/** Conservative filesystem boundary for optional transcript repair. */
import fs from "node:fs";
/** Possible writers include Claude binaries and JS runtimes; uncertainty skips repair. */
export declare function transcriptIsQuiescent(file: string): boolean;
interface Replacement {
    file: string;
    original: Buffer;
    snapshot: fs.BigIntStats;
    replacement: string;
    backupDir: string;
    sessionId: string;
    now?: Date;
    quiescent: (file: string) => boolean;
}
export declare function replaceQuiescentTranscript(input: Replacement): string | undefined;
export {};
//# sourceMappingURL=resume-repair-file.d.ts.map