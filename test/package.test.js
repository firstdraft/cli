import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const metadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

/**
 * @param {string} jobSource
 * @returns {string[]}
 */
function releaseSourceChecks(jobSource) {
  const beginMarker = "# release-source-checks:begin";
  const endMarker = "# release-source-checks:end";
  const beginIndex = jobSource.indexOf(beginMarker);

  assert.ok(beginIndex >= 0, "release check begin marker must exist");
  assert.equal(
    jobSource.indexOf(beginMarker, beginIndex + beginMarker.length),
    -1,
    "release check begin marker must be unique",
  );

  const checksStart = beginIndex + beginMarker.length;
  const endIndex = jobSource.indexOf(endMarker, checksStart);

  assert.ok(endIndex >= checksStart, "release check end marker must exist");
  assert.equal(
    jobSource.indexOf(endMarker, endIndex + endMarker.length),
    -1,
    "release check end marker must be unique",
  );

  return jobSource
    .slice(checksStart, endIndex)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("package metadata preserves the audited runtime boundary", () => {
  assert.equal(metadata.name, "firstdraft");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.engines.node, ">=22.0.0");
  assert.deepEqual(metadata.bin, { firstdraft: "./bin/firstdraft.js" });
  assert.deepEqual(metadata.files, ["bin", "src"]);
  assert.equal(metadata.scripts.test, "node scripts/run-tests.js");

  for (const property of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    assert.equal(property in metadata, false, `${property} must stay absent`);
  }
});

test("package metadata preserves the public prerelease boundary", () => {
  assert.deepEqual(metadata.repository, {
    type: "git",
    url: "git+https://github.com/firstdraft/cli.git",
  });
  assert.deepEqual(metadata.publishConfig, {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
    tag: "next",
  });
});

test("privileged publication repeats every release source check", () => {
  const verifyJobStart = publishWorkflow.indexOf("\n  verify:\n");
  const publishJobStart = publishWorkflow.indexOf("\n  publish:\n");

  assert.ok(verifyJobStart >= 0, "verify job must exist");
  assert.ok(publishJobStart > verifyJobStart, "publish job must follow verify");

  const verifyJob = publishWorkflow.slice(verifyJobStart, publishJobStart);
  const publishJob = publishWorkflow.slice(publishJobStart);
  const npmApprovalGate = 'test "$NPM_RELEASE_ENABLED" = "true"';
  const verifyChecks = releaseSourceChecks(verifyJob);
  const publishChecks = releaseSourceChecks(publishJob);
  const npmApprovalGates = publishChecks.filter(
    (line) => line === npmApprovalGate,
  );
  const publishCommand = "npm publish";
  const publishCommandIndex = publishJob.indexOf(publishCommand);
  const publishChecksEndIndex = publishJob.indexOf(
    "# release-source-checks:end",
  );

  assert.ok(verifyChecks.length > 0, "release source checks must not be empty");
  assert.equal(
    verifyChecks[0],
    "set -euo pipefail",
    "release checks must fail closed",
  );
  assert.equal(
    npmApprovalGates.length,
    1,
    "publish must require explicit approval once",
  );
  assert.equal(
    publishChecks.indexOf(npmApprovalGate),
    1,
    "approval must immediately follow shell safeguards",
  );
  assert.ok(publishCommandIndex >= 0, "publish command must exist");
  assert.equal(
    publishJob.indexOf(
      publishCommand,
      publishCommandIndex + publishCommand.length,
    ),
    -1,
    "publish command must be unique",
  );
  assert.ok(
    publishChecksEndIndex < publishCommandIndex,
    "release checks must precede publication",
  );
  assert.deepEqual(
    publishChecks.filter((line) => line !== npmApprovalGate),
    verifyChecks,
  );
});

test("package metadata defines no installation lifecycle", () => {
  for (const script of [
    "preinstall",
    "install",
    "postinstall",
    "prepack",
    "postpack",
    "prepare",
    "prepublish",
    "prepublishOnly",
  ]) {
    assert.equal(
      script in metadata.scripts,
      false,
      `${script} must stay absent`,
    );
  }
});
