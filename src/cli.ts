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

import("./cli-main.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
