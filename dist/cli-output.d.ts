interface ConsoleLike {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}
interface StreamLike {
    isTTY?: boolean;
    write(text: string): boolean;
}
/** Send `console.log`/`info`/`debug` to stderr for the rest of this process. */
export declare function routeConsoleToStderr(target?: ConsoleLike, stderr?: StreamLike): void;
/** SGR colour codes and OSC 8 hyperlinks (keeping their text) removed. */
export declare function stripAnsi(text: string): string;
export {};
//# sourceMappingURL=cli-output.d.ts.map