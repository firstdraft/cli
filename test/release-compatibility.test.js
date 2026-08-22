import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FOUNDATION_PLAN_FORMAT } from "../src/compilation-artifact.js";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const compatibility = JSON.parse(
  await readFile(
    new URL("../release/compatibility.json", import.meta.url),
    "utf8",
  ),
);
const commandReference = await readFile(
  new URL("../docs/commands.md", import.meta.url),
  "utf8",
);

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

test("release compatibility declares the coordinated CLI contract", () => {
  assertExactKeys(compatibility, [
    "component",
    "format",
    "requires",
    "version",
  ]);
  assert.equal(compatibility.format, "firstdraft.release-compatibility/1");
  assert.equal(compatibility.component, "cli");
  assert.equal(typeof compatibility.version, "string");
  assert.match(compatibility.version, semverPattern);
  assert.equal(compatibility.version, packageMetadata.version);

  assertExactKeys(compatibility.requires, [
    "api_contract",
    "foundation_plan_formats",
  ]);
  assert.deepEqual(compatibility.requires.api_contract, [
    ">= 0.3.0",
    "< 0.4.0",
  ]);
  assert.match(
    commandReference,
    /The closed API `0\.3\.x` progress-reason allowlist/,
  );
  assert.match(
    commandReference,
    /analysis whose graph version and\s+`head_source_sha256` exactly match that accepted push/,
  );
  assert.deepEqual(compatibility.requires.foundation_plan_formats, [
    FOUNDATION_PLAN_FORMAT,
  ]);

  for (const requirement of compatibility.requires.api_contract) {
    assert.equal(typeof requirement, "string");
    const match = /^(?:=|<|<=|>|>=)\s+(.+)$/.exec(requirement);

    assert.ok(match, `invalid SemVer comparator: ${requirement}`);
    const requiredVersion = match[1];

    assert.ok(requiredVersion !== undefined);
    assert.match(requiredVersion, semverPattern);
  }

  for (const format of compatibility.requires.foundation_plan_formats) {
    assert.equal(typeof format, "string");
  }
});

/**
 * @param {unknown} value
 * @param {string[]} expectedKeys
 */
function assertExactKeys(value, expectedKeys) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort());
}
