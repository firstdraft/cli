import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
assert(npmCli, "npm_execpath is required; run this check through npm");

const result = spawnSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  /** @type {{files: {path: string}[]}[]} */
  const manifests = JSON.parse(result.stdout);
  const [manifest] = manifests;
  assert(manifest, "npm pack did not return a manifest");
  const paths = manifest.files.map(({ path }) => path).sort();

  assert.deepEqual(paths, [
    "LICENSE",
    "README.md",
    "bin/firstdraft.js",
    "package.json",
    "src/api-authentication.js",
    "src/api-response.js",
    "src/application-identity.js",
    "src/cli.js",
    "src/commands/compilation.js",
    "src/commands/plan-compile.js",
    "src/commands/plan-init.js",
    "src/commands/plan-publish.js",
    "src/commands/plan-push.js",
    "src/commands/plan-status.js",
    "src/compilation-artifact.js",
    "src/file-system.js",
    "src/plan-state.js",
    "src/uuid-v7.js",
    "src/version.js",
  ]);
}
