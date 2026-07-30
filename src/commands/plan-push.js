import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isFileSystemError } from "../file-system.js";

export const DEFAULT_API_URL = "https://firstdraft.com";

const FOUNDATION_PLAN_MEDIA_TYPE =
  "application/vnd.firstdraft.foundation-plan+json";
const STATE_FORMAT = "firstdraft.cli-state/1";
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ETAG_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ETAG_PATTERN = /^"(?:[\x21\x23-\x7e\x80-\xff])*"$/;

/**
 * @typedef {object} PlanPushFileSystem
 * @property {typeof lstatSync} lstatSync
 * @property {typeof readFileSync} readFileSync
 * @property {typeof renameSync} renameSync
 * @property {typeof writeFileSync} writeFileSync
 */

/** @type {PlanPushFileSystem} */
const DEFAULT_FILE_SYSTEM = {
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
};

export class PlanPushConfigurationError extends Error {}
export class PlanPushLocalError extends Error {}

export class PlanPushNetworkError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: Error, status?: number}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
  }
}

export class PlanPushProtocolError extends Error {
  /** @param {string} message @param {{status: number}} options */
  constructor(message, options) {
    super(message);
    this.status = options.status;
  }
}

export class PlanPushStateWriteError extends Error {
  /**
   * @param {{format: string, project_id: string, api_url: string, foundation_plan_etag: string}} recoveryState
   * @param {{cause: Error}} options
   */
  constructor(recoveryState, options) {
    super("The Foundation Plan was accepted, but local state was not saved.", {
      cause: options.cause,
    });
    this.recoveryState = recoveryState;
  }
}

/**
 * @typedef {object} PushPlanOptions
 * @property {string} cwd
 * @property {string} [apiUrl]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {PlanPushFileSystem} [fileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {() => AbortSignal} [createRequestSignal]
 */

/**
 * @typedef {object} PushPlanResult
 * @property {number} status
 * @property {string} etag
 * @property {"created" | "updated"} outcome
 * @property {Record<string, unknown>} body
 */

/**
 * @typedef {object} RejectedPushResult
 * @property {number} status
 * @property {"diagnostics" | "problem" | null} responseKind
 * @property {Record<string, unknown> | null} body
 */

/**
 * @param {PushPlanOptions} options
 * @returns {Promise<PushPlanResult | RejectedPushResult>}
 */
export async function pushPlan({
  cwd,
  apiUrl,
  fetchFunction = globalThis.fetch,
  fileSystem = DEFAULT_FILE_SYSTEM,
  createTemporaryId = randomUUID,
  createRequestSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS),
}) {
  const directory = path.join(cwd, ".firstdraft");
  assertLocalDirectory(directory, fileSystem);
  const planPath = path.join(directory, "foundation-plan.json");
  const statePath = path.join(directory, "state.json");
  const planSource = readLocalFile(planPath, MAX_PLAN_BYTES, fileSystem);
  const stateSource = readLocalFile(statePath, MAX_STATE_BYTES, fileSystem);
  const state = loadState(stateSource);
  const origin = resolveApiUrl(apiUrl, state.api_url);
  const endpoint = new URL(
    `/v1/projects/${state.project_id}/foundation-plan`,
    origin,
  );
  const headers = {
    Accept: "application/json, application/problem+json",
    "Content-Type": FOUNDATION_PLAN_MEDIA_TYPE,
    ...(state.foundation_plan_etag
      ? { "If-Match": state.foundation_plan_etag }
      : { "If-None-Match": "*" }),
  };

  const response = await sendRequest(fetchFunction, endpoint, {
    method: "PUT",
    headers,
    body: planSource,
    redirect: "error",
    signal: createRequestSignal(),
  });
  const body = await readResponseBody(response);
  const sourceSha256 = createHash("sha256").update(planSource).digest("hex");

  if (
    response.status === 422 &&
    (responseMediaType(response) !== "application/json" ||
      !isDiagnosticBody(body, sourceSha256))
  ) {
    throw new PlanPushProtocolError(
      "First Draft returned invalid diagnostics.",
      { status: response.status },
    );
  }

  if (response.status !== 200 && response.status !== 201) {
    if (response.ok) {
      throw new PlanPushProtocolError(
        "First Draft returned an unexpected success status.",
        { status: response.status },
      );
    }
    if (response.status === 422) {
      return { status: response.status, responseKind: "diagnostics", body };
    }

    if (isProblemBody(response, body)) {
      return { status: response.status, responseKind: "problem", body };
    }

    return { status: response.status, responseKind: null, body: null };
  }

  const etag = response.headers.get("etag");
  const expectedStatus = state.foundation_plan_etag ? 200 : 201;
  if (
    response.status !== expectedStatus ||
    responseMediaType(response) !== "application/json" ||
    !isStrongEtag(etag) ||
    !isAcceptedBody(body, state.project_id, sourceSha256)
  ) {
    throw new PlanPushProtocolError(
      "First Draft returned an invalid success response.",
      { status: response.status },
    );
  }

  saveState({
    statePath,
    state,
    apiUrl: origin,
    etag,
    fileSystem,
    temporaryId: createTemporaryId(),
  });

  return {
    status: response.status,
    etag,
    outcome: response.status === 201 ? "created" : "updated",
    body,
  };
}

/** @param {string | undefined} configured @param {string | undefined} stored */
function resolveApiUrl(configured, stored) {
  const configuredOrigin =
    configured === undefined ? undefined : normalizeApiUrl(configured);
  if (
    stored !== undefined &&
    configuredOrigin !== undefined &&
    stored !== configuredOrigin
  ) {
    throw new PlanPushConfigurationError(
      "The configured API URL does not match local state.",
    );
  }

  return stored ?? configuredOrigin ?? DEFAULT_API_URL;
}

/** @param {string} value */
export function normalizeApiUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;

    throw new PlanPushConfigurationError("The API URL is invalid.", {
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
    throw new PlanPushConfigurationError("The API URL is invalid.");
  }

  return url.origin;
}

/** @param {string} directory @param {PlanPushFileSystem} fileSystem */
function assertLocalDirectory(directory, fileSystem) {
  try {
    if (!fileSystem.lstatSync(directory).isDirectory()) {
      throw new PlanPushLocalError(
        "The local First Draft directory is invalid.",
      );
    }
  } catch (error) {
    if (error instanceof PlanPushLocalError) throw error;
    if (!isFileSystemError(error)) throw error;

    throw new PlanPushLocalError(
      "The local First Draft directory could not be read.",
      { cause: error },
    );
  }
}

/**
 * @param {string} filePath
 * @param {number} maximumBytes
 * @param {PlanPushFileSystem} fileSystem
 */
function readLocalFile(filePath, maximumBytes, fileSystem) {
  try {
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new PlanPushLocalError("A local First Draft file is invalid.");
    }

    const source = fileSystem.readFileSync(filePath);
    if (!Buffer.isBuffer(source) || source.byteLength > maximumBytes) {
      throw new PlanPushLocalError("A local First Draft file is invalid.");
    }

    return source;
  } catch (error) {
    if (error instanceof PlanPushLocalError) throw error;
    if (!isFileSystemError(error)) throw error;

    throw new PlanPushLocalError(
      "A local First Draft file could not be read.",
      {
        cause: error,
      },
    );
  }
}

/** @param {Buffer} source */
function loadState(source) {
  let state;

  try {
    state = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) {
      throw error;
    }

    throw new PlanPushLocalError("Local First Draft state is invalid.", {
      cause: error,
    });
  }

  if (!isRecord(state)) {
    throw new PlanPushLocalError("Local First Draft state is invalid.");
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
      if (!(error instanceof PlanPushConfigurationError)) throw error;

      throw new PlanPushLocalError("Local First Draft state is invalid.", {
        cause: error,
      });
    }
  }

  if (
    !arraysEqual(keys, expectedKeys) ||
    state.format !== STATE_FORMAT ||
    typeof state.project_id !== "string" ||
    !PROJECT_ID_PATTERN.test(state.project_id) ||
    (hasRemoteState && storedApiUrl !== state.api_url) ||
    (state.foundation_plan_etag !== undefined &&
      !isStrongEtag(state.foundation_plan_etag))
  ) {
    throw new PlanPushLocalError("Local First Draft state is invalid.");
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

/**
 * @param {typeof globalThis.fetch} fetchFunction
 * @param {URL} endpoint
 * @param {RequestInit} request
 */
async function sendRequest(fetchFunction, endpoint, request) {
  try {
    return await fetchFunction(endpoint, request);
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    throw new PlanPushNetworkError("The First Draft request failed.", {
      cause: error,
    });
  }
}

/** @param {Response} response */
async function readResponseBody(response) {
  const bytes = await readResponseBytes(response);

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;

    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    return null;
  }
}

/** @param {Response} response */
async function readResponseBytes(response) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    if (response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new PlanPushProtocolError("The First Draft response is too large.", {
      status: response.status,
    });
  }

  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PlanPushProtocolError(
          "The First Draft response is too large.",
          { status: response.status },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof PlanPushProtocolError) throw error;
    if (!(error instanceof Error)) throw error;

    throw new PlanPushNetworkError("The First Draft response failed.", {
      cause: error,
      status: response.status,
    });
  }

  return Buffer.concat(chunks, byteLength);
}

/**
 * @param {object} options
 * @param {string} options.statePath
 * @param {{format: string, project_id: string, api_url?: string, foundation_plan_etag?: string}} options.state
 * @param {string} options.apiUrl
 * @param {string} options.etag
 * @param {PlanPushFileSystem} options.fileSystem
 * @param {string} options.temporaryId
 */
function saveState({
  statePath,
  state,
  apiUrl,
  etag,
  fileSystem,
  temporaryId,
}) {
  const recoveryState = {
    format: state.format,
    project_id: state.project_id,
    api_url: apiUrl,
    foundation_plan_etag: etag,
  };
  const source = `${JSON.stringify(recoveryState, null, 2)}\n`;
  const temporaryPath = `${statePath}.${temporaryId}.tmp`;

  if (Buffer.byteLength(source) > MAX_STATE_BYTES) {
    throw new PlanPushStateWriteError(recoveryState, {
      cause: new RangeError("Local First Draft state exceeds its size limit."),
    });
  }

  try {
    fileSystem.writeFileSync(temporaryPath, source, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    fileSystem.renameSync(temporaryPath, statePath);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;

    throw new PlanPushStateWriteError(recoveryState, { cause: error });
  }
}

/** @param {Response} response */
function responseMediaType(response) {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

/**
 * @param {unknown} body
 * @param {string} projectId
 * @param {string} sourceSha256
 */
function isAcceptedBody(body, projectId, sourceSha256) {
  if (!isRecord(body)) return false;

  const project = body.project;
  const foundationPlan = body.foundation_plan;
  return (
    isRecord(project) &&
    project.id === projectId &&
    Number.isSafeInteger(project.graph_version) &&
    Number(project.graph_version) >= 1 &&
    isRecord(foundationPlan) &&
    typeof foundationPlan.format === "string" &&
    foundationPlan.source_sha256 === sourceSha256 &&
    Array.isArray(body.diagnostics) &&
    body.diagnostics.every(isWarningDiagnostic)
  );
}

/** @param {unknown} body @param {string} sourceSha256 */
function isDiagnosticBody(body, sourceSha256) {
  return (
    isRecord(body) &&
    body.source_sha256 === sourceSha256 &&
    Array.isArray(body.diagnostics) &&
    body.diagnostics.some(
      (diagnostic) =>
        isDiagnostic(diagnostic) && diagnostic.severity === "error",
    ) &&
    body.diagnostics.every(isDiagnostic)
  );
}

/** @param {Response} response @param {unknown} body */
function isProblemBody(response, body) {
  return (
    responseMediaType(response) === "application/problem+json" &&
    isRecord(body) &&
    (body.type === undefined || body.type === "about:blank") &&
    typeof body.title === "string" &&
    body.status === response.status &&
    typeof body.code === "string" &&
    typeof body.detail === "string"
  );
}

/** @param {unknown} value */
function isWarningDiagnostic(value) {
  return isDiagnostic(value) && value.severity === "warning";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown> & {severity: "error" | "warning"}}
 */
function isDiagnostic(value) {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (value.severity === "error" || value.severity === "warning") &&
    typeof value.message === "string"
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isStrongEtag(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_ETAG_BYTES &&
    STRONG_ETAG_PATTERN.test(value)
  );
}

/** @param {string[]} left @param {string[]} right */
function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
