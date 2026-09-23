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
const releaseSourceScript = await readFile(
  new URL("../scripts/check-release-source.sh", import.meta.url),
  "utf8",
);

test("package metadata preserves the audited runtime boundary", () => {
  assert.equal(metadata.name, "@firstdraft.com/cli");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.engines.node, ">=22.0.0");
  assert.deepEqual(metadata.bin, { firstdraft: "bin/firstdraft.js" });
  assert.deepEqual(metadata.files, [
    "bin",
    "docs",
    "src",
    "RELEASING.md",
    "SECURITY.md",
  ]);
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
    tag: "latest",
  });
});

test("publication reuses successful exact-source CI instead of rerunning the suite", () => {
  const verifyJob = workflowJob(publishWorkflow, "verify");
  assert.match(verifyJob, /actions: read/);
  assert.match(verifyJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    verifyJob,
    /gh run list --repo "\$GITHUB_REPOSITORY" --workflow ci\.yml/,
  );
  assert.match(
    verifyJob,
    /--branch main --event push --commit "\$release_sha" --status success/,
  );
  assert.match(verifyJob, /test -n "\$ci_url"/);
  assert.match(verifyJob, /npm run pack:check/);
  assert.doesNotMatch(
    publishWorkflow,
    /npm ci|npm audit|npm run check|npm test/,
  );
});

test("OIDC publication rechecks source after approval and before publishing", () => {
  const verifyJobStart = publishWorkflow.indexOf("\n  verify:\n");
  const publishJobStart = publishWorkflow.indexOf("\n  publish:\n");

  assert.ok(verifyJobStart >= 0, "verify job must exist");
  assert.ok(publishJobStart > verifyJobStart, "publish job must follow verify");

  const verifyJob = workflowJob(publishWorkflow, "verify");
  const publishJob = workflowJob(publishWorkflow, "publish");
  const npmApprovalGate = 'test "$NPM_RELEASE_ENABLED" = "true"';
  const npmApprovalGateIndex = publishJob.indexOf(npmApprovalGate);
  const sourceCheckCommand = "bash scripts/check-release-source.sh";
  const publishSourceCheckIndex = publishJob.indexOf(sourceCheckCommand);
  const publishCommand =
    "npm publish --access public --tag latest --provenance --ignore-scripts";
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
  const publicationSource = `${publishWorkflow}\n${releaseSourceScript}`;

  for (const job of [verifyJob, publishJob]) {
    const sourceCheckIndex = job.indexOf(sourceCheckCommand);
    assert.ok(sourceCheckIndex >= 0, "both jobs must check release source");
    assert.equal(
      job.indexOf(
        sourceCheckCommand,
        sourceCheckIndex + sourceCheckCommand.length,
      ),
      -1,
      "each job must check release source once",
    );
    assert.equal(job.includes(nodeVersion), true);
  }
  assert.match(publishJob, /needs: verify/);
  assert.ok(
    verifyJob.indexOf(sourceCheckCommand) < verifyJob.indexOf("gh run list"),
  );
  assert.match(releaseSourceScript, /^set -euo pipefail$/m);
  assert.ok(
    npmApprovalGateIndex >= 0,
    "publish must require explicit approval",
  );
  assert.equal(
    publishJob.indexOf(
      npmApprovalGate,
      npmApprovalGateIndex + npmApprovalGate.length,
    ),
    -1,
    "publish must require explicit approval once",
  );
  assert.ok(
    publishJob.indexOf("set -euo pipefail") >= 0 &&
      publishJob.indexOf("set -euo pipefail") < npmApprovalGateIndex &&
      npmApprovalGateIndex < publishSourceCheckIndex,
    "approval must stop the job before release source checks",
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
    releaseSourceScript.includes(npmVersionCheck),
    true,
    "trusted publication must verify the pinned npm version",
  );
  assert.equal(
    publicationSource.includes("NODE_AUTH_TOKEN"),
    false,
    "trusted publication must not use a persistent npm credential",
  );
  assert.equal(
    publicationSource.includes("NPM_TOKEN"),
    false,
    "trusted publication must not name a persistent npm token",
  );
  assert.doesNotMatch(
    publicationSource,
    /\bsecrets\b/i,
    "trusted publication must not read a GitHub Actions secret",
  );
  assert.doesNotMatch(
    publicationSource,
    /auth[_-]?token/i,
    "trusted publication must not configure an authentication token",
  );
  assert.ok(
    publishSourceCheckIndex < publishCommandIndex,
    "release checks must precede publication",
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
