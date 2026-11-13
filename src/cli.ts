#!/usr/bin/env node

// Keep this entrypoint free of static imports so unsupported Node versions
// receive the upgrade message before parsing any implementation dependencies.
const version = process.versions.node;
const [major, minor] = version.split(".").map(Number);
if (!(major > 20 || (major === 20 && minor >= 3))) {
  console.error(
    `ccc requires Node.js 20.3 or newer; you are running ${version}. Upgrade Node.js and try again.`
  );
  process.exit(1);
}

// `ccc statusline`: Claude Code runs it after every message, so it loads only itself
// (statusline.ts): no proxy, no update check, no wait for an update to finish.
if (process.argv[2] === "statusline") {
  import("./statusline.js")
    .then((m) => m.statuslineMain(process.argv.slice(3)))
    .then((code) => { process.exitCode = code; })
    .catch(() => { process.exitCode = 1; });
} else {
  start();
}

function start(): void {
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
}
