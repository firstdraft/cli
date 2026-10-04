import { parseArgs } from "node:util";

import {
  deriveApplicationKey,
  deriveApplicationName,
  isValidApplicationKey,
  isValidApplicationName,
} from "./application-identity.js";
import {
  ApiAuthenticationRequiredError,
  STAGING_API_URL,
  authenticateApiCommand,
  environmentTokenFor,
  isAuthenticationProblem,
} from "./api-authentication.js";
import {
  CompilationArtifactInvalidError,
  CompilationArtifactResponseInvalidError,
  CompilationArtifactUnavailableError,
  CompilationCancelRejectedError,
  CompilationCancelUnavailableError,
  CompilationCancelledError,
  CompilationChangedError,
  CompilationFailedError,
  CompilationLocalPlanChangedError,
  CompilationLocalStateError,
  CompilationMaterializationError,
  CompilationNotSucceededError,
  CompilationNotPushedError,
  CompilationOutputPathError,
  CompilationRetainedError,
  CompilationRequestOutcomeUnknownError,
  CompilationStartRejectedError,
  CompilationStatusInvalidError,
  CompilationStatusUnavailableError,
  CompilationTimeoutError,
  cancelCompilation,
  downloadCompilation,
  readCompilation,
} from "./commands/compilation.js";
import {
  PlanCompileAnalysisInvalidError,
  PlanCompileAnalysisNotValidError,
  PlanCompileAnalysisRejectedError,
  PlanCompileAnalysisUnavailableError,
  PlanCompilePushRejectedError,
  compilePlanToGitHub,
  compilePlanToDirectory,
} from "./commands/plan-compile.js";
import {
  LoginDeniedError,
  LoginExpiredError,
  LoginFailedError,
  login,
  resolveLoginOrigin,
} from "./commands/login.js";
import { LogoutFailedError, logout } from "./commands/logout.js";
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
import { storedTokenReader } from "./credentials.js";
import { isFileSystemError } from "./file-system.js";
import { createPlanCompileProgressReporter } from "./plan-compile-progress.js";
import { isUuidV7 } from "./plan-state.js";
import { generateUuidV7 } from "./uuid-v7.js";
import { VERSION } from "./version.js";

const ROOT_HELP = `First Draft CLI

Usage:
  firstdraft [--staging] <command> [options]
  firstdraft [options]

Commands:
  compilation  Inspect, download, and cancel Compilations
  generate     Generate local values
  login        Log in to First Draft and save a token
  logout       Revoke and remove the saved token
  plan         Work with Foundation Plans

Options:
      --staging  Use staging for API commands (production is the default)
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
  compile  Compile the current Foundation Plan

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
      --staging  Use staging; reject a different saved origin
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com
  FIRSTDRAFT_API_URL            Override the initial API origin

The first successful push saves its API origin in .firstdraft/state.json.
Later pushes reject a different origin.
`;

const PLAN_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft plan status [--wait]

Options:
      --staging  Use staging; reject a different saved origin
      --wait     Poll until the current analysis reaches a terminal status
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com

The command uses only the API origin pinned by a successful plan push.
Without --wait, it makes exactly one status request.
`;

const PLAN_COMPILE_HELP = `First Draft CLI

Usage:
  firstdraft plan compile
  firstdraft plan compile --output <absent-directory|.>
  firstdraft plan compile --github

Options:
      --staging                      Use staging; reject a different saved origin
      --output <absent-directory|.>  Materialize here (default: .)
      --github                       Publish to a private GitHub repository
  -h, --help                         Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com
  FIRSTDRAFT_API_URL            Override the initial API origin

The command submits the exact current whole-file Plan, waits for its analysis,
and proceeds only when that analysis is valid. By default it materializes the
verified application in the current directory, preserving existing root material
under .firstdraft/design. --output can select another absent directory.
--github selects the GitHub Publication lifecycle and prints the private repository
URL; it cannot be combined with --output. Progress is written to stderr.
`;

const COMPILATION_HELP = `First Draft CLI

Usage:
  firstdraft compilation <command> [options]

Commands:
  status    Read one retained Compilation
  download  Download one successful Compilation artifact
  cancel    Cancel one queued or running Compilation

Options:
  -h, --help  Show help
`;

const COMPILATION_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft compilation status <compilation-id> [--wait]

Options:
      --staging  Use staging; reject a different saved origin
      --wait     Poll until the Compilation reaches a terminal status
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com

Without --wait, the command makes exactly one metadata-only GET. With --wait,
it polls the same retained Compilation for at most ten minutes. Failed and
cancelled terminal states are successful status reads.
`;

const COMPILATION_DOWNLOAD_HELP = `First Draft CLI

Usage:
  firstdraft compilation download <compilation-id> --output <absent-path|.>

Options:
      --staging                 Use staging; reject a different saved origin
      --output <absent-path|.>  Materialize the generated application here
  -h, --help                    Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com

The command reads the retained Compilation once, requires it to have
succeeded, downloads and verifies its exact artifact once, and atomically
materializes it into an absent output path or adopts the current directory
while preserving existing material under .firstdraft/design. It never starts work.
`;

const COMPILATION_CANCEL_HELP = `First Draft CLI

Usage:
  firstdraft compilation cancel <compilation-id>

Options:
      --staging  Use staging; reject a different saved origin
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com

The command asks First Draft once to cancel a queued or running Compilation of
the local Project and prints the cancelled Compilation. Cancelling it again
prints the same result; a succeeded or failed Compilation is not changed.
Once cancelled, it no longer blocks plan push or plan compile.
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

const LOGIN_HELP = `First Draft CLI

Usage:
  firstdraft login [--interactive]

Options:
      --staging      Log in to staging
  -i, --interactive  Approve with a code on another device (no local browser)
      --device       Same as --interactive
  -h, --help         Show help

Environment:
  FIRSTDRAFT_API_URL  Log in to a custom API origin
  XDG_CONFIG_HOME     Credentials directory base (default: ~/.config)

By default the command prints a URL to open in a browser on this machine, then
waits up to five minutes for First Draft to redirect to a one-time listener on
127.0.0.1. The token is saved for the selected origin in
firstdraft/credentials.json under the configuration directory and is never
printed. Token environment variables take precedence over a saved login.
`;

const LOGOUT_HELP = `First Draft CLI

Usage:
  firstdraft logout

Options:
      --staging  Log out of staging
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_URL  Log out of a custom API origin

The command asks First Draft to revoke the saved token for the selected origin,
then removes it from the credentials file even if revocation is not confirmed.
Token environment variables are not changed.
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
const PLAN_PUSH_LOCAL_INPUT_UNREADABLE_DETAIL =
  "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.";
const PLAN_PUSH_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "The Plan may have been accepted, but the response could not be verified. Stop and reconcile before pushing again; local state was not changed.";
const PLAN_PUSH_SERVER_REJECTED_DETAIL = "First Draft rejected the Plan.";
const AUTHENTICATION_REQUIRED_DETAIL =
  "First Draft authentication is required. Run 'firstdraft login' for the same environment, or set FIRSTDRAFT_API_TOKEN for production or custom origins, or FIRSTDRAFT_STAGING_API_TOKEN for staging.";
const LOGIN_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft login --help' for usage.";
const LOGOUT_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft logout --help' for usage.";
const LOGIN_DENIED_DETAIL =
  "The login was denied in the browser. No credential was saved. Run 'firstdraft login' again to retry.";
const LOGIN_EXPIRED_DETAIL =
  "The login was not approved before it expired. No credential was saved. Run 'firstdraft login' again to retry.";
const LOGIN_FAILED_DETAIL =
  "The login could not be completed. No credential was saved. Run 'firstdraft login' again, or use 'firstdraft login --interactive' if this machine has no browser.";
const LOGIN_CREDENTIALS_DETAIL =
  "The credentials file could not be read. No network request was made. Repair or remove it, then run 'firstdraft login' again.";
const CREDENTIALS_LOCKED_RECOVERY =
  "if no other firstdraft command is running, delete credentials.json.lock next to credentials_path";
const LOGOUT_FAILED_DETAIL =
  "The credentials file could not be read, so no token was revoked or removed. Repair or remove it, then retry.";
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
const PLAN_COMPILE_LOCAL_PLAN_CHANGED_DETAIL =
  "The local Foundation Plan changed after validation. Run 'firstdraft plan compile' again to submit the current bytes.";
const PLAN_COMPILE_DIRECT_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "A Compilation may have started, but its response could not be verified. Do not rerun 'firstdraft plan compile' or start another Compilation until the current Project is reconciled.";
const PLAN_COMPILE_DIRECT_START_REJECTED_DETAIL =
  "First Draft rejected the direct Compilation request.";
const PLAN_COMPILE_DIRECT_STATUS_UNAVAILABLE_DETAIL =
  "Could not read the retained Compilation status. Use current.compilation.id with 'firstdraft compilation status'; do not start another Compilation.";
const PLAN_COMPILE_DIRECT_STATUS_INVALID_DETAIL =
  "First Draft returned an invalid status for the retained Compilation. Preserve current.compilation.id for contract reconciliation; do not start another Compilation.";
const PLAN_COMPILE_DIRECT_CHANGED_DETAIL =
  "The pinned Compilation changed while being polled. The command stopped without downloading an artifact.";
const PLAN_COMPILE_DIRECT_TIMEOUT_DETAIL =
  "The retained Compilation is still processing after the bounded ten-minute wait. Use current.compilation.id with 'firstdraft compilation status'; do not rerun 'firstdraft plan compile' or start another Compilation.";
const PLAN_COMPILE_DIRECT_FAILED_DETAIL =
  "The pinned Compilation failed. No artifact was downloaded or materialized.";
const PLAN_COMPILE_DIRECT_CANCELLED_DETAIL =
  "The pinned Compilation was cancelled. No artifact was downloaded or materialized.";
const PLAN_PUBLISH_INCOMPATIBLE_STATE_DETAIL =
  "The saved Foundation Plan ETag is incompatible with publication. No network request was made; reconcile the CLI and server contract.";
const PLAN_PUBLISH_NOT_PUSHED_DETAIL =
  "The current Foundation Plan was not retained before the Publication request.";
const PLAN_PUBLISH_LOCAL_PLAN_CHANGED_DETAIL =
  "The local Foundation Plan changed after validation. Run 'firstdraft plan compile --github' again to submit the current bytes.";
const PLAN_PUBLISH_REQUEST_OUTCOME_UNKNOWN_DETAIL =
  "The Publication may have started, but its retained singleton status could not be verified. No mutation was retried. Do not run concurrent Compile commands. Wait, then rerun 'firstdraft plan compile --github' with unchanged Plan bytes to safely reconcile or resume the retained singleton.";
const PLAN_PUBLISH_START_REJECTED_DETAIL =
  "First Draft rejected the publication request.";
const PLAN_PUBLISH_STATUS_UNAVAILABLE_DETAIL =
  "Could not read the retained Publication status. The command stopped without starting another Publication. Do not run concurrent Compile commands. Wait, then rerun 'firstdraft plan compile --github' with unchanged Plan bytes to safely resume the retained singleton.";
const PLAN_PUBLISH_STATUS_INVALID_DETAIL =
  "First Draft returned an invalid publication status response. Retrying unchanged will not repair this protocol mismatch.";
const PLAN_PUBLISH_CHANGED_DETAIL =
  "The pinned Publication changed while being polled. The command stopped without following a replacement.";
const PLAN_PUBLISH_TIMEOUT_DETAIL =
  "The retained Publication is still processing after the bounded ten-minute wait. This invocation stopped waiting, but retained work may continue. Do not run concurrent Compile commands. Wait, then rerun 'firstdraft plan compile --github' with unchanged Plan bytes to safely resume the retained singleton.";
const PLAN_PUBLISH_FAILED_DETAIL =
  "The pinned Publication failed. Its validated status identifies the failed phase.";
const PLAN_PUBLISH_CANCELLED_DETAIL = "The pinned Publication was cancelled.";
const COMPILATION_STATUS_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft compilation status --help' for usage.";
const COMPILATION_DOWNLOAD_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft compilation download --help' for usage.";
const COMPILATION_CANCEL_INVALID_ARGUMENTS_DETAIL =
  "Invalid arguments. Run 'firstdraft compilation cancel --help' for usage.";
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
const COMPILATION_CANCEL_REJECTED_DETAIL =
  "First Draft rejected the cancellation, so nothing was cancelled. response.code compilation_not_cancellable means the Compilation already succeeded or failed; compilation_not_found or project_not_found means First Draft found no such Compilation for this Project and account.";
const COMPILATION_CANCEL_UNAVAILABLE_DETAIL =
  "Could not confirm the cancellation. Cancelling again is safe: rerun 'firstdraft compilation cancel', or check the Compilation with 'firstdraft compilation status'.";
const COMPILATION_CANCEL_INVALID_DETAIL =
  "First Draft returned an invalid response to the cancellation, so its outcome is unconfirmed. Check the Compilation with 'firstdraft compilation status'; retrying unchanged will not repair this protocol mismatch.";
const COMPILATION_ARTIFACT_UNAVAILABLE_DETAIL =
  "Could not download the requested Compilation artifact. No files were materialized.";
const COMPILATION_ARTIFACT_INVALID_DETAIL =
  "The downloaded Compilation artifact did not satisfy the integrity contract. No files were materialized.";
const COMPILATION_MATERIALIZATION_FAILED_DETAIL =
  "The validated Compilation artifact could not be materialized at the requested output path.";
const PLAN_COMPILE_DIRECT_ARTIFACT_UNAVAILABLE_DETAIL =
  "Could not download the retained Compilation artifact. Use current.compilation.id with 'firstdraft compilation download'; do not start another Compilation.";
const PLAN_COMPILE_DIRECT_ARTIFACT_INVALID_DETAIL =
  "The retained Compilation artifact did not satisfy the integrity contract. Preserve current.compilation.id for reconciliation; do not start another Compilation.";
const PLAN_COMPILE_DIRECT_MATERIALIZATION_FAILED_DETAIL =
  "The retained Compilation artifact was validated but could not be materialized. Use current.compilation.id with 'firstdraft compilation download' after repairing the output path; do not start another Compilation.";
const COMPILATION_INVALID_OUTPUT_PATH_DETAIL =
  "The compilation output must be an absent path beneath an existing real directory or the eligible current directory.";
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
 * @property {typeof import("./commands/compilation.js").compileAndDownload} [planCompileDownload]
 * @property {string} [apiUrl]
 * @property {string} [apiToken]
 * @property {string} [stagingApiToken]
 * @property {Readonly<Record<string, string | undefined>>} [env] Locates the credentials file (XDG_CONFIG_HOME)
 * @property {() => string} [homedir]
 * @property {import("./credentials.js").CredentialsFileSystem} [credentialsFileSystem]
 * @property {number} [credentialsLockTimeoutMs]
 * @property {() => string} [hostname]
 * @property {(delayMs: number, signal?: AbortSignal) => Promise<void>} [loginSleep]
 * @property {() => number} [loginNow]
 * @property {import("./oauth.js").StartLoopbackServer} [startLoopbackServer]
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
 * @property {typeof import("./commands/compilation.js").compileAndDownload} [planCompileDownload]
 * @property {string} [apiUrl]
 * @property {string} [apiToken]
 * @property {string} [stagingApiToken]
 * @property {boolean} [staging]
 * @property {import("./credentials.js").CredentialStore} [credentials]
 * @property {() => string} [hostname]
 * @property {(delayMs: number, signal?: AbortSignal) => Promise<void>} [loginSleep]
 * @property {() => number} [loginNow]
 * @property {import("./oauth.js").StartLoopbackServer} [startLoopbackServer]
 */

/**
 * @typedef {Omit<CommandOptions, "cwd" | "createUuid"> & {cwd?: string, getCwd: () => string}} PlanCommandOptions
 */

/**
 * @typedef {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "createUuid">} GenerateCommandOptions
 */

/**
 * @typedef {Omit<CommandOptions, "cwd" | "createProjectId" | "createUuid" | "fileSystem" | "createTemporaryId" | "planStatusSleep" | "planStatusNow" | "planCompileSleep" | "planCompileNow" | "planPublishSleep" | "planPublishNow" | "planCompilePush" | "planCompileReadStatus" | "planCompilePublish" | "planCompileDownload"> & {cwd?: string, getCwd: () => string}} CompilationCommandOptions
 */

/**
 * @typedef {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "fetchFunction" | "createRequestSignal" | "credentials" | "hostname" | "loginSleep" | "loginNow" | "startLoopbackServer" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging">} LoginCommandOptions
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
  planCompileDownload,
  apiUrl = process.env.FIRSTDRAFT_API_URL,
  apiToken = process.env.FIRSTDRAFT_API_TOKEN,
  stagingApiToken = process.env.FIRSTDRAFT_STAGING_API_TOKEN,
  env = process.env,
  homedir,
  credentialsFileSystem,
  credentialsLockTimeoutMs,
  hostname,
  loginSleep,
  loginNow,
  startLoopbackServer,
}) {
  const staging = argv[0] === "--staging";
  if (staging) argv = argv.slice(1);
  /** @type {import("./credentials.js").CredentialStore} */
  const credentials = {
    env,
    homedir,
    fileSystem: credentialsFileSystem,
    lockTimeoutMs: credentialsLockTimeoutMs,
  };

  if (argv[0] === "login" || argv[0] === "logout") {
    return (argv[0] === "login" ? runLogin : runLogout)({
      argv: argv.slice(1),
      stdout,
      stderr,
      fetchFunction,
      createRequestSignal,
      credentials,
      hostname,
      loginSleep,
      loginNow,
      startLoopbackServer,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
    });
  }

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
      compilationSleep,
      compilationNow,
      planCompilePush,
      planCompileReadStatus,
      planCompilePublish,
      planCompileDownload,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
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
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
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
  compilationSleep,
  compilationNow,
  planCompilePush,
  planCompileReadStatus,
  planCompilePublish,
  planCompileDownload,
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
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
      stagingApiToken,
      staging,
      credentials,
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
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
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
      compilationSleep,
      compilationNow,
      planCompilePush,
      planCompileReadStatus,
      planCompilePublish,
      planCompileDownload,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
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
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
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
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
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
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
    });
  }

  if (argv[0] === "cancel") {
    return runCompilationCancel({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd: cwd ?? getCwd(),
      fetchFunction,
      planPushFileSystem,
      createRequestSignal,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging,
      credentials,
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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "compilationSleep" | "compilationNow" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging" | "credentials">} options
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
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
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

  try {
    const authentication = authenticateApiCommand({
      fetchFunction,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging: staging || parsed.values.staging,
      readStoredTokens: storedTokenReader(credentials),
    });
    if (authentication === null) {
      writeAuthenticationRequired(stderr);
      return 1;
    }
    const result = await readCompilation({
      cwd,
      compilationId,
      wait: parsed.values.wait,
      fetchFunction: authentication.fetchFunction,
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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging" | "credentials">} options
 */
async function runCompilationDownload({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
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

  try {
    const authentication = authenticateApiCommand({
      fetchFunction,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging: staging || parsed.values.staging,
      readStoredTokens: storedTokenReader(credentials),
    });
    if (authentication === null) {
      writeAuthenticationRequired(stderr);
      return 1;
    }
    const result = await downloadCompilation({
      cwd,
      compilationId,
      output,
      fetchFunction: authentication.fetchFunction,
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
        ...(error.reason ? { reason: error.reason } : {}),
      });
      return 2;
    }

    if (error instanceof CompilationMaterializationError) {
      writeJson(stderr, {
        error: "materialization_failed",
        detail: COMPILATION_MATERIALIZATION_FAILED_DETAIL,
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.recoveryPath ? { recovery_path: error.recoveryPath } : {}),
      });
      return 1;
    }

    throw error;
  }
}

/**
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging" | "credentials">} options
 */
async function runCompilationCancel({
  argv,
  stdout,
  stderr,
  cwd,
  fetchFunction,
  planPushFileSystem,
  createRequestSignal,
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
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
      COMPILATION_CANCEL_INVALID_ARGUMENTS_DETAIL,
    );
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(COMPILATION_CANCEL_HELP);
    return 0;
  }

  const [compilationId] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !isUuidV7(compilationId)) {
    writeCompilationInvalidArguments(
      stderr,
      COMPILATION_CANCEL_INVALID_ARGUMENTS_DETAIL,
    );
    return 2;
  }

  try {
    const authentication = authenticateApiCommand({
      fetchFunction,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging: staging || parsed.values.staging,
      readStoredTokens: storedTokenReader(credentials),
    });
    if (authentication === null) {
      writeAuthenticationRequired(stderr);
      return 1;
    }
    const result = await cancelCompilation({
      cwd,
      compilationId,
      fetchFunction: authentication.fetchFunction,
      fileSystem: planPushFileSystem,
      createRequestSignal,
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    if (error instanceof CompilationCancelRejectedError) {
      if (isAuthenticationProblem(error.status, error.response)) {
        writeAuthenticationRequired(stderr, error.status, error.response);
        return 1;
      }
      writeJson(stderr, {
        error: "compilation_cancel_rejected",
        detail: COMPILATION_CANCEL_REJECTED_DETAIL,
        status: error.status,
        response: error.response,
      });
      return 1;
    }

    if (error instanceof CompilationCancelUnavailableError) {
      writeJson(stderr, {
        error: "compilation_cancel_unavailable",
        detail: COMPILATION_CANCEL_UNAVAILABLE_DETAIL,
        ...(typeof error.status === "number" ? { status: error.status } : {}),
        ...(error.response ? { response: error.response } : {}),
      });
      return 1;
    }

    if (error instanceof CompilationStatusInvalidError) {
      writeJson(stderr, {
        error: "invalid_compilation_status",
        detail: COMPILATION_CANCEL_INVALID_DETAIL,
        status: error.status,
      });
      return 1;
    }

    const status = writeCompilationReadError(stderr, error, false);
    if (status !== null) return status;
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
  if (error instanceof ApiAuthenticationRequiredError) {
    writeAuthenticationRequired(writer);
    return 1;
  }

  if (error instanceof PlanPushConfigurationError) {
    writeJson(writer, {
      error: "invalid_configuration",
      detail: error.message,
    });
    return 2;
  }

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

/** @param {LoginCommandOptions} options */
async function runLogin({
  argv,
  stdout,
  stderr,
  fetchFunction,
  createRequestSignal,
  credentials,
  hostname,
  loginSleep,
  loginNow,
  startLoopbackServer,
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
        interactive: { type: "boolean", short: "i" },
        device: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
      tokens: true,
    }),
  );

  if (
    !parsed ||
    repeatedValueOption(parsed.tokens) ||
    (parsed.values.interactive && parsed.values.device)
  ) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: LOGIN_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(LOGIN_HELP);
    return 0;
  }

  const origin = selectLoginOrigin(stderr, {
    apiUrl,
    staging: staging || parsed.values.staging,
  });
  if (origin === null) return 2;

  try {
    await login({
      origin,
      device: parsed.values.interactive || parsed.values.device,
      prompt: (text) => stderr.write(text),
      fetchFunction,
      createRequestSignal,
      sleep: loginSleep,
      now: loginNow,
      hostname,
      startLoopback: startLoopbackServer,
      credentials,
    });
  } catch (error) {
    if (error instanceof LoginDeniedError) {
      writeJson(stderr, {
        error: "authorization_denied",
        detail: LOGIN_DENIED_DETAIL,
      });
      return 1;
    }

    if (error instanceof LoginExpiredError) {
      writeJson(stderr, {
        error: "authorization_expired",
        detail: LOGIN_EXPIRED_DETAIL,
      });
      return 1;
    }

    if (error instanceof LoginFailedError) {
      writeJson(stderr, {
        error: "login_failed",
        detail:
          error.credentialsPath === undefined
            ? LOGIN_FAILED_DETAIL
            : error.phase === "write"
              ? `First Draft issued a token, but it could not be saved. Revoke the new token at ${origin}/api-tokens, then ${credentialsRecovery(error.reason)} and retry login.`
              : LOGIN_CREDENTIALS_DETAIL,
        ...(error.phase === undefined ? {} : { phase: error.phase }),
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.credentialsPath === undefined
          ? {}
          : { credentials_path: error.credentialsPath }),
      });
      return 1;
    }

    throw error;
  }

  stdout.write(`Logged in to ${origin}\n`);
  writeEnvironmentTokenNote(stderr, origin, { apiToken, stagingApiToken });
  return 0;
}

/** @param {LoginCommandOptions} options */
async function runLogout({
  argv,
  stdout,
  stderr,
  fetchFunction,
  createRequestSignal,
  credentials,
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
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
      detail: LOGOUT_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(LOGOUT_HELP);
    return 0;
  }

  const origin = selectLoginOrigin(stderr, {
    apiUrl,
    staging: staging || parsed.values.staging,
  });
  if (origin === null) return 2;

  let result;
  try {
    result = await logout({
      origin,
      fetchFunction,
      createRequestSignal,
      credentials,
    });
  } catch (error) {
    if (!(error instanceof LogoutFailedError)) throw error;

    writeJson(stderr, {
      error: "logout_failed",
      detail:
        error.phase === "read"
          ? LOGOUT_FAILED_DETAIL
          : error.revoked
            ? `First Draft confirmed token revocation, but the local credential could not be removed. To remove it, ${credentialsRecovery(error.reason)} and retry logout.`
            : `First Draft did not confirm token revocation, and the local credential could not be removed. Revoke the token at ${origin}/api-tokens, then ${credentialsRecovery(error.reason)} and retry logout.`,
      phase: error.phase,
      ...(error.revoked === undefined ? {} : { revoked: error.revoked }),
      reason: error.reason,
      credentials_path: error.credentialsPath,
    });
    return 1;
  }

  if (!result.stored) {
    stdout.write(`Not logged in to ${origin}; no saved token was found.\n`);
  } else {
    stdout.write(`Logged out of ${origin}\n`);
    if (result.changed) {
      stderr.write(
        `The saved token for ${origin} changed while logout was running, so the current saved token was left in place. Run 'firstdraft logout' again to remove it.\n`,
      );
    }
    if (!result.revoked) {
      stderr.write(
        `First Draft did not confirm that the token was revoked. The local copy was removed; revoke the token at ${new URL("/api-tokens", origin).href} if it may still be active.\n`,
      );
    }
  }
  writeEnvironmentTokenNote(stderr, origin, { apiToken, stagingApiToken });
  return 0;
}

/**
 * The recovery step after a credentials update failed, phrased to follow
 * "then" in a detail message.
 *
 * @param {string | undefined} reason
 */
function credentialsRecovery(reason) {
  return reason === "credentials_locked"
    ? CREDENTIALS_LOCKED_RECOVERY
    : "repair the credentials file";
}

/**
 * @param {Writer} stderr
 * @param {{apiUrl?: string, staging?: boolean}} options
 * @returns {string | null}
 */
function selectLoginOrigin(stderr, options) {
  try {
    return resolveLoginOrigin(options);
  } catch (error) {
    if (!(error instanceof PlanPushConfigurationError)) throw error;

    writeJson(stderr, {
      error: "invalid_configuration",
      detail: error.message,
    });
    return null;
  }
}

/**
 * @param {Writer} stderr
 * @param {string} origin
 * @param {{apiToken?: string, stagingApiToken?: string}} tokens
 */
function writeEnvironmentTokenNote(stderr, origin, tokens) {
  if (environmentTokenFor(origin, tokens) === undefined) return;

  const variable =
    origin === STAGING_API_URL
      ? "FIRSTDRAFT_STAGING_API_TOKEN"
      : "FIRSTDRAFT_API_TOKEN";
  stderr.write(
    `Note: ${variable} is set and takes precedence over the saved login for ${origin}.\n`,
  );
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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createTemporaryId" | "createRequestSignal" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging" | "credentials">} options
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
  stagingApiToken,
  staging,
  credentials,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
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
    const authentication = authenticateApiCommand({
      fetchFunction,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging: staging || parsed.values.staging,
      readStoredTokens: storedTokenReader(credentials),
    });
    if (authentication === null) {
      writeAuthenticationRequired(stderr);
      return 1;
    }
    result = await pushPlan({
      cwd,
      apiUrl: authentication.apiUrl,
      fetchFunction: authentication.fetchFunction,
      fileSystem: planPushFileSystem,
      createTemporaryId,
      createRequestSignal,
    });
  } catch (error) {
    if (error instanceof ApiAuthenticationRequiredError) {
      writeAuthenticationRequired(stderr);
      return 1;
    }

    if (error instanceof PlanPushConfigurationError) {
      writeJson(stderr, {
        error: "invalid_configuration",
        detail: error.message,
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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createRequestSignal" | "planStatusSleep" | "planStatusNow" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging" | "credentials">} options
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
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
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
    const authentication = authenticateApiCommand({
      fetchFunction,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging: staging || parsed.values.staging,
      readStoredTokens: storedTokenReader(credentials),
    });
    if (authentication === null) {
      writeAuthenticationRequired(stderr);
      return 1;
    }
    result = await readPlanStatus({
      cwd,
      wait: parsed.values.wait,
      fetchFunction: authentication.fetchFunction,
      fileSystem: planPushFileSystem,
      createRequestSignal,
      sleep: planStatusSleep,
      now: planStatusNow,
    });
  } catch (error) {
    if (error instanceof ApiAuthenticationRequiredError) {
      writeAuthenticationRequired(stderr);
      return 1;
    }

    if (error instanceof PlanPushConfigurationError) {
      writeJson(stderr, {
        error: "invalid_configuration",
        detail: error.message,
      });
      return 2;
    }

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
 * @param {Pick<CommandOptions, "argv" | "stdout" | "stderr" | "cwd" | "fetchFunction" | "planPushFileSystem" | "createTemporaryId" | "createRequestSignal" | "planCompileSleep" | "planCompileNow" | "planPublishSleep" | "planPublishNow" | "compilationSleep" | "compilationNow" | "planCompilePush" | "planCompileReadStatus" | "planCompilePublish" | "planCompileDownload" | "apiUrl" | "apiToken" | "stagingApiToken" | "staging" | "credentials">} options
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
  compilationSleep,
  compilationNow,
  planCompilePush,
  planCompileReadStatus,
  planCompilePublish,
  planCompileDownload,
  apiUrl,
  apiToken,
  stagingApiToken,
  staging,
  credentials,
}) {
  const parsed = parseArguments(() =>
    parseArgs({
      args: [...argv],
      options: {
        staging: { type: "boolean" },
        output: { type: "string" },
        github: { type: "boolean" },
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

  const { output, github } = parsed.values;
  if (output !== undefined && (output.length === 0 || github)) {
    writeJson(stderr, {
      error: "invalid_arguments",
      detail: PLAN_COMPILE_INVALID_ARGUMENTS_DETAIL,
    });
    return 2;
  }

  let authentication;
  try {
    authentication = authenticateApiCommand({
      fetchFunction,
      apiUrl,
      apiToken,
      stagingApiToken,
      staging: staging || parsed.values.staging,
      readStoredTokens: storedTokenReader(credentials),
    });
    if (authentication === null) {
      writeAuthenticationRequired(stderr);
      return 1;
    }
  } catch (error) {
    return writePlanCompileError(stderr, error);
  }

  const reportProgress = createPlanCompileProgressReporter(stderr);
  const shared = {
    cwd,
    apiUrl: authentication.apiUrl,
    fetchFunction: authentication.fetchFunction,
    fileSystem: planPushFileSystem,
    createTemporaryId,
    createRequestSignal,
    analysisSleep: planCompileSleep,
    analysisNow: planCompileNow,
    push: planCompilePush,
    readStatus: planCompileReadStatus,
    onProgress: reportProgress,
  };
  if (!github) {
    try {
      const result = await compilePlanToDirectory({
        ...shared,
        output: output ?? ".",
        compilationSleep,
        compilationNow,
        compile: planCompileDownload,
      });
      writeJson(stdout, result);
      return 0;
    } catch (error) {
      return writePlanCompileError(stderr, error);
    }
  }

  try {
    const result = await compilePlanToGitHub({
      ...shared,
      publicationSleep: planPublishSleep,
      publicationNow: planPublishNow,
      publish: planCompilePublish,
    });
    const repository =
      /** @type {NonNullable<typeof result.publication.repository>} */ (
        result.publication.repository
      );
    stdout.write(`${repository.html_url}\n`);
    return 0;
  } catch (error) {
    return writePlanCompileError(stderr, error);
  }
}

/** @param {Writer} writer @param {unknown} error */
function writePlanCompileError(writer, error) {
  if (error instanceof ApiAuthenticationRequiredError) {
    writeAuthenticationRequired(writer);
    return 1;
  }

  if (error instanceof PlanPushConfigurationError) {
    writeJson(writer, {
      error: "invalid_configuration",
      detail: error.message,
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

  const retainedError =
    error instanceof CompilationRetainedError ? error : null;
  const compilationError = retainedError?.error ?? error;
  const retainedCompilation = retainedError?.current;

  if (compilationError instanceof CompilationLocalStateError) {
    writeJson(writer, {
      error: "invalid_configuration",
      detail:
        "The configured API origin or saved Foundation Plan state is incompatible with compilation. No network request was made.",
    });
    return 2;
  }

  if (compilationError instanceof CompilationNotPushedError) {
    writeJson(writer, {
      error: "project_not_pushed",
      detail: PLAN_COMPILE_NOT_PUSHED_DETAIL,
    });
    return 1;
  }

  if (compilationError instanceof CompilationLocalPlanChangedError) {
    writeJson(writer, {
      error: "local_plan_changed",
      detail: PLAN_COMPILE_LOCAL_PLAN_CHANGED_DETAIL,
    });
    return 1;
  }

  if (compilationError instanceof CompilationRequestOutcomeUnknownError) {
    writeJson(writer, {
      error: "request_outcome_unknown",
      phase: "compilation",
      detail: PLAN_COMPILE_DIRECT_REQUEST_OUTCOME_UNKNOWN_DETAIL,
      ...(typeof compilationError.status === "number"
        ? { status: compilationError.status }
        : {}),
      ...(compilationError.response
        ? { response: compilationError.response }
        : {}),
    });
    return 1;
  }

  if (
    (compilationError instanceof CompilationStartRejectedError ||
      compilationError instanceof CompilationStatusUnavailableError) &&
    isAuthenticationProblem(compilationError.status, compilationError.response)
  ) {
    writeAuthenticationRequired(
      writer,
      compilationError.status,
      /** @type {Record<string, unknown>} */ (compilationError.response),
      retainedCompilation,
    );
    return 1;
  }

  if (compilationError instanceof CompilationStartRejectedError) {
    writeJson(writer, {
      error: "compilation_start_rejected",
      detail: PLAN_COMPILE_DIRECT_START_REJECTED_DETAIL,
      status: compilationError.status,
      response: compilationError.response,
    });
    return 1;
  }

  if (compilationError instanceof CompilationStatusUnavailableError) {
    writeJson(writer, {
      error: "compilation_status_unavailable",
      detail: PLAN_COMPILE_DIRECT_STATUS_UNAVAILABLE_DETAIL,
      ...(typeof compilationError.status === "number"
        ? { status: compilationError.status }
        : {}),
      ...(compilationError.response
        ? { response: compilationError.response }
        : {}),
      ...(retainedCompilation ? { current: retainedCompilation } : {}),
    });
    return 1;
  }

  if (compilationError instanceof CompilationStatusInvalidError) {
    writeJson(writer, {
      error: "invalid_compilation_status",
      detail: PLAN_COMPILE_DIRECT_STATUS_INVALID_DETAIL,
      status: compilationError.status,
      ...(retainedCompilation ? { current: retainedCompilation } : {}),
    });
    return 1;
  }

  if (compilationError instanceof CompilationChangedError) {
    writeJson(writer, {
      error: "compilation_changed",
      detail: PLAN_COMPILE_DIRECT_CHANGED_DETAIL,
      current: compilationError.current,
    });
    return 1;
  }

  if (compilationError instanceof CompilationTimeoutError) {
    writeJson(writer, {
      error: "compilation_wait_timed_out",
      detail: PLAN_COMPILE_DIRECT_TIMEOUT_DETAIL,
      current: compilationError.current,
    });
    return 1;
  }

  if (compilationError instanceof CompilationFailedError) {
    writeJson(writer, {
      error: "compilation_failed",
      detail: PLAN_COMPILE_DIRECT_FAILED_DETAIL,
      current: compilationError.current,
    });
    return 1;
  }

  if (compilationError instanceof CompilationCancelledError) {
    writeJson(writer, {
      error: "compilation_cancelled",
      detail: PLAN_COMPILE_DIRECT_CANCELLED_DETAIL,
      current: compilationError.current,
    });
    return 1;
  }

  if (compilationError instanceof CompilationArtifactUnavailableError) {
    if (
      isAuthenticationProblem(
        compilationError.status,
        compilationError.response,
      )
    ) {
      writeAuthenticationRequired(
        writer,
        compilationError.status,
        /** @type {Record<string, unknown>} */ (compilationError.response),
        retainedCompilation,
      );
      return 1;
    }
    writeJson(writer, {
      error: "artifact_unavailable",
      detail: PLAN_COMPILE_DIRECT_ARTIFACT_UNAVAILABLE_DETAIL,
      ...(typeof compilationError.status === "number"
        ? { status: compilationError.status }
        : {}),
      ...(compilationError.response
        ? { response: compilationError.response }
        : {}),
      ...(retainedCompilation ? { current: retainedCompilation } : {}),
    });
    return 1;
  }

  if (
    compilationError instanceof CompilationArtifactResponseInvalidError ||
    compilationError instanceof CompilationArtifactInvalidError
  ) {
    writeJson(writer, {
      error: "invalid_artifact",
      detail: PLAN_COMPILE_DIRECT_ARTIFACT_INVALID_DETAIL,
      ...(compilationError instanceof CompilationArtifactResponseInvalidError
        ? { status: compilationError.status }
        : {}),
      ...(retainedCompilation ? { current: retainedCompilation } : {}),
    });
    return 1;
  }

  if (compilationError instanceof CompilationOutputPathError) {
    writeJson(writer, {
      error: "invalid_output_path",
      detail: COMPILATION_INVALID_OUTPUT_PATH_DETAIL,
      ...(compilationError.reason ? { reason: compilationError.reason } : {}),
    });
    return 2;
  }

  if (compilationError instanceof CompilationMaterializationError) {
    writeJson(writer, {
      error: "materialization_failed",
      detail: PLAN_COMPILE_DIRECT_MATERIALIZATION_FAILED_DETAIL,
      ...(compilationError.reason ? { reason: compilationError.reason } : {}),
      ...(compilationError.recoveryPath
        ? { recovery_path: compilationError.recoveryPath }
        : {}),
      ...(retainedCompilation ? { current: retainedCompilation } : {}),
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
 * @param {import("./commands/compilation.js").CompilationResponse} [current]
 */
function writeAuthenticationRequired(writer, status, response, current) {
  writeJson(writer, {
    error: "authentication_required",
    detail: AUTHENTICATION_REQUIRED_DETAIL,
    ...(status === undefined ? {} : { status }),
    ...(response === undefined ? {} : { response }),
    ...(current === undefined ? {} : { current }),
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
