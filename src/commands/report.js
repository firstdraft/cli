import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  isProblemBody,
  problemProjection,
  readResponseBody,
  responseMediaType,
  sendRequest,
  serviceEndpoint,
} from "../api-response.js";

const REQUEST_TIMEOUT_MS = 30_000;

export const PROGRESS_STEPS = Object.freeze([
  "setup",
  "specs_first_run",
  "behavior_written",
  "specs_passing",
  "preview_started",
]);
export const FAILURE_KINDS = Object.freeze([
  "spec_failure",
  "setup_failure",
  "boot_error",
  "lint_failure",
]);
const MAX_FAILURE_FRAMES = 20;

// Code points kept in each free-text field after redaction.
const MAX_MESSAGE = 300;
const MAX_FIX_SUMMARY = 200;
const MAX_ERROR_CLASS = 200;
const MAX_RERUN = 300;
const MAX_FRAME = 300;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// An absolute path: one in a home directory, on a drive, on a network share
// (\\host\share or //host/share), or from the root with at least two
// segments. It may start a word or follow a command option such as -I or
// --require=. A URL's path, a relative path such as app/models/post.rb, and
// ./spec/... are not matched. A path in quotes may contain spaces.
const PATH_CHARACTER = String.raw`[^\s'"` + "`" + String.raw`()<>[\]{},;]`;
const SEGMENT = String.raw`[^\s\\/'"` + "`" + String.raw`()<>[\]{},;]`;
const PATH_START = String.raw`(?:(?<![\w.~:/\\-])|(?<=(?:^|[\s'"(])--?[A-Za-z][A-Za-z0-9-]*=?))`;
// After an option such as -I, a path directly under the root counts too.
// The path may be the next argument, and may contain escaped spaces.
const OPTION_PATH = new RegExp(
  String.raw`(?<=(?:^|[\s'"(])--?[A-Za-z][A-Za-z0-9-]*(?:=|[ \t]+)?)[\\/](?:\\ |${SEGMENT})+(?:\\ |${PATH_CHARACTER})*`,
  "g",
);
// A shell-escaped space continues an unquoted path.
const ESCAPED_PATH = String.raw`(?:\\ |${PATH_CHARACTER})`;
const ABSOLUTE_PATH = new RegExp(
  String.raw`${PATH_START}(?:~[\\/]${ESCAPED_PATH}+|[A-Za-z]:[\\/]${ESCAPED_PATH}*|[\\/]{2}${SEGMENT}+${ESCAPED_PATH}*|[\\/](?:\\ |${SEGMENT})+(?:[\\/]${ESCAPED_PATH}*)?)`,
  "g",
);
const QUOTED = /(['"`])([^'"`\n]+)\1/g;
const ABSOLUTE_START =
  /^(?:file:\/\/|~[\\/]|[A-Za-z]:[\\/]|[\\/]{1,2}[^\s\\/])/i;
// A quoted option and its path together, such as "-I/Team Notes/lib".
// The shortest option prefix comes first, so -IC:\lib keeps its drive letter.
const QUOTED_OPTION = /^(--?[A-Za-z][A-Za-z0-9-]*?=?)((?:[A-Za-z]:)?[\\/~].*)$/;
const FILE_URL = new RegExp(String.raw`\bfile:\/\/${PATH_CHARACTER}*`, "gi");
// NAME=value, as a shell sets an environment variable for one command.
// A value may be quoted, or unquoted with backslash escapes.
// The whole shell word: quoted parts (which may span lines), escapes, and
// plain characters, in any order.
const ASSIGNMENT_VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s\\'"])+`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w-])([A-Z_][A-Z0-9_]*)=${ASSIGNMENT_VALUE}`,
  "g",
);
// In a command line, a lowercase name such as npm_config_registry is an
// assignment too; elsewhere name=value is ordinary text.
const COMMAND_ASSIGNMENT = new RegExp(
  String.raw`(?<![\w-])([A-Za-z_][A-Za-z0-9_]*)=${ASSIGNMENT_VALUE}`,
  "g",
);
// An assignment quoted as a whole, as in env 'LABEL=North West' bin/rspec.
// Each quote ends only at its own kind, so "LABEL=O'Brien" is one value.
const QUOTED_ASSIGNMENT =
  /"([A-Z_][A-Z0-9_]*)=[^"\n]*"|'([A-Z_][A-Z0-9_]*)=[^'\n]*'/g;
const QUOTED_COMMAND_ASSIGNMENT =
  /"([A-Za-z_][A-Za-z0-9_]*)=[^"\n]*"|'([A-Za-z_][A-Za-z0-9_]*)=[^'\n]*'/g;
// Credential formats that need no digit, as the Service also scrubs them.
const CREDENTIAL =
  /\b(?:eyJ[\w-]*\.[\w-]+\.[\w-]*|fd_[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})/g;
// A frame outside the application: redacted, absolute, or through "..". The
// Service accepts only paths inside the project.
const OUTSIDE_FRAME =
  /^(?:\[path\]|[\\/~]|[A-Za-z]:)|(?:^|[\\/])\.\.(?:[\\/]|:|$)/;
// Long runs of token characters that mix letters and digits, such as API
// tokens, digests, and UUIDs.
const TOKEN_CANDIDATE = /[A-Za-z0-9_-]{32,}/g;
const REDACTED_PATH = "[path]";

export class ReportRejectedError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} response
   */
  constructor(status, response) {
    super("First Draft rejected the report.");
    this.status = status;
    this.response = response;
  }
}

export class ReportUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The report's outcome could not be confirmed.");
    this.status = status;
    this.response = response;
  }
}

/**
 * @typedef {object} ProgressCounts
 * @property {number} [examples]
 * @property {number} [failures]
 * @property {number} [behavior_to_write_failures]
 * @property {number} [items_remaining]
 */

/**
 * @param {string} step one of PROGRESS_STEPS
 * @param {ProgressCounts} counts only the counts that were given
 */
export function progressReportBody(step, counts) {
  return {
    progress_report: {
      step,
      ...(Object.keys(counts).length === 0 ? {} : { counts }),
    },
  };
}

/**
 * @typedef {object} FailureReport
 * @property {string} kind one of FAILURE_KINDS
 * @property {string} rerun
 * @property {string} errorClass
 * @property {string} [message]
 * @property {readonly string[]} [frames]
 * @property {string} [fixSummary]
 * @property {string} [rubyVersion]
 * @property {string} [railsVersion]
 */

/**
 * Builds the failure report that is printed and sent. Every free-text field
 * is redacted, then cut to its limit, so the printed report is exactly what
 * leaves the computer. A frame outside `cwd` is left out, because a report
 * describes generated code.
 *
 * @param {FailureReport} report
 * @param {string} cwd absolute paths inside it become relative
 */
export function failureReportBody(
  {
    kind,
    rerun,
    errorClass,
    message,
    frames = [],
    fixSummary,
    rubyVersion,
    railsVersion,
  },
  cwd,
) {
  /** @param {string} text @param {number} limit */
  const field = (text, limit) => clip(redact(text, cwd), limit);
  const kept = frames
    .map((frame) => field(frame, MAX_FRAME))
    .filter((frame) => !OUTSIDE_FRAME.test(frame))
    // The Service accepts frames with / separators only.
    .map((frame) => frame.replace(/^[^:]*/, (file) => file.replace(/\\/g, "/")))
    .slice(0, MAX_FAILURE_FRAMES);
  const versions = {
    ...(rubyVersion === undefined ? {} : { ruby: rubyVersion }),
    ...(railsVersion === undefined ? {} : { rails: railsVersion }),
  };

  return {
    failure_report: {
      kind,
      rerun: clip(
        redact(
          rerun
            .replace(QUOTED_COMMAND_ASSIGNMENT, quotedAssignment)
            .replace(COMMAND_ASSIGNMENT, "$1=[value]"),
          cwd,
        ),
        MAX_RERUN,
      ),
      error_class: field(errorClass, MAX_ERROR_CLASS),
      ...(message === undefined
        ? {}
        : { message: field(message, MAX_MESSAGE) }),
      ...(kept.length === 0 ? {} : { frames: kept }),
      ...(fixSummary === undefined
        ? {}
        : { fix_summary: field(fixSummary, MAX_FIX_SUMMARY) }),
      ...(Object.keys(versions).length === 0 ? {} : { versions }),
    },
  };
}

/**
 * Removes terminal escapes and control characters other than tab and
 * newline, then replaces email addresses, absolute paths, and token-like
 * strings. An absolute path inside `cwd` becomes relative to it.
 *
 * @param {string} text
 * @param {string} cwd
 */
export function redact(text, cwd) {
  const root = cwd.replace(/[\\/]+$/, "");
  /** @param {string} match */
  const replacePath = (match) => {
    const inside =
      root !== "" &&
      (match.startsWith(`${root}/`) || match.startsWith(`${root}\\`));
    const relative = match.slice(root.length + 1);
    return inside && relative !== "" ? relative : REDACTED_PATH;
  };
  // The current directory may contain spaces, which end an unquoted path, so
  // its prefix is removed before paths are matched.
  const rootPrefix =
    root === ""
      ? null
      : new RegExp(
          `${PATH_START}${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/](?=${PATH_CHARACTER})`,
          "g",
        );

  const quotedPathsRedacted = text
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL, "")
    .replace(EMAIL, "[email]")
    .replace(CREDENTIAL, "[token]")
    .replace(QUOTED_ASSIGNMENT, quotedAssignment)
    .replace(ASSIGNMENT, "$1=[value]")
    .replace(QUOTED, (match, quote, inner) => {
      if (ABSOLUTE_START.test(inner)) {
        return `${quote}${replacePath(inner)}${quote}`;
      }
      const [, option, operand] = QUOTED_OPTION.exec(inner) ?? [];
      return option !== undefined &&
        operand !== undefined &&
        ABSOLUTE_START.test(operand)
        ? `${quote}${option}${replacePath(operand)}${quote}`
        : match;
    })
    .replace(FILE_URL, REDACTED_PATH);

  return (
    rootPrefix === null
      ? quotedPathsRedacted
      : quotedPathsRedacted.replace(rootPrefix, "")
  )
    .replace(OPTION_PATH, replacePath)
    .replace(ABSOLUTE_PATH, replacePath)
    .replace(TOKEN_CANDIDATE, (match) =>
      /\d/.test(match) && /[A-Za-z]/.test(match) ? "[token]" : match,
    );
}

/**
 * @param {string} match
 * @param {string | undefined} doubleQuoted
 * @param {string | undefined} singleQuoted
 */
function quotedAssignment(match, doubleQuoted, singleQuoted) {
  return doubleQuoted === undefined
    ? `'${singleQuoted}=[value]'`
    : `"${doubleQuoted}=[value]"`;
}

/** @param {string} text @param {number} limit */
function clip(text, limit) {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : characters.slice(0, limit).join("");
}

/**
 * @typedef {object} SendReportOptions
 * @property {string} origin
 * @property {{method: string, path: string}} route
 * @property {string} projectId
 * @property {string} compilationId
 * @property {string} body the exact JSON text that was printed
 * @property {string} wrapper the key, such as progress_report, under which
 *   First Draft acknowledges the stored report with its id and Compilation
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 */

/**
 * Sends one report once. A report is never retried: First Draft may already
 * hold it when the outcome is unconfirmed.
 *
 * @param {SendReportOptions} options
 * @returns {Promise<{outcome: "sent" | "reports_off"}>}
 */
export async function sendReport({
  origin,
  route,
  projectId,
  compilationId,
  body,
  wrapper,
  fetchFunction = globalThis.fetch,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const endpoint = serviceEndpoint(route, origin, {
    project_id: projectId,
    compilation_id: compilationId,
  });
  let response;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      headers: {
        Accept: "application/json, application/problem+json",
        "Content-Type": "application/json",
      },
      body,
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new ReportUnavailableError(error.status);
    }
    throw error;
  }

  let responseBody;
  try {
    responseBody = await readResponseBody(response);
  } catch (error) {
    if (
      error instanceof FirstDraftNetworkError ||
      error instanceof FirstDraftProtocolError
    ) {
      throw new ReportUnavailableError(response.status);
    }
    throw error;
  }

  // First Draft acknowledges a stored report with 201 and the report itself.
  // Any other success, such as a proxy's page, confirms nothing.
  if (response.ok) {
    if (
      response.status === 201 &&
      responseMediaType(response) === "application/json" &&
      isRecord(responseBody) &&
      isRecord(responseBody[wrapper]) &&
      isStoredReport(responseBody[wrapper], compilationId)
    ) {
      return { outcome: "sent" };
    }
    throw new ReportUnavailableError(response.status);
  }

  const problem = isProblemBody(response, responseBody)
    ? problemProjection(responseBody)
    : null;
  if (response.status === 403 && problem?.code === "reports_off") {
    return { outcome: "reports_off" };
  }
  if (problem !== null && response.status !== 408 && response.status < 500) {
    throw new ReportRejectedError(response.status, problem);
  }
  throw new ReportUnavailableError(response.status, problem);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} report
 * @param {string} compilationId
 */
function isStoredReport(report, compilationId) {
  return (
    typeof report.id === "string" &&
    STORED_ID.test(report.id) &&
    report.compilation_id === compilationId
  );
}

// First Draft stores each report under a UUID.
const STORED_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
