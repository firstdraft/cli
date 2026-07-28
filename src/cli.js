import { parseArgs } from "node:util";

import { VERSION } from "./version.js";

const HELP = `First Draft CLI

Usage:
  firstdraft [options]

Options:
  -h, --help     Show help
  -V, --version  Show version
`;

const USAGE_ERROR = "Invalid arguments.\nRun 'firstdraft --help' for usage.\n";
const UNKNOWN_COMMAND =
  "Unknown command.\nRun 'firstdraft --help' for usage.\n";

/**
 * @typedef {object} Writer
 * @property {(text: string) => unknown} write
 */

/**
 * @typedef {object} RunOptions
 * @property {readonly string[]} argv
 * @property {Writer} stdout
 * @property {Writer} stderr
 */

/** @param {RunOptions} options */
export function run({ argv, stdout, stderr }) {
  let parsed;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (!isParseArgsError(error)) throw error;

    stderr.write(USAGE_ERROR);
    return 2;
  }

  if (argv.length === 0) {
    stdout.write(HELP);
    return 0;
  }

  if (parsed.positionals.length > 0) {
    stderr.write(UNKNOWN_COMMAND);
    return 2;
  }

  if (parsed.values.help) {
    stdout.write(HELP);
    return 0;
  }

  if (parsed.values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  stdout.write(HELP);
  return 0;
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
