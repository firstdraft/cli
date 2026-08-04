import { lstatSync, readFileSync } from "node:fs";

import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  isProblemBody,
  readResponseBody,
  responseMediaType,
  sendRequest,
} from "../api-response.js";
import { isUuidV7, readPlanState } from "../plan-state.js";

const REQUEST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;
const TERMINAL_STATUSES = new Set([
  "valid",
  "issues_found",
  "analysis_failed",
  "superseded",
]);
const ALL_STATUSES = new Set(["processing", ...TERMINAL_STATUSES]);
const RESPONSE_KEYS = ["analysis", "project"];
const PROJECT_KEYS = ["graph_version", "id"];
const ANALYSIS_KEYS = [
  "analyzer_release",
  "completed_at",
  "diagnostics",
  "graph_version",
  "id",
  "started_at",
  "status",
];
const DIAGNOSTIC_KEYS = [
  "code",
  "location",
  "message",
  "related_locations",
  "severity",
  "subject",
  "suggestions",
];

/**
 * @typedef {object} PlanStatusFileSystem
 * @property {typeof lstatSync} lstatSync
 * @property {typeof readFileSync} readFileSync
 */

/** @type {PlanStatusFileSystem} */
const DEFAULT_FILE_SYSTEM = { lstatSync, readFileSync };

export class PlanStatusNotPushedError extends Error {}

export class PlanStatusChangedError extends Error {
  /** @param {AnalysisResponse} current */
  constructor(current) {
    super("The current analysis changed while it was being polled.");
    this.current = current;
  }
}

export class PlanStatusTimeoutError extends Error {
  /** @param {AnalysisResponse} current */
  constructor(current) {
    super("The current analysis did not finish before the wait deadline.");
    this.current = current;
  }
}

/**
 * @typedef {object} PlanStatusOptions
 * @property {string} cwd
 * @property {boolean} [wait]
 * @property {number} [expectedGraphVersion]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {PlanStatusFileSystem} [fileSystem]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} AnalysisResponse
 * @property {{id: string, graph_version: number}} project
 * @property {{id: string, graph_version: number, analyzer_release: string, status: string, diagnostics: Record<string, unknown>[], started_at: string | null, completed_at: string | null}} analysis
 */

/** @typedef {{source_pointer: string} | {line: number, column: number}} SourceLocation */
/** @typedef {{kind: string, readable_path: string, subject_uuid?: string}} DiagnosticSubject */
/** @typedef {{code: string, severity: "error" | "warning", message: string, location: SourceLocation, subject: DiagnosticSubject | null, related_locations: SourceLocation[], suggestions: string[]}} StructuredDiagnostic */

/**
 * @typedef {object} StatusSuccess
 * @property {200} status
 * @property {AnalysisResponse} body
 */

/**
 * @typedef {object} StatusRejection
 * @property {number} status
 * @property {"problem" | null} responseKind
 * @property {Record<string, unknown> | null} body
 */

/**
 * @param {PlanStatusOptions} options
 * @returns {Promise<StatusSuccess | StatusRejection>}
 */
export async function readPlanStatus({
  cwd,
  wait = false,
  expectedGraphVersion,
  fetchFunction = globalThis.fetch,
  fileSystem = DEFAULT_FILE_SYSTEM,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  sleep = sleepFor,
  now = Date.now,
}) {
  const state = readPlanState({ cwd, fileSystem });
  if (state.api_url === undefined) {
    throw new PlanStatusNotPushedError(
      "The local Foundation Plan has not been pushed.",
    );
  }

  const endpoint = new URL(
    `/v1/projects/${state.project_id}/analysis`,
    state.api_url,
  );
  const deadline = wait ? now() + WAIT_TIMEOUT_MS : null;
  /** @type {AnalysisResponse | null} */
  let first = null;
  /** @type {AnalysisResponse | null} */
  let current = null;

  while (true) {
    if (deadline !== null && current !== null && now() >= deadline) {
      throw new PlanStatusTimeoutError(current);
    }

    const requestTimeout =
      deadline === null
        ? REQUEST_TIMEOUT_MS
        : Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));
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
      if (
        error instanceof FirstDraftNetworkError &&
        deadline !== null &&
        current !== null &&
        now() >= deadline
      ) {
        throw new PlanStatusTimeoutError(current);
      }

      throw error;
    }

    if (response.status !== 200) {
      if (response.ok) {
        throw new FirstDraftProtocolError(
          "First Draft returned an unexpected success status.",
          { status: response.status },
        );
      }

      if (isProblemBody(response, body)) {
        return {
          status: response.status,
          responseKind: "problem",
          body,
        };
      }

      return {
        status: response.status,
        responseKind: null,
        body: null,
      };
    }

    const parsed = parseAnalysisResponse(body, state.project_id);
    if (responseMediaType(response) !== "application/json" || parsed === null) {
      throw new FirstDraftProtocolError(
        "First Draft returned an invalid analysis response.",
        { status: response.status },
      );
    }

    current = parsed;
    if (
      expectedGraphVersion !== undefined &&
      current.analysis.graph_version !== expectedGraphVersion
    ) {
      if (!wait || current.analysis.graph_version > expectedGraphVersion) {
        throw new PlanStatusChangedError(current);
      }

      const remaining = deadline === null ? 0 : deadline - now();
      if (remaining <= 0) throw new PlanStatusTimeoutError(current);
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      continue;
    }

    first ??= parsed;
    if (
      current.analysis.id !== first.analysis.id ||
      current.analysis.graph_version !== first.analysis.graph_version
    ) {
      throw new PlanStatusChangedError(current);
    }

    if (!wait || TERMINAL_STATUSES.has(current.analysis.status)) {
      return { status: 200, body: current };
    }

    const remaining = deadline === null ? 0 : deadline - now();
    if (remaining <= 0) throw new PlanStatusTimeoutError(current);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/** @param {number} delayMs */
function sleepFor(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * @param {unknown} value
 * @param {string} projectId
 * @returns {AnalysisResponse | null}
 */
function parseAnalysisResponse(value, projectId) {
  if (!hasRequiredKeys(value, RESPONSE_KEYS)) return null;

  const project = value.project;
  const analysis = value.analysis;
  if (
    !hasRequiredKeys(project, PROJECT_KEYS) ||
    !hasRequiredKeys(analysis, ANALYSIS_KEYS) ||
    project.id !== projectId ||
    !isGraphVersion(project.graph_version) ||
    !isUuidV7(analysis.id) ||
    !isGraphVersion(analysis.graph_version) ||
    analysis.graph_version !== project.graph_version ||
    typeof analysis.analyzer_release !== "string" ||
    Buffer.byteLength(analysis.analyzer_release) === 0 ||
    Buffer.byteLength(analysis.analyzer_release) > 256 ||
    typeof analysis.status !== "string" ||
    !ALL_STATUSES.has(analysis.status) ||
    !Array.isArray(analysis.diagnostics) ||
    !analysis.diagnostics.every(isStructuredDiagnostic) ||
    !isNullableTimestamp(analysis.started_at) ||
    !isNullableTimestamp(analysis.completed_at)
  ) {
    return null;
  }

  const terminal = TERMINAL_STATUSES.has(analysis.status);
  if (
    (terminal && analysis.completed_at === null) ||
    (!terminal && analysis.completed_at !== null) ||
    (analysis.started_at !== null &&
      analysis.completed_at !== null &&
      timestampMilliseconds(analysis.completed_at) <
        timestampMilliseconds(analysis.started_at)) ||
    (analysis.status === "valid" &&
      analysis.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      )) ||
    (analysis.status === "issues_found" &&
      !analysis.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      ))
  ) {
    return null;
  }

  return {
    project: {
      id: project.id,
      graph_version: project.graph_version,
    },
    analysis: {
      id: analysis.id,
      graph_version: analysis.graph_version,
      analyzer_release: analysis.analyzer_release,
      status: analysis.status,
      diagnostics: analysis.diagnostics.map(copyDiagnostic),
      started_at: analysis.started_at,
      completed_at: analysis.completed_at,
    },
  };
}

/** @param {unknown} value @returns {value is StructuredDiagnostic} */
function isStructuredDiagnostic(value) {
  if (
    !hasRequiredKeys(value, DIAGNOSTIC_KEYS) ||
    typeof value.code !== "string" ||
    (value.severity !== "error" && value.severity !== "warning") ||
    typeof value.message !== "string" ||
    !isSourceLocation(value.location) ||
    !isDiagnosticSubject(value.subject) ||
    !Array.isArray(value.related_locations) ||
    !value.related_locations.every(isSourceLocation) ||
    !Array.isArray(value.suggestions) ||
    !value.suggestions.every((suggestion) => typeof suggestion === "string")
  ) {
    return false;
  }

  return true;
}

/** @param {unknown} value @returns {value is SourceLocation} */
function isSourceLocation(value) {
  if (!isRecord(value)) return false;

  const pointerLocation = hasOwn(value, "source_pointer");
  const coordinateLocation = hasOwn(value, "line") || hasOwn(value, "column");
  if (pointerLocation === coordinateLocation) return false;

  if (pointerLocation) {
    return isJsonPointer(value.source_pointer);
  }

  return (
    hasOwn(value, "line") &&
    hasOwn(value, "column") &&
    Number.isSafeInteger(value.line) &&
    Number(value.line) > 0 &&
    Number.isSafeInteger(value.column) &&
    Number(value.column) > 0
  );
}

/** @param {unknown} value @returns {value is DiagnosticSubject | null} */
function isDiagnosticSubject(value) {
  if (value === null) return true;
  if (!isRecord(value)) return false;

  return (
    hasOwn(value, "kind") &&
    hasOwn(value, "readable_path") &&
    typeof value.kind === "string" &&
    typeof value.readable_path === "string" &&
    (value.subject_uuid === undefined || isUuidV7(value.subject_uuid))
  );
}

/** @param {unknown} value */
function isJsonPointer(value) {
  return (
    typeof value === "string" &&
    (value === "" || value.startsWith("/")) &&
    !/~(?:[^01]|$)/.test(value)
  );
}

/** @param {unknown} value @returns {value is number} */
function isGraphVersion(value) {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

/** @param {unknown} value @returns {value is string | null} */
function isNullableTimestamp(value) {
  return value === null || timestampParts(value) !== null;
}

/** @param {string} value */
function timestampMilliseconds(value) {
  const parts = timestampParts(value);
  if (parts === null) return Number.NaN;

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

  return { year, month, day, hour, minute, second };
}

/** @param {number} year @param {number} month */
function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** @param {StructuredDiagnostic} diagnostic */
function copyDiagnostic(diagnostic) {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    location: copyLocation(diagnostic.location),
    subject:
      diagnostic.subject === null
        ? null
        : {
            kind: diagnostic.subject.kind,
            readable_path: diagnostic.subject.readable_path,
            ...(diagnostic.subject.subject_uuid === undefined
              ? {}
              : { subject_uuid: diagnostic.subject.subject_uuid }),
          },
    related_locations: diagnostic.related_locations.map(copyLocation),
    suggestions: [...diagnostic.suggestions],
  };
}

/** @param {SourceLocation} location */
function copyLocation(location) {
  return "source_pointer" in location
    ? { source_pointer: location.source_pointer }
    : { line: location.line, column: location.column };
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function hasRequiredKeys(value, keys) {
  return isRecord(value) && keys.every((key) => hasOwn(value, key));
}

/** @param {Record<string, unknown>} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
