import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { changelogEntries, changelogProblem } from "../scripts/changelog.js";

const script = fileURLToPath(
  new URL("../scripts/check-changelog.js", import.meta.url),
);

/** @param {string[]} lines */
const changelog = (...lines) =>
  ["# Changelog", "", "Newest first.", "", ...lines, ""].join("\n");

test("a version heading followed by text is the version's entry", () => {
  for (const heading of [
    "## 1.4.0",
    "## 1.4.0: Local output",
    "## 1.4.0 (breaking)",
    "## 1.4.0 ##",
    "   ## 1.4.0",
  ]) {
    const source = changelog(heading, "", "Adds `--output`.", "", "## 1.3.2");
    assert.equal(changelogProblem(source, "1.4.0"), undefined, heading);
    assert.deepEqual(
      changelogEntries(source, "1.4.0"),
      ["\nAdds `--output`.\n"],
      heading,
    );
  }
  assert.equal(
    changelogProblem(changelog("## 1.4.0\r", "Adds `--output`.\r"), "1.4.0"),
    undefined,
    "CRLF line endings",
  );
  assert.equal(
    changelogProblem(
      changelog("## 1.4.0", "", "```sh", "firstdraft plan compile", "```"),
      "1.4.0",
    ),
    undefined,
    "an entry may hold only a code block",
  );
  assert.equal(
    changelogProblem(
      changelog("````md", "```", "````", "", "## 1.4.0", "Adds `--output`."),
      "1.4.0",
    ),
    undefined,
    "a shorter fence inside a closed block leaves later entries visible",
  );
});

test("other headings and versions are not the version's entry", () => {
  for (const heading of [
    "### 1.4.0",
    "# 1.4.0",
    "## v1.4.0",
    "## [1.4.0]",
    "## 1.4.0-rc.1",
    "## 1.4.01",
    "## 1.4.0.1",
    "## 11.4.0",
    "## Release 1.4.0",
    "##1.4.0",
    "    ## 1.4.0",
  ]) {
    const source = changelog(heading, "", "Adds `--output`.");
    assert.deepEqual(changelogEntries(source, "1.4.0"), [], heading);
    assert.match(
      changelogProblem(source, "1.4.0") ?? "",
      /has no entry for 1\.4\.0\. Add a "## 1\.4\.0" heading/,
      heading,
    );
  }

  for (const fence of [
    ["```md", "## 1.4.0", "Adds `--output`.", "```"],
    ["~~~", "## 1.4.0", "Adds `--output`.", "~~~"],
    ["````md", "```", "## 1.4.0", "Adds `--output`.", "````"],
    ["```", "``` not a close", "## 1.4.0", "Adds `--output`.", "```"],
    ["```", "~~~", "## 1.4.0", "Adds `--output`.", "```"],
  ]) {
    const source = changelog(...fence);
    assert.deepEqual(changelogEntries(source, "1.4.0"), [], fence.join("|"));
  }
});

test("an entry ends at the next section and must hold text", () => {
  for (const source of [
    changelog("## 1.4.0", "", "## 1.3.2", "", "Fixes recovery."),
    changelog("## 1.4.0", "", "# Archive", "", "Older notes."),
    changelog("## 1.4.0", "", "   "),
  ]) {
    assert.match(
      changelogProblem(source, "1.4.0") ?? "",
      /1\.4\.0 entry has no text/,
    );
  }

  const nested = changelog("## 1.4.0", "", "### Added", "", "- `--output`");
  assert.deepEqual(changelogEntries(nested, "1.4.0"), [
    "\n### Added\n\n- `--output`\n",
  ]);
});

test("a version with two entries is rejected", () => {
  const source = changelog("## 1.4.0", "One.", "", "## 1.4.0", "Two.");
  assert.equal(
    changelogProblem(source, "1.4.0"),
    "CHANGELOG.md has 2 entries for 1.4.0. Keep one.",
  );
});

test("the check reads the repository changelog and accepts a tag", () => {
  const help = spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: node scripts\/check-changelog\.js/);

  const missing = spawnSync(process.execPath, [script, "v0.0.0"], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(
    missing.stdout,
    /^Checking .*CHANGELOG\.md for version 0\.0\.0\n/,
  );
  assert.match(missing.stderr, /^CHANGELOG\.md has no entry for 0\.0\.0\./);

  const invalid = spawnSync(process.execPath, [script, "latest"], {
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Expected a version such as 1\.4\.0/);
});
