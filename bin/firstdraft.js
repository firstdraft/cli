#!/usr/bin/env node

import { run } from "../src/cli.js";

process.stdout.on("error", handleStreamError);
process.stderr.on("error", handleStreamError);

process.exitCode = run({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
});

/** @param {Error} error */
function handleStreamError(error) {
  if ("code" in error && error.code === "EPIPE") return;

  throw error;
}
