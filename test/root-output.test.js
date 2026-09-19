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
  { path: ".firstdraft/gaps.json", mode: 0o644, contents: '{"gaps":[]}\n' },
  {
    path: ".firstdraft/submitted-foundation-plan.json",
    mode: 0o644,
    contents: '{"submitted":true}\n',
  },
  { path: "README.md", mode: 0o644, contents: "Generated application\n" },
  { path: "app/models/movie.rb", mode: 0o644, contents: "class Movie; end\n" },
  { path: "bin/setup", mode: 0o755, contents: "#!/bin/sh\n" },
];

test("refuses root adoption on Windows", () => {
  assert.throws(
    () => prepareRootOutput({ root: "ignored", platform: "win32" }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_platform_unsupported",
  );
});

test("adopts an arbitrary non-Git root without traversing preserved interiors", (context) => {
  if (process.platform === "win32") return context.skip();
  const root = temporaryDirectory(context);
  mkdirSync(path.join(root, ".firstdraft"), { mode: 0o700 });
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
    design_path: path.join(realpathSync(root), ".firstdraft/design"),
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
      path.join(root, ".firstdraft/design/.firstdraft/foundation-plan.json"),
      "utf8",
    ),
    "plan\n",
  );
  assert.equal(
    lstatSync(
      path.join(root, ".firstdraft/design/materials/latest"),
    ).isSymbolicLink(),
    true,
  );
  assert.equal(
    lstatSync(path.join(root, ".firstdraft/design/.firstdraft")).mode & 0o777,
    0o700,
  );
  assert.equal(lstatSync(path.join(root, ".firstdraft")).mode & 0o777, 0o755);
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
});

test("preflight holds one root lock and releases it before any irreversible phase", (context) => {
  if (process.platform === "win32") return context.skip();
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

  const externallyRemoved = prepareRootOutput({ root });
  rmSync(externallyRemoved.transactionPath, { recursive: true });
  assert.doesNotThrow(() => releaseRootOutput(externallyRemoved));
});

test("rejects unsafe root shapes before mutation", (context) => {
  if (process.platform === "win32") return context.skip();
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
  mkdirSync(path.join(reservedRoot, ".FirstDraft/Design"), { recursive: true });
  assert.throws(
    () => prepareRootOutput({ root: reservedRoot }),
    (error) =>
      error instanceof RootOutputPathError &&
      error.reason === "root_reserved_path",
  );
});

test("preserves a Git worktree and installs an exact prepared index", (context) => {
  if (process.platform === "win32") return context.skip();
  const root = temporaryDirectory(context);
  initializeGit(root);
  writeFileSync(
    path.join(root, ".gitignore"),
    ".env\n.firstdraft/state.json\n",
  );
  writeFileSync(path.join(root, "README.md"), "Design README\n");
  mkdirSync(path.join(root, ".firstdraft"));
  writeFileSync(
    path.join(root, ".firstdraft", "foundation-plan.json"),
    "plan\n",
  );
  writeFileSync(path.join(root, ".firstdraft/state.json"), "private-state\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(root, ".env"), "SECRET=value\n", { mode: 0o600 });
  writeFileSync(path.join(root, "notes.md"), "untracked\n");
  git(root, [
    "add",
    ".gitignore",
    "README.md",
    ".firstdraft/foundation-plan.json",
  ]);
  git(root, ["commit", "-m", "Design application"]);
  git(root, ["remote", "add", "origin", "https://example.test/planning.git"]);
  const originalHead = git(root, ["rev-parse", "HEAD"]).trim();
  const originalConfig = readFileSync(path.join(root, ".git/config"));

  const target = prepareRootOutput({ root });
  const result = materialize(target);

  assert.equal(result.root_adoption.git_repository_preserved, true);
  assert.equal(result.root_adoption.git_index_replaced, true);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), originalHead);
  assert.deepEqual(
    readFileSync(path.join(root, ".git/config")),
    originalConfig,
  );
  assert.equal(
    readFileSync(
      path.join(root, ".firstdraft/design/.firstdraft/state.json"),
      "utf8",
    ),
    "private-state\n",
  );
  assert.equal(
    lstatSync(path.join(root, ".firstdraft/design/.firstdraft/state.json"))
      .mode & 0o777,
    0o600,
  );
  assert.equal(
    gitStatus(root, [
      "check-ignore",
      ".firstdraft/design/.firstdraft/state.json",
    ]),
    0,
  );
  assert.equal(existsSync(path.join(root, "design")), false);
  assert.equal(
    readFileSync(path.join(root, "README.md"), "utf8"),
    "Generated application\n",
  );
  assert.equal(
    readFileSync(path.join(root, ".firstdraft/design/README.md"), "utf8"),
    "Design README\n",
  );
  assert.equal(
    readFileSync(path.join(root, ".firstdraft/design/.env"), "utf8"),
    "SECRET=value\n",
  );
  assert.equal(gitStatus(root, ["check-ignore", ".firstdraft/design/.env"]), 0);
  assert.equal(gitStatus(root, ["diff-files", "--quiet", "--"]), 0);

  const indexed = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(indexed, [
    ".firstdraft/design/.firstdraft/foundation-plan.json",
    ".firstdraft/design/.gitignore",
    ".firstdraft/design/README.md",
    ".firstdraft/gaps.json",
    ".firstdraft/submitted-foundation-plan.json",
    "README.md",
    "app/models/movie.rb",
    "bin/setup",
  ]);
  assert.equal(indexed.includes(".firstdraft/design/.env"), false);
  assert.equal(indexed.includes(".firstdraft/design/notes.md"), false);
});

test("preserves a linked Git worktree without relocating its Git file", (context) => {
  if (process.platform === "win32") return context.skip();
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
    readFileSync(path.join(root, ".firstdraft/design/README.md"), "utf8"),
    "Design README\n",
  );
});

test("refuses enclosing worktrees, dirty indexes, and submodule metadata", (context) => {
  if (process.platform === "win32") return context.skip();
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
  if (process.platform === "win32") return context.skip();
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
  assert.equal(
    existsSync(path.join(rollbackRoot, ".firstdraft/design")),
    false,
  );
  assert.equal(
    existsSync(path.join(rollbackRoot, ROOT_TRANSACTION_NAME)),
    false,
  );
});

test("preserves a Git index changed before installation", (context) => {
  if (process.platform === "win32") return context.skip();
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
  /** @type {Buffer | undefined} */
  let externalIndex;

  assert.throws(
    () =>
      materialize(target, {
        rename() {
          git(root, ["update-index", "--index-version=4"]);
          externalIndex = readFileSync(indexPath);
          assert.equal(externalIndex.equals(originalIndex), false);
          const error = new Error("Injected pre-install rename failure");
          Object.assign(error, { code: "EIO" });
          throw error;
        },
      }),
    (error) =>
      error instanceof RootOutputMaterializationError &&
      error.reason === "root_transaction_failed",
  );

  assert(externalIndex);
  assert.equal(readFileSync(indexPath).equals(externalIndex), true);
  assert.equal(
    readFileSync(path.join(root, "README.md"), "utf8"),
    "Design README\n",
  );
  assert.equal(existsSync(path.join(root, ".firstdraft/design")), false);
  assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
});

for (const failureAt of [
  "planning",
  "context",
  "application",
  "verification",
]) {
  test(`restores both contexts, private files, and Git after ${failureAt} failure`, (context) => {
    if (process.platform === "win32") return context.skip();
    const root = temporaryDirectory(context);
    initializeGit(root);
    git(root, ["remote", "add", "origin", "https://example.test/planning.git"]);
    writeFileSync(
      path.join(root, ".gitignore"),
      ".env\n.firstdraft/state.json\n",
    );
    writeFileSync(path.join(root, "README.md"), "Planning README\n");
    mkdirSync(path.join(root, ".firstdraft"), { mode: 0o700 });
    writeFileSync(
      path.join(root, ".firstdraft/foundation-plan.json"),
      "original plan\n",
    );
    writeFileSync(
      path.join(root, ".firstdraft/state.json"),
      "original private state\n",
      { mode: 0o600 },
    );
    writeFileSync(path.join(root, ".env"), "SECRET=original\n", {
      mode: 0o600,
    });
    writeFileSync(path.join(root, "notes.md"), "untracked notes\n");
    git(root, [
      "add",
      ".gitignore",
      "README.md",
      ".firstdraft/foundation-plan.json",
    ]);
    git(root, ["commit", "-m", "Plan application"]);
    const originalHead = git(root, ["rev-parse", "HEAD"]);
    const originalConfig = readFileSync(path.join(root, ".git/config"));
    const originalIndex = readFileSync(path.join(root, ".git/index"));
    const originalFiles = snapshotWorktree(root);
    const target = prepareRootOutput({ root });
    let injected = false;
    assert.throws(
      () =>
        materializeRootOutput(
          target,
          { files: ARTIFACT_FILES, manifest_sha256: "a".repeat(64) },
          {
            writeArtifact,
            rename(from, to) {
              const shouldFail =
                !injected &&
                ((failureAt === "planning" &&
                  from === path.join(target.path, "README.md")) ||
                  (failureAt === "context" &&
                    to === path.join(target.path, ".firstdraft")) ||
                  (failureAt === "application" &&
                    to === path.join(target.path, "README.md")));
              if (shouldFail) {
                injected = true;
                throw Object.assign(new Error("Injected rename failure"), {
                  code: "EIO",
                });
              }
              renameSync(from, to);
            },
            verifyArtifact(artifactRoot, ignoredPaths) {
              verifyArtifact(artifactRoot, ignoredPaths);
              if (failureAt === "verification" && ignoredPaths !== undefined) {
                injected = true;
                throw new Error("Injected post-install verification failure");
              }
            },
          },
        ),
      (error) =>
        error instanceof RootOutputMaterializationError &&
        error.reason === "root_transaction_failed",
    );
    assert.equal(injected, true);
    assert.deepEqual(snapshotWorktree(root), originalFiles);
    assert.deepEqual(
      readFileSync(path.join(root, ".git/index")),
      originalIndex,
    );
    assert.deepEqual(
      readFileSync(path.join(root, ".git/config")),
      originalConfig,
    );
    assert.equal(git(root, ["rev-parse", "HEAD"]), originalHead);
    assert.equal(gitStatus(root, ["diff", "--quiet", "--"]), 0);
    assert.equal(gitStatus(root, ["diff", "--cached", "--quiet", "--"]), 0);
    assert.equal(
      gitStatus(root, ["check-ignore", ".env", ".firstdraft/state.json"]),
      0,
    );
    assert.equal(existsSync(path.join(root, ROOT_TRANSACTION_NAME)), false);
  });
}

test("archives existing top-level design material without reserving that name", (context) => {
  if (process.platform === "win32") return context.skip();
  const root = temporaryDirectory(context);
  mkdirSync(path.join(root, "design"));
  writeFileSync(path.join(root, "design/notes.md"), "original design\n");
  materialize(prepareRootOutput({ root }));
  assert.equal(
    readFileSync(path.join(root, ".firstdraft/design/design/notes.md"), "utf8"),
    "original design\n",
  );
  assert.equal(existsSync(path.join(root, "design")), false);
});

test("does not retain an archive when the original root is empty", (context) => {
  if (process.platform === "win32") return context.skip();
  const root = temporaryDirectory(context);
  const result = materialize(prepareRootOutput({ root }));
  assert.equal(result.root_adoption.design_path, null);
  assert.equal(result.root_adoption.moved_entry_count, 0);
  assert.equal(existsSync(path.join(root, ".firstdraft/design")), false);
});

for (const artifactPath of [
  ".firstdraft/design/README.md",
  ".firstdraft/Design",
  ".FIRSTDRAFT/gaps.json",
  ".firstdraft",
  ".FIRSTDRAFT-ROOT-OUTPUT/notes.md",
]) {
  test(`refuses artifact collision at ${artifactPath}`, (context) => {
    if (process.platform === "win32") return context.skip();
    const root = temporaryDirectory(context);
    writeFileSync(path.join(root, "notes.md"), "notes\n");
    const target = prepareRootOutput({ root });
    assert.throws(
      () =>
        materializeRootOutput(
          target,
          {
            files: [{ path: artifactPath, mode: 0o644 }],
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
}

test("retains both contexts and their journal when rollback cannot complete", (context) => {
  if (process.platform === "win32") return context.skip();
  const root = realpathSync(temporaryDirectory(context));
  mkdirSync(path.join(root, ".firstdraft"), { mode: 0o700 });
  writeFileSync(path.join(root, ".firstdraft/state.json"), "private state\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(root, "README.md"), "Planning README\n");
  const target = prepareRootOutput({ root });
  assert.throws(
    () =>
      materialize(target, {
        rename(from, to) {
          if (
            to === path.join(root, "README.md") ||
            (from === path.join(root, ".firstdraft") &&
              to === path.join(target.transactionPath, "artifact/.firstdraft"))
          ) {
            throw Object.assign(new Error("Injected rename failure"), {
              code: "EIO",
            });
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
  assert.equal(
    readFileSync(
      path.join(root, ".firstdraft/design/.firstdraft/state.json"),
      "utf8",
    ),
    "private state\n",
  );
  assert.equal(
    readFileSync(path.join(root, ".firstdraft/design/README.md"), "utf8"),
    "Planning README\n",
  );
  for (const file of ARTIFACT_FILES.filter((file) =>
    file.path.startsWith(".firstdraft/"),
  )) {
    assert.equal(
      readFileSync(path.join(root, file.path), "utf8"),
      file.contents,
    );
  }
  assert.equal(
    journal.artifact_moves[0].destination,
    path.join(root, ".firstdraft"),
  );
  assert.equal(
    journal.design_moves[0].destination,
    path.join(
      target.transactionPath,
      "artifact/.firstdraft/design/.firstdraft",
    ),
  );
  assert.equal(
    lstatSync(path.join(root, ROOT_TRANSACTION_NAME)).mode & 0o777,
    0o700,
  );
  assert.throws(
    () => prepareRootOutput({ root }),
    (error) =>
      error instanceof RootOutputPathError && error.reason === "root_busy",
  );
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

/** @param {string} root @param {Set<string>} [ignoredPaths] */
function verifyArtifact(root, ignoredPaths = new Set()) {
  const expected = new Set(ARTIFACT_FILES.map((file) => file.path));
  const actual = new Set();
  walkFiles(root, "", actual, ignoredPaths);
  assert.deepEqual(actual, expected);
  for (const file of ARTIFACT_FILES) {
    const destination = path.join(root, ...file.path.split("/"));
    assert.equal(readFileSync(destination, "utf8"), file.contents);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(destination).mode & 0o777, file.mode);
    }
  }
}

/** @param {string} root @param {string} relative @param {Set<string>} files @param {Set<string>} ignoredPaths */
function walkFiles(root, relative, files, ignoredPaths) {
  const current =
    relative === "" ? root : path.join(root, ...relative.split("/"));
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (ignoredPaths.has(child)) continue;
    if (entry.isDirectory()) walkFiles(root, child, files, ignoredPaths);
    else if (entry.isFile()) files.add(child);
    else assert.fail(`unexpected artifact entry ${child}`);
  }
}

/** @param {string} root @param {string} [relative] @returns {unknown[]} */
function snapshotWorktree(root, relative = "") {
  return readdirSync(path.join(root, relative))
    .sort()
    .flatMap((name) => {
      if (relative === "" && name === ".git") return [];
      const child = path.join(relative, name);
      const stat = lstatSync(path.join(root, child));
      return [
        {
          path: child,
          mode: stat.mode,
          inode: stat.ino,
          contents: stat.isFile()
            ? readFileSync(path.join(root, child)).toString("base64")
            : null,
        },
        ...(stat.isDirectory() ? snapshotWorktree(root, child) : []),
      ];
    });
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
