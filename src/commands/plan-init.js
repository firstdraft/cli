import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} FileSystem
 * @property {typeof mkdirSync} mkdirSync
 * @property {typeof writeFileSync} writeFileSync
 */

/** @type {FileSystem} */
const DEFAULT_FILE_SYSTEM = { mkdirSync, writeFileSync };

/**
 * @typedef {object} InitializePlanOptions
 * @property {string} applicationKey
 * @property {string} name
 * @property {string} projectId
 * @property {string} cwd
 * @property {FileSystem} [fileSystem]
 */

/** @param {InitializePlanOptions} options */
export function initializePlan({
  applicationKey,
  name,
  projectId,
  cwd,
  fileSystem = DEFAULT_FILE_SYSTEM,
}) {
  const plan = `${JSON.stringify(emptyPlan(applicationKey, name), null, 2)}\n`;
  const state = `${JSON.stringify(projectState(projectId), null, 2)}\n`;
  const directory = path.join(cwd, ".firstdraft");
  const writeOptions = { flag: "wx", mode: 0o600, flush: true };

  fileSystem.mkdirSync(directory, { recursive: false, mode: 0o700 });
  fileSystem.writeFileSync(
    path.join(directory, ".gitignore"),
    "*\n",
    writeOptions,
  );
  fileSystem.writeFileSync(
    path.join(directory, "foundation-plan.json"),
    plan,
    writeOptions,
  );
  fileSystem.writeFileSync(
    path.join(directory, "state.json"),
    state,
    writeOptions,
  );
}

/** @param {unknown} error */
export function isFileSystemError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    !error.code.startsWith("ERR_")
  );
}

/** @param {string} applicationKey @param {string} name */
function emptyPlan(applicationKey, name) {
  return {
    format: "firstdraft.foundation-plan.sketch/0.19",
    target: {
      id: "rails",
      profile: "rails-sketch/2026-07",
    },
    application: {
      key: applicationKey,
      name,
      native: {},
      delivery: {},
      entities: [],
    },
  };
}

/** @param {string} projectId */
function projectState(projectId) {
  return {
    format: "firstdraft.cli-state/1",
    project_id: projectId,
  };
}
