import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/sync-version.js [--apply]

Copies the version in package.json into every other field that must
match it: package-lock.json (version and packages[""].version) and
release/compatibility.json (version).

Without --apply, prints the changes and writes nothing. npm runs this
script with --apply as the package's \`version\` lifecycle, so
\`npm version <x.y.z> --no-git-tag-version --ignore-scripts=false\`
updates every field in one step.

Options:
  --apply     Write the changes
  -h, --help  Show this help
`;

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(USAGE);
} else {
  const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const version = readJson(repository, "package.json").version;
  assert.equal(typeof version, "string", "package.json must declare version");

  const changes = [
    ...packageLockChanges(repository, version),
    ...compatibilityChanges(repository, version),
  ];

  process.stdout.write(
    `${values.apply ? "Applying" : "Dry run"}: package.json version ${version} in ${repository}\n`,
  );
  for (const change of changes) {
    for (const field of change.fields) {
      process.stdout.write(
        `${change.file}: ${field.name} ${field.from} -> ${version}\n`,
      );
    }
    if (values.apply) {
      writeFileSync(path.join(repository, change.file), change.source);
    }
  }
  if (changes.length === 0) {
    process.stdout.write("Every version field already matches.\n");
  } else if (!values.apply) {
    process.stdout.write("Nothing was written. Pass --apply to write.\n");
  }
}

/**
 * npm writes package-lock.json as two-space JSON.stringify output, so
 * rewriting it that way keeps the file byte-identical apart from the fields.
 *
 * @param {string} repository
 * @param {string} version
 */
function packageLockChanges(repository, version) {
  const file = "package-lock.json";
  const lock = readJson(repository, file);
  const fields = [];

  if (lock.version !== version) {
    fields.push({ name: "version", from: lock.version });
    lock.version = version;
  }
  if (lock.packages[""].version !== version) {
    fields.push({
      name: 'packages[""].version',
      from: lock.packages[""].version,
    });
    lock.packages[""].version = version;
  }

  return fields.length === 0
    ? []
    : [{ file, fields, source: `${JSON.stringify(lock, null, 2)}\n` }];
}

/**
 * Prettier keeps this file's short arrays on one line, which JSON.stringify
 * would expand, so only the version value's text is replaced.
 *
 * @param {string} repository
 * @param {string} version
 */
function compatibilityChanges(repository, version) {
  const file = path.posix.join("release", "compatibility.json");
  const original = readFileSync(path.join(repository, file), "utf8");
  const declaration = JSON.parse(original);
  if (declaration.version === version) return [];

  const member = /^( {2}"version": )"[^"\\]*"/gm;
  const source = original.replace(member, `$1${JSON.stringify(version)}`);
  assert.deepEqual(
    JSON.parse(source),
    { ...declaration, version },
    `${file} must hold exactly one top-level "version" member on its own line`,
  );

  return [
    { file, fields: [{ name: "version", from: declaration.version }], source },
  ];
}

/** @param {string} repository @param {string} file */
function readJson(repository, file) {
  return JSON.parse(readFileSync(path.join(repository, file), "utf8"));
}
