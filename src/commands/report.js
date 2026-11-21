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

// A failure report carries only fields of a known shape. Free text keeps
// plain words, and anything that does not fit its shape is left out, so the
// rules say what may leave the computer rather than guessing what a secret
// looks like. The Service refuses the same shapes.
const MAX_MESSAGE = 300;
const MAX_FIX_SUMMARY = 200;
const MAX_ERROR_CLASS = 200;
const MAX_RERUN = 300;
const MAX_FRAME = 300;
const MAX_VERSION = 32;
// Components of safe characters, each separated by one slash.
const SAFE_PATH = String.raw`[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*`;
// bundle exec rspec ./spec/models/post_spec.rb:42, bin/rspec spec/x_spec.rb
const RERUN = new RegExp(
  String.raw`^(?:bundle exec |bin/)?rspec(?: (?:\./)?spec/${SAFE_PATH}(?::\d{1,7})*)+$`,
);
const ERROR_CLASS = /^(?:::)?[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;
const FRAME = new RegExp(
  String.raw`^(?:\./)?((?:app|lib|config|db|spec)/${SAFE_PATH}):(\d{1,7})(?::in .*)?$`,
);
// Checked in every argument and frame: spec/.. spec/models has one too.
const PARENT_SEGMENT = /(?:^|[/\s:])\.\.(?=[/\s:]|$)/;
// 4.0.6, 8.1.4.1, 8.2.0.beta1, 3.4.0-preview2
const VERSION_NUMBER =
  /^\d{1,4}(?:\.\d{1,4}){0,3}(?:[.-](?:alpha|beta|rc|pre|preview)\d{0,3})?$/;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Quotes are not paired: from the word holding the first one, the rest of the
// line is one placeholder, so no quoted value survives.
const QUOTE = /['"`]/;
// A word that can carry a value: an assignment, a path or URL, an address,
// or anything long enough to be a token.
const VALUE_WORD = /[=/\\@]/;
const MAX_PLAIN_WORD = 24;
const PLACEHOLDER = "[…]";

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
 * @property {string} [rerun]
 * @property {string} [errorClass]
 * @property {string} [message]
 * @property {readonly string[]} [frames]
 * @property {string} [fixSummary]
 * @property {string} [rubyVersion]
 * @property {string} [railsVersion]
 */

/**
 * Shapes the failure report that is printed and sent. Each field keeps only
 * what fits its shape; `omitted` says, for the preview, what was left out.
 *
 * @param {FailureReport} report
 * @param {string} cwd an absolute frame inside it becomes relative
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
  /** @type {string[]} */
  const omitted = [];
  const shapedRerun = rerun === undefined ? undefined : rspecRun(rerun);
  if (rerun !== undefined && shapedRerun === undefined) {
    omitted.push("rerun, which is not an RSpec run of the application's specs");
  }
  const shapedErrorClass =
    errorClass !== undefined &&
    errorClass.length <= MAX_ERROR_CLASS &&
    ERROR_CLASS.test(errorClass)
      ? errorClass
      : undefined;
  if (errorClass !== undefined && shapedErrorClass === undefined) {
    omitted.push("error_class, which is not a Ruby constant");
  }
  const shapedFrames = frames
    .map((frame) => appFrame(frame, cwd))
    .filter((frame) => frame !== undefined);
  if (shapedFrames.length < frames.length) {
    const dropped = frames.length - shapedFrames.length;
    omitted.push(
      `${dropped} ${dropped === 1 ? "frame" : "frames"} not in the application's files with a line number`,
    );
  }
  if (shapedFrames.length > MAX_FAILURE_FRAMES) {
    omitted.push(`frames after the first ${MAX_FAILURE_FRAMES}`);
  }
  /** @type {Record<string, string>} */
  const versions = {};
  for (const [name, value] of /** @type {const} */ ([
    ["ruby", rubyVersion],
    ["rails", railsVersion],
  ])) {
    if (value === undefined) continue;
    if (value.length <= MAX_VERSION && VERSION_NUMBER.test(value)) {
      versions[name] = value;
    } else {
      omitted.push(`the ${name} version, which is not a version number`);
    }
  }
  const shapedMessage =
    message === undefined ? undefined : plainWords(message, MAX_MESSAGE);
  if (message !== undefined && !shapedMessage) {
    omitted.push("message, which has no plain words on its first line");
  }
  const shapedFixSummary =
    fixSummary === undefined
      ? undefined
      : plainWords(fixSummary, MAX_FIX_SUMMARY);
  if (fixSummary !== undefined && !shapedFixSummary) {
    omitted.push("fix_summary, which has no plain words on its first line");
  }

  return {
    body: {
      failure_report: {
        kind,
        ...(shapedRerun === undefined ? {} : { rerun: shapedRerun }),
        ...(shapedErrorClass === undefined
          ? {}
          : { error_class: shapedErrorClass }),
        ...(shapedMessage ? { message: shapedMessage } : {}),
        ...(shapedFrames.length === 0
          ? {}
          : { frames: shapedFrames.slice(0, MAX_FAILURE_FRAMES) }),
        ...(shapedFixSummary ? { fix_summary: shapedFixSummary } : {}),
        ...(Object.keys(versions).length === 0 ? {} : { versions }),
      },
    },
    omitted,
  };
}

/**
 * The command without its leading environment assignments, when what is left
 * is an RSpec run of the application's specs.
 *
 * @param {string} command
 * @returns {string | undefined}
 */
export function rspecRun(command) {
  const words = shellWords(command);
  if (words === null) return undefined;

  let start = 0;
  if (
    words[0]?.value === "env" &&
    words[1] !== undefined &&
    ASSIGNMENT_WORD.test(words[1].value)
  ) {
    start = 1;
  }
  while (ASSIGNMENT_WORD.test(words[start]?.value ?? "")) {
    start += 1;
  }

  // A spec directory may be written with a trailing slash: spec/models/.
  const run = words
    .slice(start)
    .map((word) => word.raw.replace(/^((?:\.\/)?spec\/.*[^/])\/+$/, "$1"))
    .join(" ");
  return run.length <= MAX_RERUN && RERUN.test(run) && !PARENT_SEGMENT.test(run)
    ? run
    : undefined;
}

/**
 * Splits a command into shell words, keeping each word's text as written
 * and its value with quotes and escapes removed. Returns null for an
 * unterminated quote.
 *
 * @param {string} command
 * @returns {{raw: string, value: string}[] | null}
 */
function shellWords(command) {
  /** @type {{raw: string, value: string}[]} */
  const words = [];
  let raw = "";
  let value = "";
  let inWord = false;
  let index = 0;
  while (index < command.length) {
    const character = /** @type {string} */ (command[index]);
    if (/\s/.test(character)) {
      if (inWord) words.push({ raw, value });
      raw = "";
      value = "";
      inWord = false;
      index += 1;
      continue;
    }

    inWord = true;
    if (character === "'" || character === '"') {
      const close = command.indexOf(character, index + 1);
      if (close === -1) return null;
      raw += command.slice(index, close + 1);
      value += command.slice(index + 1, close);
      index = close + 1;
    } else if (character === "\\" && index + 1 < command.length) {
      raw += command.slice(index, index + 2);
      value += command[index + 1];
      index += 2;
    } else {
      raw += character;
      value += character;
      index += 1;
    }
  }
  if (inWord) words.push({ raw, value });
  return words;
}

/**
 * A frame in the application's own files, as `path:line`.
 *
 * @param {string} frame
 * @param {string} cwd
 * @returns {string | undefined}
 */
function appFrame(frame, cwd) {
  const root = `${cwd.replace(/[\\/]+$/, "")}/`;
  const relative = frame.startsWith(root) ? frame.slice(root.length) : frame;
  const match = FRAME.exec(
    relative.replace(/^[^:]*/, (file) => file.replace(/\\/g, "/")),
  );
  if (match === null || PARENT_SEGMENT.test(match[1] ?? "")) return undefined;

  const shaped = `${match[1]}:${match[2]}`;
  return shaped.length <= MAX_FRAME ? shaped : undefined;
}

/**
 * The plain words of free text's first line. From the word that holds the
 * first quote character to the end of the line is one placeholder; before
 * it, a word that can carry a value is one too; then words that fit within
 * `limit` are kept.
 *
 * @param {string} text
 * @param {number} limit
 */
export function plainWords(text, limit) {
  const [firstLine = ""] = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/, 1);
  const line = firstLine.replace(/\t/g, " ").replace(CONTROL, "");
  const quote = line.search(QUOTE);
  const words = (quote === -1 ? line : line.slice(0, quote))
    .split(/\s+/)
    .filter((word) => word !== "");
  // The word that holds the quote goes with the rest of the line.
  if (quote !== -1 && !/\s/.test(line[quote - 1] ?? " ")) words.pop();
  const shaped = words.map((word) =>
    !VALUE_WORD.test(word) && Array.from(word).length <= MAX_PLAIN_WORD
      ? word
      : PLACEHOLDER,
  );
  if (quote !== -1) shaped.push(PLACEHOLDER);

  /** @type {string[]} */
  const kept = [];
  let length = 0;
  for (const word of shaped) {
    const next = length + (kept.length === 0 ? 0 : 1) + Array.from(word).length;
    if (next > limit) break;
    kept.push(word);
    length = next;
  }
  return kept.join(" ");
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
