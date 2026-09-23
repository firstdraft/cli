import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/check-release-source.sh", import.meta.url),
);
const sourceSha = "a".repeat(40);
const otherSha = "b".repeat(40);

test(
  "release source checks reject incompatible tools, event identity, and mutable refs",
  {
    skip: process.platform === "win32" && "publication runs on Ubuntu",
  },
  (context) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "firstdraft-release-source-"),
    );
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    const gitCalls = path.join(directory, "git-calls");
    const programs = {
      node: `case "$1" in
  --version) printf '%s\\n' "$TEST_NODE_VERSION" ;;
  --print) printf '%s\\n' "$TEST_PACKAGE_VERSION" ;;
  *) exit 2 ;;
esac`,
      npm: `test "$1" = "--version"
printf '%s\\n' "$TEST_NPM_VERSION"`,
      git: `printf '%s\\n' "$*" >> "$TEST_GIT_CALLS"
case "$1" in
  rev-parse)
    case "$2" in
      'HEAD^{commit}') printf '%s\\n' "$TEST_SOURCE_SHA" ;;
      'refs/release-check/tag^{commit}') printf '%s\\n' "$TEST_REMOTE_TAG_SHA" ;;
      *) printf '%s\\n' "$TEST_EVENT_SHA" ;;
    esac ;;
  fetch) exit "$TEST_FETCH_STATUS" ;;
  rev-list) printf '%s\\n' "$TEST_MAIN_COMMITS" ;;
  *) exit 2 ;;
esac`,
    };
    for (const [name, source] of Object.entries(programs)) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${source}\n`, {
        mode: 0o755,
      });
    }
    const environment = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: "firstdraft/cli",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF: "refs/tags/v0.4.0",
      GITHUB_REF_NAME: "v0.4.0",
      GITHUB_REF_PROTECTED: "true",
      GITHUB_SHA: sourceSha,
      RUNNER_TEMP: directory,
      TEST_NODE_VERSION: "v24.18.0",
      TEST_NPM_VERSION: "11.16.0",
      TEST_PACKAGE_VERSION: "0.4.0",
      TEST_SOURCE_SHA: sourceSha,
      TEST_EVENT_SHA: sourceSha,
      TEST_REMOTE_TAG_SHA: sourceSha,
      TEST_MAIN_COMMITS: `${otherSha}\n${sourceSha}`,
      TEST_FETCH_STATUS: "0",
      TEST_GIT_CALLS: gitCalls,
    };
    const accepted = spawnSync("bash", [script], {
      cwd: directory,
      env: environment,
      encoding: "utf8",
    });
    assert.ifError(accepted.error);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(readFileSync(gitCalls, "utf8").trim().split("\n"), [
      "rev-parse HEAD^{commit}",
      `rev-parse ${sourceSha}^{commit}`,
      "fetch --force --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/tags/v0.4.0:refs/release-check/tag",
      "rev-parse refs/release-check/tag^{commit}",
      "rev-list --first-parent refs/remotes/origin/main",
    ]);

    for (const [name, value] of Object.entries({
      TEST_NODE_VERSION: "v22.0.0",
      TEST_NPM_VERSION: "10.0.0",
      GITHUB_REPOSITORY: "someone/cli",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_NAME: "v0.5.0",
      GITHUB_REF_PROTECTED: "false",
      TEST_EVENT_SHA: otherSha,
      TEST_REMOTE_TAG_SHA: otherSha,
      TEST_PACKAGE_VERSION: "0.5.0",
      TEST_MAIN_COMMITS: otherSha,
      TEST_FETCH_STATUS: "1",
    })) {
      const rejected = spawnSync("bash", [script], {
        cwd: directory,
        env: { ...environment, [name]: value },
        encoding: "utf8",
      });
      assert.ifError(rejected.error);
      assert.equal(rejected.signal, null);
      assert.notEqual(
        rejected.status,
        0,
        `${name} must reject before publication`,
      );
    }
  },
);
