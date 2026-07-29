import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/cli.js";

const SUBJECT_ID = "01900000-0000-7000-8000-000000000302";
const HELP = `First Draft CLI

Usage:
  firstdraft plan subject-id

Prints one UUIDv7 for a new independently mutable Plan subject.
The command reads no files and makes no network request.

Options:
  -h, --help  Show help
`;
const USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan subject-id --help' for usage.\n";
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/;
/** @satisfies {Partial<import("../src/cli.js").RunOptions>} */
const INACCESSIBLE_DEPENDENCIES = {
  getCwd: () => {
    throw new Error("Working directory must not be read");
  },
  fileSystem: {
    mkdirSync() {
      throw new Error("Filesystem must not run");
    },
    writeFileSync() {
      throw new Error("Filesystem must not run");
    },
  },
  planPushFileSystem: {
    lstatSync() {
      throw new Error("Filesystem must not run");
    },
    readFileSync() {
      throw new Error("Filesystem must not run");
    },
    renameSync() {
      throw new Error("Filesystem must not run");
    },
    writeFileSync() {
      throw new Error("Filesystem must not run");
    },
  },
  fetchFunction: async () => {
    throw new Error("Network must not run");
  },
  createRequestSignal: () => {
    throw new Error("Network setup must not run");
  },
};

test("plan subject-id prints exactly one generated UUID", async () => {
  let calls = 0;
  const result = await invoke(["plan", "subject-id"], {
    ...INACCESSIBLE_DEPENDENCIES,
    createProjectId: () => {
      throw new Error("Project ID generation must not run");
    },
    createSubjectId: () => {
      calls += 1;
      return SUBJECT_ID;
    },
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: `${SUBJECT_ID}\n`,
    stderr: "",
  });
  assert.equal(calls, 1);
});

test("plan subject-id uses the production generator for fresh UUIDv7s", async () => {
  const first = await invoke(["plan", "subject-id"], INACCESSIBLE_DEPENDENCIES);
  const second = await invoke(
    ["plan", "subject-id"],
    INACCESSIBLE_DEPENDENCIES,
  );

  for (const result of [first, second]) {
    assert.equal(result.status, 0);
    assert.match(result.stdout, UUID_V7);
    assert.equal(result.stderr, "");
  }
  assert.notEqual(first.stdout, second.stdout);
});

test("plan subject-id help has no generation prerequisites", async () => {
  for (const argv of [
    ["plan", "subject-id", "--help"],
    ["plan", "subject-id", "-h"],
    ["plan", "subject-id", "--help", "--help"],
    ["plan", "subject-id", "-h", "-h"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        ...INACCESSIBLE_DEPENDENCIES,
        createSubjectId: () => {
          throw new Error("Subject ID generation must not run");
        },
      }),
      { status: 0, stdout: HELP, stderr: "" },
    );
  }
});

test("plan subject-id validates arguments before generating an ID", async () => {
  const canary = "canary-secret-argument";

  for (const argv of [
    ["plan", "subject-id", canary],
    ["plan", "subject-id", `--${canary}`],
    ["plan", "subject-id", "--help", canary],
    ["plan", "subject-id", canary, "--help"],
  ]) {
    const result = await invoke(argv, {
      ...INACCESSIBLE_DEPENDENCIES,
      createSubjectId: () => {
        throw new Error("Subject ID generation must not run");
      },
    });

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: USAGE_ERROR,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

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
