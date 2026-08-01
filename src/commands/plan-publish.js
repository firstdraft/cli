import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { isAuthenticationProblem } from "../api-authentication.js";
import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  isProblemBody,
  readResponseBody,
  responseMediaType,
  sendRequest,
} from "../api-response.js";
import { isUuidV7, readLocalFile, readPlanState } from "../plan-state.js";

const MAX_PLAN_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_REPOSITORY_NAME_BYTES = 100;
const MAX_LOGIN_BYTES = 39;
const MAX_FAILURE_CODE_BYTES = 256;
const HEAD_ETAG_PATTERN = /^"sha256:([0-9a-f]{64})"$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const COMPILATION_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const PUBLICATION_STATUSES = new Set([
  "compiling",
  "provisioning_repository",
  "repository_unknown",
  "publishing",
  "publication_unknown",
  "succeeded",
  "repository_conflict",
  "failed",
  "cancelled",
]);
const TERMINAL_PUBLICATION_STATUSES = new Set([
  "succeeded",
  "repository_conflict",
  "failed",
  "cancelled",
]);
const RESPONSE_KEYS = ["compilation", "project", "publication"];
const PROJECT_KEYS = ["graph_version", "head_source_sha256", "id"];
const COMPILATION_KEYS = [
  "analysis_run_id",
  "artifact",
  "compiler_release",
  "graph_version",
  "head_source_sha256",
  "id",
  "status",
  "target",
];
const TARGET_KEYS = ["id", "profile"];
const ARTIFACT_KEYS = ["file_count", "manifest_sha256", "sha256"];
const PUBLICATION_KEYS = [
  "completed_at",
  "created_at",
  "failure",
  "id",
  "repository",
  "started_at",
  "status",
];
const FAILURE_KEYS = ["code", "phase"];
const REPOSITORY_KEYS = [
  "commit_sha",
  "default_branch",
  "full_name",
  "html_url",
  "id",
  "owner",
  "private",
  "tree_sha",
];
const OWNER_KEYS = ["id", "login", "type"];

/**
 * @typedef {object} PlanPublishFileSystem
 * @property {typeof lstatSync} lstatSync
 * @property {typeof readFileSync} readFileSync
 */

/** @type {PlanPublishFileSystem} */
const DEFAULT_FILE_SYSTEM = { lstatSync, readFileSync };

export class PublicationNotPushedError extends Error {}
export class PublicationLocalStateError extends Error {}
export class PublicationLocalPlanChangedError extends Error {}

export class PublicationRequestOutcomeUnknownError extends Error {
  /** @param {number | undefined} status */
  constructor(status) {
    super("The publication request outcome is unknown.");
    this.status = status;
  }
}

export class PublicationStartRejectedError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} response
   */
  constructor(status, response) {
    super("First Draft rejected the publication request.");
    this.status = status;
    this.response = response;
  }
}

export class PublicationStatusUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The publication status is unavailable.");
    this.status = status;
    this.response = response;
  }
}

export class PublicationStatusInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The publication status response is invalid.");
    this.status = status;
  }
}

export class PublicationChangedError extends Error {
  /** @param {PublicationResponse} current */
  constructor(current) {
    super("The pinned publication changed while it was being polled.");
    this.current = current;
  }
}

export class PublicationTimeoutError extends Error {
  /** @param {PublicationResponse} current */
  constructor(current) {
    super("The publication did not finish before the wait deadline.");
    this.current = current;
  }
}

export class PublicationFailedError extends Error {
  /** @param {PublicationResponse} current */
  constructor(current) {
    super("The publication failed.");
    this.current = current;
  }
}

export class PublicationCancelledError extends Error {
  /** @param {PublicationResponse} current */
  constructor(current) {
    super("The publication was cancelled.");
    this.current = current;
  }
}

/**
 * @typedef {object} PublicationResponse
 * @property {{id: string, graph_version: number, head_source_sha256: string}} project
 * @property {{id: string, analysis_run_id: string, graph_version: number, head_source_sha256: string, status: string, compiler_release: string, target: {id: string, profile: string}, artifact: null | {sha256: string, manifest_sha256: string, file_count: number}}} compilation
 * @property {{id: string, status: string, repository: null | {id: number, private: true, owner: {id: number, login: string, type: "User"}, full_name: string, default_branch: string, html_url: string, tree_sha: string | null, commit_sha: string | null}, failure: null | {phase: string, code: string}, created_at: string, started_at: string | null, completed_at: string | null}} publication
 */

/**
 * @typedef {object} PublishPlanOptions
 * @property {string} cwd
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {PlanPublishFileSystem} [fileSystem]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

/**
 * @param {PublishPlanOptions} options
 * @returns {Promise<PublicationResponse>}
 */
export async function publishPlan({
  cwd,
  fetchFunction = globalThis.fetch,
  fileSystem = DEFAULT_FILE_SYSTEM,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  sleep = sleepFor,
  now = Date.now,
}) {
  const state = readPlanState({ cwd, fileSystem });
  if (state.api_url === undefined || state.foundation_plan_etag === undefined) {
    throw new PublicationNotPushedError(
      "The local Foundation Plan has not been pushed.",
    );
  }

  const match = HEAD_ETAG_PATTERN.exec(state.foundation_plan_etag);
  if (match === null) {
    throw new PublicationLocalStateError(
      "The saved Foundation Plan ETag cannot identify its accepted source.",
    );
  }
  const headSourceSha256 = match[1] ?? "";
  const planSource = readLocalFile(
    path.join(cwd, ".firstdraft", "foundation-plan.json"),
    MAX_PLAN_BYTES,
    fileSystem,
  );
  if (sha256(planSource) !== headSourceSha256) {
    throw new PublicationLocalPlanChangedError(
      "The local Foundation Plan differs from the accepted Plan.",
    );
  }

  const endpoint = new URL(
    `/v1/projects/${state.project_id}/github-publication`,
    state.api_url,
  );
  const deadline = now() + WAIT_TIMEOUT_MS;
  let initial;

  try {
    initial = await startPublication({
      endpoint,
      projectId: state.project_id,
      headSourceSha256,
      etag: state.foundation_plan_etag,
      fetchFunction,
      createRequestSignal,
    });
  } catch (error) {
    if (!(error instanceof PublicationRequestOutcomeUnknownError)) throw error;

    try {
      initial = await readPublicationStatus({
        endpoint,
        projectId: state.project_id,
        headSourceSha256,
        fetchFunction,
        createRequestSignal,
        requestTimeout: Math.max(
          1,
          Math.min(REQUEST_TIMEOUT_MS, deadline - now()),
        ),
      });
    } catch (reconciliationError) {
      if (
        reconciliationError instanceof PublicationStatusUnavailableError &&
        isAuthenticationProblem(
          reconciliationError.status,
          reconciliationError.response,
        )
      ) {
        throw reconciliationError;
      }
      if (
        reconciliationError instanceof PublicationStatusUnavailableError ||
        reconciliationError instanceof PublicationStatusInvalidError
      ) {
        throw new PublicationRequestOutcomeUnknownError(
          reconciliationError.status ?? error.status,
        );
      }

      throw reconciliationError;
    }
  }

  let current = initial;
  while (!TERMINAL_PUBLICATION_STATUSES.has(current.publication.status)) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new PublicationTimeoutError(current);

    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    if (now() >= deadline) throw new PublicationTimeoutError(current);

    const next = await readPublicationStatus({
      endpoint,
      projectId: state.project_id,
      headSourceSha256,
      fetchFunction,
      createRequestSignal,
      requestTimeout: Math.max(
        1,
        Math.min(REQUEST_TIMEOUT_MS, deadline - now()),
      ),
    });
    if (!samePublication(initial, next) || !validTransition(current, next)) {
      throw new PublicationChangedError(next);
    }
    current = next;
  }

  if (
    current.publication.status === "failed" ||
    current.publication.status === "repository_conflict"
  ) {
    throw new PublicationFailedError(current);
  }
  if (current.publication.status === "cancelled") {
    throw new PublicationCancelledError(current);
  }

  return current;
}

/**
 * @param {object} options
 * @param {URL} options.endpoint
 * @param {string} options.projectId
 * @param {string} options.headSourceSha256
 * @param {string} options.etag
 * @param {typeof globalThis.fetch} options.fetchFunction
 * @param {(timeoutMs: number) => AbortSignal} options.createRequestSignal
 */
async function startPublication({
  endpoint,
  projectId,
  headSourceSha256,
  etag,
  fetchFunction,
  createRequestSignal,
}) {
  let response;
  let body;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      method: "PUT",
      headers: {
        Accept: "application/json, application/problem+json",
        "If-Match": etag,
      },
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
    body = await readResponseBody(response);
  } catch (error) {
    if (
      error instanceof FirstDraftNetworkError ||
      error instanceof FirstDraftProtocolError
    ) {
      throw new PublicationRequestOutcomeUnknownError(error.status);
    }

    throw error;
  }

  if (response.status !== 200 && response.status !== 201) {
    const problem = safeProblem(response, body);
    if (response.ok || problem === null) {
      throw new PublicationRequestOutcomeUnknownError(response.status);
    }

    throw new PublicationStartRejectedError(response.status, problem);
  }

  const parsed = parsePublicationResponse(body, projectId, headSourceSha256);
  if (responseMediaType(response) !== "application/json" || parsed === null) {
    throw new PublicationRequestOutcomeUnknownError(response.status);
  }

  return parsed;
}

/**
 * @param {object} options
 * @param {URL} options.endpoint
 * @param {string} options.projectId
 * @param {string} options.headSourceSha256
 * @param {typeof globalThis.fetch} options.fetchFunction
 * @param {(timeoutMs: number) => AbortSignal} options.createRequestSignal
 * @param {number} options.requestTimeout
 */
async function readPublicationStatus({
  endpoint,
  projectId,
  headSourceSha256,
  fetchFunction,
  createRequestSignal,
  requestTimeout,
}) {
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
      throw new PublicationStatusUnavailableError(error.status);
    }
    if (error instanceof FirstDraftProtocolError) {
      throw new PublicationStatusInvalidError(error.status);
    }

    throw error;
  }

  if (response.status !== 200) {
    if (!response.ok) {
      throw new PublicationStatusUnavailableError(
        response.status,
        safeProblem(response, body),
      );
    }
    throw new PublicationStatusInvalidError(response.status);
  }

  const parsed = parsePublicationResponse(body, projectId, headSourceSha256);
  if (responseMediaType(response) !== "application/json" || parsed === null) {
    throw new PublicationStatusInvalidError(response.status);
  }

  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} projectId
 * @param {string} headSourceSha256
 * @returns {PublicationResponse | null}
 */
function parsePublicationResponse(value, projectId, headSourceSha256) {
  if (
    !hasExactKeySet(value, RESPONSE_KEYS) ||
    !hasExactKeySet(value.project, PROJECT_KEYS) ||
    !hasExactKeySet(value.compilation, COMPILATION_KEYS) ||
    !hasExactKeySet(value.publication, PUBLICATION_KEYS)
  ) {
    return null;
  }

  const project = value.project;
  const compilation = value.compilation;
  const publication = value.publication;
  if (
    project.id !== projectId ||
    !isGraphVersion(project.graph_version) ||
    project.head_source_sha256 !== headSourceSha256 ||
    !isUuidV7(compilation.id) ||
    !isUuidV7(compilation.analysis_run_id) ||
    compilation.graph_version !== project.graph_version ||
    compilation.head_source_sha256 !== headSourceSha256 ||
    typeof compilation.status !== "string" ||
    !COMPILATION_STATUSES.has(compilation.status) ||
    !isRelease(compilation.compiler_release) ||
    !hasExactKeySet(compilation.target, TARGET_KEYS) ||
    !isRelease(compilation.target.id) ||
    !isRelease(compilation.target.profile) ||
    !isNullableArtifact(compilation.artifact) ||
    !isUuidV7(publication.id) ||
    typeof publication.status !== "string" ||
    !PUBLICATION_STATUSES.has(publication.status) ||
    !isNullableRepository(publication.repository) ||
    !isNullableFailure(publication.failure) ||
    !isTimestamp(publication.created_at) ||
    !isNullableTimestamp(publication.started_at) ||
    !isNullableTimestamp(publication.completed_at) ||
    !hasValidCompilationShape(compilation) ||
    !hasValidPublicationShape(compilation, publication)
  ) {
    return null;
  }

  const target = /** @type {{id: string, profile: string}} */ (
    compilation.target
  );
  const artifact =
    /** @type {null | {sha256: string, manifest_sha256: string, file_count: number}} */ (
      compilation.artifact
    );
  const repository =
    /** @type {null | {id: number, private: true, owner: {id: number, login: string, type: "User"}, full_name: string, default_branch: string, html_url: string, tree_sha: string | null, commit_sha: string | null}} */ (
      publication.repository
    );
  const failure = /** @type {null | {phase: string, code: string}} */ (
    publication.failure
  );

  return {
    project: {
      id: project.id,
      graph_version: /** @type {number} */ (project.graph_version),
      head_source_sha256: project.head_source_sha256,
    },
    compilation: {
      id: compilation.id,
      analysis_run_id: compilation.analysis_run_id,
      graph_version: /** @type {number} */ (compilation.graph_version),
      head_source_sha256: compilation.head_source_sha256,
      status: compilation.status,
      compiler_release: /** @type {string} */ (compilation.compiler_release),
      target: { id: target.id, profile: target.profile },
      artifact:
        artifact === null
          ? null
          : {
              sha256: artifact.sha256,
              manifest_sha256: artifact.manifest_sha256,
              file_count: artifact.file_count,
            },
    },
    publication: {
      id: publication.id,
      status: publication.status,
      repository:
        repository === null
          ? null
          : {
              id: repository.id,
              private: true,
              owner: {
                id: repository.owner.id,
                login: repository.owner.login,
                type: "User",
              },
              full_name: repository.full_name,
              default_branch: repository.default_branch,
              html_url: repository.html_url,
              tree_sha: repository.tree_sha,
              commit_sha: repository.commit_sha,
            },
      failure:
        failure === null ? null : { phase: failure.phase, code: failure.code },
      created_at: /** @type {string} */ (publication.created_at),
      started_at: /** @type {string | null} */ (publication.started_at),
      completed_at: /** @type {string | null} */ (publication.completed_at),
    },
  };
}

/** @param {Record<string, unknown>} compilation */
function hasValidCompilationShape(compilation) {
  return compilation.status === "succeeded"
    ? compilation.artifact !== null
    : compilation.artifact === null;
}

/**
 * @param {Record<string, unknown>} compilation
 * @param {Record<string, unknown>} publication
 */
function hasValidPublicationShape(compilation, publication) {
  const status = String(publication.status);
  const terminal = TERMINAL_PUBLICATION_STATUSES.has(status);
  const failureExpected =
    status === "failed" || status === "repository_conflict";
  const created = timestampMilliseconds(String(publication.created_at));
  const started =
    publication.started_at === null
      ? null
      : timestampMilliseconds(String(publication.started_at));
  const completed =
    publication.completed_at === null
      ? null
      : timestampMilliseconds(String(publication.completed_at));
  const repository = /** @type {Record<string, unknown> | null} */ (
    publication.repository
  );

  if (
    (terminal && completed === null) ||
    (!terminal && completed !== null) ||
    (failureExpected && publication.failure === null) ||
    (!failureExpected && publication.failure !== null) ||
    (status !== "compiling" &&
      started === null &&
      !(
        (status === "failed" && compilation.status === "failed") ||
        (status === "cancelled" && compilation.status === "cancelled")
      )) ||
    (started !== null && started < created) ||
    (completed !== null && completed < created) ||
    (started !== null && completed !== null && completed < started) ||
    (status === "compiling" &&
      !["queued", "running", "succeeded"].includes(
        String(compilation.status),
      )) ||
    (status === "failed" &&
      !["failed", "succeeded"].includes(String(compilation.status))) ||
    (status === "cancelled" &&
      !["cancelled", "succeeded"].includes(String(compilation.status))) ||
    (!["compiling", "failed", "cancelled"].includes(status) &&
      compilation.status !== "succeeded") ||
    (["publishing", "publication_unknown", "succeeded"].includes(status) &&
      repository === null)
  ) {
    return false;
  }

  if (status !== "succeeded") return true;

  return (
    repository !== null &&
    typeof repository.tree_sha === "string" &&
    typeof repository.commit_sha === "string"
  );
}

/** @param {unknown} value */
function isNullableArtifact(value) {
  return (
    value === null ||
    (hasExactKeySet(value, ARTIFACT_KEYS) &&
      typeof value.sha256 === "string" &&
      SHA256_PATTERN.test(value.sha256) &&
      typeof value.manifest_sha256 === "string" &&
      SHA256_PATTERN.test(value.manifest_sha256) &&
      Number.isSafeInteger(value.file_count) &&
      Number(value.file_count) >= 0)
  );
}

/** @param {unknown} value */
function isNullableFailure(value) {
  return (
    value === null ||
    (hasExactKeySet(value, FAILURE_KEYS) &&
      isRelease(value.phase) &&
      isFailureCode(value.code))
  );
}

/** @param {unknown} value */
function isNullableRepository(value) {
  if (value === null) return true;
  if (
    !hasExactKeySet(value, REPOSITORY_KEYS) ||
    !isPositiveInteger(value.id) ||
    value.private !== true ||
    !hasExactKeySet(value.owner, OWNER_KEYS) ||
    !isPositiveInteger(value.owner.id) ||
    value.owner.type !== "User" ||
    !isGithubName(value.owner.login, MAX_LOGIN_BYTES) ||
    typeof value.full_name !== "string" ||
    typeof value.default_branch !== "string" ||
    typeof value.html_url !== "string" ||
    !isNullableGitSha(value.tree_sha) ||
    !isNullableGitSha(value.commit_sha) ||
    (value.tree_sha === null) !== (value.commit_sha === null)
  ) {
    return false;
  }

  const prefix = `${value.owner.login}/`;
  const repositoryName = value.full_name.startsWith(prefix)
    ? value.full_name.slice(prefix.length)
    : "";
  return (
    isGithubName(repositoryName, MAX_REPOSITORY_NAME_BYTES) &&
    isGitBranch(value.default_branch) &&
    value.html_url === `https://github.com/${value.full_name}`
  );
}

/** @param {PublicationResponse} first @param {PublicationResponse} current */
function samePublication(first, current) {
  return (
    current.project.id === first.project.id &&
    current.project.graph_version === first.project.graph_version &&
    current.project.head_source_sha256 === first.project.head_source_sha256 &&
    current.compilation.id === first.compilation.id &&
    current.compilation.analysis_run_id === first.compilation.analysis_run_id &&
    current.compilation.graph_version === first.compilation.graph_version &&
    current.compilation.head_source_sha256 ===
      first.compilation.head_source_sha256 &&
    current.compilation.compiler_release ===
      first.compilation.compiler_release &&
    current.compilation.target.id === first.compilation.target.id &&
    current.compilation.target.profile === first.compilation.target.profile &&
    current.publication.id === first.publication.id &&
    current.publication.created_at === first.publication.created_at
  );
}

/** @param {PublicationResponse} previous @param {PublicationResponse} current */
function validTransition(previous, current) {
  if (!validCompilationTransition(previous.compilation, current.compilation)) {
    return false;
  }
  if (!validPublicationStatusTransition(previous, current)) return false;
  if (!validRepositoryTransition(previous, current)) return false;

  return (
    (previous.publication.started_at === null ||
      current.publication.started_at === previous.publication.started_at) &&
    (previous.publication.completed_at === null ||
      current.publication.completed_at === previous.publication.completed_at) &&
    (previous.publication.failure === null ||
      JSON.stringify(current.publication.failure) ===
        JSON.stringify(previous.publication.failure))
  );
}

/**
 * @param {PublicationResponse["compilation"]} previous
 * @param {PublicationResponse["compilation"]} current
 */
function validCompilationTransition(previous, current) {
  if (previous.status === current.status) {
    return (
      JSON.stringify(previous.artifact) === JSON.stringify(current.artifact)
    );
  }

  if (previous.status === "queued") {
    return ["running", "succeeded", "failed", "cancelled"].includes(
      current.status,
    );
  }
  return (
    previous.status === "running" &&
    ["succeeded", "failed", "cancelled"].includes(current.status)
  );
}

/** @param {PublicationResponse} previous @param {PublicationResponse} current */
function validPublicationStatusTransition(previous, current) {
  const from = previous.publication.status;
  const to = current.publication.status;
  if (from === to) {
    return (
      current.publication.started_at === previous.publication.started_at &&
      current.publication.completed_at === previous.publication.completed_at &&
      JSON.stringify(current.publication.failure) ===
        JSON.stringify(previous.publication.failure)
    );
  }

  return publicationStage(to) >= publicationStage(from);
}

/** @param {string} status */
function publicationStage(status) {
  if (status === "compiling") return 0;
  if (status === "provisioning_repository" || status === "repository_unknown") {
    return 1;
  }
  if (status === "publishing" || status === "publication_unknown") return 2;
  return 3;
}

/** @param {PublicationResponse} previous @param {PublicationResponse} current */
function validRepositoryTransition(previous, current) {
  const before = previous.publication.repository;
  const after = current.publication.repository;
  if (before === null) return true;
  if (after === null) return false;

  return (
    after.id === before.id &&
    after.private === before.private &&
    after.owner.id === before.owner.id &&
    after.owner.login === before.owner.login &&
    after.owner.type === before.owner.type &&
    after.full_name === before.full_name &&
    after.default_branch === before.default_branch &&
    after.html_url === before.html_url &&
    (before.tree_sha === null || after.tree_sha === before.tree_sha) &&
    (before.commit_sha === null || after.commit_sha === before.commit_sha)
  );
}

/** @param {Response} response @param {unknown} body */
function safeProblem(response, body) {
  if (!isProblemBody(response, body)) return null;
  const problem = /** @type {Record<string, unknown>} */ (body);

  return {
    ...(problem.type === "about:blank" ? { type: problem.type } : {}),
    title: problem.title,
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
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

/** @param {unknown} value */
function isRelease(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES &&
    RELEASE_PATTERN.test(value)
  );
}

/** @param {unknown} value */
function isFailureCode(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_FAILURE_CODE_BYTES &&
    RELEASE_PATTERN.test(value)
  );
}

/** @param {unknown} value */
function isGraphVersion(value) {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

/** @param {unknown} value */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** @param {unknown} value */
function isNullableGitSha(value) {
  return (
    value === null || (typeof value === "string" && GIT_SHA_PATTERN.test(value))
  );
}

/** @param {unknown} value @param {number} maximumBytes */
function isGithubName(value, maximumBytes) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= maximumBytes &&
    GITHUB_NAME_PATTERN.test(value)
  );
}

/** @param {unknown} value */
function isGitBranch(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES &&
    value.length > 0 &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//") &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || "~^:?*[\\".includes(character);
    })
  );
}

/** @param {unknown} value */
function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

/** @param {unknown} value */
function isTimestamp(value) {
  return timestampParts(value) !== null;
}

/** @param {string} value */
function timestampMilliseconds(value) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;

  return Date.parse(value.replace(/:60(?=[.,Zz+-])/, ":59")) + 1_000;
}

/** @param {unknown} value */
function timestampParts(value) {
  if (typeof value !== "string") return null;

  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    (second === 60 && (hour !== 23 || minute !== 59)) ||
    offsetHour > 23 ||
    offsetMinute > 59
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
