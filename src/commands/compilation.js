import { createHash } from "node:crypto";

import {
  ARTIFACT_MEDIA_TYPE,
  CompilationArtifactInvalidError,
  CompilationMaterializationError,
  CompilationOutputPathError,
  MAX_ARTIFACT_BYTES,
  materializeCompilationArtifact,
  parseCompilationArtifact,
  resolveOutputTarget,
} from "../compilation-artifact.js";
import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  isProblemBody,
  readResponseBody,
  readResponseBytes,
  responseMediaType,
  sendRequest,
} from "../api-response.js";
import { isUuidV7, readPlanState } from "../plan-state.js";

const REQUEST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const ALL_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const RESPONSE_KEYS = ["project", "compilation"];
const PROJECT_KEYS = ["id", "graph_version"];
const COMPILATION_KEYS = [
  "id",
  "analysis_run_id",
  "graph_version",
  "head_source_sha256",
  "status",
  "compiler_release",
  "target",
  "status_path",
  "cancel_path",
  "artifact",
  "failure",
  "created_at",
  "started_at",
  "completed_at",
];
const TARGET_KEYS = ["id", "profile"];
const ARTIFACT_KEYS = ["path", "sha256", "media_type", "byte_size"];
const FAILURE_KEYS = ["phase", "code", "message"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_FAILURE_MESSAGE_BYTES = 4_096;

export class CompilationNotPushedError extends Error {}

export class CompilationStatusUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   * @param {{transport?: boolean}} [options]
   */
  constructor(status, response = null, options = {}) {
    super("The compilation status is unavailable.");
    this.status = status;
    this.response = response;
    this.transport = options.transport ?? false;
  }
}

export class CompilationStatusInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The compilation status response is invalid.");
    this.status = status;
  }
}

export class CompilationChangedError extends Error {
  /** @param {CompilationResponse} current */
  constructor(current) {
    super("The compilation changed while it was being polled.");
    this.current = current;
  }
}

export class CompilationTimeoutError extends Error {
  /** @param {CompilationResponse} current */
  constructor(current) {
    super("The compilation did not finish before the wait deadline.");
    this.current = current;
  }
}

export class CompilationNotSucceededError extends Error {
  /** @param {CompilationResponse} current */
  constructor(current) {
    super("The compilation has not succeeded.");
    this.current = current;
  }
}

export class CompilationArtifactUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The compilation artifact is unavailable.");
    this.status = status;
    this.response = response;
  }
}

export class CompilationArtifactResponseInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The compilation artifact response is invalid.");
    this.status = status;
  }
}

/**
 * @typedef {object} CompilationResponse
 * @property {{id: string, graph_version: number}} project
 * @property {{
 *   id: string,
 *   analysis_run_id: string,
 *   graph_version: number,
 *   head_source_sha256: string,
 *   status: string,
 *   compiler_release: string,
 *   target: {id: string, profile: string},
 *   status_path: string,
 *   cancel_path: string,
 *   artifact: null | {path: string, sha256: string, media_type: string, byte_size: number},
 *   failure: null | {phase: string, code: string, message: string},
 *   created_at: string,
 *   started_at: string | null,
 *   completed_at: string | null
 * }} compilation
 */

/**
 * @typedef {object} CompilationStatusOptions
 * @property {string} cwd
 * @property {string} compilationId
 * @property {boolean} [wait]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("../plan-state.js").PlanStateFileSystem} [fileSystem]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

/**
 * @param {CompilationStatusOptions} options
 * @returns {Promise<CompilationResponse>}
 */
export async function readCompilation({
  cwd,
  compilationId,
  wait = false,
  fetchFunction = globalThis.fetch,
  fileSystem,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  sleep = sleepFor,
  now = Date.now,
}) {
  const context = readContext({ cwd, compilationId, fileSystem });
  const deadline = wait ? now() + WAIT_TIMEOUT_MS : null;
  /** @type {CompilationResponse | null} */
  let first = null;
  /** @type {CompilationResponse | null} */
  let current = null;

  while (true) {
    if (deadline !== null && current !== null && now() >= deadline) {
      throw new CompilationTimeoutError(current);
    }

    const requestTimeout =
      deadline === null
        ? REQUEST_TIMEOUT_MS
        : Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));
    let next;
    try {
      next = await readCompilationStatus({
        ...context,
        fetchFunction,
        createRequestSignal,
        requestTimeout,
      });
    } catch (error) {
      if (
        error instanceof CompilationStatusUnavailableError &&
        error.transport &&
        deadline !== null &&
        current !== null &&
        now() >= deadline
      ) {
        throw new CompilationTimeoutError(current);
      }
      throw error;
    }

    first ??= next;
    if (!sameCompilation(first, next)) {
      throw new CompilationChangedError(next);
    }
    if (current !== null && !validTransition(current, next)) {
      throw new CompilationChangedError(next);
    }
    current = next;

    if (!wait || TERMINAL_STATUSES.has(current.compilation.status)) {
      return current;
    }

    const remaining = deadline === null ? 0 : deadline - now();
    if (remaining <= 0) throw new CompilationTimeoutError(current);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/**
 * @typedef {object} CompilationDownloadOptions
 * @property {string} cwd
 * @property {string} compilationId
 * @property {string} output
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("../plan-state.js").PlanStateFileSystem} [fileSystem]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 */

/**
 * @param {CompilationDownloadOptions} options
 */
export async function downloadCompilation({
  cwd,
  compilationId,
  output,
  fetchFunction = globalThis.fetch,
  fileSystem,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const context = readContext({ cwd, compilationId, fileSystem });
  const outputTarget = resolveOutputTarget({ cwd, output });
  const current = await readCompilationStatus({
    ...context,
    fetchFunction,
    createRequestSignal,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
  if (current.compilation.status !== "succeeded") {
    throw new CompilationNotSucceededError(current);
  }

  const metadata =
    /** @type {{path: string, sha256: string, media_type: string, byte_size: number}} */ (
      current.compilation.artifact
    );
  const source = await downloadArtifact({
    apiUrl: context.apiUrl,
    metadata,
    fetchFunction,
    createRequestSignal,
  });
  const artifact = parseCompilationArtifact(source, {
    projectId: context.projectId,
    compilationId: current.compilation.id,
    graphVersion: current.compilation.graph_version,
    headSourceSha256: current.compilation.head_source_sha256,
    analysisRunId: current.compilation.analysis_run_id,
    compilerRelease: current.compilation.compiler_release,
    target: current.compilation.target,
  });
  const materialized = materializeCompilationArtifact(artifact, outputTarget);

  return {
    project: current.project,
    compilation: current.compilation,
    output: materialized,
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.compilationId
 * @param {import("../plan-state.js").PlanStateFileSystem | undefined} options.fileSystem
 */
function readContext({ cwd, compilationId, fileSystem }) {
  if (!isUuidV7(compilationId)) {
    throw new TypeError("Compilation ID must be a canonical UUIDv7.");
  }

  const state = readPlanState({ cwd, fileSystem });
  if (state.api_url === undefined) {
    throw new CompilationNotPushedError(
      "The local Foundation Plan has not been pushed.",
    );
  }

  return {
    apiUrl: state.api_url,
    projectId: state.project_id,
    compilationId,
  };
}

/**
 * @param {object} options
 * @param {string} options.apiUrl
 * @param {string} options.projectId
 * @param {string} options.compilationId
 * @param {typeof globalThis.fetch} options.fetchFunction
 * @param {(timeoutMs: number) => AbortSignal} options.createRequestSignal
 * @param {number} options.requestTimeout
 */
async function readCompilationStatus({
  apiUrl,
  projectId,
  compilationId,
  fetchFunction,
  createRequestSignal,
  requestTimeout,
}) {
  const endpoint = new URL(
    `/v1/projects/${projectId}/compilations/${compilationId}`,
    apiUrl,
  );
  let response;
  let body;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      method: "GET",
      headers: { Accept: "application/json, application/problem+json" },
      redirect: "error",
      signal: createRequestSignal(requestTimeout),
    });
    body = await readResponseBody(response);
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new CompilationStatusUnavailableError(error.status, null, {
        transport: true,
      });
    }
    if (error instanceof FirstDraftProtocolError) {
      throw new CompilationStatusInvalidError(error.status);
    }

    throw error;
  }

  if (response.status !== 200) {
    if (!response.ok) {
      throw new CompilationStatusUnavailableError(
        response.status,
        safeProblem(response, body),
      );
    }
    throw new CompilationStatusInvalidError(response.status);
  }

  const parsed = parseCompilationResponse(body, projectId, compilationId);
  if (responseMediaType(response) !== "application/json" || parsed === null) {
    throw new CompilationStatusInvalidError(response.status);
  }

  return parsed;
}

/**
 * @param {object} options
 * @param {string} options.apiUrl
 * @param {{path: string, sha256: string, media_type: string, byte_size: number}} options.metadata
 * @param {typeof globalThis.fetch} options.fetchFunction
 * @param {(timeoutMs: number) => AbortSignal} options.createRequestSignal
 */
async function downloadArtifact({
  apiUrl,
  metadata,
  fetchFunction,
  createRequestSignal,
}) {
  const endpoint = new URL(metadata.path, apiUrl);
  let response;
  let source;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      method: "GET",
      headers: {
        Accept: `${ARTIFACT_MEDIA_TYPE}, application/problem+json`,
      },
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
    source = await readResponseBytes(response, MAX_ARTIFACT_BYTES);
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new CompilationArtifactUnavailableError(error.status);
    }
    if (error instanceof FirstDraftProtocolError) {
      throw new CompilationArtifactResponseInvalidError(error.status);
    }

    throw error;
  }

  if (response.status !== 200) {
    let body = null;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(source),
      );
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) {
        throw error;
      }
    }
    throw new CompilationArtifactUnavailableError(
      response.status,
      safeProblem(response, body),
    );
  }

  const contentLength = response.headers.get("content-length");
  if (
    responseMediaType(response) !== ARTIFACT_MEDIA_TYPE ||
    response.headers.get("cache-control") !== "no-store, no-transform" ||
    response.headers.get("content-encoding") !== null ||
    contentLength === null ||
    contentLength !== String(metadata.byte_size) ||
    source.byteLength !== metadata.byte_size ||
    response.headers.get("etag") !== `"sha256:${metadata.sha256}"` ||
    sha256(source) !== metadata.sha256
  ) {
    throw new CompilationArtifactResponseInvalidError(response.status);
  }

  return source;
}

/**
 * @param {unknown} value
 * @param {string} projectId
 * @param {string} compilationId
 * @returns {CompilationResponse | null}
 */
function parseCompilationResponse(value, projectId, compilationId) {
  if (
    !hasExactKeySet(value, RESPONSE_KEYS) ||
    !hasExactKeySet(value.project, PROJECT_KEYS) ||
    !hasExactKeySet(value.compilation, COMPILATION_KEYS)
  ) {
    return null;
  }

  const project = value.project;
  const compilation = value.compilation;
  if (
    project.id !== projectId ||
    !isGraphVersion(project.graph_version) ||
    compilation.id !== compilationId ||
    !isUuidV7(compilation.id) ||
    !isUuidV7(compilation.analysis_run_id) ||
    !isGraphVersion(compilation.graph_version) ||
    compilation.graph_version !== project.graph_version ||
    typeof compilation.head_source_sha256 !== "string" ||
    !SHA256_PATTERN.test(compilation.head_source_sha256) ||
    typeof compilation.status !== "string" ||
    !ALL_STATUSES.has(compilation.status) ||
    !isRelease(compilation.compiler_release) ||
    !hasExactKeySet(compilation.target, TARGET_KEYS) ||
    !isRelease(compilation.target.id) ||
    !isRelease(compilation.target.profile) ||
    !isCompilationPath(compilation.status_path, projectId, compilation.id) ||
    !isCompilationPath(
      compilation.cancel_path,
      projectId,
      compilation.id,
      "/cancel",
    ) ||
    !isNullableArtifact(compilation.artifact, projectId, compilation.id) ||
    !isNullableFailure(compilation.failure) ||
    !isTimestamp(compilation.created_at) ||
    !isNullableTimestamp(compilation.started_at) ||
    !isNullableTimestamp(compilation.completed_at) ||
    !hasValidStatusFields(compilation)
  ) {
    return null;
  }

  const target = /** @type {{id: string, profile: string}} */ (
    compilation.target
  );
  const artifact =
    /** @type {null | {path: string, sha256: string, media_type: string, byte_size: number}} */ (
      compilation.artifact
    );
  const failure =
    /** @type {null | {phase: string, code: string, message: string}} */ (
      compilation.failure
    );
  return {
    project: { id: project.id, graph_version: project.graph_version },
    compilation: {
      id: compilation.id,
      analysis_run_id: compilation.analysis_run_id,
      graph_version: compilation.graph_version,
      head_source_sha256: /** @type {string} */ (
        compilation.head_source_sha256
      ),
      status: compilation.status,
      compiler_release: /** @type {string} */ (compilation.compiler_release),
      target: {
        id: target.id,
        profile: target.profile,
      },
      status_path: /** @type {string} */ (compilation.status_path),
      cancel_path: /** @type {string} */ (compilation.cancel_path),
      artifact:
        artifact === null
          ? null
          : {
              path: artifact.path,
              sha256: artifact.sha256,
              media_type: artifact.media_type,
              byte_size: artifact.byte_size,
            },
      failure:
        failure === null
          ? null
          : {
              phase: failure.phase,
              code: failure.code,
              message: failure.message,
            },
      created_at: /** @type {string} */ (compilation.created_at),
      started_at: /** @type {string | null} */ (compilation.started_at),
      completed_at: /** @type {string | null} */ (compilation.completed_at),
    },
  };
}

/** @param {Record<string, unknown>} compilation */
function hasValidStatusFields(compilation) {
  const status = compilation.status;
  const terminal = TERMINAL_STATUSES.has(String(status));
  if (
    (status === "queued" && compilation.started_at !== null) ||
    (status === "running" && compilation.started_at === null) ||
    (terminal && compilation.completed_at === null) ||
    (!terminal && compilation.completed_at !== null) ||
    (status === "succeeded" &&
      (compilation.started_at === null ||
        compilation.artifact === null ||
        compilation.failure !== null)) ||
    (status === "failed" &&
      (compilation.started_at === null ||
        compilation.artifact !== null ||
        compilation.failure === null)) ||
    (status === "cancelled" &&
      (compilation.artifact !== null || compilation.failure !== null)) ||
    ((status === "queued" || status === "running") &&
      (compilation.artifact !== null || compilation.failure !== null))
  ) {
    return false;
  }

  const created = timestampMilliseconds(String(compilation.created_at));
  const started =
    compilation.started_at === null
      ? null
      : timestampMilliseconds(String(compilation.started_at));
  const completed =
    compilation.completed_at === null
      ? null
      : timestampMilliseconds(String(compilation.completed_at));
  return (
    (started === null || started >= created) &&
    (completed === null || completed >= created) &&
    (started === null || completed === null || completed >= started)
  );
}

/**
 * @param {unknown} value
 * @param {string} projectId
 * @param {string} compilationId
 */
function isNullableArtifact(value, projectId, compilationId) {
  return (
    value === null ||
    (hasExactKeySet(value, ARTIFACT_KEYS) &&
      isCompilationPath(value.path, projectId, compilationId, "/artifact") &&
      typeof value.sha256 === "string" &&
      SHA256_PATTERN.test(value.sha256) &&
      value.media_type === ARTIFACT_MEDIA_TYPE &&
      Number.isSafeInteger(value.byte_size) &&
      Number(value.byte_size) >= 0 &&
      Number(value.byte_size) <= MAX_ARTIFACT_BYTES)
  );
}

/** @param {unknown} value */
function isNullableFailure(value) {
  return (
    value === null ||
    (hasExactKeySet(value, FAILURE_KEYS) &&
      isRelease(value.phase) &&
      isRelease(value.code) &&
      typeof value.message === "string" &&
      Buffer.byteLength(value.message) > 0 &&
      Buffer.byteLength(value.message) <= MAX_FAILURE_MESSAGE_BYTES)
  );
}

/**
 * @param {unknown} value
 * @param {string} projectId
 * @param {string} compilationId
 * @param {string} [suffix]
 */
function isCompilationPath(value, projectId, compilationId, suffix = "") {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return false;
  }

  const parsed = new URL(value, "https://firstdraft.invalid");
  const expected = `/v1/projects/${projectId}/compilations/${compilationId}${suffix}`;
  return (
    parsed.origin === "https://firstdraft.invalid" &&
    parsed.pathname === value &&
    parsed.search === "" &&
    parsed.hash === "" &&
    value === expected
  );
}

/** @param {CompilationResponse} first @param {CompilationResponse} current */
function sameCompilation(first, current) {
  return (
    current.project.id === first.project.id &&
    current.project.graph_version === first.project.graph_version &&
    current.compilation.id === first.compilation.id &&
    current.compilation.analysis_run_id === first.compilation.analysis_run_id &&
    current.compilation.graph_version === first.compilation.graph_version &&
    current.compilation.head_source_sha256 ===
      first.compilation.head_source_sha256 &&
    current.compilation.compiler_release ===
      first.compilation.compiler_release &&
    current.compilation.target.id === first.compilation.target.id &&
    current.compilation.target.profile === first.compilation.target.profile &&
    current.compilation.status_path === first.compilation.status_path &&
    current.compilation.cancel_path === first.compilation.cancel_path &&
    current.compilation.created_at === first.compilation.created_at
  );
}

/** @param {CompilationResponse} previous @param {CompilationResponse} current */
function validTransition(previous, current) {
  const from = previous.compilation.status;
  const to = current.compilation.status;
  if (from === to) {
    return (
      current.compilation.started_at === previous.compilation.started_at &&
      current.compilation.completed_at === previous.compilation.completed_at &&
      JSON.stringify(current.compilation.artifact) ===
        JSON.stringify(previous.compilation.artifact) &&
      JSON.stringify(current.compilation.failure) ===
        JSON.stringify(previous.compilation.failure)
    );
  }

  if (from === "queued") {
    return (
      to === "running" ||
      to === "succeeded" ||
      to === "failed" ||
      to === "cancelled"
    );
  }
  return (
    from === "running" &&
    (to === "succeeded" || to === "failed" || to === "cancelled") &&
    current.compilation.started_at === previous.compilation.started_at
  );
}

/** @param {Response} response @param {unknown} body */
function safeProblem(response, body) {
  if (!isRecord(body) || !isProblemBody(response, body)) return null;

  return {
    ...(body.type === "about:blank" ? { type: body.type } : {}),
    title: body.title,
    status: body.status,
    code: body.code,
    detail: body.detail,
  };
}

/** @param {number} delayMs */
function sleepFor(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value @returns {value is string} */
function isRelease(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES &&
    RELEASE_PATTERN.test(value)
  );
}

/** @param {unknown} value @returns {value is number} */
function isGraphVersion(value) {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

/** @param {unknown} value @returns {value is string | null} */
function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

/** @param {unknown} value @returns {value is string} */
function isTimestamp(value) {
  return timestampParts(value) !== null;
}

/** @param {string} value */
function timestampMilliseconds(value) {
  return Date.parse(value);
}

/** @param {unknown} value */
function timestampParts(value) {
  if (typeof value !== "string") return null;

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  return true;
}

/** @param {number} year @param {number} month */
function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function hasExactKeySet(value, keys) {
  return (
    isRecord(value) && arraysEqual(Object.keys(value).sort(), [...keys].sort())
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown[]} left @param {unknown[]} right */
function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export {
  CompilationArtifactInvalidError,
  CompilationMaterializationError,
  CompilationOutputPathError,
};
