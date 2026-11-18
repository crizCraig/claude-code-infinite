// Install the test socket before loading the CLI, without a Node preload flag.
import "./direct-mcp-https.mjs";

if (process.env.TEST_EXEC_ARG) process.execArgv.push(process.env.TEST_EXEC_ARG);
if (process.env.TEST_NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.TEST_NODE_OPTIONS;
if (process.env.TEST_NO_DISABLE_SIGUSR1 === "1") {
  const supported = new Set(process.allowedNodeEnvironmentFlags);
  supported.delete("--disable-sigusr1");
  process.allowedNodeEnvironmentFlags = supported;
}
if (process.env.TEST_NODE_BINARY) process.execPath = process.env.TEST_NODE_BINARY;
await import("../../dist/cli.js");
