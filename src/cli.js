import { parseArgs } from "node:util";

import {
  CompilationArtifactInvalidError,
  CompilationArtifactResponseInvalidError,
  CompilationArtifactUnavailableError,
  CompilationCancelledError,
  CompilationChangedError,
  CompilationFailedError,
  CompilationLocalStateError,
  CompilationMaterializationError,
  CompilationNotPushedError,
  CompilationOutputPathError,
  CompilationRequestOutcomeUnknownError,
  CompilationStartRejectedError,
  CompilationStatusInvalidError,
  CompilationStatusUnavailableError,
  CompilationTimeoutError,
  compilePlan,
} from "./commands/plan-compile.js";
import { initializePlan } from "./commands/plan-init.js";
import {
  PlanPushConfigurationError,
  PlanPushLocalError,
  PlanPushNetworkError,
  PlanPushProtocolError,
  PlanPushStateWriteError,
  pushPlan,
} from "./commands/plan-push.js";
import {
  PlanStatusChangedError,
  PlanStatusNotPushedError,
  PlanStatusTimeoutError,
  readPlanStatus,
} from "./commands/plan-status.js";
import { isFileSystemError } from "./file-system.js";
import { generateUuidV7 } from "./uuid-v7.js";
import { VERSION } from "./version.js";

const ROOT_HELP = `First Draft CLI

Usage:
  firstdraft <command> [options]
  firstdraft [options]

Commands:
  plan  Work with Foundation Plans

Options:
  -h, --help     Show help
  -V, --version  Show version
`;

const PLAN_HELP = `First Draft CLI

Usage:
  firstdraft plan <command> [options]

Commands:
  init        Create a local empty Foundation Plan
  subject-id  Generate a UUIDv7 for a new Plan subject
  push        Send the local Foundation Plan to First Draft
  status      Read the current whole-graph analysis status
  compile     Compile the accepted Plan into a new local directory

Options:
  -h, --help  Show help
`;

const PLAN_PUSH_HELP = `First Draft CLI

Usage:
  firstdraft plan push

Options:
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_URL  Override the initial API origin

The first successful push saves its API origin in .firstdraft/state.json.
Later pushes reject a different origin.
`;

const PLAN_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft plan status [--wait]

Options:
      --wait  Poll until the current analysis reaches a terminal status
  -h, --help  Show help

The command uses only the API origin pinned by a successful plan push.
Without --wait, it makes exactly one status request.
`;

const PLAN_COMPILE_HELP = `First Draft CLI

Usage:
  firstdraft plan compile --output <absent-path>

Options:
      --output <absent-path>  Materialize the generated application here
  -h, --help                  Show help

The command starts one compilation of the exact Plan ETag pinned by the
last successful push, waits up to ten minutes, validates the complete
artifact, and atomically renames it into an absent output path.
`;

const PLAN_SUBJECT_ID_HELP = `First Draft CLI

Usage:
  firstdraft plan subject-id

Prints one UUIDv7 for a new independently mutable Plan subject.
The command reads no files and makes no network request.

Options:
  -h, --help  Show help
`;

const PLAN_INIT_HELP = `First Draft CLI

Usage:
  firstdraft plan init --application-key <key> --name <name>

Options:
      --application-key <key>  Lower-snake-case application key
      --name <name>            Application display name
  -h, --help                   Show help
`;

const ROOT_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft --help' for usage.\n";
const ROOT_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft --help' for usage.\n";
const PLAN_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan --help' for usage.\n";
const PLAN_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft plan --help' for usage.\n";
const PLAN_INIT_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft plan init --help' for usage.";
const PLAN_INIT_FAILED_DETAIL =
  "Could not initialize .firstdraft. The directory may be incomplete; no existing files were overwritten.";
const PLAN_INIT_SUCCESS = "Initialized .firstdraft/foundation-plan.json.\n";
const PLAN_PUSH_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft plan push --help' for usage.";
const PLAN_PUSH_INVALID_CONFIGURATION_DETAIL =
  "Invalid First Draft API configuration. Run 'firstdraft plan push --help' for usage.";
const PLAN_PUSH_LOCAL_INPUT_UNREADABLE_DETAIL =
  "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.";
const PLAN_PUSH_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "The Plan may have been accepted, but the response could not be verified. Stop and reconcile before pushing again; local state was not changed.";
const PLAN_PUSH_SERVER_REJECTED_DETAIL = "First Draft rejected the Plan.";
const PLAN_STATUS_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft plan status --help' for usage.";
const PLAN_STATUS_LOCAL_INPUT_UNREADABLE_DETAIL =
  "Could not read valid local First Draft state. No network request was made. Run 'firstdraft plan init' if this directory is not initialized; otherwise repair the private state before retrying.";
const PLAN_STATUS_NOT_PUSHED_DETAIL =
  "The local Foundation Plan has not been pushed successfully. Run 'firstdraft plan push' before requesting analysis status.";
const PLAN_STATUS_UNAVAILABLE_DETAIL =
  "Could not verify the current analysis status. Retry this read-only request a bounded number of times; if it keeps failing, inspect the API origin pinned in .firstdraft/state.json.";
const PLAN_STATUS_INVALID_RESPONSE_DETAIL =
  "First Draft returned an invalid analysis response. Retrying the unchanged request will not repair this protocol mismatch.";
const PLAN_STATUS_SERVER_REJECTED_DETAIL =
  "First Draft rejected the analysis status request.";
const PLAN_STATUS_CHANGED_DETAIL =
  "The current analysis changed while waiting. Run 'firstdraft plan status --wait' again to follow the latest analysis.";
const PLAN_STATUS_TIMEOUT_DETAIL =
  "The current analysis is still processing after the bounded wait. Run 'firstdraft plan status --wait' again to continue waiting.";
const PLAN_COMPILE_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft plan compile --help' for usage.";
const PLAN_COMPILE_LOCAL_INPUT_UNREADABLE_DETAIL =
  "Could not read valid local First Draft state. No network request was made. Run 'firstdraft plan push' before compiling.";
const PLAN_COMPILE_INCOMPATIBLE_STATE_DETAIL =
  "The saved Foundation Plan ETag is incompatible with compilation. No network request was made; reconcile the CLI and server contract.";
const PLAN_COMPILE_NOT_PUSHED_DETAIL =
  "The local Foundation Plan has not been pushed successfully. Run 'firstdraft plan push' before compiling.";
const PLAN_COMPILE_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "The compilation may have started, but the response could not be verified. Do not start another compilation until the current Project is reconciled.";
const PLAN_COMPILE_START_REJECTED_DETAIL =
  "First Draft rejected the compilation start request.";
const PLAN_COMPILE_STATUS_UNAVAILABLE_DETAIL =
  "Could not read the pinned compilation status. The command stopped without following or starting another Compilation.";
const PLAN_COMPILE_STATUS_INVALID_DETAIL =
  "First Draft returned an invalid compilation status response. Retrying unchanged will not repair this protocol mismatch.";
const PLAN_COMPILE_CHANGED_DETAIL =
  "The pinned Compilation changed while being polled. The command stopped without downloading an artifact.";
const PLAN_COMPILE_TIMEOUT_DETAIL =
  "The pinned Compilation is still running after the bounded ten-minute wait.";
const PLAN_COMPILE_FAILED_DETAIL =
  "The pinned Compilation failed. No artifact was downloaded or materialized.";
const PLAN_COMPILE_CANCELLED_DETAIL =
  "The pinned Compilation was cancelled. No artifact was downloaded or materialized.";
const PLAN_COMPILE_ARTIFACT_UNAVAILABLE_DETAIL =
  "Could not download the pinned Compilation artifact. No files were materialized.";
const PLAN_COMPILE_ARTIFACT_INVALID_DETAIL =
  "The downloaded Compilation artifact did not satisfy the integrity contract. No files were materialized.";
const PLAN_COMPILE_MATERIALIZATION_FAILED_DETAIL =
  "The validated Compilation artifact could not be materialized at the requested absent output path.";
const PLAN_COMPILE_INVALID_OUTPUT_PATH_DETAIL =
  "The compilation output path must be absent beneath an existing real directory. No network request was made.";
const PLAN_SUBJECT_ID_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft plan subject-id --help' for usage.";

/**
 * @typedef {object} Writer
 * @property {(text: string) => unknown} write
 */

/**
 * @typedef {object} RunOptions
 * @property {readonly string[]} argv
 * @property {Writer} stdout
 * @property {Writer} stderr
 * @property {string} [cwd]
 * @property {() => string} [getCwd]
 * @property {() => string} [createProjectId]
 * @property {() => string} [createSubjectId]
 * @property {import("./commands/plan-init.js").FileSystem} [fileSystem]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("./commands/plan-push.js").PlanPushFileSystem} [planPushFileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [planStatusSleep]
 * @property {() => number} [planStatusNow]
 * @property {(delayMs: number) => Promise<void>} [planCompileSleep]
 * @property {() => number} [planCompileNow]
 * @property {string} [apiUrl]
 */

/**
 * @typedef {object} CommandOptions
 * @property {readonly string[]} argv
 * @property {Writer} stdout
 * @property {Writer} stderr
 * @property {string} cwd
 * @property {() => string} createProjectId
 * @property {() => string} createSubjectId
 * @property {import("./commands/plan-init.js").FileSystem} [fileSystem]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("./commands/plan-push.js").PlanPushFileSystem} [planPushFileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [planStatusSleep]
 * @property {() => number} [planStatusNow]
 * @property {(delayMs: number) => Promise<void>} [planCompileSleep]
 * @property {() => number} [planCompileNow]
 * @property {string} [apiUrl]
 */

/**
 * @typedef {Omit<CommandOptions, "cwd"> & {cwd?: string, getCwd: () => string}} PlanCommandOptions
 */

/** @param {RunOptions} options */
export async function run({
  argv,
  stdout,
  stderr,
  cwd,
  getCwd = process.cwd,
  createProjectId = generateUuidV7,
  createSubjectId = generateUuidV7,
  fileSystem,
  fetchFunction,
  planPushFileSystem,
  createTemporaryId,
  createRequestSignal,
  planStatusSleep,
  planStatusNow,
  planCompileSleep,
  planCompileNow,
  apiUrl = process.env.FIRSTDRAFT_API_URL,
}) {
  if (argv[0] === "plan") {
    return runPlan({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd,
      getCwd,
      createProjectId,
      createSubjectId,
      fileSystem,
      fetchFunction,
      planPushFileSystem,
      createTemporaryId,
      createRequestSignal,
      planStatusSleep,
      planStatusNow,
      planCompileSleep,
      planCompileNow,
      apiUrl,
    });
  }

  return runRoot({ argv, stdout, stderr });
}

/** @param {Pick<RunOptions, "argv" | "stdout" | "stderr">} options */
function runRoot({ argv, stdout, stderr }) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );

  if (!parsed) {
    stderr.write(ROOT_USAGE_ERROR);
    return 2;
  }

  if (argv.length === 0) {
    stdout.write(ROOT_HELP);
    return 0;
  }

  if (parsed.positionals.length > 0) {
    stderr.write(ROOT_UNKNOWN_COMMAND);
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(ROOT_HELP);
    return 0;
  }

  if (parsed.values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  stdout.write(ROOT_HELP);
  return 0;
}

/** @param {PlanCommandOptions} options */
async function runPlan({
  argv,
  stdout,
  stderr,
  cwd,
  getCwd,
  createProjectId,
  createSubjectId,
  fileSystem,
  fetchFunction,
  planPushFileSystem,
  createTemporaryId,
  createRequestSignal,
  planStatusSleep,
  planStatusNow,
  planCompileSleep,
  planCompileNow,
  apiUrl,
}) {
  if (argv[0] === "init") {
    return runPlanInit({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      createProjectId,
      fileSystem,
    });
  }

  if (argv[0] === "push") {
    return runPlanPush({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      fetchFunction,
      planPushFileSystem,
      createTemporaryId,
      createRequestSignal,
      apiUrl,
    });
  }

  if (argv[0] === "status") {
    return runPlanStatus({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      fetchFunction,
      planPushFileSystem,
      createRequestSignal,
      planStatusSleep,
      planStatusNow,
    });
  }

  if (argv[0] === "compile") {
    return runPlanCompile({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      fetchFunction,
      planPushFileSystem,
      createRequestSignal,
      planCompileSleep,
      planCompileNow,
    });
  }

  if (argv[0] === "subject-id") {
    return runPlanSubjectId({
      argv: argv.slice(1),
      stdout,
      stderr,
      createSubjectId,
    });
  }

  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    }),
  );

  if (!parsed) {
    stderr.write(PLAN_USAGE_ERROR);
    return 2;
  }

  if (parsed.positionals.length > 0) {
    stderr.write(PLAN_UNKNOWN_COMMAND);
    return 2;
  }

  if (argv.length === 0 || parsed.values.help) {
    stdout.write(PLAN_HELP);
    return 0;
  }

  stdout.write(PLAN_HELP);
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "createSubjectId">} options
 */
function runPlanSubjectId({ argv, stdout, stderr, createSubjectId }) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
    }),
  );

  if (!parsed) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_SUBJECT_ID_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(PLAN_SUBJECT_ID_HELP);
    return 0;
  }

  stdout.write(`${createSubjectId()}\n`);
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createTemporaryId" | "createRequestSignal" | "apiUrl">} options
 */
async function runPlanPush({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createTemporaryId,
  createRequestSignal,
  apiUrl,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
      tokens: true,
    }),
  );

  if (!parsed || repeatedValueOption(parsed.tokens)) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_PUSH_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(PLAN_PUSH_HELP);
    return 0;
  }

  let result;
  try {
    result = await pushPlan({
      cwd,
      apiUrl,
      fetchFunction,
      fileSystem: planPushFileSystem,
      createTemporaryId,
      createRequestSignal,
    });
  } catch (error) {
    if (error instanceof PlanPushConfigurationError) {
      writeJson(stderr, {
        error: "invalid_configuration",
        detail: PLAN_PUSH_INVALID_CONFIGURATION_DETAIL,
      });
      return 2;
    }

    if (error instanceof PlanPushLocalError) {
      writeJson(stderr, {
        error: "local_input_unreadable",
        detail: PLAN_PUSH_LOCAL_INPUT_UNREADABLE_DETAIL,
      });
      return 1;
    }

    if (
      error instanceof PlanPushNetworkError ||
      error instanceof PlanPushProtocolError
    ) {
      writeJson(stderr, {
        error: "request_outcome_unknown",
        detail: PLAN_PUSH_REQUEST_OUTCOME_UNKNOWN_DETAIL,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
      });
      return 1;
    }

    if (error instanceof PlanPushStateWriteError) {
      writeJson(stderr, {
        error: "local_state_not_saved",
        detail:
          "The Plan was accepted, but its ETag could not be saved. Do not push again until local state is repaired.",
        recovery_state: error.recoveryState,
      });
      return 1;
    }

    throw error;
  }

  if (!("etag" in result)) {
    if (result.responseKind === null) {
      writeJson(stderr, {
        error: "request_outcome_unknown",
        detail: PLAN_PUSH_REQUEST_OUTCOME_UNKNOWN_DETAIL,
        status: result.status,
      });
      return 1;
    }

    const response = safeRejectedResponse(result.responseKind, result.body);
    writeJson(stderr, {
      error: "server_rejected",
      detail: PLAN_PUSH_SERVER_REJECTED_DETAIL,
      status: result.status,
      ...(response ? { response } : {}),
    });
    return 1;
  }

  writeJson(stdout, {
    outcome: result.outcome,
    etag: result.etag,
    project: result.body.project,
    foundation_plan: result.body.foundation_plan,
    diagnostics: result.body.diagnostics,
  });
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "planStatusSleep" | "planStatusNow">} options
 */
async function runPlanStatus({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  planStatusSleep,
  planStatusNow,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        wait: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
      tokens: true,
    }),
  );

  if (!parsed || repeatedValueOption(parsed.tokens)) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_STATUS_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(PLAN_STATUS_HELP);
    return 0;
  }

  let result;
  try {
    result = await readPlanStatus({
      cwd,
      wait: parsed.values.wait,
      fetchFunction,
      fileSystem: planPushFileSystem,
      createRequestSignal,
      sleep: planStatusSleep,
      now: planStatusNow,
    });
  } catch (error) {
    if (error instanceof PlanPushLocalError) {
      writeJson(stderr, {
        error: "local_input_unreadable",
        detail: PLAN_STATUS_LOCAL_INPUT_UNREADABLE_DETAIL,
      });
      return 1;
    }

    if (error instanceof PlanStatusNotPushedError) {
      writeJson(stderr, {
        error: "project_not_pushed",
        detail: PLAN_STATUS_NOT_PUSHED_DETAIL,
      });
      return 1;
    }

    if (error instanceof PlanStatusChangedError) {
      writeJson(stderr, {
        error: "analysis_changed",
        detail: PLAN_STATUS_CHANGED_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof PlanStatusTimeoutError) {
      writeJson(stderr, {
        error: "wait_timed_out",
        detail: PLAN_STATUS_TIMEOUT_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof PlanPushNetworkError) {
      writeJson(stderr, {
        error: "status_unavailable",
        detail: PLAN_STATUS_UNAVAILABLE_DETAIL,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
      });
      return 1;
    }

    if (error instanceof PlanPushProtocolError) {
      writeJson(stderr, {
        error: "invalid_server_response",
        detail: PLAN_STATUS_INVALID_RESPONSE_DETAIL,
        status: error.status,
      });
      return 1;
    }

    throw error;
  }

  if ("responseKind" in result) {
    if (result.responseKind === null) {
      writeJson(stderr, {
        error: "invalid_server_response",
        detail: PLAN_STATUS_INVALID_RESPONSE_DETAIL,
        status: result.status,
      });
      return 1;
    }

    const response = safeRejectedResponse(result.responseKind, result.body);
    writeJson(stderr, {
      error: "server_rejected",
      detail: PLAN_STATUS_SERVER_REJECTED_DETAIL,
      status: result.status,
      ...(response ? { response } : {}),
    });
    return 1;
  }

  writeJson(stdout, result.body);
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "planCompileSleep" | "planCompileNow">} options
 */
async function runPlanCompile({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  planCompileSleep,
  planCompileNow,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
      tokens: true,
    }),
  );

  if (!parsed || repeatedValueOption(parsed.tokens)) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_COMPILE_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(PLAN_COMPILE_HELP);
    return 0;
  }

  if (
    typeof parsed.values.output !== "string" ||
    parsed.values.output.length === 0 ||
    parsed.values.output.includes("\0")
  ) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_COMPILE_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  let result;
  try {
    result = await compilePlan({
      cwd,
      output: parsed.values.output,
      fetchFunction,
      fileSystem: planPushFileSystem,
      createRequestSignal,
      sleep: planCompileSleep,
      now: planCompileNow,
    });
  } catch (error) {
    if (error instanceof PlanPushLocalError) {
      writeJson(stderr, {
        error: "local_input_unreadable",
        detail: PLAN_COMPILE_LOCAL_INPUT_UNREADABLE_DETAIL,
      });
      return 1;
    }

    if (error instanceof CompilationLocalStateError) {
      writeJson(stderr, {
        error: "invalid_configuration",
        detail: PLAN_COMPILE_INCOMPATIBLE_STATE_DETAIL,
      });
      return 2;
    }

    if (error instanceof CompilationNotPushedError) {
      writeJson(stderr, {
        error: "project_not_pushed",
        detail: PLAN_COMPILE_NOT_PUSHED_DETAIL,
      });
      return 1;
    }

    if (error instanceof CompilationRequestOutcomeUnknownError) {
      writeJson(stderr, {
        error: "request_outcome_unknown",
        detail: PLAN_COMPILE_REQUEST_OUTCOME_UNKNOWN_DETAIL,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
      });
      return 1;
    }

    if (error instanceof CompilationStartRejectedError) {
      writeJson(stderr, {
        error: "compilation_start_rejected",
        detail: PLAN_COMPILE_START_REJECTED_DETAIL,
        status: error.status,
        ...(error.response ? { response: error.response } : {}),
      });
      return 1;
    }

    if (error instanceof CompilationStatusUnavailableError) {
      writeJson(stderr, {
        error: "compilation_status_unavailable",
        detail: PLAN_COMPILE_STATUS_UNAVAILABLE_DETAIL,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
        ...(error.response ? { response: error.response } : {}),
      });
      return 1;
    }

    if (error instanceof CompilationStatusInvalidError) {
      writeJson(stderr, {
        error: "invalid_compilation_status",
        detail: PLAN_COMPILE_STATUS_INVALID_DETAIL,
        status: error.status,
      });
      return 1;
    }

    if (error instanceof CompilationChangedError) {
      writeJson(stderr, {
        error: "compilation_changed",
        detail: PLAN_COMPILE_CHANGED_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof CompilationTimeoutError) {
      writeJson(stderr, {
        error: "compilation_wait_timed_out",
        detail: PLAN_COMPILE_TIMEOUT_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof CompilationFailedError) {
      writeJson(stderr, {
        error: "compilation_failed",
        detail: PLAN_COMPILE_FAILED_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof CompilationCancelledError) {
      writeJson(stderr, {
        error: "compilation_cancelled",
        detail: PLAN_COMPILE_CANCELLED_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof CompilationArtifactUnavailableError) {
      writeJson(stderr, {
        error: "artifact_unavailable",
        detail: PLAN_COMPILE_ARTIFACT_UNAVAILABLE_DETAIL,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
        ...(error.response ? { response: error.response } : {}),
      });
      return 1;
    }

    if (
      error instanceof CompilationArtifactResponseInvalidError ||
      error instanceof CompilationArtifactInvalidError
    ) {
      writeJson(stderr, {
        error: "invalid_artifact",
        detail: PLAN_COMPILE_ARTIFACT_INVALID_DETAIL,
        ...(error instanceof CompilationArtifactResponseInvalidError
          ? { status: error.status }
          : {}),
      });
      return 1;
    }

    if (error instanceof CompilationOutputPathError) {
      writeJson(stderr, {
        error: "invalid_output_path",
        detail: PLAN_COMPILE_INVALID_OUTPUT_PATH_DETAIL,
      });
      return 2;
    }

    if (error instanceof CompilationMaterializationError) {
      writeJson(stderr, {
        error: "materialization_failed",
        detail: PLAN_COMPILE_MATERIALIZATION_FAILED_DETAIL,
      });
      return 1;
    }

    throw error;
  }

  writeJson(stdout, result);
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "createProjectId" | "fileSystem">} options
 */
function runPlanInit({
  argv,
  stdout,
  stderr,
  cwd,
  createProjectId,
  fileSystem,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        "application-key": { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
      tokens: true,
    }),
  );

  if (!parsed || repeatedValueOption(parsed.tokens)) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_INIT_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(PLAN_INIT_HELP);
    return 0;
  }

  const applicationKey = parsed.values["application-key"];
  const name = parsed.values.name;
  if (
    typeof applicationKey !== "string" ||
    !/^[a-z][a-z0-9_]*$/.test(applicationKey) ||
    typeof name !== "string" ||
    !isValidApplicationName(name)
  ) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_INIT_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  const projectId = createProjectId();

  try {
    initializePlan({
      applicationKey,
      name,
      projectId,
      cwd,
      fileSystem,
    });
  } catch (error) {
    if (!isFileSystemError(error)) throw error;

    writeJson(stderr, {
      error: "local_initialization_failed",
      detail: PLAN_INIT_FAILED_DETAIL,
    });
    return 1;
  }

  stdout.write(PLAN_INIT_SUCCESS);
  return 0;
}

/** @param {string} name */
function isValidApplicationName(name) {
  let hasNonWhitespace = false;

  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xfffe) === 0xfffe
    ) {
      return false;
    }

    if (!isUnicodeWhitespace(codePoint)) hasNonWhitespace = true;
  }

  return hasNonWhitespace;
}

/** @param {number} codePoint */
function isUnicodeWhitespace(codePoint) {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

/**
 * @template T
 * @param {() => T} callback
 * @returns {T | null}
 */
function parseArguments(callback) {
  try {
    return callback();
  } catch (error) {
    if (!isParseArgsError(error)) throw error;

    return null;
  }
}

/** @param {readonly {kind: string, name?: string}[]} tokens */
function repeatedValueOption(tokens) {
  const names = tokens
    .filter(
      (token) =>
        token.kind === "option" &&
        typeof token.name === "string" &&
        token.name !== "help",
    )
    .map((token) => token.name);

  return new Set(names).size !== names.length;
}

/** @param {unknown} error */
function isParseArgsError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

/** @param {Writer} writer @param {unknown} value */
function writeJson(writer, value) {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {"diagnostics" | "problem" | null} responseKind
 * @param {Record<string, unknown> | null} body
 */
function safeRejectedResponse(responseKind, body) {
  if (
    responseKind === "diagnostics" &&
    body &&
    Array.isArray(body.diagnostics)
  ) {
    return {
      source_sha256: body.source_sha256,
      diagnostics: body.diagnostics.map(safeDiagnostic),
    };
  }

  if (responseKind === "problem" && body) {
    return {
      ...(body.type === "about:blank" ? { type: body.type } : {}),
      title: body.title,
      status: body.status,
      code: body.code,
      detail: body.detail,
    };
  }

  return null;
}

/** @param {unknown} value */
function safeDiagnostic(value) {
  if (!isRecord(value)) return {};

  const location = safeSourceLocation(value.location);
  const subject = safeDiagnosticSubject(value.subject);
  const relatedLocations = safeSourceLocations(value.related_locations);
  const suggestions = safeSuggestions(value.suggestions);

  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(value.severity === "error" || value.severity === "warning"
      ? { severity: value.severity }
      : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(location ? { location } : {}),
    ...(value.subject === null ? { subject: null } : {}),
    ...(subject ? { subject } : {}),
    ...(relatedLocations ? { related_locations: relatedLocations } : {}),
    ...(suggestions ? { suggestions } : {}),
  };
}

/** @param {unknown} value */
function safeSourceLocations(value) {
  if (!Array.isArray(value)) return null;

  const locations = value.map(safeSourceLocation);
  return locations.every(Boolean) ? locations : null;
}

/** @param {unknown} value */
function safeSuggestions(value) {
  if (
    !Array.isArray(value) ||
    !value.every((suggestion) => typeof suggestion === "string")
  ) {
    return null;
  }

  return value;
}

/** @param {unknown} value */
function safeSourceLocation(value) {
  if (!isRecord(value)) return null;

  if (typeof value.source_pointer === "string") {
    return { source_pointer: value.source_pointer };
  }

  if (
    Number.isSafeInteger(value.line) &&
    Number(value.line) > 0 &&
    Number.isSafeInteger(value.column) &&
    Number(value.column) > 0
  ) {
    return { line: value.line, column: value.column };
  }

  return null;
}

/** @param {unknown} value */
function safeDiagnosticSubject(value) {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.readable_path !== "string" ||
    (value.subject_uuid !== undefined && typeof value.subject_uuid !== "string")
  ) {
    return null;
  }

  return {
    kind: value.kind,
    readable_path: value.readable_path,
    ...(typeof value.subject_uuid === "string"
      ? { subject_uuid: value.subject_uuid }
      : {}),
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
