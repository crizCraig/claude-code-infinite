import {renameSync} from 'node:fs';

/** All accounting workers in one Node process share its time origin and PID. */
export const LAUNCH_TIME = Math.trunc(performance.timeOrigin);

export function ownerExited(pid: number, launchTime: number): boolean {
  // A process manager can give the replacement launcher the previous PID.
  if (pid === process.pid) return launchTime !== LAUNCH_TIME;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  return false;
}

/** The next registered dispatch must include this gap before removing the marker. */
export function retireReservation(path: string): void {
  try { renameSync(path,path + '.abandoned'); }
  catch { /* The worker normally removed its reservation after registration. */ }
}
