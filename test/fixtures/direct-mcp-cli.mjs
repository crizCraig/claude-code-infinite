// Install the test socket before loading the CLI, without a Node preload flag.
import "./direct-mcp-https.mjs";

if (process.env.TEST_EXEC_ARG) process.execArgv.push(process.env.TEST_EXEC_ARG);
if (process.env.TEST_NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.TEST_NODE_OPTIONS;
await import("../../dist/cli.js");
