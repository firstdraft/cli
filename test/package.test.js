import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const metadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const releasingGuide = await readFile(
  new URL("../RELEASING.md", import.meta.url),
  "utf8",
);
const releaseHistory = await readFile(
  new URL("../docs/release-history.md", import.meta.url),
  "utf8",
);
const agentInstructions = await readFile(
  new URL("../AGENTS.md", import.meta.url),
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
  assert.equal(metadata.name, "@firstdraft.com/cli");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.engines.node, ">=22.0.0");
  assert.deepEqual(metadata.bin, { firstdraft: "bin/firstdraft.js" });
  assert.deepEqual(metadata.files, ["bin", "src"]);
  assert.equal(metadata.files.includes("docs"), false);
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

test("ordinary pre-1.0 versions use the approval-gated distribution channel", () => {
  assert.match(metadata.version, /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.equal(packageLock.version, metadata.version);
  assert.equal(packageLock.packages[""].version, metadata.version);
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

test("stable release completion requires qualified latest promotion", () => {
  assert.match(
    agentInstructions,
    /publication under `next` as candidate availability, not a completed stable release[\s\S]*?explicitly named release-specific qualification[\s\S]*?separately approved[\s\S]*?npm's `latest`/,
  );
  assert.match(
    releasingGuide,
    /Release-specific qualification means the exact gate named for that candidate; it does not imply unrelated or full[\s\S]*?service qualification/,
  );
  assert.match(
    releaseHistory,
    /Later on August 7, 2026,[\s\S]*?`next`, while `latest`[\s\S]*?continued to identify `0\.1\.0-alpha\.2`[\s\S]*?On August 12, 2026,[\s\S]*?selected bounded CLI `0\.1\.0` user-journey smoke passed[\s\S]*?separate promotion approval[\s\S]*?both `next` and `latest` then identified ordinary version `0\.1\.0`[\s\S]*?Full\s+v14 service qualification remained separate and incomplete/,
  );
  assert.match(
    readme,
    /stable release selected by npm's `latest` dist-tag[\s\S]*?Candidate publication under `next` is not stable\s+release completion[\s\S]*?\[dated release history\]\(docs\/release-history\.md\)/,
  );
  assert.match(
    releaseHistory,
    /Protected tag `v0\.1\.0` and package version `0\.1\.0` were consumed and immutable/,
  );
  assert.match(
    releasingGuide,
    /If either identity is already[\s\S]*?consumed, prepare the next version required by the pre-1\.0 policy rather than moving or reusing it/,
  );
  assert.doesNotMatch(
    `${readme}\n${releasingGuide}`,
    /Before (?:creating )?the first ordinary `v0\.1\.0`/,
  );
  assert.doesNotMatch(
    releasingGuide,
    /npm trust github '@firstdraft\.com\/cli'/,
    "routine release instructions must not recreate trusted publishing",
  );
  assert.doesNotMatch(
    releasingGuide,
    /npm access grant/,
    "routine release instructions must not mutate package access",
  );
});

test("OIDC publication repeats every release source check", () => {
  const verifyJobStart = publishWorkflow.indexOf("\n  verify:\n");
  const publishJobStart = publishWorkflow.indexOf("\n  publish:\n");

  assert.ok(verifyJobStart >= 0, "verify job must exist");
  assert.ok(publishJobStart > verifyJobStart, "publish job must follow verify");

  const verifyJob = workflowJob(publishWorkflow, "verify");
  const publishJob = workflowJob(publishWorkflow, "publish");
  const npmApprovalGate = 'test "$NPM_RELEASE_ENABLED" = "true"';
  const verifyChecks = releaseSourceChecks(verifyJob);
  const publishChecks = releaseSourceChecks(publishJob);
  const npmApprovalGates = publishChecks.filter(
    (line) => line === npmApprovalGate,
  );
  const publishCommand =
    "npm publish --access public --tag next --provenance --ignore-scripts";
  const publishCommandIndex = publishJob.indexOf(publishCommand);
  const publishInvocation = "npm publish";
  const oidcPermission = "\n      id-token: write\n";
  const oidcPermissionIndex = publishJob.indexOf(oidcPermission);
  const approvalEnvironmentKey = "\n    environment:";
  const approvalEnvironment = "\n    environment: npm\n";
  const approvalEnvironmentIndex = publishJob.indexOf(approvalEnvironment);
  const runnerKey = "\n    runs-on:";
  const approvedRunner = "\n    runs-on: ubuntu-latest\n";
  const approvedRunnerIndex = publishJob.indexOf(approvedRunner);
  const nodeVersion = "\n          node-version: 24.18.0\n";
  const npmVersionCheck = 'test "$(npm --version)" = "11.16.0"';
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
    publishJob.indexOf(publishInvocation),
    publishCommandIndex,
    "the only publish invocation must use the exact approved command",
  );
  assert.equal(
    publishJob.indexOf(
      publishInvocation,
      publishCommandIndex + publishInvocation.length,
    ),
    -1,
    "the publish job must contain only one npm publish invocation",
  );
  assert.equal(
    publishJob.includes("npm dist-tag"),
    false,
    "publication must not mutate a dist-tag separately",
  );
  assert.ok(oidcPermissionIndex >= 0, "publication must permit OIDC tokens");
  assert.equal(
    publishJob.indexOf(
      oidcPermission,
      oidcPermissionIndex + oidcPermission.length,
    ),
    -1,
    "the OIDC permission must be unique",
  );
  assert.equal(
    verifyJob.includes(oidcPermission),
    false,
    "only publication may request an OIDC token",
  );
  assert.ok(
    approvalEnvironmentIndex >= 0,
    "publication must select the approval-gated npm environment",
  );
  assert.equal(
    publishJob.indexOf(approvalEnvironmentKey),
    approvalEnvironmentIndex,
    "publication must use the exact approval-gated environment",
  );
  assert.equal(
    publishJob.indexOf(
      approvalEnvironmentKey,
      approvalEnvironmentIndex + approvalEnvironmentKey.length,
    ),
    -1,
    "the approval-gated environment must be unique",
  );
  assert.equal(
    verifyJob.includes(approvalEnvironmentKey),
    false,
    "verification must not enter the npm environment",
  );
  assert.ok(
    approvedRunnerIndex >= 0,
    "trusted publication must use the approved GitHub-hosted runner",
  );
  assert.equal(
    publishJob.indexOf(runnerKey),
    approvedRunnerIndex,
    "the publish job must use only the approved runner syntax",
  );
  assert.equal(
    publishJob.indexOf(runnerKey, approvedRunnerIndex + runnerKey.length),
    -1,
    "the publish job must declare one runner",
  );
  assert.equal(
    publishJob.includes(nodeVersion),
    true,
    "trusted publication must use the pinned Node version",
  );
  assert.equal(
    publishChecks.includes(npmVersionCheck),
    true,
    "trusted publication must verify the pinned npm version",
  );
  assert.equal(
    publishWorkflow.includes("NODE_AUTH_TOKEN"),
    false,
    "trusted publication must not use a persistent npm credential",
  );
  assert.equal(
    publishWorkflow.includes("NPM_TOKEN"),
    false,
    "trusted publication must not name a persistent npm token",
  );
  assert.doesNotMatch(
    publishWorkflow,
    /\bsecrets\b/i,
    "trusted publication must not read a GitHub Actions secret",
  );
  assert.doesNotMatch(
    publishWorkflow,
    /auth[_-]?token/i,
    "trusted publication must not configure an authentication token",
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

/**
 * @param {string} workflowSource
 * @param {string} jobName
 * @returns {string}
 */
function workflowJob(workflowSource, jobName) {
  const marker = `\n  ${jobName}:\n`;
  const startIndex = workflowSource.indexOf(marker);

  assert.ok(startIndex >= 0, `${jobName} job must exist`);
  assert.equal(
    workflowSource.indexOf(marker, startIndex + marker.length),
    -1,
    `${jobName} job must be unique`,
  );

  const contentStart = startIndex + marker.length;
  const followingJob = /\n {2}[a-zA-Z0-9_-]+:\n/.exec(
    workflowSource.slice(contentStart),
  );
  const endIndex = followingJob
    ? contentStart + followingJob.index
    : workflowSource.length;

  return workflowSource.slice(startIndex, endIndex);
}

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
