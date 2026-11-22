import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isFileSystemError } from "./file-system.js";

const STATE_FORMAT = "firstdraft.cli-state/1";
export const MAX_STATE_BYTES = 4096;
const MAX_ETAG_BYTES = 1024;
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ETAG_PATTERN = /^"(?:[\x21\x23-\x7e\x80-\xff])*"$/;

/**
 * @typedef {object} PlanStateFileSystem
 * @property {typeof lstatSync} lstatSync
 * @property {typeof readFileSync} readFileSync
 */

/** @type {PlanStateFileSystem} */
const DEFAULT_FILE_SYSTEM = { lstatSync, readFileSync };

export class PlanStateConfigurationError extends Error {}
export class PlanStateLocalError extends Error {}
export class PlanStateNotPushedError extends Error {}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {PlanStateFileSystem} [options.fileSystem]
 */
export function readPlanState({ cwd, fileSystem = DEFAULT_FILE_SYSTEM }) {
  const directory = path.join(cwd, ".firstdraft");
  assertLocalDirectory(directory, fileSystem);
  const source = readLocalFile(
    path.join(directory, "state.json"),
    MAX_STATE_BYTES,
    fileSystem,
  );

  return parsePlanState(source);
}

/**
 * The Project and API origin that a successful plan push pinned, read from
 * the Project's directory or, in an application that adopted the current
 * directory, from the planning state archived at .firstdraft/design.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {PlanStateFileSystem} [options.fileSystem]
 */
export function readPinnedProject({ cwd, fileSystem }) {
  const projectDirectory = pinnedProjectDirectory(cwd, fileSystem);
  const state = readPlanState({ cwd: projectDirectory, fileSystem });
  if (state.api_url === undefined) {
    throw new PlanStateNotPushedError(
      "The local Foundation Plan has not been pushed.",
    );
  }

  return {
    apiUrl: state.api_url,
    projectId: state.project_id,
    stateDirectory: path.join(projectDirectory, ".firstdraft"),
  };
}

/**
 * The directory whose .firstdraft holds the Project's state: `cwd`, or the
 * archive at .firstdraft/design when `cwd` is an adopted application root.
 *
 * @param {string} cwd
 * @param {PlanStateFileSystem} [fileSystem]
 */
function pinnedProjectDirectory(cwd, fileSystem) {
  // Only an adopted root, whose real .firstdraft holds no state.json, falls
  // back; any other local problem is reported for this directory.
  const adoptedRoot =
    isDirectory(path.join(cwd, ".firstdraft"), fileSystem) &&
    isAbsent(path.join(cwd, ".firstdraft", "state.json"), fileSystem) &&
    isDirectory(path.join(cwd, ".firstdraft", "design"), fileSystem);
  return adoptedRoot ? path.join(cwd, ".firstdraft", "design") : cwd;
}

// The Compilation whose code the CLI last wrote for the Project, kept in its
// own file beside state.json so the state format stays as it is. It moves
// with the planning state into an adopted root's archive.
const COMPILATION_RECORD_NAME = "compilation.json";
const COMPILATION_RECORD_FORMAT = "firstdraft.cli-compilation/1";

export class CompilationRecordWriteError extends Error {}
export class CompilationNotRecordedError extends Error {}

/**
 * Records `compilationId` as the Compilation whose code the CLI just wrote,
 * beside the state of the Project found from `cwd` as readPinnedProject
 * finds it, replacing any earlier record.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.compilationId
 * @param {() => string} [options.createTemporaryId]
 * @returns {string} the record's path
 */
export function recordCompilation({
  cwd,
  compilationId,
  createTemporaryId = randomUUID,
}) {
  const recordPath = path.join(
    pinnedProjectDirectory(cwd),
    ".firstdraft",
    COMPILATION_RECORD_NAME,
  );
  const temporaryPath = `${recordPath}.${createTemporaryId()}.tmp`;
  const source = `${JSON.stringify(
    { format: COMPILATION_RECORD_FORMAT, compilation_id: compilationId },
    null,
    2,
  )}\n`;
  try {
    writeFileSync(temporaryPath, source, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temporaryPath, recordPath);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;

    throw new CompilationRecordWriteError(
      "The Compilation record could not be written.",
      { cause: error },
    );
  }
  return recordPath;
}

/**
 * The Compilation that recordCompilation recorded in `stateDirectory`.
 *
 * @param {object} options
 * @param {string} options.stateDirectory from readPinnedProject
 * @param {PlanStateFileSystem} [options.fileSystem]
 * @returns {string}
 */
export function readRecordedCompilation({
  stateDirectory,
  fileSystem = DEFAULT_FILE_SYSTEM,
}) {
  const recordPath = path.join(stateDirectory, COMPILATION_RECORD_NAME);
  if (isAbsent(recordPath, fileSystem)) {
    throw new CompilationNotRecordedError(
      "No Compilation is recorded for this Project.",
    );
  }

  const source = readLocalFile(recordPath, MAX_STATE_BYTES, fileSystem);
  let record;
  try {
    record = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) {
      throw error;
    }

    throw new PlanStateLocalError("The Compilation record is invalid.", {
      cause: error,
    });
  }
  if (
    !isRecord(record) ||
    !arraysEqual(Object.keys(record).sort(), ["compilation_id", "format"]) ||
    record.format !== COMPILATION_RECORD_FORMAT ||
    !isUuidV7(record.compilation_id)
  ) {
    throw new PlanStateLocalError("The Compilation record is invalid.");
  }
  return record.compilation_id;
}

/** @param {string} value */
export function normalizeApiUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;

    throw new PlanStateConfigurationError("The API URL is invalid.", {
      cause: error,
    });
  }

  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PlanStateConfigurationError("The API URL is invalid.");
  }

  return url.origin;
}

/**
 * @param {string} directory
 * @param {PlanStateFileSystem} [fileSystem]
 */
function isDirectory(directory, fileSystem = DEFAULT_FILE_SYSTEM) {
  try {
    return fileSystem.lstatSync(directory).isDirectory();
  } catch (error) {
    if (!isFileSystemError(error)) throw error;

    return false;
  }
}

/**
 * @param {string} filePath
 * @param {PlanStateFileSystem} [fileSystem]
 */
function isAbsent(filePath, fileSystem = DEFAULT_FILE_SYSTEM) {
  try {
    fileSystem.lstatSync(filePath);
    return false;
  } catch (error) {
    if (!isFileSystemError(error)) throw error;

    return error.code === "ENOENT";
  }
}

/** @param {unknown} value @returns {value is string} */
export function isUuidV7(value) {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

/**
 * @param {string} filePath
 * @param {number} maximumBytes
 * @param {PlanStateFileSystem} fileSystem
 */
export function readLocalFile(filePath, maximumBytes, fileSystem) {
  try {
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new PlanStateLocalError("A local First Draft file is invalid.");
    }

    const source = fileSystem.readFileSync(filePath);
    if (!Buffer.isBuffer(source) || source.byteLength > maximumBytes) {
      throw new PlanStateLocalError("A local First Draft file is invalid.");
    }

    return source;
  } catch (error) {
    if (error instanceof PlanStateLocalError) throw error;
    if (!isFileSystemError(error)) throw error;

    throw new PlanStateLocalError(
      "A local First Draft file could not be read.",
      { cause: error },
    );
  }
}

/**
 * @param {string} directory
 * @param {PlanStateFileSystem} fileSystem
 */
function assertLocalDirectory(directory, fileSystem) {
  try {
    if (!fileSystem.lstatSync(directory).isDirectory()) {
      throw new PlanStateLocalError(
        "The local First Draft directory is invalid.",
      );
    }
  } catch (error) {
    if (error instanceof PlanStateLocalError) throw error;
    if (!isFileSystemError(error)) throw error;

    throw new PlanStateLocalError(
      "The local First Draft directory could not be read.",
      { cause: error },
    );
  }
}

/** @param {Buffer} source */
function parsePlanState(source) {
  let state;

  try {
    state = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) {
      throw error;
    }

    throw new PlanStateLocalError("Local First Draft state is invalid.", {
      cause: error,
    });
  }

  if (!isRecord(state)) {
    throw new PlanStateLocalError("Local First Draft state is invalid.");
  }

  const keys = Object.keys(state).sort();
  const hasRemoteState =
    state.api_url !== undefined || state.foundation_plan_etag !== undefined;
  const expectedKeys = hasRemoteState
    ? ["api_url", "format", "foundation_plan_etag", "project_id"]
    : ["format", "project_id"];
  let storedApiUrl;

  if (typeof state.api_url === "string") {
    try {
      storedApiUrl = normalizeApiUrl(state.api_url);
    } catch (error) {
      if (!(error instanceof PlanStateConfigurationError)) throw error;

      throw new PlanStateLocalError("Local First Draft state is invalid.", {
        cause: error,
      });
    }
  }

  if (
    !arraysEqual(keys, expectedKeys) ||
    state.format !== STATE_FORMAT ||
    !isUuidV7(state.project_id) ||
    (hasRemoteState && storedApiUrl !== state.api_url) ||
    (state.foundation_plan_etag !== undefined &&
      !isStrongEtag(state.foundation_plan_etag))
  ) {
    throw new PlanStateLocalError("Local First Draft state is invalid.");
  }

  return {
    format: state.format,
    project_id: state.project_id,
    ...(storedApiUrl ? { api_url: storedApiUrl } : {}),
    ...(typeof state.foundation_plan_etag === "string"
      ? { foundation_plan_etag: state.foundation_plan_etag }
      : {}),
  };
}

/** @param {unknown} value @returns {value is string} */
export function isStrongEtag(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_ETAG_BYTES &&
    STRONG_ETAG_PATTERN.test(value)
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string[]} left @param {string[]} right */
function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
