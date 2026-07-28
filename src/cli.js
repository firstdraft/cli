import { parseArgs } from "node:util";

import { initializePlan, isFileSystemError } from "./commands/plan-init.js";
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
  init  Create a local empty Foundation Plan

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
 * @property {() => string} [createProjectId]
 * @property {import("./commands/plan-init.js").FileSystem} [fileSystem]
 */

/**
 * @typedef {object} CommandOptions
 * @property {readonly string[]} argv
 * @property {Writer} stdout
 * @property {Writer} stderr
 * @property {string} cwd
 * @property {() => string} createProjectId
 * @property {import("./commands/plan-init.js").FileSystem} [fileSystem]
 */

/** @param {RunOptions} options */
export function run({
  argv,
  stdout,
  stderr,
  cwd = process.cwd(),
  createProjectId = generateUuidV7,
  fileSystem,
}) {
  if (argv[0] === "plan") {
    return runPlan({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd,
      createProjectId,
      fileSystem,
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

/** @param {CommandOptions} options */
function runPlan({ argv, stdout, stderr, cwd, createProjectId, fileSystem }) {
  if (argv[0] === "init") {
    return runPlanInit({
      argv: argv.slice(1),
      stdout,
      stderr,
      cwd,
      createProjectId,
      fileSystem,
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

/** @param {CommandOptions} options */
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
