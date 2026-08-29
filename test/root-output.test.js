import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeRootOutput,
  prepareRootOutput,
  releaseRootOutput,
  ROOT_TRANSACTION_NAME,
  RootOutputMaterializationError,
  RootOutputPathError,
} from "../src/root-output.js";

/** @type {Array<{path: string, mode: 420 | 493, contents: string}>} */
const ARTIFACT_FILES = [
  { path: "README.md", mode: 0o644, contents: "Generated application\n" },
  { path: "app/models/movie.rb", mode: 0o644, contents: "class Movie; end\n" },
  { path: "bin/setup", mode: 0o755, contents: "#!/bin/sh\n" },
];

test("adopts an arbitrary non-Git root without traversing preserved interiors", (context) => {
  const root = temporaryDirectory(context);
  mkdirSync(path.join(root, ".firstdraft"));
  writeFileSync(
    path.join(root, ".firstdraft", "foundation-plan.json"),
    "plan\n",
  );
  mkdirSync(path.join(root, "materials"));
  writeFileSync(path.join(root, "materials", "notes.md"), "notes\n");
  symlinkSync("notes.md", path.join(root, "materials", "latest"));

  const target = prepareRootOutput({ root });
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), true);
  const result = materialize(target);

  assert.deepEqual(result.root_adoption, {
    design_path: path.join(realpathSync(root), "design"),
    moved_entry_count: 2,
    git_repository_preserved: false,
    git_index_replaced: false,
  });
  assert.equal(
    readFileSync(path.join(root, "README.md"), "utf8"),
    "Generated application\n",
  );
  assert.equal(
    readFileSync(
      path.join(root, "design/.firstdraft/foundation-plan.json"),
      "utf8",
    ),
    "plan\n",
  );
  assert.equal(
    lstatSync(path.join(root, "design/materials/latest")).isSymbolicLink(),
    true,
  );
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
});

test("preflight holds one root lock and releases it before any irreversible phase", (context) => {
  const root = temporaryDirectory(context);
  writeFileSync(path.join(root, "notes.md"), "notes\n");
  const first = prepareRootOutput({ root });
  assert.throws(
    () => prepareRootOutput({ root }),
    (error) =>
      error instanceof RootOutputPathError && error.reason === "root_busy",
  );

  releaseRootOutput(first);
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
  const second = prepareRootOutput({ root });
  releaseRootOutput(second);
});

test("rejects unsafe root shapes before mutation", (context) => {
  const windowsRoot = temporaryDirectory(context);
  assert.throws(
    () => prepareRootOutput({ root: windowsRoot, platform: "win32" }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_platform_unsupported",
  );

  const linkedRoot = temporaryDirectory(context);
  writeFileSync(path.join(linkedRoot, "outside"), "outside\n");
  symlinkSync("outside", path.join(linkedRoot, "linked"));
  assert.throws(
    () => prepareRootOutput({ root: linkedRoot }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_entry_unsupported",
  );
  assert.equal(existsSync(path.join(linkedRoot, ROOT_TRANSACTION_NAME)), false);

  const reservedRoot = temporaryDirectory(context);
  mkdirSync(path.join(reservedRoot, "Design"));
  assert.throws(
    () => prepareRootOutput({ root: reservedRoot }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_reserved_path",
  );
});

test("preserves a Git worktree and installs an exact prepared index", (context) => {
  const root = temporaryDirectory(context);
  initializeGit(root);
  writeFileSync(path.join(root, ".gitignore"), ".env\n");
  writeFileSync(path.join(root, "README.md"), "Design README\n");
  mkdirSync(path.join(root, ".firstdraft"));
  writeFileSync(
    path.join(root, ".firstdraft", "foundation-plan.json"),
    "plan\n",
  );
  writeFileSync(path.join(root, ".env"), "SECRET=value\n");
  writeFileSync(path.join(root, "notes.md"), "untracked\n");
  git(root, [
    "add",
    ".gitignore",
    "README.md",
    ".firstdraft/foundation-plan.json",
  ]);
  git(root, ["commit", "-m", "Design application"]);
  const originalHead = git(root, ["rev-parse", "HEAD"]).trim();

  const target = prepareRootOutput({ root });
  const result = materialize(target);

  assert.equal(result.root_adoption.git_repository_preserved, true);
  assert.equal(result.root_adoption.git_index_replaced, true);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), originalHead);
  assert.equal(
    readFileSync(path.join(root, "README.md"), "utf8"),
    "Generated application\n",
  );
  assert.equal(
    readFileSync(path.join(root, "design/README.md"), "utf8"),
    "Design README\n",
  );
  assert.equal(
    readFileSync(path.join(root, "design/.env"), "utf8"),
    "SECRET=value\n",
  );
  assert.equal(gitStatus(root, ["check-ignore", "design/.env"]), 0);
  assert.equal(gitStatus(root, ["diff-files", "--quiet", "--"]), 0);

  const indexed = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(indexed, [
    "README.md",
    "app/models/movie.rb",
    "bin/setup",
    "design/.firstdraft/foundation-plan.json",
    "design/.gitignore",
    "design/README.md",
  ]);
  assert.equal(indexed.includes("design/.env"), false);
  assert.equal(indexed.includes("design/notes.md"), false);
});

test("preserves a linked Git worktree without relocating its Git file", (context) => {
  const holder = temporaryDirectory(context);
  initializeGit(holder);
  writeFileSync(path.join(holder, "README.md"), "Design README\n");
  git(holder, ["add", "README.md"]);
  git(holder, ["commit", "-m", "Design application"]);
  const root = path.join(holder, "linked");
  git(holder, ["worktree", "add", "--quiet", "--detach", root, "HEAD"]);
  const gitFile = readFileSync(path.join(root, ".git"));

  const target = prepareRootOutput({ root });
  const result = materialize(target);

  assert.equal(result.root_adoption.git_repository_preserved, true);
  assert.equal(lstatSync(path.join(root, ".git")).isFile(), true);
  assert.equal(readFileSync(path.join(root, ".git")).equals(gitFile), true);
  assert.equal(gitStatus(root, ["diff-files", "--quiet", "--"]), 0);
  assert.equal(
    readFileSync(path.join(root, "README.md"), "utf8"),
    "Generated application\n",
  );
  assert.equal(
    readFileSync(path.join(root, "design/README.md"), "utf8"),
    "Design README\n",
  );
});

test("refuses enclosing worktrees, dirty indexes, and submodule metadata", (context) => {
  const enclosing = temporaryDirectory(context);
  initializeGit(enclosing);
  mkdirSync(path.join(enclosing, "child"));
  assert.throws(
    () => prepareRootOutput({ root: path.join(enclosing, "child") }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_enclosing_worktree",
  );

  const dirty = temporaryDirectory(context);
  initializeGit(dirty);
  writeFileSync(path.join(dirty, "tracked"), "before\n");
  git(dirty, ["add", "tracked"]);
  git(dirty, ["commit", "-m", "Tracked"]);
  writeFileSync(path.join(dirty, "tracked"), "after\n");
  assert.throws(
    () => prepareRootOutput({ root: dirty }),
    (error) =>
      error instanceof RootOutputPathError && error.reason === "root_git_dirty",
  );

  const submodule = temporaryDirectory(context);
  initializeGit(submodule);
  writeFileSync(path.join(submodule, ".gitmodules"), '[submodule "vendor"]\n');
  git(submodule, ["add", ".gitmodules"]);
  git(submodule, ["commit", "-m", "Submodule metadata"]);
  assert.throws(
    () => prepareRootOutput({ root: submodule }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_git_unsupported",
  );
});

test("detects pre-move changes and rolls back a failed rename exactly", (context) => {
  const changedRoot = temporaryDirectory(context);
  writeFileSync(path.join(changedRoot, "notes.md"), "notes\n");
  const changed = prepareRootOutput({ root: changedRoot });
  writeFileSync(path.join(changedRoot, "new.md"), "new\n");
  assert.throws(
    () => materialize(changed),
    (error) =>
      error instanceof RootOutputMaterializationError &&
      error.reason === "output_changed",
  );
  assert.equal(
    existsSync(path.join(changedRoot, ROOT_TRANSACTION_NAME)),
    false,
  );
  assert.equal(
    readFileSync(path.join(changedRoot, "notes.md"), "utf8"),
    "notes\n",
  );

  const rollbackRoot = temporaryDirectory(context);
  writeFileSync(path.join(rollbackRoot, "one"), "one\n");
  writeFileSync(path.join(rollbackRoot, "two"), "two\n");
  const rollback = prepareRootOutput({ root: rollbackRoot });
  let renames = 0;
  assert.throws(
    () =>
      materialize(rollback, {
        rename(from, to) {
          renames += 1;
          if (renames === 2) {
            const error = new Error("injected rename failure");
            Object.assign(error, { code: "EIO" });
            throw error;
          }
          renameSync(from, to);
        },
      }),
    (error) =>
      error instanceof RootOutputMaterializationError &&
      error.reason === "root_transaction_failed",
  );
  assert.equal(readFileSync(path.join(rollbackRoot, "one"), "utf8"), "one\n");
  assert.equal(readFileSync(path.join(rollbackRoot, "two"), "utf8"), "two\n");
  assert.equal(existsSync(path.join(rollbackRoot, "design")), false);
  assert.equal(
    existsSync(path.join(rollbackRoot, ROOT_TRANSACTION_NAME)),
    false,
  );
});

test("restores exact Git index bytes when post-install verification fails", (context) => {
  const root = temporaryDirectory(context);
  initializeGit(root);
  writeFileSync(path.join(root, "README.md"), "Design README\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Design application"]);
  const indexPath = path.resolve(
    root,
    git(root, ["rev-parse", "--git-path", "index"]).trim(),
  );
  const originalIndex = readFileSync(indexPath);
  const target = prepareRootOutput({ root });
  let verifications = 0;

  assert.throws(
    () =>
      materializeRootOutput(
        target,
        { files: ARTIFACT_FILES, manifest_sha256: "a".repeat(64) },
        {
          writeArtifact,
          verifyArtifact(artifactRoot, ignoredRootEntries) {
            verifications += 1;
            verifyArtifact(artifactRoot, ignoredRootEntries);
            if (verifications === 2) {
              throw new RootOutputMaterializationError(
                "Injected post-install verification failure.",
                "root_transaction_failed",
              );
            }
          },
        },
      ),
    (error) =>
      error instanceof RootOutputMaterializationError &&
      error.reason === "root_transaction_failed",
  );

  assert.equal(readFileSync(indexPath).equals(originalIndex), true);
  assert.equal(gitStatus(root, ["diff", "--quiet", "--"]), 0);
  assert.equal(gitStatus(root, ["diff", "--cached", "--quiet", "--"]), 0);
  assert.equal(
    readFileSync(path.join(root, "README.md"), "utf8"),
    "Design README\n",
  );
  assert.equal(existsSync(path.join(root, "design")), false);
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
});

test("refuses artifact collisions with reserved root names", (context) => {
  const root = temporaryDirectory(context);
  writeFileSync(path.join(root, "notes.md"), "notes\n");
  const target = prepareRootOutput({ root });
  assert.throws(
    () =>
      materializeRootOutput(
        target,
        {
          files: [{ path: "design/README.md", mode: 0o644 }],
          manifest_sha256: "a".repeat(64),
        },
        { writeArtifact, verifyArtifact },
      ),
    (error) =>
      error instanceof RootOutputMaterializationError &&
      error.reason === "root_artifact_collision",
  );
  assert.equal(readFileSync(path.join(root, "notes.md"), "utf8"), "notes\n");
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
});

test("retains a versioned journal only when rollback cannot complete", (context) => {
  const root = temporaryDirectory(context);
  writeFileSync(path.join(root, "one"), "one\n");
  writeFileSync(path.join(root, "two"), "two\n");
  const target = prepareRootOutput({ root });
  let renames = 0;
  assert.throws(
    () =>
      materialize(target, {
        rename(from, to) {
          renames += 1;
          if (renames === 2 || renames === 3) {
            const error = new Error("injected rename failure");
            Object.assign(error, { code: "EIO" });
            throw error;
          }
          renameSync(from, to);
        },
      }),
    (error) =>
      error instanceof RootOutputMaterializationError &&
      error.reason === "root_rollback_incomplete" &&
      error.recoveryPath === ROOT_TRANSACTION_NAME,
  );
  const journal = JSON.parse(
    readFileSync(
      path.join(root, ROOT_TRANSACTION_NAME, "journal.json"),
      "utf8",
    ),
  );
  assert.equal(journal.format, "firstdraft.root-output-transaction/1");
  assert.equal(journal.phase, "rollback_incomplete");
});

/** @param {ReturnType<typeof prepareRootOutput>} target @param {{rename?: (from: string, to: string) => void}} [options] */
function materialize(target, options = {}) {
  return materializeRootOutput(
    target,
    { files: ARTIFACT_FILES, manifest_sha256: "a".repeat(64) },
    {
      writeArtifact,
      verifyArtifact,
      ...options,
    },
  );
}

/** @param {string} root */
function writeArtifact(root) {
  for (const file of ARTIFACT_FILES) {
    const destination = path.join(root, ...file.path.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, file.contents, { mode: file.mode });
    chmodSync(destination, file.mode);
  }
}

/** @param {string} root @param {Set<string>} [ignoredRootEntries] */
function verifyArtifact(root, ignoredRootEntries = new Set()) {
  const expected = new Set(ARTIFACT_FILES.map((file) => file.path));
  const actual = new Set();
  walkFiles(root, "", actual, ignoredRootEntries);
  assert.deepEqual(actual, expected);
  for (const file of ARTIFACT_FILES) {
    const destination = path.join(root, ...file.path.split("/"));
    assert.equal(readFileSync(destination, "utf8"), file.contents);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(destination).mode & 0o777, file.mode);
    }
  }
}

/** @param {string} root @param {string} relative @param {Set<string>} files @param {Set<string>} ignoredRootEntries */
function walkFiles(root, relative, files, ignoredRootEntries) {
  const current =
    relative === "" ? root : path.join(root, ...relative.split("/"));
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (relative === "" && ignoredRootEntries.has(entry.name)) continue;
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(root, child, files, ignoredRootEntries);
    else if (entry.isFile()) files.add(child);
    else assert.fail(`unexpected artifact entry ${child}`);
  }
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-root-output-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {string} cwd */
function initializeGit(cwd) {
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "First Draft Tests"]);
  git(cwd, ["config", "user.email", "tests@firstdraft.test"]);
}

/** @param {string} cwd @param {string[]} arguments_ */
function git(cwd, arguments_) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** @param {string} cwd @param {string[]} arguments_ */
function gitStatus(cwd, arguments_) {
  return spawnSync("git", arguments_, { cwd }).status;
}
