import { createHash } from "node:crypto";
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
export const MAX_PLAN_STATUS_RESPONSE_BYTES = 128 * 1024 * 1024;
const GAP_SET_FORMAT = "firstdraft.foundation-gaps/2";
const GAP_TEXT_MAX_BYTES = 64 * 1024;
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
  "id",
  "graph_version",
  "head_source_sha256",
  "analyzer_release",
  "compiler_release",
  "target",
  "status",
  "diagnostics",
  "gap_set",
  "gap_set_sha256",
  "started_at",
  "completed_at",
];
const TARGET_KEYS = ["id", "profile"];
const GAP_SET_KEYS = [
  "format",
  "source",
  "project",
  "analysis",
  "compiler_release",
  "target",
  "gaps",
];
const GAP_SOURCE_KEYS = ["sha256"];
const GAP_PROJECT_KEYS = ["id", "graph_version"];
const GAP_ANALYSIS_KEYS = ["release"];
const GAP_REQUIRED_ENTRY_KEYS = [
  "classification",
  "code",
  "kind",
  "status",
  "reason",
  "consequence",
];
const GAP_OPTIONAL_ENTRY_KEYS = ["pointer", "readable_path", "cause"];
const GAP_CLASSIFICATIONS = new Set([
  "service_support_gap",
  "target_support_gap",
]);
const GAP_STATUSES = new Set([
  "skipped_at_import",
  "not_generated",
  "partially_generated",
]);
const DIAGNOSTIC_KEYS = [
  "code",
  "location",
  "message",
  "related_locations",
  "severity",
  "subject",
  "suggestions",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

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
 * @property {{id: string, graph_version: number, head_source_sha256: string, analyzer_release: string, compiler_release: string, target: {id: string, profile: string}, status: string, diagnostics: Record<string, unknown>[], gap_set: Record<string, unknown> | null, gap_set_sha256: string | null, started_at: string | null, completed_at: string | null}} analysis
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
      body = await readResponseBody(
        response,
        response.status === 200 ? MAX_PLAN_STATUS_RESPONSE_BYTES : undefined,
      );
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
  const target = isRecord(analysis) ? analysis.target : null;
  if (
    !hasRequiredKeys(project, PROJECT_KEYS) ||
    !hasRequiredKeys(analysis, ANALYSIS_KEYS) ||
    project.id !== projectId ||
    !isGraphVersion(project.graph_version) ||
    !isUuidV7(analysis.id) ||
    !isGraphVersion(analysis.graph_version) ||
    analysis.graph_version !== project.graph_version ||
    typeof analysis.head_source_sha256 !== "string" ||
    !SHA256_PATTERN.test(analysis.head_source_sha256) ||
    !isIdentifier(analysis.analyzer_release) ||
    !isIdentifier(analysis.compiler_release) ||
    !isTarget(target) ||
    typeof analysis.status !== "string" ||
    !ALL_STATUSES.has(analysis.status) ||
    !Array.isArray(analysis.diagnostics) ||
    !analysis.diagnostics.every(isStructuredDiagnostic) ||
    (analysis.gap_set_sha256 !== null &&
      typeof analysis.gap_set_sha256 !== "string") ||
    !isNullableTimestamp(analysis.started_at) ||
    !isNullableTimestamp(analysis.completed_at)
  ) {
    return null;
  }

  const terminal = TERMINAL_STATUSES.has(analysis.status);
  const gapSet = parseGapSet(analysis.gap_set, {
    projectId: project.id,
    graphVersion: project.graph_version,
    headSourceSha256: analysis.head_source_sha256,
    analyzerRelease: analysis.analyzer_release,
    compilerRelease: analysis.compiler_release,
    target,
  });
  const gapSetSha256 = analysis.gap_set_sha256;
  const hasGapSet = gapSet !== null && typeof gapSetSha256 === "string";
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
      )) ||
    (analysis.status === "valid") !== hasGapSet ||
    (analysis.gap_set === null) !== (gapSetSha256 === null) ||
    (analysis.gap_set !== null && gapSet === null) ||
    (typeof gapSetSha256 === "string" &&
      (!SHA256_PATTERN.test(gapSetSha256) ||
        gapSetSha256 !== sha256(canonicalGapSetSource(gapSet))))
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
      head_source_sha256: analysis.head_source_sha256,
      analyzer_release: analysis.analyzer_release,
      compiler_release: analysis.compiler_release,
      target: { id: target.id, profile: target.profile },
      status: analysis.status,
      diagnostics: analysis.diagnostics.map(copyDiagnostic),
      gap_set: gapSet,
      gap_set_sha256: gapSetSha256,
      started_at: analysis.started_at,
      completed_at: analysis.completed_at,
    },
  };
}

/** @param {unknown} value @returns {value is string} */
function isIdentifier(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= 256 &&
    IDENTIFIER_PATTERN.test(value)
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown> & {id: string, profile: string}}
 */
function isTarget(value) {
  return (
    hasExactKeys(value, TARGET_KEYS) &&
    isIdentifier(value.id) &&
    isIdentifier(value.profile)
  );
}

/**
 * @param {unknown} value
 * @param {{projectId: string, graphVersion: number, headSourceSha256: string, analyzerRelease: string, compilerRelease: string, target: {id: string, profile: string}}} identity
 * @returns {Record<string, unknown> | null}
 */
function parseGapSet(value, identity) {
  if (value === null) return null;
  if (!hasExactKeys(value, GAP_SET_KEYS)) return null;

  const source = value.source;
  const project = value.project;
  const analysis = value.analysis;
  const target = value.target;
  if (
    value.format !== GAP_SET_FORMAT ||
    !hasExactKeys(source, GAP_SOURCE_KEYS) ||
    source.sha256 !== identity.headSourceSha256 ||
    !hasExactKeys(project, GAP_PROJECT_KEYS) ||
    project.id !== identity.projectId ||
    project.graph_version !== identity.graphVersion ||
    !hasExactKeys(analysis, GAP_ANALYSIS_KEYS) ||
    analysis.release !== identity.analyzerRelease ||
    value.compiler_release !== identity.compilerRelease ||
    !hasExactKeys(target, TARGET_KEYS) ||
    target.id !== identity.target.id ||
    target.profile !== identity.target.profile ||
    !Array.isArray(value.gaps) ||
    !value.gaps.every(isGapEntry) ||
    !gapsAreCanonicallyOrdered(value.gaps)
  ) {
    return null;
  }

  return {
    format: GAP_SET_FORMAT,
    source: { sha256: source.sha256 },
    project: { id: project.id, graph_version: project.graph_version },
    analysis: { release: analysis.release },
    compiler_release: value.compiler_release,
    target: { id: target.id, profile: target.profile },
    gaps: value.gaps.map(copyGapEntry),
  };
}

/** @param {Record<string, unknown>[]} gaps */
function gapsAreCanonicallyOrdered(gaps) {
  return gaps.every((entry, index) => {
    const previous = gaps[index - 1];
    return previous === undefined || compareGapEntries(previous, entry) <= 0;
  });
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function compareGapEntries(left, right) {
  return (
    compareGapLocations(left, right) ||
    compareUtf8(String(left.code), String(right.code)) ||
    compareUtf8(String(left.kind), String(right.kind))
  );
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function compareGapLocations(left, right) {
  const leftPointer = typeof left.pointer === "string";
  const rightPointer = typeof right.pointer === "string";
  if (leftPointer !== rightPointer) return leftPointer ? -1 : 1;
  if (typeof left.pointer !== "string" || typeof right.pointer !== "string") {
    return compareUtf8(
      typeof left.readable_path === "string" ? left.readable_path : "",
      typeof right.readable_path === "string" ? right.readable_path : "",
    );
  }

  const leftTokens = pointerSortTokens(left.pointer);
  const rightTokens = pointerSortTokens(right.pointer);
  for (
    let index = 0;
    index < Math.min(leftTokens.length, rightTokens.length);
    index += 1
  ) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === undefined || rightToken === undefined) {
      throw new TypeError("GapSet pointer token comparison is inconsistent.");
    }
    const comparison = comparePointerTokens(leftToken, rightToken);
    if (comparison !== 0) return comparison;
  }
  return leftTokens.length - rightTokens.length;
}

/** @param {string} pointer */
function pointerSortTokens(pointer) {
  return pointer
    .split("/")
    .slice(1)
    .map((token) => {
      const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^(?:0|[1-9][0-9]*)$/.test(decoded)
        ? { kind: 0, value: BigInt(decoded) }
        : { kind: 1, value: decoded };
    });
}

/**
 * @param {{kind: number, value: bigint | string}} left
 * @param {{kind: number, value: bigint | string}} right
 */
function comparePointerTokens(left, right) {
  if (left.kind !== right.kind) return left.kind - right.kind;
  if (typeof left.value === "bigint" && typeof right.value === "bigint") {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  return compareUtf8(String(left.value), String(right.value));
}

/** @param {string} left @param {string} right */
function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** @param {unknown} value */
function isGapEntry(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !GAP_REQUIRED_ENTRY_KEYS.every((key) => keys.includes(key)) ||
    !keys.every(
      (key) =>
        GAP_REQUIRED_ENTRY_KEYS.includes(key) ||
        GAP_OPTIONAL_ENTRY_KEYS.includes(key),
    ) ||
    !isGapText(value.classification) ||
    !GAP_CLASSIFICATIONS.has(value.classification) ||
    !isGapIdentifier(value.code) ||
    !isGapIdentifier(value.kind) ||
    !isGapText(value.status) ||
    !GAP_STATUSES.has(value.status) ||
    !isGapText(value.reason) ||
    !isGapText(value.consequence) ||
    (value.pointer !== undefined &&
      (!isGapText(value.pointer) || !isJsonPointer(value.pointer))) ||
    (value.readable_path !== undefined && !isGapText(value.readable_path)) ||
    (value.cause !== undefined && !isGapText(value.cause))
  ) {
    return false;
  }

  return value.classification === "service_support_gap"
    ? value.status === "skipped_at_import"
    : value.status === "not_generated" ||
        value.status === "partially_generated";
}

/** @param {unknown} value @returns {value is string} */
function isGapIdentifier(value) {
  return isGapText(value) && IDENTIFIER_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
function isGapText(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= GAP_TEXT_MAX_BYTES &&
    !value.includes("\0")
  );
}

/** @param {Record<string, unknown>} entry */
function copyGapEntry(entry) {
  return {
    classification: entry.classification,
    code: entry.code,
    kind: entry.kind,
    status: entry.status,
    ...(entry.pointer === undefined ? {} : { pointer: entry.pointer }),
    ...(entry.readable_path === undefined
      ? {}
      : { readable_path: entry.readable_path }),
    reason: entry.reason,
    consequence: entry.consequence,
    ...(entry.cause === undefined ? {} : { cause: entry.cause }),
  };
}

/** @param {Record<string, unknown> | null} gapSet */
function canonicalGapSetSource(gapSet) {
  return Buffer.from(`${JSON.stringify(gapSet, null, 2)}\n`, "utf8");
}

/** @param {Buffer} source */
function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
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

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => hasOwn(value, key))
  );
}

/** @param {Record<string, unknown>} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
