import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const npmCli = requiredEnvironmentVariable("npm_execpath");

/** @type {{version: string}} */
const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "firstdraft-cli-"));
const installationDirectory = path.join(temporaryDirectory, "installation");
const packedExecutable = path.join(
  installationDirectory,
  "node_modules",
  "firstdraft",
  "bin",
  "firstdraft.js",
);

try {
  const packResult = runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryDirectory,
  ]);
  /** @type {{filename: string}[]} */
  const packedManifests = JSON.parse(packResult.stdout);
  const [packed] = packedManifests;
  assert(packed, "npm pack did not return a manifest");
  const tarball = path.join(temporaryDirectory, packed.filename);

  mkdirSync(installationDirectory);
  writeFileSync(
    path.join(installationDirectory, "package.json"),
    '{"name":"firstdraft-smoke","private":true}\n',
  );

  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--no-save",
      tarball,
    ],
    installationDirectory,
  );
  const execution = runNpm(
    ["exec", "--offline", "--", "firstdraft", "--version"],
    installationDirectory,
  );

  assert.equal(execution.stdout, `${packageMetadata.version}\n`);
  assert.equal(execution.stderr, "");

  const subjectId = runNpm(
    ["exec", "--offline", "--", "firstdraft", "plan", "subject-id"],
    installationDirectory,
  );

  assert.match(
    subjectId.stdout,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/,
  );
  assert.equal(subjectId.stderr, "");

  const invalidSubjectId = spawnPackedCli(
    ["plan", "subject-id", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidSubjectId, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft plan subject-id --help' for usage.",
  });

  const invalidInit = spawnPackedCli(
    ["plan", "init", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidInit, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan init --help' for usage.",
  });

  const projectDirectory = path.join(temporaryDirectory, "project");
  mkdirSync(projectDirectory);
  const initialized = spawnPackedCli(
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    projectDirectory,
  );
  assert.deepEqual(
    {
      status: initialized.status,
      stdout: initialized.stdout,
      stderr: initialized.stderr,
    },
    {
      status: 0,
      stdout: "Initialized .firstdraft/foundation-plan.json.\n",
      stderr: "",
    },
  );

  const repeatedInit = spawnPackedCli(
    [
      "plan",
      "init",
      "--application-key",
      "other_application",
      "--name",
      "canary-secret-name",
    ],
    projectDirectory,
  );
  assertHandledFailure(repeatedInit, 1, {
    error: "local_initialization_failed",
    detail:
      "Could not initialize .firstdraft. The directory may be incomplete; no existing files were overwritten.",
  });

  const invalidPush = spawnPackedCli(
    ["plan", "push", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidPush, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan push --help' for usage.",
  });

  const localPush = spawnPackedCli(["plan", "push"], installationDirectory);
  assertHandledFailure(localPush, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.",
  });

  const invalidStatus = spawnPackedCli(
    ["plan", "status", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidStatus, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan status --help' for usage.",
  });

  const localStatus = spawnPackedCli(["plan", "status"], installationDirectory);
  assertHandledFailure(localStatus, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read valid local First Draft state. No network request was made. Run 'firstdraft plan init' if this directory is not initialized; otherwise repair the private state before retrying.",
  });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function runNpm(arguments_, cwd = process.cwd()) {
  const result = spawnNpm(arguments_, cwd);

  assert.equal(
    result.status,
    0,
    `npm ${arguments_.join(" ")} failed\n${result.stdout}${result.stderr}`,
  );

  return result;
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function spawnNpm(arguments_, cwd = process.cwd()) {
  return spawnSync(process.execPath, [npmCli, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function spawnPackedCli(arguments_, cwd = process.cwd()) {
  return spawnSync(process.execPath, [packedExecutable, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

/**
 * @param {ReturnType<typeof spawnPackedCli>} execution
 * @param {number} status
 * @param {Record<string, unknown>} error
 */
function assertHandledFailure(execution, status, error) {
  assert.equal(execution.status, status);
  assert.equal(execution.stdout, "");
  assert.equal(execution.stderr, `${JSON.stringify(error, null, 2)}\n`);
  assert.doesNotMatch(execution.stderr, /canary-secret/);
}

/** @param {string} name */
function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  assert(value, `${name} is required; run this check through npm`);
  return value;
}
