import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const testFiles = findTestFiles("test");
assert.notEqual(testFiles.length, 0, "No test files found");

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;

/**
 * @param {string} directory
 * @returns {string[]}
 */
function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return findTestFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".test.js")
        ? [entryPath]
        : [];
    })
    .sort();
}
