import * as path from "node:path";

/** At the spawn boundary, Windows commands must already have a drive or UNC root. */
export function executablePath(command: string, platform = process.platform): string {
  if (platform === "win32" && !(path.win32.isAbsolute(command) && path.win32.parse(command).root.length > 1)) {
    throw new Error("An absolute executable path is required on Windows.");
  }
  return command;
}
