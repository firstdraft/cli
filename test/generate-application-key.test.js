import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/cli.js";

const HELP = `First Draft CLI

Usage:
  firstdraft generate application-key --name <name>

Options:
      --name <name>  Application display name
  -h, --help         Show help

The command derives the same application key used by name-only plan init.
Generated keys are at most 63 ASCII bytes.
`;
const USAGE_ERROR = `${JSON.stringify(
  {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft generate application-key --help' for usage.",
  },
  null,
  2,
)}\n`;

test("generate application-key prints the deterministic derived key", async () => {
  /** @type {readonly (readonly [string, string])[]} */
  const examples = [
    ["Movie Catalog", "movie_catalog"],
    ["Café Planner", "cafe_planner"],
    ["2026 Inventory", "app_2026_inventory"],
    ["東京", "app_130016b2599b"],
  ];

  for (const [name, key] of examples) {
    assert.deepEqual(
      await invoke(
        ["generate", "application-key", "--name", name],
        inaccessibleDependencies(),
      ),
      { status: 0, stdout: `${key}\n`, stderr: "" },
    );
  }
});

test("generate application-key help has no local or network prerequisites", async () => {
  for (const argv of [
    ["generate", "application-key", "--help"],
    ["generate", "application-key", "-h"],
    ["generate", "application-key", "--name", "canary-secret", "--help"],
  ]) {
    assert.deepEqual(await invoke(argv, inaccessibleDependencies()), {
      status: 0,
      stdout: HELP,
      stderr: "",
    });
  }
});

test("generate application-key validates names before producing output", async () => {
  for (const argv of [
    ["generate", "application-key"],
    ["generate", "application-key", "--name", "\u3000"],
    ["generate", "application-key", "--name", "\ud800"],
    [
      "generate",
      "application-key",
      "--name",
      "Movie Catalog",
      "--name",
      "Other",
    ],
    ["generate", "application-key", "canary-secret"],
    ["generate", "application-key", "--canary-secret-option"],
  ]) {
    const result = await invoke(argv, inaccessibleDependencies());
    assert.deepEqual(result, { status: 2, stdout: "", stderr: USAGE_ERROR });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

/** @returns {Partial<import("../src/cli.js").RunOptions>} */
function inaccessibleDependencies() {
  return {
    getCwd: () => {
      throw new Error("Working directory must not be read");
    },
    createProjectId: () => {
      throw new Error("Project ID generation must not run");
    },
    createUuid: () => {
      throw new Error("UUID generation must not run");
    },
    fileSystem: {
      mkdirSync() {
        throw new Error("Filesystem must not run");
      },
      writeFileSync() {
        throw new Error("Filesystem must not run");
      },
    },
    fetchFunction: async () => {
      throw new Error("Network must not run");
    },
  };
}

/**
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions>} [overrides]
 */
async function invoke(argv, overrides = {}) {
  let stdout = "";
  let stderr = "";

  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    ...overrides,
  });

  return { status, stdout, stderr };
}
