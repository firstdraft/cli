import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const testFiles = findTestFiles("test");
assert.notEqual(testFiles.length, 0, "No test files found");

// Saved `firstdraft login` credentials must never leak into, or out of, tests.
const configHome = mkdtempSync(path.join(tmpdir(), "firstdraft-test-config-"));

const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...testFiles],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      FIRSTDRAFT_API_URL: undefined,
      FIRSTDRAFT_API_TOKEN: undefined,
      FIRSTDRAFT_STAGING_API_TOKEN: undefined,
      XDG_CONFIG_HOME: configHome,
    },
  },
);
rmSync(configHome, { recursive: true, force: true });

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
