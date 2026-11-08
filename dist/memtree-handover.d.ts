/** Days of messages a pack covers by default, and at most (the server's bounds). */
export declare const HANDOVER_DEFAULT_DAYS = 3;
export declare const HANDOVER_MAX_DAYS = 60;
export declare const USER_MESSAGES_MAX_LIMIT = 200;
/** `user_messages` arguments as the server's query string; throws on bad input. */
export declare function userMessagesQuery(args: Record<string, unknown>): URLSearchParams;
/** `handover` arguments as the server's query string; throws on bad input. */
export declare function handoverQuery(args: Record<string, unknown>): URLSearchParams;
/** The user_messages answer as text. */
export declare function formatUserMessages(body: unknown, args: Record<string, unknown>, tree?: string): string;
/** The handover pack as text: how it ended, the model's lists, then the messages. */
export declare function formatHandover(body: unknown, tree?: string): string;
//# sourceMappingURL=memtree-handover.d.ts.map