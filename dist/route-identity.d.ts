import { type Message } from "./turns.js";
/** Hash each incoming message once, then reuse it across route candidates/checks. */
export declare function routeMessageHash(message: Message): string;
/** Stable prefixes span turns in which Claude can omit earlier thinking blocks. */
export declare function stablePrefixMessageHash(message: Message): string;
//# sourceMappingURL=route-identity.d.ts.map