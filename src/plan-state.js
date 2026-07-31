import { lstatSync, readFileSync } from "node:fs";
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
