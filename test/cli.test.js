import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { run } from "../src/cli.js";
import { VERSION } from "../src/version.js";

const HELP = `First Draft CLI

Usage:
  firstdraft <command> [options]
  firstdraft [options]

Commands:
  plan  Work with Foundation Plans

Options:
  -h, --help     Show help
  -V, --version  Show version
`;
const USAGE_ERROR = "Invalid arguments.\nRun 'firstdraft --help' for usage.\n";
const UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft --help' for usage.\n";
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("no arguments show help", async () => {
  const result = await invoke([]);

  assert.deepEqual(result, { status: 0, stdout: HELP, stderr: "" });
});

test("help uses long and short options", async () => {
  const long = await invoke(["--help"]);
  const short = await invoke(["-h"]);

  assert.deepEqual(long, { status: 0, stdout: HELP, stderr: "" });
  assert.deepEqual(short, long);
});

test("version matches the package through long and short options", async () => {
  const long = await invoke(["--version"]);
  const short = await invoke(["-V"]);

  assert.equal(VERSION, packageMetadata.version);
  assert.deepEqual(long, { status: 0, stdout: `${VERSION}\n`, stderr: "" });
  assert.deepEqual(short, long);
});

test("an unknown command returns a non-echoing usage error", async () => {
  const canary = "\u001b[31mcanary-secret-command\n";

  for (const argv of [
    [canary],
    [canary, "--help"],
    ["--help", canary],
    [canary, "--version"],
    ["--version", canary],
  ]) {
    const result = await invoke(argv);

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: UNKNOWN_COMMAND,
    });
    assert.doesNotMatch(result.stderr, /canary-secret|\n\n/);
    assert.equal(result.stderr.includes("\u001b"), false);
  }
});

test("an unknown option returns a non-echoing usage error", async () => {
  for (const argv of [
    ["--canary-secret-option"],
    ["--canary-secret-option", "--help"],
    ["--help", "--canary-secret-option"],
  ]) {
    const result = await invoke(argv);

    assert.deepEqual(result, { status: 2, stdout: "", stderr: USAGE_ERROR });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("recognized root options have deterministic precedence", async () => {
  for (const argv of [
    ["--help", "--version"],
    ["-hV"],
    ["--help", "--help"],
    ["--"],
  ]) {
    assert.deepEqual(await invoke(argv), {
      status: 0,
      stdout: HELP,
      stderr: "",
    });
  }

  assert.deepEqual(await invoke(["--version", "--version"]), {
    status: 0,
    stdout: `${VERSION}\n`,
    stderr: "",
  });
});

test("argument parsing does not mutate injected input", async () => {
  const argv = Object.freeze(["--version"]);

  assert.equal((await invoke(argv)).status, 0);
  assert.deepEqual(argv, ["--version"]);
});

test("the executable delegates success and usage errors to the tested runner", () => {
  const executable = fileURLToPath(
    new URL("../bin/firstdraft.js", import.meta.url),
  );
  const success = spawnSync(process.execPath, [executable, "--version"], {
    encoding: "utf8",
  });
  const usageError = spawnSync(process.execPath, [executable, "unknown"], {
    encoding: "utf8",
  });

  assert.deepEqual(
    { status: success.status, stdout: success.stdout, stderr: success.stderr },
    { status: 0, stdout: `${VERSION}\n`, stderr: "" },
  );
  assert.deepEqual(
    {
      status: usageError.status,
      stdout: usageError.stdout,
      stderr: usageError.stderr,
    },
    { status: 2, stdout: "", stderr: UNKNOWN_COMMAND },
  );
});

test("the executable preserves its status when an output pipe closes", async () => {
  const executable = fileURLToPath(
    new URL("../bin/firstdraft.js", import.meta.url),
  );
  const help = spawn(process.execPath, [executable, "--help"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  help.stdout.destroy();
  const [helpStatus, helpSignal] = await once(help, "close");

  assert.equal(helpStatus, 0);
  assert.equal(helpSignal, null);

  const usageError = spawn(process.execPath, [executable, "unknown"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  usageError.stderr.destroy();
  const [usageStatus, usageSignal] = await once(usageError, "close");

  assert.equal(usageStatus, 2);
  assert.equal(usageSignal, null);
});

/** @param {readonly string[]} argv */
async function invoke(argv) {
  let stdout = "";
  let stderr = "";

  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });

  return { status, stdout, stderr };
}
