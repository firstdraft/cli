import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  FirstDraftProtocolError,
  isDiagnostic,
  isProblemBody,
  readResponseBody,
  responseMediaType,
  sendRequest,
} from "../api-response.js";
import { isFileSystemError } from "../file-system.js";
import {
  MAX_STATE_BYTES,
  PlanStateConfigurationError,
  isStrongEtag,
  normalizeApiUrl,
  readLocalFile,
  readPlanState,
} from "../plan-state.js";

export {
  PlanStateConfigurationError as PlanPushConfigurationError,
  PlanStateLocalError as PlanPushLocalError,
  normalizeApiUrl,
} from "../plan-state.js";
export {
  FirstDraftNetworkError as PlanPushNetworkError,
  FirstDraftProtocolError as PlanPushProtocolError,
} from "../api-response.js";

export const DEFAULT_API_URL = "https://firstdraft.com";

const FOUNDATION_PLAN_MEDIA_TYPE =
  "application/vnd.firstdraft.foundation-plan+json";
const MAX_PLAN_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

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
  const state = readPlanState({ cwd, fileSystem });
  const directory = path.join(cwd, ".firstdraft");
  const planPath = path.join(directory, "foundation-plan.json");
  const statePath = path.join(directory, "state.json");
  const planSource = readLocalFile(planPath, MAX_PLAN_BYTES, fileSystem);
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
    throw new FirstDraftProtocolError(
      "First Draft returned invalid diagnostics.",
      { status: response.status },
    );
  }

  if (response.status !== 200 && response.status !== 201) {
    if (response.ok) {
      throw new FirstDraftProtocolError(
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
    throw new FirstDraftProtocolError(
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
    throw new PlanStateConfigurationError(
      "The configured API URL does not match local state.",
    );
  }

  return stored ?? configuredOrigin ?? DEFAULT_API_URL;
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

/** @param {unknown} value */
function isWarningDiagnostic(value) {
  return isDiagnostic(value) && value.severity === "warning";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
