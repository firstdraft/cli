import { parseArgs } from "node:util";

import { initializePlan } from "./commands/plan-init.js";
import {
  PlanPushConfigurationError,
  PlanPushLocalError,
  PlanPushNetworkError,
  PlanPushProtocolError,
  PlanPushStateWriteError,
  pushPlan,
} from "./commands/plan-push.js";
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
const PLAN_INIT_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan init --help' for usage.\n";
const PLAN_INIT_ERROR =
  "Could not initialize .firstdraft. The directory may be incomplete; no existing files were overwritten.\n";
const PLAN_INIT_SUCCESS = "Initialized .firstdraft/foundation-plan.json.\n";
const PLAN_PUSH_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan push --help' for usage.\n";
const PLAN_PUSH_CONFIGURATION_ERROR =
  "Invalid First Draft API configuration.\nRun 'firstdraft plan push --help' for usage.\n";
const PLAN_PUSH_LOCAL_ERROR =
  "Could not read the local First Draft Plan or state. No network request was made.\n";
const PLAN_PUSH_NETWORK_ERROR =
  "Could not complete the First Draft request. The Plan may have been accepted; local state was not changed.\n";
const PLAN_PUSH_PROTOCOL_ERROR =
  "First Draft returned an unexpected response. The Plan may have been accepted; local state was not changed.\n";
const PLAN_SUBJECT_ID_USAGE_ERROR =
  "Invalid arguments.\nRun 'firstdraft plan subject-id --help' for usage.\n";

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
 * @property {() => AbortSignal} [createRequestSignal]
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
 * @property {() => AbortSignal} [createRequestSignal]
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
    stderr.write(PLAN_SUBJECT_ID_USAGE_ERROR);
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
    stderr.write(PLAN_PUSH_USAGE_ERROR);
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
      stderr.write(PLAN_PUSH_CONFIGURATION_ERROR);
      return 2;
    }

    if (error instanceof PlanPushLocalError) {
      stderr.write(PLAN_PUSH_LOCAL_ERROR);
      return 1;
    }

    if (error instanceof PlanPushNetworkError) {
      stderr.write(PLAN_PUSH_NETWORK_ERROR);
      return 1;
    }

    if (error instanceof PlanPushProtocolError) {
      stderr.write(PLAN_PUSH_PROTOCOL_ERROR);
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
    if (result.body === null) {
      stderr.write(`First Draft rejected the Plan (HTTP ${result.status}).\n`);
    } else {
      writeJson(stderr, result.body);
    }
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
    stderr.write(PLAN_INIT_USAGE_ERROR);
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
    stderr.write(PLAN_INIT_USAGE_ERROR);
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

    stderr.write(PLAN_INIT_ERROR);
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
