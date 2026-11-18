import { type SavingsLane } from './savings.js';
interface Dispatch {
    dir: string;
    file: string;
    previousAt?: number;
    previous?: SavingsLane;
}
/** Each writer owns its dispatch file, so a slower response cannot overwrite a newer turn.
 * Only timestamps, token counts and hashed prompt prefixes are shared across launchers. */
export declare class SavingsObservation {
    readonly sessionId: string;
    readonly report: (value: unknown) => void;
    private readonly cacheDirectory?;
    readonly id: `${string}-${string}-${string}-${string}-${string}`;
    closed: boolean;
    requestedAt?: number;
    dispatch?: Dispatch;
    constructor(sessionId: string, report: (value: unknown) => void, cacheDirectory?: string | undefined);
    dispatched(laneKey: string, at: number): void;
    remember(lane: SavingsLane): void;
}
export {};
//# sourceMappingURL=savings-turn.d.ts.map