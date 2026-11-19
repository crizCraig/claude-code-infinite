/** All accounting workers in one Node process share its time origin and PID. */
export declare const LAUNCH_TIME: number;
export declare function ownerExited(pid: number, launchTime: number): boolean;
/** The next registered dispatch must include this gap before removing the marker. */
export declare function retireReservation(path: string): void;
//# sourceMappingURL=savings-owner.d.ts.map