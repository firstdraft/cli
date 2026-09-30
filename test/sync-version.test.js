import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = readJson(repository, "package.json");
const compatibilitySource = readFileSync(
  path.join(repository, "release", "compatibility.json"),
  "utf8",
);
const nextVersion = packageMetadata.version.replace(
  /\d+$/,
  (/** @type {string} */ patch) => String(Number(patch) + 1),
);

test("the version sync script prints its usage", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repository, "scripts", "sync-version.js"), "--help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: node scripts\/sync-version\.js/);
  assert.match(result.stdout, /--apply/);
});

test("the version sync script is a dry run until --apply", (context) => {
  const directory = copyRepository(context);
  writeJson(directory, "package.json", {
    ...packageMetadata,
    version: nextVersion,
  });
  const before = snapshot(directory);

  const dryRun = syncVersion(directory, []);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /^Dry run: package\.json version /);
  for (const field of [
    `package-lock.json: version ${packageMetadata.version} -> ${nextVersion}`,
    `package-lock.json: packages[""].version ${packageMetadata.version} -> ${nextVersion}`,
    `release/compatibility.json: version ${packageMetadata.version} -> ${nextVersion}`,
  ]) {
    assert.ok(dryRun.stdout.includes(`${field}\n`), field);
  }
  assert.deepEqual(snapshot(directory), before);

  const applied = syncVersion(directory, ["--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assertSynchronized(directory);

  const repeated = syncVersion(directory, []);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Every version field already matches\.\n$/);
});

test(
  "npm version updates every version field through the lifecycle script",
  { skip: !process.env.npm_execpath && "run through npm to locate npm" },
  (context) => {
    const npmCli = process.env.npm_execpath;
    assert(npmCli);
    const directory = copyRepository(context);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)),
    );

    const result = spawnSync(
      process.execPath,
      [
        npmCli,
        "version",
        nextVersion,
        "--no-git-tag-version",
        "--ignore-scripts=false",
        "--update-notifier=false",
      ],
      { cwd: directory, env: environment, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assertSynchronized(directory);
  },
);

/** @param {import("node:test").TestContext} context */
function copyRepository(context) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "firstdraft-sync-version-"),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "release"));
  mkdirSync(path.join(directory, "scripts"));

  for (const file of [
    ".npmrc",
    "package.json",
    "package-lock.json",
    path.join("release", "compatibility.json"),
    path.join("scripts", "sync-version.js"),
  ]) {
    copyFileSync(path.join(repository, file), path.join(directory, file));
  }

  return directory;
}

/** @param {string} directory @param {string[]} options */
function syncVersion(directory, options) {
  return spawnSync(
    process.execPath,
    [path.join(directory, "scripts", "sync-version.js"), ...options],
    { encoding: "utf8" },
  );
}

/** @param {string} directory */
function assertSynchronized(directory) {
  const lock = readJson(directory, "package-lock.json");
  assert.equal(readJson(directory, "package.json").version, nextVersion);
  assert.equal(lock.version, nextVersion);
  assert.equal(lock.packages[""].version, nextVersion);
  assert.equal(
    readFileSync(path.join(directory, "package-lock.json"), "utf8"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  assert.equal(
    readFileSync(path.join(directory, "release", "compatibility.json"), "utf8"),
    compatibilitySource.replace(
      `"version": "${packageMetadata.version}"`,
      `"version": "${nextVersion}"`,
    ),
  );
}

/** @param {string} directory */
function snapshot(directory) {
  return ["package-lock.json", path.join("release", "compatibility.json")].map(
    (file) => readFileSync(path.join(directory, file), "utf8"),
  );
}

/** @param {string} directory @param {string} file */
function readJson(directory, file) {
  return JSON.parse(readFileSync(path.join(directory, file), "utf8"));
}

/** @param {string} directory @param {string} file @param {unknown} value */
function writeJson(directory, file, value) {
  writeFileSync(
    path.join(directory, file),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
