export declare const BOARD_CHANNEL_SERVER_NAME = "board";
export declare const BOARD_CHANNEL_SCRIPT = "board_channel.py";
export declare const BOARD_FLAG = "--board";
export declare const DEV_CHANNELS_FLAG = "--dangerously-load-development-channels";
export declare const BOARD_CHANNEL_ENV = "CCC_BOARD_CHANNEL";
/** What `--board` asked for: off, on (path from env/config), or on with a path. */
export type BoardRequest = {
    on: false;
} | {
    on: true;
    path?: string;
};
export type BoardChannelPlan = {
    register: true;
    script: string;
} | {
    register: false;
    note?: string;
};
/**
 * Whether ccc adds the board channel to this session, and the script it runs.
 * A note explains why a requested board was left out.
 */
export declare function planBoardChannel(request: BoardRequest, opts: {
    interactive: boolean;
    env: NodeJS.ProcessEnv;
    configPath?: string;
}): BoardChannelPlan;
/** board_channel.py itself, or inside the given directory; undefined if absent. */
export declare function boardChannelScript(given: string): string | undefined;
/** The `--mcp-config` JSON naming the board's channel server. */
export declare function boardChannelMcpConfig(script: string, env: NodeJS.ProcessEnv): object;
export interface BoardChannelConfigFile {
    path: string;
    close(): void;
}
export declare function writeBoardChannelConfig(script: string, env: NodeJS.ProcessEnv, tempRoot?: string): BoardChannelConfigFile;
/**
 * Prepend the config and the channel opt-in. `=` forms, because both options
 * are variadic and would otherwise swallow a following positional prompt.
 */
export declare function withBoardChannelArgs(args: readonly string[], configPath: string): string[];
export interface BoardChannelLaunch {
    args: string[];
    file: BoardChannelConfigFile | null;
}
/**
 * Claude's argv with the board channel added when `--board` asked for it and
 * it can run; a note on stderr when it cannot. Never stops the launch.
 */
export declare function addBoardChannel(args: readonly string[], request: BoardRequest, opts: {
    interactive: boolean;
    env: NodeJS.ProcessEnv;
    configPath?: string;
}, warn?: (line: string) => void): BoardChannelLaunch;
//# sourceMappingURL=board-channel.d.ts.map