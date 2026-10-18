#!/usr/bin/env node
// Keep this entrypoint free of static imports so unsupported Node versions
// receive the upgrade message before parsing any implementation dependencies.
const version = process.versions.node;
const [major, minor] = version.split(".").map(Number);
if (!(major > 20 || (major === 20 && minor >= 3))) {
    console.error(`ccc requires Node.js 20.3 or newer; you are running ${version}. Upgrade Node.js and try again.`);
    process.exit(1);
}
// Windows updates as ccc exits: a ccc started right after waits for it (update-wait.ts).
const finishUpdate = process.platform === "win32"
    ? import("./update-wait.js")
        .then((m) => m.waitForUpdateToFinish({ onWait: () => console.error("Finishing a ccc update…") }))
        .catch(() => false)
    : Promise.resolve(false);
finishUpdate.then(() => import("./cli-main.js")).catch((err) => {
    console.error(err);
    process.exit(1);
});
export {};
//# sourceMappingURL=cli.js.map