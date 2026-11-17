import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Only this version's postinstall writes this proof, before any ccc launch.
export const NEW_INSTALL_FILE = "first-question-new-install";

/** Any existing entry counts as ccc state, including empty session dirs or bad config. */
export function hasNoInstallState(configDir: string): boolean {
  try {
    return readdirSync(configDir).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Snapshot before startup writes state/keys. Old install_id/first_run_pending aren't proof. */
export function takeNewInstall(configDir: string): boolean {
  if (hasNoInstallState(configDir)) return true;
  try {
    const files = readdirSync(configDir);
    const proof = readFileSync(join(configDir, NEW_INSTALL_FILE), "utf8");
    // Consume even an ineligible proof: a later interactive launch isn't a new install.
    unlinkSync(join(configDir, NEW_INSTALL_FILE));
    return files.every((file) => [NEW_INSTALL_FILE, "install_id", "first_run_pending"].includes(file)) &&
      /^[0-9a-f-]{36}$/.test(proof) &&
      proof === readFileSync(join(configDir, "install_id"), "utf8").trim();
  } catch {
    return false;
  }
}
