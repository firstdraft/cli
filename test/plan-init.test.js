import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000000301";
const PLAN_HELP = `First Draft CLI

Usage:
  firstdraft plan <command> [options]

Commands:
  init  Create a local empty Foundation Plan

Options:
  -h, --help  Show help
`;
const PLAN_INIT_HELP = `First Draft CLI

Usage:
  firstdraft plan init --application-key <key> --name <name>

Options:
      --application-key <key>  Lower-snake-case application key
      --name <name>            Application display name
  -h, --help                   Show help
`;
const PLAN_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan --help' for usage.\n";
const PLAN_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft plan --help' for usage.\n";
const PLAN_INIT_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan init --help' for usage.\n";
const PLAN_INIT_ERROR =
  "Could not initialize .firstdraft. The directory may be incomplete; no existing files were overwritten.\n";

const EXPECTED_PLAN = `{
  "format": "firstdraft.foundation-plan.sketch/0.19",
  "target": {
    "id": "rails",
    "profile": "rails-sketch/2026-07"
  },
  "application": {
    "key": "oscar_party",
    "name": "Oscar Party",
    "native": {},
    "delivery": {},
    "entities": []
  }
}
`;
const EXPECTED_STATE = `{
  "format": "firstdraft.cli-state/1",
  "project_id": "01900000-0000-7000-8000-000000000301"
}
`;

test("plan help describes the available command", () => {
  assert.deepEqual(invoke(["plan"]), {
    status: 0,
    stdout: PLAN_HELP,
    stderr: "",
  });
  assert.deepEqual(invoke(["plan", "--help"]), {
    status: 0,
    stdout: PLAN_HELP,
    stderr: "",
  });
  assert.deepEqual(invoke(["plan", "-h"]), {
    status: 0,
    stdout: PLAN_HELP,
    stderr: "",
  });
});

test("plan init help does not require creation options", () => {
  for (const argv of [
    ["plan", "init", "--help"],
    ["plan", "init", "-h"],
    ["plan", "init", "--help", "--help"],
    ["plan", "init", "-h", "-h"],
  ]) {
    assert.deepEqual(invoke(argv), {
      status: 0,
      stdout: PLAN_INIT_HELP,
      stderr: "",
    });
  }
});

test("plan commands return non-echoing usage errors", () => {
  const canary = "canary-secret-command";

  for (const argv of [
    ["plan", canary],
    ["plan", canary, "--help"],
    ["plan", "--help", canary],
  ]) {
    const result = invoke(argv);

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: PLAN_UNKNOWN_COMMAND,
    });
    refuteCanary(result);
  }

  for (const argv of [
    ["plan", "--canary-secret-option"],
    ["plan", "--canary-secret-option", "--help"],
  ]) {
    const result = invoke(argv);

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: PLAN_USAGE_ERROR,
    });
    refuteCanary(result);
  }
});

test("plan init creates exact deterministic local files", (context) => {
  const cwd = temporaryDirectory(context, "firstdraft init ünicode ");
  const result = invoke(
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    { cwd, createProjectId: () => PROJECT_ID },
  );
  const directory = path.join(cwd, ".firstdraft");

  assert.deepEqual(result, {
    status: 0,
    stdout: "Initialized .firstdraft/foundation-plan.json.\n",
    stderr: "",
  });
  assert.equal(readFileSync(path.join(directory, ".gitignore"), "utf8"), "*\n");
  assert.equal(
    readFileSync(path.join(directory, "foundation-plan.json"), "utf8"),
    EXPECTED_PLAN,
  );
  assert.equal(
    readFileSync(path.join(directory, "state.json"), "utf8"),
    EXPECTED_STATE,
  );
  assert.equal(existsSync(path.join(cwd, ".gitignore")), false);

  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const file of [".gitignore", "foundation-plan.json", "state.json"]) {
      assert.equal(statSync(path.join(directory, file)).mode & 0o777, 0o600);
    }
  }
});

test("the executable initializes with a production UUIDv7", (context) => {
  const cwd = temporaryDirectory(context);
  const executable = fileURLToPath(
    new URL("../bin/firstdraft.js", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      executable,
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    { cwd, encoding: "utf8" },
  );
  const state = JSON.parse(
    readFileSync(path.join(cwd, ".firstdraft", "state.json"), "utf8"),
  );

  assert.deepEqual(
    { status: result.status, stdout: result.stdout, stderr: result.stderr },
    {
      status: 0,
      stdout: "Initialized .firstdraft/foundation-plan.json.\n",
      stderr: "",
    },
  );
  assert.match(
    state.project_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("the nested ignore file hides the complete local directory from Git", (context) => {
  const cwd = temporaryDirectory(context);
  runGit(cwd, ["init", "--quiet"]);

  const result = invoke(
    ["plan", "init", "--application-key=oscar_party", "--name=Oscar Party"],
    { cwd, createProjectId: () => PROJECT_ID },
  );
  assert.equal(result.status, 0);

  const status = runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  assert.equal(status.stdout, "");

  const ignored = runGit(cwd, [
    "check-ignore",
    "-v",
    ".firstdraft/.gitignore",
    ".firstdraft/foundation-plan.json",
    ".firstdraft/state.json",
  ]);
  assert.equal(ignored.stdout.trim().split("\n").length, 3);
  assert.match(ignored.stdout, /\.firstdraft\/\.gitignore:1:\*/);
});

test("an existing root gitignore remains byte-for-byte unchanged", (context) => {
  const cwd = temporaryDirectory(context);
  const gitignore = path.join(cwd, ".gitignore");
  const original = Buffer.from([0x61, 0x0d, 0x0a, 0x62, 0x0a, 0xff]);
  writeFileSync(gitignore, original);

  const result = invoke(
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    { cwd, createProjectId: () => PROJECT_ID },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(readFileSync(gitignore), original);
});

test("plan init validates every argument before randomness or filesystem access", () => {
  const invalidArguments = [
    ["plan", "init"],
    ["plan", "init", "--application-key", "oscar_party"],
    ["plan", "init", "--name", "Oscar Party"],
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--application-key",
      "other",
      "--name",
      "Oscar Party",
    ],
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
      "--name",
      "Other",
    ],
    [
      "plan",
      "init",
      "--application-key",
      "Invalid-Key",
      "--name",
      "Oscar Party",
    ],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\u00a0\t"],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\u0085"],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\u0000"],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\ud800"],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\udc00"],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\ufdd0"],
    ["plan", "init", "--application-key", "oscar_party", "--name", "\ufffe"],
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      String.fromCodePoint(0x1fffe),
    ],
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
      "--canary-secret-option",
    ],
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
      "canary-secret-positional",
    ],
  ];

  for (const argv of invalidArguments) {
    const result = invoke(argv, {
      createProjectId: () => {
        throw new Error("randomness must not run");
      },
      fileSystem: inaccessibleFileSystem(),
    });

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: PLAN_INIT_USAGE_ERROR,
    });
    refuteCanary(result);
  }
});

test("plan init accepts ordinary astral Unicode in the application name", (context) => {
  const cwd = temporaryDirectory(context);
  const name = "Oscar Party \ud83c\udf89";

  const result = invoke(
    ["plan", "init", "--application-key", "oscar_party", "--name", name],
    { cwd, createProjectId: () => PROJECT_ID },
  );
  const plan = JSON.parse(
    readFileSync(path.join(cwd, ".firstdraft", "foundation-plan.json"), "utf8"),
  );

  assert.equal(result.status, 0);
  assert.equal(plan.application.name, name);
});

test("plan init never overwrites an existing local path", (context) => {
  const directoryCwd = temporaryDirectory(context);
  const directory = path.join(directoryCwd, ".firstdraft");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "canary.txt"), "canary-secret-directory");

  const directoryResult = invokeValidInit(directoryCwd);
  assertInitializationFailure(directoryResult);
  assert.equal(
    readFileSync(path.join(directory, "canary.txt"), "utf8"),
    "canary-secret-directory",
  );

  const fileCwd = temporaryDirectory(context);
  const file = path.join(fileCwd, ".firstdraft");
  writeFileSync(file, "canary-secret-file");

  const fileResult = invokeValidInit(fileCwd);
  assertInitializationFailure(fileResult);
  assert.equal(readFileSync(file, "utf8"), "canary-secret-file");
});

test(
  "plan init refuses an existing symlink without following it",
  { skip: process.platform === "win32" },
  (context) => {
    const cwd = temporaryDirectory(context);
    const target = temporaryDirectory(context);
    symlinkSync(target, path.join(cwd, ".firstdraft"), "dir");

    const result = invokeValidInit(cwd);

    assertInitializationFailure(result);
    assert.equal(
      lstatSync(path.join(cwd, ".firstdraft")).isSymbolicLink(),
      true,
    );
    assert.deepEqual(readFileNames(target), []);
  },
);

test("a second initialization preserves the first Project", (context) => {
  const cwd = temporaryDirectory(context);
  const first = invokeValidInit(cwd);
  const directory = path.join(cwd, ".firstdraft");
  const originalPlan = readFileSync(
    path.join(directory, "foundation-plan.json"),
  );
  const originalState = readFileSync(path.join(directory, "state.json"));

  const second = invoke(
    [
      "plan",
      "init",
      "--application-key",
      "other_application",
      "--name",
      "Other Application",
    ],
    { cwd, createProjectId: () => "01900000-0000-7000-8000-000000000399" },
  );

  assert.equal(first.status, 0);
  assertInitializationFailure(second);
  assert.deepEqual(
    readFileSync(path.join(directory, "foundation-plan.json")),
    originalPlan,
  );
  assert.deepEqual(
    readFileSync(path.join(directory, "state.json")),
    originalState,
  );
});

test("partial filesystem failures stop immediately without cleanup", () => {
  const operations = [
    "mkdir",
    "write:.gitignore",
    "write:foundation-plan.json",
    "write:state.json",
  ];

  for (
    let failureIndex = 0;
    failureIndex < operations.length;
    failureIndex += 1
  ) {
    /** @type {string[]} */
    const calls = [];
    const fileSystem = recordingFileSystem(calls, failureIndex);
    const result = invokeValidInit("/unused", { fileSystem });

    assertInitializationFailure(result);
    assert.deepEqual(calls, operations.slice(0, failureIndex + 1));
  }
});

test("unexpected programming errors remain loud", () => {
  /** @type {import("../src/commands/plan-init.js").FileSystem} */
  const fileSystem = {
    mkdirSync() {
      throw new TypeError("programming error");
    },
    writeFileSync() {
      throw new Error("not reached");
    },
  };

  assert.throws(
    () => invokeValidInit("/unused", { fileSystem }),
    /programming error/,
  );
});

/**
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions>} [overrides]
 */
function invoke(argv, overrides = {}) {
  let stdout = "";
  let stderr = "";

  const status = run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    ...overrides,
  });

  return { status, stdout, stderr };
}

/**
 * @param {string} cwd
 * @param {Partial<import("../src/cli.js").RunOptions>} [overrides]
 */
function invokeValidInit(cwd, overrides = {}) {
  return invoke(
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    { cwd, createProjectId: () => PROJECT_ID, ...overrides },
  );
}

/** @param {{stdout: string, stderr: string}} result */
function refuteCanary(result) {
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /canary-secret/);
}

/** @param {{status: number, stdout: string, stderr: string}} result */
function assertInitializationFailure(result) {
  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: PLAN_INIT_ERROR,
  });
  refuteCanary(result);
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context, prefix = "firstdraft-plan-init-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {string} cwd */
function readFileNames(cwd) {
  return readdirSync(cwd);
}

/** @param {string} cwd @param {string[]} arguments_ */
function runGit(cwd, arguments_) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${arguments_.join(" ")} failed\n${result.stdout}${result.stderr}`,
  );
  return result;
}

function inaccessibleFileSystem() {
  /** @type {import("../src/commands/plan-init.js").FileSystem} */
  return {
    mkdirSync() {
      throw new Error("filesystem must not run");
    },
    writeFileSync() {
      throw new Error("filesystem must not run");
    },
  };
}

/**
 * @param {string[]} calls
 * @param {number} failureIndex
 * @returns {import("../src/commands/plan-init.js").FileSystem}
 */
function recordingFileSystem(calls, failureIndex) {
  /** @param {string} operation */
  function record(operation) {
    calls.push(operation);
    if (calls.length - 1 === failureIndex) {
      const error = new Error("canary-secret-filesystem");
      Object.assign(error, { code: "EIO" });
      throw error;
    }
  }

  return {
    mkdirSync() {
      record("mkdir");
    },
    writeFileSync(file) {
      record(`write:${path.basename(file.toString())}`);
    },
  };
}
