import { parseArgs } from "node:util";

import {
  deriveApplicationKey,
  deriveApplicationName,
  isValidApplicationKey,
  isValidApplicationName,
} from "./application-identity.js";
import {
  authenticatedFetch,
  isAuthenticationProblem,
} from "./api-authentication.js";
import {
  CompilationArtifactInvalidError,
  CompilationArtifactResponseInvalidError,
  CompilationArtifactUnavailableError,
  CompilationChangedError,
  CompilationMaterializationError,
  CompilationNotSucceededError,
  CompilationNotPushedError,
  CompilationOutputPathError,
  CompilationStatusInvalidError,
  CompilationStatusUnavailableError,
  CompilationTimeoutError,
  downloadCompilation,
  readCompilation,
} from "./commands/compilation.js";
import {
  PlanCompileAnalysisInvalidError,
  PlanCompileAnalysisNotValidError,
  PlanCompileAnalysisRejectedError,
  PlanCompileAnalysisUnavailableError,
  PlanCompilePushRejectedError,
  compilePlan,
} from "./commands/plan-compile.js";
import { initializePlan } from "./commands/plan-init.js";
import {
  PublicationCancelledError,
  PublicationChangedError,
  PublicationFailedError,
  PublicationLocalPlanChangedError,
  PublicationLocalStateError,
  PublicationNotPushedError,
  PublicationRequestOutcomeUnknownError,
  PublicationStartRejectedError,
  PublicationStatusInvalidError,
  PublicationStatusUnavailableError,
  PublicationTimeoutError,
} from "./commands/plan-publish.js";
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
import { createPlanCompileProgressReporter } from "./plan-compile-progress.js";
import { isUuidV7 } from "./plan-state.js";
import { generateUuidV7 } from "./uuid-v7.js";
import { VERSION } from "./version.js";

const ROOT_HELP = `First Draft CLI

Usage:
  firstdraft <command> [options]
  firstdraft [options]

Commands:
  compilation  Inspect and download Compilations
  generate     Generate local values
  plan         Work with Foundation Plans

Options:
  -h, --help     Show help
  -V, --version  Show version
`;

const PLAN_HELP = `First Draft CLI

Usage:
  firstdraft plan <command> [options]

Commands:
  init     Create a local empty Foundation Plan
  push     Send the local Foundation Plan to First Draft
  status   Read the current whole-graph analysis status
  compile  Compile and publish the current Foundation Plan

Options:
  -h, --help  Show help
`;

const GENERATE_HELP = `First Draft CLI

Usage:
  firstdraft generate <command> [options]

Commands:
  uuid             Generate one or more UUIDv7 values
  application-key  Derive a lower-snake-case application key

Options:
  -h, --help  Show help
`;

const GENERATE_UUID_HELP = `First Draft CLI

Usage:
  firstdraft generate uuid [--count <n>]

Options:
      --count <n>  Number to generate (positive integer)
  -h, --help       Show help

The command reads no files and makes no network request. Each UUID is printed
on its own line.
`;

const GENERATE_APPLICATION_KEY_HELP = `First Draft CLI

Usage:
  firstdraft generate application-key --name <name>

Options:
      --name <name>  Application display name
  -h, --help         Show help

The command derives the same application key used by name-only plan init.
Generated keys are at most 63 ASCII bytes.
`;

const PLAN_PUSH_HELP = `First Draft CLI

Usage:
  firstdraft plan push

Options:
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests
  FIRSTDRAFT_API_URL    Override the initial API origin

The first successful push saves its API origin in .firstdraft/state.json.
Later pushes reject a different origin.
`;

const PLAN_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft plan status [--wait]

Options:
      --wait  Poll until the current analysis reaches a terminal status
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests

The command uses only the API origin pinned by a successful plan push.
Without --wait, it makes exactly one status request.
`;

const PLAN_COMPILE_HELP = `First Draft CLI

Usage:
  firstdraft plan compile

Options:
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests
  FIRSTDRAFT_API_URL    Override the initial API origin

The command submits the exact current whole-file Plan, waits for its analysis,
and proceeds only when that analysis is valid. It then conditionally creates or
replays the internal GitHub Publication lifecycle. Progress is written to
stderr. Success prints only the validated private GitHub repository URL.
`;

const COMPILATION_HELP = `First Draft CLI

Usage:
  firstdraft compilation <command> [options]

Commands:
  status    Read one retained Compilation
  download  Download one successful Compilation artifact

Options:
  -h, --help  Show help
`;

const COMPILATION_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft compilation status <compilation-id> [--wait]

Options:
      --wait  Poll until the Compilation reaches a terminal status
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests

Without --wait, the command makes exactly one metadata-only GET. With --wait,
it polls the same retained Compilation for at most ten minutes. Failed and
cancelled terminal states are successful status reads.
`;

const COMPILATION_DOWNLOAD_HELP = `First Draft CLI

Usage:
  firstdraft compilation download <compilation-id> --output <absent-path>

Options:
      --output <absent-path>  Materialize the generated application here
  -h, --help                  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests

The command reads the retained Compilation once, requires it to have
succeeded, downloads and verifies its exact artifact once, and atomically
renames the verified files into an absent output path. It never starts work.
`;

const PLAN_INIT_HELP = `First Draft CLI

Usage:
  firstdraft plan init [--application-key <key>] [--name <name>]

Options:
      --application-key <key>  Lower-snake-case application key
      --name <name>            Application display name
  -h, --help                   Show help

Provide at least one of --application-key or --name. The command derives a
missing key from the name or a missing display name from the key.
`;

const ROOT_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft --help' for usage.\n";
const ROOT_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft --help' for usage.\n";
const GENERATE_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft generate --help' for usage.\n";
const GENERATE_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft generate --help' for usage.\n";
const COMPILATION_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft compilation --help' for usage.\n";
const COMPILATION_UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft compilation --help' for usage.\n";
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
const AUTHENTICATION_REQUIRED_DETAIL =
  "First Draft authentication is required. Set FIRSTDRAFT_API_TOKEN to an active API token.";
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
  "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.";
const PLAN_COMPILE_INCOMPATIBLE_STATE_DETAIL =
  "The configured API origin or saved Foundation Plan state is incompatible with compilation. No network request was made.";
const PLAN_COMPILE_NOT_PUSHED_DETAIL =
  "The current Foundation Plan could not be associated with a pushed Project.";
const PLAN_COMPILE_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "The current Plan may have been accepted, but its response could not be verified. Stop and reconcile before compiling again.";
const PLAN_COMPILE_PLAN_REJECTED_DETAIL =
  "First Draft rejected the current Foundation Plan.";
const PLAN_COMPILE_ANALYSIS_REJECTED_DETAIL =
  "First Draft rejected the current analysis status request.";
const PLAN_COMPILE_ANALYSIS_NOT_VALID_DETAIL =
  "The current Foundation Plan analysis is not valid. Inspect its status and diagnostics before compiling again.";
const PLAN_PUBLISH_INCOMPATIBLE_STATE_DETAIL =
  "The saved Foundation Plan ETag is incompatible with publication. No network request was made; reconcile the CLI and server contract.";
const PLAN_PUBLISH_NOT_PUSHED_DETAIL =
  "The current Foundation Plan was not retained before the Publication request.";
const PLAN_PUBLISH_LOCAL_PLAN_CHANGED_DETAIL =
  "The local Foundation Plan changed after validation. Run 'firstdraft plan compile' again to submit the current bytes.";
const PLAN_PUBLISH_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "The Publication may have started, but its retained singleton status could not be verified. No mutation was retried. Do not run concurrent Compile commands. Wait, then rerun 'firstdraft plan compile' with unchanged Plan bytes to safely reconcile or resume the retained singleton.";
const PLAN_PUBLISH_START_REJECTED_DETAIL =
  "First Draft rejected the publication request.";
const PLAN_PUBLISH_STATUS_UNAVAILABLE_DETAIL =
  "Could not read the retained Publication status. The command stopped without starting another Publication. Do not run concurrent Compile commands. Wait, then rerun 'firstdraft plan compile' with unchanged Plan bytes to safely resume the retained singleton.";
const PLAN_PUBLISH_STATUS_INVALID_DETAIL =
  "First Draft returned an invalid publication status response. Retrying unchanged will not repair this protocol mismatch.";
const PLAN_PUBLISH_CHANGED_DETAIL =
  "The pinned Publication changed while being polled. The command stopped without following a replacement.";
const PLAN_PUBLISH_TIMEOUT_DETAIL =
  "The retained Publication is still processing after the bounded ten-minute wait. This invocation stopped waiting, but retained work may continue. Do not run concurrent Compile commands. Wait, then rerun 'firstdraft plan compile' with unchanged Plan bytes to safely resume the retained singleton.";
const PLAN_PUBLISH_FAILED_DETAIL =
  "The pinned Publication failed. Its validated status identifies the failed phase.";
const PLAN_PUBLISH_CANCELLED_DETAIL = "The pinned Publication was cancelled.";
const COMPILATION_STATUS_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft compilation status --help' for usage.";
const COMPILATION_DOWNLOAD_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft compilation download --help' for usage.";
const COMPILATION_LOCAL_INPUT_UNREADABLE_DETAIL =
  "Could not read valid local First Draft state. No network request was made.";
const COMPILATION_NOT_PUSHED_DETAIL =
  "The local Project has no pinned API origin. Run 'firstdraft plan push' first.";
const COMPILATION_STATUS_UNAVAILABLE_DETAIL =
  "Could not read the requested Compilation status. This read-only request is safe to retry.";
const COMPILATION_STATUS_INVALID_DETAIL =
  "First Draft returned an invalid Compilation status response. Retrying unchanged will not repair this protocol mismatch.";
const COMPILATION_CHANGED_DETAIL =
  "The retained Compilation identity, provenance, or lifecycle progression changed while waiting.";
const COMPILATION_TIMEOUT_DETAIL =
  "The retained Compilation is still processing after the bounded ten-minute wait.";
const COMPILATION_NOT_SUCCEEDED_DETAIL =
  "The requested Compilation has not succeeded, so no artifact was downloaded.";
const COMPILATION_ARTIFACT_UNAVAILABLE_DETAIL =
  "Could not download the requested Compilation artifact. No files were materialized.";
const COMPILATION_ARTIFACT_INVALID_DETAIL =
  "The downloaded Compilation artifact did not satisfy the integrity contract. No files were materialized.";
const COMPILATION_MATERIALIZATION_FAILED_DETAIL =
  "The validated Compilation artifact could not be materialized at the requested absent output path.";
const COMPILATION_INVALID_OUTPUT_PATH_DETAIL =
  "The compilation output path must be absent beneath an existing real directory. No network request was made.";
const GENERATE_UUID_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft generate uuid --help' for usage.";
const GENERATE_APPLICATION_KEY_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft generate application-key --help' for usage.";

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
 * @property {() => string} [createUuid]
 * @property {import("./commands/plan-init.js").FileSystem} [fileSystem]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("./commands/plan-push.js").PlanPushFileSystem} [planPushFileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [planStatusSleep]
 * @property {() => number} [planStatusNow]
 * @property {(delayMs: number) => Promise<void>} [planCompileSleep]
 * @property {() => number} [planCompileNow]
 * @property {(delayMs: number) => Promise<void>} [planPublishSleep]
 * @property {() => number} [planPublishNow]
 * @property {(delayMs: number) => Promise<void>} [compilationSleep]
 * @property {() => number} [compilationNow]
 * @property {typeof pushPlan} [planCompilePush]
 * @property {typeof readPlanStatus} [planCompileReadStatus]
 * @property {typeof import("./commands/plan-publish.js").publishPlan} [planCompilePublish]
 * @property {string} [apiUrl]
 * @property {string} [apiToken]
 */

/**
 * @typedef {object} CommandOptions
 * @property {readonly string[]} argv
 * @property {Writer} stdout
 * @property {Writer} stderr
 * @property {string} cwd
 * @property {() => string} createProjectId
 * @property {() => string} createUuid
 * @property {import("./commands/plan-init.js").FileSystem} [fileSystem]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("./commands/plan-push.js").PlanPushFileSystem} [planPushFileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [planStatusSleep]
 * @property {() => number} [planStatusNow]
 * @property {(delayMs: number) => Promise<void>} [planCompileSleep]
 * @property {() => number} [planCompileNow]
 * @property {(delayMs: number) => Promise<void>} [planPublishSleep]
 * @property {() => number} [planPublishNow]
 * @property {(delayMs: number) => Promise<void>} [compilationSleep]
 * @property {() => number} [compilationNow]
 * @property {typeof pushPlan} [planCompilePush]
 * @property {typeof readPlanStatus} [planCompileReadStatus]
 * @property {typeof import("./commands/plan-publish.js").publishPlan} [planCompilePublish]
 * @property {string} [apiUrl]
 * @property {string} [apiToken]
 */

/**
 * @typedef {Omit<CommandOptions, "cwd" | "createUuid"> & {cwd?: string, getCwd: () => string}} PlanCommandOptions
 */

/**
 * @typedef {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "createUuid">} GenerateCommandOptions
 */

/**
 * @typedef {Omit<CommandOptions, "cwd" | "createProjectId" | "createUuid" | "fileSystem" | "createTemporaryId" | "planStatusSleep" | "planStatusNow" | "planCompileSleep" | "planCompileNow" | "planPublishSleep" | "planPublishNow" | "apiUrl" | "planCompilePush" | "planCompileReadStatus" | "planCompilePublish"> & {cwd?: string, getCwd: () => string}} CompilationCommandOptions
 */

/** @param {RunOptions} options */
export async function run({
  argv,
  stdout,
  stderr,
  cwd,
  getCwd = process.cwd,
  createProjectId = generateUuidV7,
  createUuid = generateUuidV7,
  fileSystem,
  fetchFunction,
  planPushFileSystem,
  createTemporaryId,
  createRequestSignal,
  planStatusSleep,
  planStatusNow,
  planCompileSleep,
  planCompileNow,
  planPublishSleep,
  planPublishNow,
  compilationSleep,
  compilationNow,
  planCompilePush,
  planCompileReadStatus,
  planCompilePublish,
  apiUrl = process.env.FIRSTDRAFT_API_URL,
  apiToken = process.env.FIRSTDRAFT_API_TOKEN,
}) {
  if (argv[0] === "generate") {
    return runGenerate({
      argv: argv.slice(1),
      stdout,
      stderr,
      createUuid,
    });
  }

  if (argv[0] === "plan") {
    return runPlan({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd,
      getCwd,
      createProjectId,
      fileSystem,
      fetchFunction,
      planPushFileSystem,
      createTemporaryId,
      createRequestSignal,
      planStatusSleep,
      planStatusNow,
      planCompileSleep,
      planCompileNow,
      planPublishSleep,
      planPublishNow,
      planCompilePush,
      planCompileReadStatus,
      planCompilePublish,
      apiUrl,
      apiToken,
    });
  }

  if (argv[0] === "compilation") {
    return runCompilation({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd,
      getCwd,
      fetchFunction,
      planPushFileSystem,
      createRequestSignal,
      compilationSleep,
      compilationNow,
      apiToken,
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
  fileSystem,
  fetchFunction,
  planPushFileSystem,
  createTemporaryId,
  createRequestSignal,
  planStatusSleep,
  planStatusNow,
  planCompileSleep,
  planCompileNow,
  planPublishSleep,
  planPublishNow,
  planCompilePush,
  planCompileReadStatus,
  planCompilePublish,
  apiUrl,
  apiToken,
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
      apiToken,
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
      apiToken,
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
      createTemporaryId,
      createRequestSignal,
      planCompileSleep,
      planCompileNow,
      planPublishSleep,
      planPublishNow,
      planCompilePush,
      planCompileReadStatus,
      planCompilePublish,
      apiUrl,
      apiToken,
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

/** @param {CompilationCommandOptions} options */
async function runCompilation({
  argv,
  stdout,
  stderr,
  cwd,
  getCwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  compilationSleep,
  compilationNow,
  apiToken,
}) {
  if (argv[0] === "status") {
    return runCompilationStatus({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      fetchFunction,
      planPushFileSystem,
      createRequestSignal,
      compilationSleep,
      compilationNow,
      apiToken,
    });
  }

  if (argv[0] === "download") {
    return runCompilationDownload({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      fetchFunction,
      planPushFileSystem,
      createRequestSignal,
      apiToken,
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
    stderr.write(COMPILATION_USAGE_ERROR);
    return 2;
  }

  if (parsed.positionals.length > 0) {
    stderr.write(COMPILATION_UNKNOWN_COMMAND);
    return 2;
  }

  if (argv.length === 0 || parsed.values.help) {
    stdout.write(COMPILATION_HELP);
    return 0;
  }

  stdout.write(COMPILATION_HELP);
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "compilationSleep" | "compilationNow" | "apiToken">} options
 */
async function runCompilationStatus({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  compilationSleep,
  compilationNow,
  apiToken,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        wait: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    }),
  );

  if (!parsed || repeatedValueOption(parsed.tokens)) {
    writeCompilationInvalidArguments(
      stderr,
      COMPILATION_STATUS_INVALID_ARGUMENTS_DETAIL,
    );
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(COMPILATION_STATUS_HELP);
    return 0;
  }

  const [compilationId] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !isUuidV7(compilationId)) {
    writeCompilationInvalidArguments(
      stderr,
      COMPILATION_STATUS_INVALID_ARGUMENTS_DETAIL,
    );
    return 2;
  }

  const authorizedFetch = authenticatedFetch(fetchFunction, apiToken);
  if (authorizedFetch === null) {
    writeAuthenticationRequired(stderr);
    return 1;
  }

  try {
    const result = await readCompilation({
      cwd,
      compilationId,
      wait: parsed.values.wait,
      fetchFunction: authorizedFetch,
      fileSystem: planPushFileSystem,
      createRequestSignal,
      sleep: compilationSleep,
      now: compilationNow,
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    const status = writeCompilationReadError(stderr, error, false);
    if (status !== null) return status;
    throw error;
  }
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "apiToken">} options
 */
async function runCompilationDownload({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  apiToken,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    }),
  );

  if (!parsed || repeatedValueOption(parsed.tokens)) {
    writeCompilationInvalidArguments(
      stderr,
      COMPILATION_DOWNLOAD_INVALID_ARGUMENTS_DETAIL,
    );
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(COMPILATION_DOWNLOAD_HELP);
    return 0;
  }

  const [compilationId] = parsed.positionals;
  const output = parsed.values.output;
  if (
    parsed.positionals.length !== 1 ||
    !isUuidV7(compilationId) ||
    typeof output !== "string" ||
    output.length === 0
  ) {
    writeCompilationInvalidArguments(
      stderr,
      COMPILATION_DOWNLOAD_INVALID_ARGUMENTS_DETAIL,
    );
    return 2;
  }

  const authorizedFetch = authenticatedFetch(fetchFunction, apiToken);
  if (authorizedFetch === null) {
    writeAuthenticationRequired(stderr);
    return 1;
  }

  try {
    const result = await downloadCompilation({
      cwd,
      compilationId,
      output,
      fetchFunction: authorizedFetch,
      fileSystem: planPushFileSystem,
      createRequestSignal,
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    const readStatus = writeCompilationReadError(stderr, error, false);
    if (readStatus !== null) return readStatus;

    if (error instanceof CompilationNotSucceededError) {
      writeJson(stderr, {
        error: "compilation_not_succeeded",
        detail: COMPILATION_NOT_SUCCEEDED_DETAIL,
        current: error.current,
      });
      return 1;
    }

    if (error instanceof CompilationArtifactUnavailableError) {
      if (isAuthenticationProblem(error.status, error.response)) {
        writeAuthenticationRequired(
          stderr,
          error.status,
          /** @type {Record<string, unknown>} */ (error.response),
        );
        return 1;
      }
      writeJson(stderr, {
        error: "artifact_unavailable",
        detail: COMPILATION_ARTIFACT_UNAVAILABLE_DETAIL,
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
        detail: COMPILATION_ARTIFACT_INVALID_DETAIL,
        ...(error instanceof CompilationArtifactResponseInvalidError
          ? { status: error.status }
          : {}),
      });
      return 1;
    }

    if (error instanceof CompilationOutputPathError) {
      writeJson(stderr, {
        error: "invalid_output_path",
        detail: COMPILATION_INVALID_OUTPUT_PATH_DETAIL,
      });
      return 2;
    }

    if (error instanceof CompilationMaterializationError) {
      writeJson(stderr, {
        error: "materialization_failed",
        detail: COMPILATION_MATERIALIZATION_FAILED_DETAIL,
      });
      return 1;
    }

    throw error;
  }
}

/** @param {Writer} writer @param {string} detail */
function writeCompilationInvalidArguments(writer, detail) {
  writeJson(writer, { error: "invalid_arguments", detail });
}

/**
 * @param {Writer} writer
 * @param {unknown} error
 * @param {boolean} [throwUnknown]
 */
function writeCompilationReadError(writer, error, throwUnknown = true) {
  if (error instanceof PlanPushLocalError) {
    writeJson(writer, {
      error: "local_input_unreadable",
      detail: COMPILATION_LOCAL_INPUT_UNREADABLE_DETAIL,
    });
    return 1;
  }

  if (error instanceof CompilationNotPushedError) {
    writeJson(writer, {
      error: "project_not_pushed",
      detail: COMPILATION_NOT_PUSHED_DETAIL,
    });
    return 1;
  }

  if (error instanceof CompilationStatusUnavailableError) {
    if (isAuthenticationProblem(error.status, error.response)) {
      writeAuthenticationRequired(
        writer,
        error.status,
        /** @type {Record<string, unknown>} */ (error.response),
      );
      return 1;
    }
    writeJson(writer, {
      error: "compilation_status_unavailable",
      detail: COMPILATION_STATUS_UNAVAILABLE_DETAIL,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
      ...(error.response ? { response: error.response } : {}),
    });
    return 1;
  }

  if (error instanceof CompilationStatusInvalidError) {
    writeJson(writer, {
      error: "invalid_compilation_status",
      detail: COMPILATION_STATUS_INVALID_DETAIL,
      status: error.status,
    });
    return 1;
  }

  if (error instanceof CompilationChangedError) {
    writeJson(writer, {
      error: "compilation_changed",
      detail: COMPILATION_CHANGED_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (error instanceof CompilationTimeoutError) {
    writeJson(writer, {
      error: "compilation_wait_timed_out",
      detail: COMPILATION_TIMEOUT_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (throwUnknown) throw error;
  return null;
}

/**
 * @param {GenerateCommandOptions} options
 */
function runGenerate({ argv, stdout, stderr, createUuid }) {
  if (argv[0] === "uuid") {
    return runGenerateUuid({
      argv: argv.slice(1),
      stdout,
      stderr,
      createUuid,
    });
  }

  if (argv[0] === "application-key") {
    return runGenerateApplicationKey({
      argv: argv.slice(1),
      stdout,
      stderr,
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
    stderr.write(GENERATE_USAGE_ERROR);
    return 2;
  }

  if (parsed.positionals.length > 0) {
    stderr.write(GENERATE_UNKNOWN_COMMAND);
    return 2;
  }

  if (argv.length === 0 || parsed.values.help) {
    stdout.write(GENERATE_HELP);
    return 0;
  }

  stdout.write(GENERATE_HELP);
  return 0;
}

/** @param {GenerateCommandOptions} options */
function runGenerateUuid({ argv, stdout, stderr, createUuid }) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        count: { type: "string" },
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
      detail: GENERATE_UUID_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(GENERATE_UUID_HELP);
    return 0;
  }

  const count = parseUuidCount(parsed.values.count);
  if (count === null) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: GENERATE_UUID_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  for (let index = 0; index < count; index += 1) {
    stdout.write(`${createUuid()}\n`);
  }
  return 0;
}

/**
 * @param {Pick<GenerateCommandOptions, "argv" | "stdout" | "stderr">} options
 */
function runGenerateApplicationKey({ argv, stdout, stderr }) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
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
      detail: GENERATE_APPLICATION_KEY_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(GENERATE_APPLICATION_KEY_HELP);
    return 0;
  }

  if (!isValidApplicationName(parsed.values.name)) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: GENERATE_APPLICATION_KEY_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  stdout.write(`${deriveApplicationKey(parsed.values.name)}\n`);
  return 0;
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createTemporaryId" | "createRequestSignal" | "apiUrl" | "apiToken">} options
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
  apiToken,
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

  const authorizedFetch = authenticatedFetch(fetchFunction, apiToken);
  if (authorizedFetch === null) {
    writeAuthenticationRequired(stderr);
    return 1;
  }

  let result;
  try {
    result = await pushPlan({
      cwd,
      apiUrl,
      fetchFunction: authorizedFetch,
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
    if (isAuthenticationProblem(result.status, response)) {
      writeAuthenticationRequired(stderr, result.status, response);
      return 1;
    }
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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "planStatusSleep" | "planStatusNow" | "apiToken">} options
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
  apiToken,
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

  const authorizedFetch = authenticatedFetch(fetchFunction, apiToken);
  if (authorizedFetch === null) {
    writeAuthenticationRequired(stderr);
    return 1;
  }

  let result;
  try {
    result = await readPlanStatus({
      cwd,
      wait: parsed.values.wait,
      fetchFunction: authorizedFetch,
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
    if (isAuthenticationProblem(result.status, response)) {
      writeAuthenticationRequired(stderr, result.status, response);
      return 1;
    }
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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createTemporaryId" | "createRequestSignal" | "planCompileSleep" | "planCompileNow" | "planPublishSleep" | "planPublishNow" | "planCompilePush" | "planCompileReadStatus" | "planCompilePublish" | "apiUrl" | "apiToken">} options
 */
async function runPlanCompile({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createTemporaryId,
  createRequestSignal,
  planCompileSleep,
  planCompileNow,
  planPublishSleep,
  planPublishNow,
  planCompilePush,
  planCompileReadStatus,
  planCompilePublish,
  apiUrl,
  apiToken,
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
      detail: PLAN_COMPILE_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(PLAN_COMPILE_HELP);
    return 0;
  }

  const authorizedFetch = authenticatedFetch(fetchFunction, apiToken);
  if (authorizedFetch === null) {
    writeAuthenticationRequired(stderr);
    return 1;
  }

  let result;
  const reportProgress = createPlanCompileProgressReporter(stderr);
  try {
    result = await compilePlan({
      cwd,
      apiUrl,
      fetchFunction: authorizedFetch,
      fileSystem: planPushFileSystem,
      createTemporaryId,
      createRequestSignal,
      analysisSleep: planCompileSleep,
      analysisNow: planCompileNow,
      publicationSleep: planPublishSleep,
      publicationNow: planPublishNow,
      push: planCompilePush,
      readStatus: planCompileReadStatus,
      publish: planCompilePublish,
      onProgress: reportProgress,
    });
  } catch (error) {
    return writePlanCompileError(stderr, error);
  }

  const repository =
    /** @type {NonNullable<typeof result.publication.repository>} */ (
      result.publication.repository
    );
  stdout.write(`${repository.html_url}\n`);
  return 0;
}

/** @param {Writer} writer @param {unknown} error */
function writePlanCompileError(writer, error) {
  if (error instanceof PlanPushConfigurationError) {
    writeJson(writer, {
      error: "invalid_configuration",
      detail: PLAN_COMPILE_INCOMPATIBLE_STATE_DETAIL,
    });
    return 2;
  }

  if (error instanceof PlanPushLocalError) {
    writeJson(writer, {
      error: "local_input_unreadable",
      detail: PLAN_COMPILE_LOCAL_INPUT_UNREADABLE_DETAIL,
    });
    return 1;
  }

  if (
    error instanceof PlanPushNetworkError ||
    error instanceof PlanPushProtocolError
  ) {
    writeJson(writer, {
      error: "request_outcome_unknown",
      phase: "push",
      detail: PLAN_COMPILE_REQUEST_OUTCOME_UNKNOWN_DETAIL,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    });
    return 1;
  }

  if (error instanceof PlanPushStateWriteError) {
    writeJson(writer, {
      error: "local_state_not_saved",
      detail:
        "The Plan was accepted, but its ETag could not be saved. Do not compile again until local state is repaired.",
      recovery_state: error.recoveryState,
    });
    return 1;
  }

  if (error instanceof PlanCompilePushRejectedError) {
    const { result } = error;
    if (result.responseKind === null) {
      writeJson(writer, {
        error: "request_outcome_unknown",
        phase: "push",
        detail: PLAN_COMPILE_REQUEST_OUTCOME_UNKNOWN_DETAIL,
        status: result.status,
      });
      return 1;
    }

    const response = safeRejectedResponse(result.responseKind, result.body);
    if (isAuthenticationProblem(result.status, response)) {
      writeAuthenticationRequired(writer, result.status, response);
      return 1;
    }
    writeJson(writer, {
      error: "server_rejected",
      detail: PLAN_COMPILE_PLAN_REJECTED_DETAIL,
      status: result.status,
      ...(response ? { response } : {}),
    });
    return 1;
  }

  if (error instanceof PlanStatusNotPushedError) {
    writeJson(writer, {
      error: "project_not_pushed",
      detail: PLAN_COMPILE_NOT_PUSHED_DETAIL,
    });
    return 1;
  }

  if (error instanceof PlanStatusChangedError) {
    writeJson(writer, {
      error: "analysis_changed",
      detail: PLAN_STATUS_CHANGED_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (error instanceof PlanStatusTimeoutError) {
    writeJson(writer, {
      error: "analysis_wait_timed_out",
      detail: PLAN_STATUS_TIMEOUT_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (error instanceof PlanCompileAnalysisUnavailableError) {
    writeJson(writer, {
      error: "analysis_status_unavailable",
      detail: PLAN_STATUS_UNAVAILABLE_DETAIL,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    });
    return 1;
  }

  if (error instanceof PlanCompileAnalysisInvalidError) {
    writeJson(writer, {
      error: "invalid_analysis_status",
      detail: PLAN_STATUS_INVALID_RESPONSE_DETAIL,
      status: error.status,
    });
    return 1;
  }

  if (error instanceof PlanCompileAnalysisRejectedError) {
    const { result } = error;
    if (result.responseKind === null) {
      writeJson(writer, {
        error: "invalid_analysis_status",
        detail: PLAN_STATUS_INVALID_RESPONSE_DETAIL,
        status: result.status,
      });
      return 1;
    }

    const response = safeRejectedResponse(result.responseKind, result.body);
    if (isAuthenticationProblem(result.status, response)) {
      writeAuthenticationRequired(writer, result.status, response);
      return 1;
    }
    writeJson(writer, {
      error: "analysis_status_rejected",
      detail: PLAN_COMPILE_ANALYSIS_REJECTED_DETAIL,
      status: result.status,
      ...(response ? { response } : {}),
    });
    return 1;
  }

  if (error instanceof PlanCompileAnalysisNotValidError) {
    writeJson(writer, {
      error: "plan_not_valid",
      detail: PLAN_COMPILE_ANALYSIS_NOT_VALID_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (error instanceof PublicationLocalStateError) {
    writeJson(writer, {
      error: "invalid_configuration",
      detail: PLAN_PUBLISH_INCOMPATIBLE_STATE_DETAIL,
    });
    return 2;
  }

  if (error instanceof PublicationNotPushedError) {
    writeJson(writer, {
      error: "project_not_pushed",
      detail: PLAN_PUBLISH_NOT_PUSHED_DETAIL,
    });
    return 1;
  }

  if (error instanceof PublicationLocalPlanChangedError) {
    writeJson(writer, {
      error: "local_plan_changed",
      detail: PLAN_PUBLISH_LOCAL_PLAN_CHANGED_DETAIL,
    });
    return 1;
  }

  if (
    (error instanceof PublicationStartRejectedError ||
      error instanceof PublicationStatusUnavailableError) &&
    isAuthenticationProblem(error.status, error.response)
  ) {
    writeAuthenticationRequired(
      writer,
      error.status,
      /** @type {Record<string, unknown>} */ (error.response),
    );
    return 1;
  }

  if (error instanceof PublicationRequestOutcomeUnknownError) {
    writeJson(writer, {
      error: "request_outcome_unknown",
      phase: "publication",
      detail: PLAN_PUBLISH_REQUEST_OUTCOME_UNKNOWN_DETAIL,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
      ...(error.response ? { response: error.response } : {}),
    });
    return 1;
  }

  if (error instanceof PublicationStartRejectedError) {
    writeJson(writer, {
      error: "publication_start_rejected",
      detail: PLAN_PUBLISH_START_REJECTED_DETAIL,
      status: error.status,
      response: error.response,
    });
    return 1;
  }

  if (error instanceof PublicationStatusUnavailableError) {
    writeJson(writer, {
      error: "publication_status_unavailable",
      detail: PLAN_PUBLISH_STATUS_UNAVAILABLE_DETAIL,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
      ...(error.response ? { response: error.response } : {}),
    });
    return 1;
  }

  if (error instanceof PublicationStatusInvalidError) {
    writeJson(writer, {
      error: "invalid_publication_status",
      detail: PLAN_PUBLISH_STATUS_INVALID_DETAIL,
      status: error.status,
    });
    return 1;
  }

  if (error instanceof PublicationChangedError) {
    writeJson(writer, {
      error: "publication_changed",
      detail: PLAN_PUBLISH_CHANGED_DETAIL,
      current: error.current,
      rejected: error.rejected,
    });
    return 1;
  }

  if (error instanceof PublicationTimeoutError) {
    writeJson(writer, {
      error: "publication_wait_timed_out",
      detail: PLAN_PUBLISH_TIMEOUT_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (error instanceof PublicationFailedError) {
    writeJson(writer, {
      error: "publication_failed",
      detail: PLAN_PUBLISH_FAILED_DETAIL,
      current: error.current,
    });
    return 1;
  }

  if (error instanceof PublicationCancelledError) {
    writeJson(writer, {
      error: "publication_cancelled",
      detail: PLAN_PUBLISH_CANCELLED_DETAIL,
      current: error.current,
    });
    return 1;
  }

  throw error;
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

  const providedApplicationKey = parsed.values["application-key"];
  const providedName = parsed.values.name;
  if (
    (providedApplicationKey !== undefined &&
      !isValidApplicationKey(providedApplicationKey)) ||
    (providedName !== undefined && !isValidApplicationName(providedName)) ||
    (providedApplicationKey === undefined && providedName === undefined)
  ) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_INIT_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  let applicationKey;
  let name;
  if (providedApplicationKey !== undefined) {
    applicationKey = providedApplicationKey;
    name =
      providedName === undefined
        ? deriveApplicationName(providedApplicationKey)
        : providedName;
  } else {
    name = /** @type {string} */ (providedName);
    applicationKey = deriveApplicationKey(name);
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

/** @param {unknown} value */
function parseUuidCount(value) {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;

  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
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
 * @param {Writer} writer
 * @param {number} [status]
 * @param {Record<string, unknown>} [response]
 */
function writeAuthenticationRequired(writer, status, response) {
  writeJson(writer, {
    error: "authentication_required",
    detail: AUTHENTICATION_REQUIRED_DETAIL,
    ...(status === undefined ? {} : { status }),
    ...(response === undefined ? {} : { response }),
  });
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
