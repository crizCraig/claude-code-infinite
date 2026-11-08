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
/** Write the CA cert (public) bundle for NODE_EXTRA_CA_CERTS into a private temp dir. */
export declare function writeCaBundle(ca: SessionCa, userExtraCaPem?: string): SessionCaFiles;
//# sourceMappingURL=mitm-ca.d.ts.map