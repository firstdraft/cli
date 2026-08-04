import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/cli.js";

const UUID_ONE = "01900000-0000-7000-8000-000000000301";
const UUID_TWO = "01900000-0000-7000-8000-000000000302";
const UUID_THREE = "01900000-0000-7000-8000-000000000303";
const UUIDS = [UUID_ONE, UUID_TWO, UUID_THREE];
const GENERATE_HELP = `First Draft CLI

Usage:
  firstdraft generate <command> [options]

Commands:
  uuid             Generate one or more UUIDv7 values
  application-key  Derive a lower-snake-case application key

Options:
  -h, --help  Show help
`;
const UUID_HELP = `First Draft CLI

Usage:
  firstdraft generate uuid [--count <n>]

Options:
      --count <n>  Number to generate (positive integer)
  -h, --help       Show help

The command reads no files and makes no network request. Each UUID is printed
on its own line.
`;
const USAGE_ERROR = jsonOutput({
  error: "invalid_arguments",
  detail: "Invalid arguments. Run 'firstdraft generate uuid --help' for usage.",
});
const GROUP_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft generate --help' for usage.\n";
const GROUP_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft generate --help' for usage.\n";
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("generate help describes only its local commands", async () => {
  for (const argv of [
    ["generate"],
    ["generate", "--help"],
    ["generate", "-h"],
  ]) {
    assert.deepEqual(await invoke(argv, inaccessibleDependencies()), {
      status: 0,
      stdout: GENERATE_HELP,
      stderr: "",
    });
  }
});

test("generate group returns non-echoing usage errors", async () => {
  for (const argv of [
    ["generate", "canary-secret-command"],
    ["generate", "canary-secret-command", "--help"],
  ]) {
    const result = await invoke(argv, inaccessibleDependencies());
    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: GROUP_UNKNOWN_COMMAND,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }

  const option = await invoke(
    ["generate", "--canary-secret-option"],
    inaccessibleDependencies(),
  );
  assert.deepEqual(option, {
    status: 2,
    stdout: "",
    stderr: GROUP_USAGE_ERROR,
  });
  assert.doesNotMatch(option.stderr, /canary-secret/);
});

test("generate uuid prints one value by default and a requested count", async () => {
  let calls = 0;
  const createUuid = () => UUIDS[calls++] ?? UUID_ONE;

  assert.deepEqual(
    await invoke(["generate", "uuid"], {
      ...inaccessibleDependencies(),
      createUuid,
    }),
    { status: 0, stdout: `${UUID_ONE}\n`, stderr: "" },
  );
  assert.deepEqual(
    await invoke(["generate", "uuid", "--count", "2"], {
      ...inaccessibleDependencies(),
      createUuid,
    }),
    { status: 0, stdout: `${UUID_TWO}\n${UUID_THREE}\n`, stderr: "" },
  );
  assert.equal(calls, 3);
});

test("generate uuid accepts counts beyond an arbitrary product cap", async () => {
  let calls = 0;
  const result = await invoke(["generate", "uuid", "--count", "1001"], {
    ...inaccessibleDependencies(),
    createUuid: () => {
      calls += 1;
      return UUID_ONE;
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trimEnd().split("\n").length, 1001);
  assert.equal(calls, 1001);
});

test("generate uuid uses fresh production UUIDv7 values", async () => {
  const first = await invoke(["generate", "uuid"], inaccessibleDependencies());
  const second = await invoke(["generate", "uuid"], inaccessibleDependencies());

  assert.match(first.stdout.trim(), UUID_V7);
  assert.match(second.stdout.trim(), UUID_V7);
  assert.notEqual(first.stdout, second.stdout);
});

test("generate uuid help has no generation prerequisites", async () => {
  for (const argv of [
    ["generate", "uuid", "--help"],
    ["generate", "uuid", "-h"],
    ["generate", "uuid", "--count", "canary-secret", "--help"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        ...inaccessibleDependencies(),
        createUuid: () => {
          throw new Error("UUID generation must not run");
        },
      }),
      { status: 0, stdout: UUID_HELP, stderr: "" },
    );
  }
});

test("generate uuid validates count before generating output", async () => {
  const invalidArguments = [
    ["generate", "uuid", "--count", "0"],
    ["generate", "uuid", "--count", "-1"],
    ["generate", "uuid", "--count", "01"],
    ["generate", "uuid", "--count", "1.5"],
    ["generate", "uuid", "--count", "9007199254740992"],
    ["generate", "uuid", "--count", "1", "--count", "2"],
    ["generate", "uuid", "canary-secret"],
    ["generate", "uuid", "--canary-secret-option"],
  ];

  for (const argv of invalidArguments) {
    const result = await invoke(argv, {
      ...inaccessibleDependencies(),
      createUuid: () => {
        throw new Error("UUID generation must not run");
      },
    });

    assert.deepEqual(result, { status: 2, stdout: "", stderr: USAGE_ERROR });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("unexpected UUID generation errors remain loud", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      invoke(["generate", "uuid", "--count", "2"], {
        ...inaccessibleDependencies(),
        createUuid: () => {
          calls += 1;
          if (calls === 2) throw new TypeError("programming error");
          return UUID_ONE;
        },
      }),
    /programming error/,
  );
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

/** @param {unknown} value */
function jsonOutput(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
