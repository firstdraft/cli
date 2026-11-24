import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  SERVICE_ROUTES,
  isProblemBody,
  readResponseBody,
  responseMediaType,
  sendRequest,
  serviceEndpoint,
} from "../api-response.js";
import { readPinnedOrApplicationProject } from "../plan-state.js";

const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_ENVIRONMENT = "production";
export const RESOLUTION_REASONS = Object.freeze([
  "pull_request",
  "host_change",
  "not_a_bug",
  "duplicate",
  "stopped_occurring",
]);
// What caused the error: code First Draft generated, code written since,
// configuration or the host, data, a dependency, nothing wrong, or unknown
// when the agent looked and could not tell.
export const RESOLUTION_CAUSES = Object.freeze([
  "generated_code",
  "later_code",
  "configuration_or_host",
  "data",
  "dependency",
  "not_a_bug",
  "unknown",
]);
// The Service's Project::Environment::NAME_PATTERN. Checking it locally also
// keeps a name from adding path segments to the request URL.
const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
// Item IDs are UUIDs of any version, unlike the UUIDv7 Project IDs.
const ITEM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The Service's Project::Environment::Item::GITHUB_ISSUE_URL.
const GITHUB_ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/issues\/[1-9][0-9]{0,9}$/;
const KINDS = new Set(["agent_fixable"]);
const SEVERITIES = new Set(["fatal", "error", "warning", "info", "debug"]);
const ENVIRONMENT_KEYS = ["project_id", "name"];
const INDEX_KEYS = ["environment", "items", "next_page"];
const ITEM_RESPONSE_KEYS = ["environment", "item"];
const SUMMARY_KEYS = [
  "id",
  "kind",
  "severity",
  "title",
  "occurrences",
  "first_seen_at",
  "last_seen_at",
  "last_release",
  "status",
  "resolution_reason",
  "resolution_cause",
  "issue_url",
];
const DETAIL_KEYS = [...SUMMARY_KEYS, "evidence", "done_when"];
const EVIDENCE_KEYS = [
  "occurred_at",
  "release",
  "exceptions",
  "request",
  "untrusted",
  "note",
];
const EXCEPTION_KEYS = ["type", "message", "frames"];
const FRAME_KEYS = ["file", "line", "function"];
const REQUEST_KEYS = ["method", "host", "path"];
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

export class MaintainRejectedError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} response
   */
  constructor(status, response) {
    super("First Draft rejected the maintenance request.");
    this.status = status;
    this.response = response;
  }
}

export class MaintainUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The maintenance request could not be completed.");
    this.status = status;
    this.response = response;
  }
}

export class MaintainResponseInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The maintenance response is invalid.");
    this.status = status;
  }
}

/** @param {unknown} value @returns {value is string} */
export function isEnvironmentName(value) {
  return typeof value === "string" && ENVIRONMENT_NAME_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isItemId(value) {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isResolutionReason(value) {
  return (
    typeof value === "string" &&
    /** @type {readonly string[]} */ (RESOLUTION_REASONS).includes(value)
  );
}

/** @param {unknown} value @returns {value is string} */
export function isResolutionCause(value) {
  return (
    typeof value === "string" &&
    /** @type {readonly string[]} */ (RESOLUTION_CAUSES).includes(value)
  );
}

/**
 * The Project and origin every maintain request uses, read once per command:
 * the Project's state, in `cwd` or in an adopted application's archive at
 * .firstdraft/design, or else the Project the application's own
 * .firstdraft/gaps.json names, at the origin `login` would select.
 *
 * @param {{cwd: string, fileSystem?: import("../plan-state.js").PlanStateFileSystem, selectOrigin: () => string}} options
 * @returns {MaintainContext}
 */
export function readMaintainContext({ cwd, fileSystem, selectOrigin }) {
  const { apiUrl, projectId, fromApplication } = readPinnedOrApplicationProject(
    { cwd, fileSystem, selectOrigin },
  );
  return { apiUrl, projectId, fromApplication };
}

/**
 * @typedef {object} MaintainContext
 * @property {string} apiUrl
 * @property {string} projectId
 * @property {boolean} fromApplication true when the Project came from the
 *   application's files, so the origin is not pinned
 */

/**
 * @typedef {object} MaintainRequestOptions
 * @property {MaintainContext} context
 * @property {string} environment
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 */

/**
 * Read one page of an Environment's open items, most severe first.
 *
 * @param {MaintainRequestOptions & {page: number}} options
 */
export async function listMaintenanceItems({
  context,
  environment,
  page,
  fetchFunction = globalThis.fetch,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const { apiUrl, projectId } = context;
  const endpoint = serviceEndpoint(
    SERVICE_ROUTES.listMaintenanceItems,
    apiUrl,
    {
      project_id: projectId,
      environment_name: environment,
    },
  );
  endpoint.url.searchParams.set("page", String(page));
  const { status, body } = await request(fetchFunction, endpoint, {
    createRequestSignal,
  });

  if (
    !hasExactKeys(body, INDEX_KEYS) ||
    !isEnvironment(body.environment, projectId, environment) ||
    !Array.isArray(body.items) ||
    !body.items.every((item) => isSummary(item) && item.status === "open") ||
    !(
      body.next_page === null ||
      (Number.isSafeInteger(body.next_page) && Number(body.next_page) > page)
    )
  ) {
    throw new MaintainResponseInvalidError(status);
  }

  return {
    environment: copyEnvironment(body.environment),
    items: body.items.map(copySummary),
    next_page: body.next_page,
  };
}

/**
 * Read one item with its latest evidence and what done means.
 *
 * @param {MaintainRequestOptions & {itemId: string}} options
 */
export async function showMaintenanceItem({
  context,
  environment,
  itemId,
  fetchFunction = globalThis.fetch,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const { apiUrl, projectId } = context;
  const endpoint = serviceEndpoint(SERVICE_ROUTES.readMaintenanceItem, apiUrl, {
    project_id: projectId,
    environment_name: environment,
    item_id: itemId,
  });
  const { status, body } = await request(fetchFunction, endpoint, {
    createRequestSignal,
  });
  const item = isRecord(body) ? body.item : null;

  if (
    !hasExactKeys(body, ITEM_RESPONSE_KEYS) ||
    !isEnvironment(body.environment, projectId, environment) ||
    !hasExactKeys(item, DETAIL_KEYS) ||
    !isSummary(pick(item, SUMMARY_KEYS)) ||
    item.id !== itemId ||
    !(item.evidence === null || isEvidence(item.evidence)) ||
    typeof item.done_when !== "string"
  ) {
    throw new MaintainResponseInvalidError(status);
  }

  return {
    environment: copyEnvironment(body.environment),
    item: {
      ...copySummary(item),
      evidence: item.evidence === null ? null : copyEvidence(item.evidence),
      done_when: item.done_when,
    },
  };
}

/**
 * Resolve one open item. The Service refuses to resolve an item that is still
 * resolved, but a recurrence reopens it, so an unconfirmed outcome must be
 * checked with `maintain show` before resolving again.
 *
 * @param {MaintainRequestOptions & {itemId: string, reason: string, cause: string, detail?: string}} options
 */
export async function resolveMaintenanceItem({
  context,
  environment,
  itemId,
  reason,
  cause,
  detail,
  fetchFunction = globalThis.fetch,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const { apiUrl, projectId } = context;
  const endpoint = serviceEndpoint(
    SERVICE_ROUTES.resolveMaintenanceItem,
    apiUrl,
    {
      project_id: projectId,
      environment_name: environment,
      item_id: itemId,
    },
  );
  const { status, body } = await request(fetchFunction, endpoint, {
    createRequestSignal,
    json: { reason, cause, ...(detail === undefined ? {} : { detail }) },
  });
  const item = isRecord(body) ? body.item : null;

  if (
    !hasExactKeys(body, ITEM_RESPONSE_KEYS) ||
    !isEnvironment(body.environment, projectId, environment) ||
    !isSummary(item) ||
    item.id !== itemId ||
    item.status !== "resolved" ||
    item.resolution_reason !== reason ||
    item.resolution_cause !== cause
  ) {
    throw new MaintainResponseInvalidError(status);
  }

  return {
    environment: copyEnvironment(body.environment),
    item: copySummary(item),
  };
}

/**
 * @param {typeof globalThis.fetch} fetchFunction
 * @param {import("../api-response.js").ServiceEndpoint} endpoint
 * @param {{createRequestSignal: (timeoutMs: number) => AbortSignal, json?: Record<string, string>}} options
 */
async function request(fetchFunction, endpoint, { createRequestSignal, json }) {
  let response;
  let body;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      headers: {
        Accept: "application/json, application/problem+json",
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
    body = await readResponseBody(response);
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new MaintainUnavailableError(error.status);
    }
    // Only an oversized success breaks the contract; an oversized error body
    // is as unconfirmed as any other failed response.
    if (error instanceof FirstDraftProtocolError) {
      throw error.status >= 200 && error.status < 300
        ? new MaintainResponseInvalidError(error.status)
        : new MaintainUnavailableError(error.status);
    }

    throw error;
  }

  if (response.status !== 200) {
    if (response.ok) throw new MaintainResponseInvalidError(response.status);

    const problem = safeProblem(response, body);
    if (problem !== null && response.status !== 408 && response.status < 500) {
      throw new MaintainRejectedError(response.status, problem);
    }
    throw new MaintainUnavailableError(response.status, problem);
  }

  if (responseMediaType(response) !== "application/json") {
    throw new MaintainResponseInvalidError(response.status);
  }

  return { status: response.status, body };
}

/**
 * @param {unknown} value
 * @param {string} projectId
 * @param {string} name
 * @returns {value is Record<string, unknown>}
 */
function isEnvironment(value, projectId, name) {
  return (
    hasExactKeys(value, ENVIRONMENT_KEYS) &&
    value.project_id === projectId &&
    value.name === name
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isSummary(value) {
  if (!hasExactKeys(value, SUMMARY_KEYS)) return false;

  return (
    isItemId(value.id) &&
    typeof value.kind === "string" &&
    KINDS.has(value.kind) &&
    typeof value.severity === "string" &&
    SEVERITIES.has(value.severity) &&
    typeof value.title === "string" &&
    Number.isSafeInteger(value.occurrences) &&
    Number(value.occurrences) >= 0 &&
    isTimestamp(value.first_seen_at) &&
    isTimestamp(value.last_seen_at) &&
    isNullableString(value.last_release) &&
    (value.issue_url === null ||
      (typeof value.issue_url === "string" &&
        GITHUB_ISSUE_URL_PATTERN.test(value.issue_url))) &&
    ((value.status === "open" &&
      value.resolution_reason === null &&
      value.resolution_cause === null) ||
      (value.status === "resolved" &&
        isResolutionReason(value.resolution_reason) &&
        isResolutionCause(value.resolution_cause)))
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isEvidence(value) {
  return (
    hasExactKeys(value, EVIDENCE_KEYS) &&
    (value.occurred_at === null || isTimestamp(value.occurred_at)) &&
    isNullableString(value.release) &&
    Array.isArray(value.exceptions) &&
    value.exceptions.every(isException) &&
    (value.request === null || isRequest(value.request)) &&
    Array.isArray(value.untrusted) &&
    value.untrusted.every((field) => typeof field === "string") &&
    typeof value.note === "string"
  );
}

/** @param {unknown} value */
function isException(value) {
  return (
    hasExactKeys(value, EXCEPTION_KEYS) &&
    isNullableString(value.type) &&
    typeof value.message === "string" &&
    Array.isArray(value.frames) &&
    value.frames.every(isFrame)
  );
}

/** @param {unknown} value */
function isFrame(value) {
  return (
    hasExactKeys(value, FRAME_KEYS) &&
    isNullableString(value.file) &&
    (value.line === null || Number.isSafeInteger(value.line)) &&
    isNullableString(value.function)
  );
}

/** @param {unknown} value */
function isRequest(value) {
  return (
    hasExactKeys(value, REQUEST_KEYS) &&
    isNullableString(value.method) &&
    isNullableString(value.host) &&
    isNullableString(value.path)
  );
}

/** @param {Record<string, unknown>} environment */
function copyEnvironment(environment) {
  return { project_id: environment.project_id, name: environment.name };
}

/** @param {Record<string, unknown>} item */
function copySummary(item) {
  return pick(item, SUMMARY_KEYS);
}

/** @param {Record<string, unknown>} evidence */
function copyEvidence(evidence) {
  const exceptions = /** @type {Record<string, unknown>[]} */ (
    evidence.exceptions
  );
  const request = /** @type {Record<string, unknown> | null} */ (
    evidence.request
  );
  return {
    occurred_at: evidence.occurred_at,
    release: evidence.release,
    exceptions: exceptions.map((exception) => ({
      type: exception.type,
      message: exception.message,
      frames: /** @type {Record<string, unknown>[]} */ (exception.frames).map(
        (frame) => pick(frame, FRAME_KEYS),
      ),
    })),
    request: request === null ? null : pick(request, REQUEST_KEYS),
    untrusted: [.../** @type {string[]} */ (evidence.untrusted)],
    note: evidence.note,
  };
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

/** @param {unknown} value */
function isTimestamp(value) {
  if (typeof value !== "string") return false;

  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return (
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

/** @param {number} year @param {number} month */
function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** @param {unknown} value */
function isNullableString(value) {
  return value === null || typeof value === "string";
}

/** @param {Record<string, unknown>} value @param {string[]} keys */
function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
