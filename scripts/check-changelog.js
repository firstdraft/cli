import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { changelogProblem } from "./changelog.js";

const USAGE = `Usage: node scripts/check-changelog.js [<version>]

Checks that CHANGELOG.md has exactly one entry for <version>: a
"## <version>" heading followed by text. <version> defaults to the
version in package.json. A leading "v", as in the tag v1.4.0, is removed.

The publish workflow runs this for the pushed tag, and CI runs it for a
version that has no tag yet. It only reads files, and it exits 1 when the
entry is missing, empty, or repeated.

Options:
  -h, --help  Show this help
`;

const { values, positionals } = parseArgs({
  options: {
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  process.stdout.write(USAGE);
} else {
  assert(positionals.length <= 1, `Expected at most one version.\n\n${USAGE}`);
  const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const version = (
    positionals[0] ??
    JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"))
      .version
  ).replace(/^v/, "");
  assert.match(
    version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `Expected a version such as 1.4.0 or a tag such as v1.4.0, not ${version}`,
  );
  const changelog = path.join(repository, "CHANGELOG.md");

  process.stdout.write(`Checking ${changelog} for version ${version}\n`);
  const problem = changelogProblem(readFileSync(changelog, "utf8"), version);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Found the ${version} entry.\n`);
  }
}
