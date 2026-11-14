export declare const INTERCEPT_HOST = "api.anthropic.com";
export type KeyAlg = "ec" | "rsa";
export interface SessionCa {
    caCertPem: string;
    leafCertPem: string;
    leafKeyPem: string;
}
export interface SessionCaFiles {
    dir: string;
    /** NODE_EXTRA_CA_CERTS for the child: the user's own extra CAs, then ours. */
    bundlePath: string;
    cleanup: () => void;
}
/** Make a CA (name-constrained to `host`) and a leaf for `host`, all in memory. */
export declare function createSessionCa(host?: string, alg?: KeyAlg, leafHost?: string): SessionCa;
/** Prefix of each session's temp dir (the bundle and the Bash env file). */
export declare const SESSION_DIR_PREFIX = "ccc-ca-";
/**
 * Write the CA cert (public) bundle for NODE_EXTRA_CA_CERTS into a private temp
 * dir: the user's own extra CAs first (corporate roots keep working), then ours.
 */
export declare function writeCaBundle(ca: SessionCa, userExtraCaPem?: string, root?: string): SessionCaFiles;
/**
 * Remove session dirs that a crashed or killed ccc left behind: older than a
 * day, owned by this user, and whose owner process is gone. A live session
 * can run for weeks, and its Claude Code reads the bundle and the Bash env
 * file throughout, so a dir whose owner is alive is never touched. Best
 * effort: returns how many were removed.
 */
export declare function sweepStaleSessionDirs(root?: string, now?: number, alive?: (pid: number) => boolean): number;
//# sourceMappingURL=mitm-ca.d.ts.map