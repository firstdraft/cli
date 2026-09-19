import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isFileSystemError } from "./file-system.js";

export const ROOT_TRANSACTION_NAME = ".firstdraft-root-output";
export const ROOT_DESIGN_PATH = ".firstdraft/design";

const JOURNAL_FORMAT = "firstdraft.root-output-transaction/1";
const JOURNAL_NAME = "journal.json";
const JOURNAL_TEMPORARY_NAME = "journal.tmp";
const PREVIEW_NAME = "ignore-preview";
const ARTIFACT_STAGE_NAME = "artifact";
const PREPARED_INDEX_NAME = "prepared.index";
const ORIGINAL_INDEX_NAME = "original.index";
const DIRECTORY_MODE = 0o755;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const GIT_HASH_PATTERN = /^[0-9a-f]{40,64}$/;
const RESERVED_NAMES = new Set([ROOT_TRANSACTION_NAME.toLowerCase()]);

export class RootOutputPathError extends Error {
  /** @param {string} message @param {string} reason @param {{cause?: unknown}} [options] */
  constructor(message, reason, options = {}) {
    super(message, options);
    this.reason = reason;
  }
}

export class RootOutputMaterializationError extends Error {
  /** @param {string} message @param {string} reason @param {{cause?: unknown, recoveryPath?: string}} [options] */
  constructor(message, reason, options = {}) {
    super(message, options);
    this.reason = reason;
    this.recoveryPath = options.recoveryPath;
  }
}

/**
 * @typedef {object} RootEntryIdentity
 * @property {string} name
 * @property {"file" | "directory"} kind
 * @property {string} device
 * @property {string} inode
 */

/**
 * @typedef {object} GitIndexEntry
 * @property {string} mode
 * @property {string} object
 * @property {string} path
 */

/**
 * @typedef {object} RootGitContext
 * @property {string} gitDirectory
 * @property {string} indexPath
 * @property {string} indexLockPath
 * @property {GitIndexEntry[]} indexEntries
 * @property {string[]} ignoredPaths
 */

/**
 * @typedef {object} RootOutputTarget
 * @property {"root"} kind
 * @property {string} path
 * @property {string} transactionPath
 * @property {string} transactionDevice
 * @property {string} transactionInode
 * @property {RootEntryIdentity[]} snapshot
 * @property {RootGitContext | null} git
 * @property {Record<string, unknown>} journal
 * @property {boolean} irreversible
 * @property {boolean} released
 * @property {Map<NodeJS.Signals, () => void>} signalHandlers
 */

/**
 * Return the physical current directory when output selects root adoption.
 * Other existing or absent outputs return null for the ordinary resolver.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.output
 * @returns {string | null}
 */
export function resolveRootOutputPath({ cwd, output }) {
  let physicalCwd;
  try {
    physicalCwd = realpathSync(cwd);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    return null;
  }

  const candidate = path.resolve(cwd, output);
  let physicalCandidate;
  try {
    physicalCandidate = realpathSync(candidate);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    if (error.code === "ENOENT") return null;
    return null;
  }

  return physicalCandidate === physicalCwd ? physicalCwd : null;
}

/**
 * Validate and exclusively reserve one root adoption before any request.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {NodeJS.Platform} [options.platform]
 * @returns {RootOutputTarget}
 */
export function prepareRootOutput({ root, platform = process.platform }) {
  if (platform === "win32") {
    throw new RootOutputPathError(
      "Root output is not supported on this platform.",
      "root_platform_unsupported",
    );
  }

  try {
    root = realpathSync(root);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw new RootOutputPathError(
      "The root output directory could not be resolved.",
      "root_not_real",
      { cause: error },
    );
  }

  let rootStat;
  try {
    rootStat = lstatSync(root, { bigint: true });
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw new RootOutputPathError(
      "The root output directory could not be read.",
      "root_not_real",
      { cause: error },
    );
  }
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    root === path.dirname(root)
  ) {
    throw new RootOutputPathError(
      "The root output directory is not a real non-root directory.",
      "root_not_real",
    );
  }

  try {
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw new RootOutputPathError(
      "The root output directory is not writable.",
      "root_not_writable",
      { cause: error },
    );
  }

  assertReservedPathsAvailable(root);
  const transactionPath = path.join(root, ROOT_TRANSACTION_NAME);
  try {
    mkdirSync(transactionPath, { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(transactionPath, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    if (error.code === "EEXIST") throw existingTransactionError(root);
    throw new RootOutputPathError(
      "The root output lock could not be created.",
      "root_not_writable",
      { cause: error },
    );
  }

  const transactionStat = lstatSync(transactionPath, { bigint: true });
  /** @type {RootOutputTarget} */
  const target = {
    kind: "root",
    path: root,
    transactionPath,
    transactionDevice: String(transactionStat.dev),
    transactionInode: String(transactionStat.ino),
    snapshot: [],
    git: null,
    journal: {},
    irreversible: false,
    released: false,
    signalHandlers: new Map(),
  };

  try {
    target.snapshot = captureRootSnapshot(root, rootStat.dev);
    target.git = inspectGitRoot(root, transactionPath);
    target.journal = initialJournal(target);
    writeJournal(target);
    if (target.git !== null) assertIgnoreProtection(target);
    installSignalHandlers(target);
    return target;
  } catch (error) {
    releaseRootOutput(target);
    if (error instanceof RootOutputPathError) throw error;
    if (isFileSystemError(error)) {
      throw new RootOutputPathError(
        "The root output preflight could not be completed.",
        "root_not_writable",
        { cause: error },
      );
    }
    throw error;
  }
}

/** @param {RootOutputTarget} target */
export function releaseRootOutput(target) {
  removeSignalHandlers(target);
  if (target.released || target.irreversible) return;
  try {
    removePreparedTransaction(target);
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") {
      target.released = true;
      return;
    }
    if (
      error instanceof RootOutputMaterializationError ||
      isFileSystemError(error)
    ) {
      return;
    }
    throw error;
  }
}

/**
 * @param {RootOutputTarget} target
 * @param {object} artifact
 * @param {Array<{path: string, mode: 420 | 493}>} artifact.files
 * @param {string} artifact.manifest_sha256
 * @param {object} callbacks
 * @param {(root: string) => void} callbacks.writeArtifact
 * @param {(root: string, ignoredPaths?: Set<string>) => void} callbacks.verifyArtifact
 * @param {(from: string, to: string) => void} [callbacks.rename]
 */
export function materializeRootOutput(
  target,
  artifact,
  { writeArtifact, verifyArtifact, rename = renameSync },
) {
  assertOwnedTransaction(target);
  const artifactStage = path.join(target.transactionPath, ARTIFACT_STAGE_NAME);

  try {
    assertArtifactRootNames(artifact.files);
    mkdirSync(artifactStage, { mode: DIRECTORY_MODE });
    chmodSync(artifactStage, DIRECTORY_MODE);
    writeArtifact(artifactStage);
    verifyArtifact(artifactStage);

    if (target.git !== null) prepareGitIndex(target, artifact.files);
    recheckRootSnapshot(target);
    performRootTransaction(target, artifact.files, rename);
    verifyRootResult(target, artifact.files, verifyArtifact);

    target.journal.phase = "complete";
    target.journal.pending = null;
    writeJournal(target);
    removeSignalHandlers(target);
    removeCompletedTransaction(target);

    const movedEntries = target.snapshot.filter(
      (entry) => entry.name !== ".git",
    );
    return {
      path: target.path,
      file_count: artifact.files.length,
      manifest_sha256: artifact.manifest_sha256,
      root_adoption: {
        design_path:
          movedEntries.length === 0
            ? null
            : path.join(target.path, ROOT_DESIGN_PATH),
        moved_entry_count: movedEntries.length,
        git_repository_preserved: target.git !== null,
        git_index_replaced: target.git !== null,
      },
    };
  } catch (error) {
    const materializationError = normalizeMaterializationError(error);
    const rollbackComplete = rollbackRootTransaction(target, rename);
    if (!rollbackComplete) {
      target.irreversible = true;
      target.journal.phase = "rollback_incomplete";
      writeJournalBestEffort(target);
      removeSignalHandlers(target);
      throw new RootOutputMaterializationError(
        "The root output transaction could not be rolled back.",
        "root_rollback_incomplete",
        {
          cause: materializationError,
          recoveryPath: ROOT_TRANSACTION_NAME,
        },
      );
    }

    removePreparedTransaction(target);
    throw materializationError;
  }
}

/** @param {string} root */
function assertReservedPathsAvailable(root) {
  const names = readdirSync(root);
  for (const name of names) {
    const folded = name.toLowerCase();
    if (folded !== ROOT_TRANSACTION_NAME.toLowerCase()) continue;
    if (name === ROOT_TRANSACTION_NAME) throw existingTransactionError(root);
    throw new RootOutputPathError(
      "The root output transaction path is reserved.",
      "root_reserved_path",
    );
  }
  for (const name of names) assertDesignPathAvailable(root, name);
}

/** @param {string} root @param {string} name */
function assertDesignPathAvailable(root, name) {
  if (name.toLowerCase() !== ".firstdraft") return;
  const entry = path.join(root, name);
  if (!lstatSync(entry).isDirectory()) return;
  if (readdirSync(entry).some((child) => child.toLowerCase() === "design")) {
    throw new RootOutputPathError(
      "The root output design path is reserved.",
      "root_reserved_path",
    );
  }
}

/** @param {string} root */
function existingTransactionError(root) {
  const journalPath = path.join(root, ROOT_TRANSACTION_NAME, JOURNAL_NAME);
  try {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    if (journal?.format === JOURNAL_FORMAT && journal?.root === root) {
      return new RootOutputPathError(
        "Another root output transaction is active or retained.",
        "root_busy",
      );
    }
  } catch (error) {
    if (!(error instanceof SyntaxError || isFileSystemError(error)))
      throw error;
  }

  return new RootOutputPathError(
    "The root output transaction path is reserved.",
    "root_reserved_path",
  );
}

/** @param {string} root @param {bigint} rootDevice */
function captureRootSnapshot(root, rootDevice) {
  /** @type {RootEntryIdentity[]} */
  const snapshot = [];
  const names = readdirSync(root).sort(compareStrings);
  for (const name of names) {
    if (name === ROOT_TRANSACTION_NAME) continue;
    assertDesignPathAvailable(root, name);
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new RootOutputPathError(
        "A reserved root output path appeared during preflight.",
        "root_reserved_path",
      );
    }
    const entryPath = path.join(root, name);
    const stat = lstatSync(entryPath, { bigint: true });
    const kind = stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : null;
    if (kind === null || stat.isSymbolicLink() || stat.dev !== rootDevice) {
      throw new RootOutputPathError(
        "A root output entry is unsupported.",
        "root_entry_unsupported",
      );
    }
    snapshot.push({
      name,
      kind,
      device: String(stat.dev),
      inode: String(stat.ino),
    });
  }
  return snapshot;
}

/** @param {RootOutputTarget} target */
function recheckRootSnapshot(target) {
  const rootStat = lstatSync(target.path, { bigint: true });
  const current = captureRootSnapshot(target.path, rootStat.dev);
  if (JSON.stringify(current) !== JSON.stringify(target.snapshot)) {
    throw new RootOutputMaterializationError(
      "The root output changed while Compilation was running.",
      "output_changed",
    );
  }
}

/** @param {RootOutputTarget} target */
function initialJournal(target) {
  return {
    format: JOURNAL_FORMAT,
    root: target.path,
    phase: "prepared",
    irreversible: false,
    snapshot: target.snapshot,
    pending: null,
    design_created: false,
    design_moves: [],
    artifact_moves: [],
    index: null,
  };
}

/** @param {RootOutputTarget} target */
function writeJournal(target) {
  assertOwnedTransaction(target);
  const temporary = path.join(target.transactionPath, JOURNAL_TEMPORARY_NAME);
  const destination = path.join(target.transactionPath, JOURNAL_NAME);
  const source = Buffer.from(`${JSON.stringify(target.journal, null, 2)}\n`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, "wx", PRIVATE_FILE_MODE);
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, destination);
    fsyncDirectory(target.transactionPath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    removePathIfPresent(temporary);
  }
}

/** @param {RootOutputTarget} target */
function writeJournalBestEffort(target) {
  try {
    writeJournal(target);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
  }
}

/** @param {string} directory */
function fsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** @param {RootOutputTarget} target */
function installSignalHandlers(target) {
  for (const signal of /** @type {NodeJS.Signals[]} */ ([
    "SIGINT",
    "SIGTERM",
  ])) {
    const handler = () => {
      try {
        if (!target.irreversible) releaseRootOutput(target);
      } finally {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    target.signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

/** @param {RootOutputTarget} target */
function removeSignalHandlers(target) {
  for (const [signal, handler] of target.signalHandlers) {
    process.removeListener(signal, handler);
  }
  target.signalHandlers.clear();
}

/** @param {RootOutputTarget} target */
function assertOwnedTransaction(target) {
  const stat = lstatSync(target.transactionPath, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== target.transactionDevice ||
    String(stat.ino) !== target.transactionInode
  ) {
    throw new RootOutputMaterializationError(
      "The owned root output transaction changed.",
      "root_transaction_failed",
    );
  }
}

/** @param {RootOutputTarget} target */
function removePreparedTransaction(target) {
  removeSignalHandlers(target);
  if (target.released) return;
  assertOwnedTransaction(target);
  rmSync(target.transactionPath, { recursive: true, force: true });
  target.released = true;
}

/** @param {RootOutputTarget} target */
function removeCompletedTransaction(target) {
  assertOwnedTransaction(target);
  rmSync(target.transactionPath, { recursive: true, force: true });
  target.released = true;
}

/** @param {Array<{path: string}>} files */
function assertArtifactRootNames(files) {
  for (const file of files) {
    const top = file.path.split("/", 1)[0] ?? "";
    const folded = file.path.toLowerCase();
    if (
      RESERVED_NAMES.has(top.toLowerCase()) ||
      folded === ".firstdraft" ||
      (top.toLowerCase() === ".firstdraft" && top !== ".firstdraft") ||
      folded === ROOT_DESIGN_PATH ||
      folded.startsWith(`${ROOT_DESIGN_PATH}/`)
    ) {
      throw new RootOutputMaterializationError(
        "The compilation artifact owns a reserved root path.",
        "root_artifact_collision",
      );
    }
  }
}

/**
 * @param {RootOutputTarget} target
 * @param {Array<{path: string, mode: 420 | 493}>} files
 * @param {(from: string, to: string) => void} rename
 */
function performRootTransaction(target, files, rename) {
  const designEntries = target.snapshot.filter(
    (entry) => entry.name !== ".git",
  );
  const artifactStage = path.join(target.transactionPath, ARTIFACT_STAGE_NAME);
  // Keep the old .firstdraft inside the staged archive until the generated
  // .firstdraft and its archive can be installed together at the root.
  const designPath = path.join(artifactStage, ROOT_DESIGN_PATH);
  const artifactTopNames = [
    ...new Set([
      ...files.map((file) => file.path.split("/", 1)[0] ?? ""),
      ...(designEntries.length > 0 ? [".firstdraft"] : []),
    ]),
  ].sort(compareStrings);

  if (designEntries.length > 0) {
    startIrreversibleStep(target, {
      kind: "create_design",
      path: designPath,
    });
    mkdirSync(path.dirname(designPath), {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    chmodSync(path.dirname(designPath), DIRECTORY_MODE);
    mkdirSync(designPath, { mode: DIRECTORY_MODE });
    target.journal.design_created = true;
    chmodSync(designPath, DIRECTORY_MODE);
    finishIrreversibleStep(target, "moving_design");

    for (const entry of designEntries) {
      const source = path.join(target.path, entry.name);
      const destination = path.join(designPath, entry.name);
      startIrreversibleStep(target, {
        kind: "move_design_entry",
        source,
        destination,
      });
      rename(source, destination);
      /** @type {Array<Record<string, string>>} */ (
        target.journal.design_moves
      ).push({ source, destination });
      finishIrreversibleStep(target, "moving_design");
    }
  }

  for (const name of artifactTopNames) {
    const source = path.join(artifactStage, name);
    const destination = path.join(target.path, name);
    if (!isAbsent(destination)) {
      throw new RootOutputMaterializationError(
        "An artifact root path appeared during materialization.",
        "root_transaction_failed",
      );
    }
    startIrreversibleStep(target, {
      kind: "install_artifact_entry",
      source,
      destination,
    });
    rename(source, destination);
    /** @type {Array<Record<string, string>>} */ (
      target.journal.artifact_moves
    ).push({ source, destination });
    finishIrreversibleStep(target, "installing_artifact");
  }

  if (target.git !== null) {
    refreshPreparedIndex(target);
    installPreparedIndex(target);
  }
}

/** @param {RootOutputTarget} target @param {Record<string, string>} pending */
function startIrreversibleStep(target, pending) {
  target.irreversible = true;
  target.journal.irreversible = true;
  target.journal.pending = pending;
  writeJournal(target);
}

/** @param {RootOutputTarget} target @param {string} phase */
function finishIrreversibleStep(target, phase) {
  target.journal.phase = phase;
  target.journal.pending = null;
  writeJournal(target);
}

/**
 * @param {RootOutputTarget} target
 * @param {Array<{path: string}>} files
 * @param {(root: string, ignoredPaths?: Set<string>) => void} verifyArtifact
 */
function verifyRootResult(target, files, verifyArtifact) {
  const ignored = new Set([ROOT_TRANSACTION_NAME]);
  if (target.snapshot.some((entry) => entry.name === ".git")) {
    ignored.add(".git");
  }
  if (target.snapshot.some((entry) => entry.name !== ".git")) {
    ignored.add(ROOT_DESIGN_PATH);
  }
  verifyArtifact(target.path, ignored);

  const designPath = path.join(target.path, ROOT_DESIGN_PATH);
  for (const identity of target.snapshot) {
    const currentPath =
      identity.name === ".git"
        ? path.join(target.path, identity.name)
        : path.join(designPath, identity.name);
    if (!sameIdentity(currentPath, identity)) {
      throw new RootOutputMaterializationError(
        "A preserved root entry changed during materialization.",
        "root_transaction_failed",
      );
    }
  }

  if (target.git !== null) {
    assertInstalledIndex(target);
    assertMovedIgnoreProtection(target);
    const worktree = invokeGit(target.path, [
      "diff-files",
      "--quiet",
      "--ignore-submodules=none",
      "--",
    ]);
    if (worktree.status !== 0) {
      const detail = invokeGit(target.path, [
        "diff-files",
        "--name-status",
        "--",
      ]);
      throw new RootOutputMaterializationError(
        "The prepared Git index does not match the adopted worktree.",
        "root_transaction_failed",
        {
          cause: new Error(detail.stdout.toString("utf8")),
        },
      );
    }
  }

  const expectedTopNames = new Set(
    files.map((file) => file.path.split("/", 1)[0] ?? ""),
  );
  for (const name of ignored) expectedTopNames.add(name.split("/", 1)[0] ?? "");
  const actualTopNames = new Set(readdirSync(target.path));
  if (!setsEqual(expectedTopNames, actualTopNames)) {
    throw new RootOutputMaterializationError(
      "The adopted root contains an unexpected entry.",
      "root_transaction_failed",
    );
  }
}

/** @param {RootOutputTarget} target @param {(from: string, to: string) => void} rename */
function rollbackRootTransaction(target, rename) {
  let complete = true;

  if (!rollbackIndex(target)) complete = false;

  const artifactMoves =
    /** @type {Array<{source: string, destination: string}>} */ (
      target.journal.artifact_moves ?? []
    );
  for (const move of [...artifactMoves].reverse()) {
    try {
      if (!isAbsent(move.source) || isAbsent(move.destination)) {
        complete = false;
        continue;
      }
      rename(move.destination, move.source);
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      complete = false;
    }
  }

  const designMoves =
    /** @type {Array<{source: string, destination: string}>} */ (
      target.journal.design_moves ?? []
    );
  for (const move of [...designMoves].reverse()) {
    try {
      if (!isAbsent(move.source) || isAbsent(move.destination)) {
        complete = false;
        continue;
      }
      rename(move.destination, move.source);
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      complete = false;
    }
  }

  if (target.journal.design_created) {
    try {
      const designPath = path.join(
        target.transactionPath,
        ARTIFACT_STAGE_NAME,
        ROOT_DESIGN_PATH,
      );
      if (readdirSync(designPath).length === 0) {
        rmdirSync(designPath);
      } else {
        complete = false;
      }
    } catch (error) {
      if (!isFileSystemError(error) || error.code !== "ENOENT") {
        if (!isFileSystemError(error)) throw error;
        complete = false;
      }
    }
  }

  if (complete) {
    target.irreversible = false;
    target.journal.irreversible = false;
    target.journal.phase = "rolled_back";
    target.journal.pending = null;
    writeJournalBestEffort(target);
  }
  return complete;
}

/** @param {unknown} error */
function normalizeMaterializationError(error) {
  if (error instanceof RootOutputMaterializationError) return error;
  if (error instanceof RootOutputPathError) {
    return new RootOutputMaterializationError(
      "The root output preconditions changed during materialization.",
      "root_transaction_failed",
      { cause: error },
    );
  }
  if (isFileSystemError(error)) {
    return new RootOutputMaterializationError(
      "The root output transaction failed.",
      "root_transaction_failed",
      { cause: error },
    );
  }
  return new RootOutputMaterializationError(
    "The root output transaction failed.",
    "root_transaction_failed",
    { cause: error },
  );
}

/** @param {string} root @param {string} transactionPath */
function inspectGitRoot(root, transactionPath) {
  const topLevel = invokeGit(root, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) {
    const hasGitEntry = pathExists(path.join(root, ".git"));
    const detail = topLevel.stderr.toString("utf8");
    if (!hasGitEntry && detail.includes("not a git repository")) return null;
    throw new RootOutputPathError(
      "The Git worktree could not be discovered.",
      "root_git_unavailable",
    );
  }

  const discovered = topLevel.stdout.toString("utf8").trim();
  let physicalTopLevel;
  try {
    physicalTopLevel = realpathSync(discovered);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw new RootOutputPathError(
      "The Git worktree root could not be read.",
      "root_git_unavailable",
      { cause: error },
    );
  }
  if (physicalTopLevel !== root) {
    throw new RootOutputPathError(
      "Root output cannot adopt a directory inside another Git worktree.",
      "root_enclosing_worktree",
    );
  }

  for (const operation of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
  ]) {
    const operationPath = gitPath(root, operation);
    if (pathExists(operationPath)) {
      throw new RootOutputPathError(
        "The Git worktree has an in-progress operation.",
        "root_git_dirty",
      );
    }
  }

  if (gitBoolean(root, ["config", "--bool", "core.sparseCheckout"])) {
    throw new RootOutputPathError(
      "Sparse Git worktrees are not supported for root output.",
      "root_git_unsupported",
    );
  }

  for (const arguments_ of [
    ["diff", "--quiet", "--ignore-submodules=none", "--"],
    ["diff", "--cached", "--quiet", "--ignore-submodules=none", "--"],
  ]) {
    const result = invokeGit(root, arguments_);
    if (result.status === 1) {
      throw new RootOutputPathError(
        "The Git worktree or index is not clean.",
        "root_git_dirty",
      );
    }
    if (result.status !== 0) {
      throw new RootOutputPathError(
        "The Git worktree could not be inspected.",
        "root_git_unavailable",
      );
    }
  }

  const entriesResult = requiredGitPath(root, ["ls-files", "--stage", "-z"]);
  const indexEntries = parseIndexEntries(entriesResult.stdout);
  if (
    indexEntries.some(
      (entry) =>
        entry.mode === "160000" ||
        entry.path.split("/").includes(".gitmodules"),
    )
  ) {
    throw new RootOutputPathError(
      "Git submodules are not supported for root output.",
      "root_git_unsupported",
    );
  }

  const unmerged = requiredGitPath(root, ["ls-files", "--unmerged", "-z"]);
  if (unmerged.stdout.length > 0) {
    throw new RootOutputPathError(
      "The Git index contains unmerged entries.",
      "root_git_dirty",
    );
  }

  const status = requiredGitPath(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  const ignoredPaths = parseIgnoredPaths(status.stdout).filter(
    (candidate) =>
      candidate !== ROOT_TRANSACTION_NAME &&
      !candidate.startsWith(`${ROOT_TRANSACTION_NAME}/`),
  );

  const gitDirectory = requiredGitPath(root, [
    "rev-parse",
    "--absolute-git-dir",
  ])
    .stdout.toString("utf8")
    .trim();
  const indexPath = gitPath(root, "index");
  const indexLockPath = gitPath(root, "index.lock");
  if (pathExists(indexLockPath)) {
    throw new RootOutputPathError(
      "The Git index is currently locked.",
      "root_busy",
    );
  }

  return {
    gitDirectory,
    indexPath,
    indexLockPath,
    indexEntries,
    ignoredPaths,
    transactionPath,
  };
}

/** @param {string} root @param {string[]} arguments_ */
function gitBoolean(root, arguments_) {
  const result = invokeGit(root, arguments_);
  if (result.status === 1) return false;
  if (result.status !== 0) {
    throw new RootOutputPathError(
      "The Git configuration could not be inspected.",
      "root_git_unavailable",
    );
  }
  return result.stdout.toString("utf8").trim() === "true";
}

/** @param {string} root @param {string} name */
function gitPath(root, name) {
  return requiredGitPath(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    name,
  ])
    .stdout.toString("utf8")
    .trim();
}

/** @param {string} root @param {string[]} arguments_ */
function requiredGitPath(root, arguments_) {
  const result = invokeGit(root, arguments_);
  if (result.status !== 0) {
    throw new RootOutputPathError(
      "The required Git inspection failed.",
      "root_git_unavailable",
    );
  }
  return result;
}

/** @param {Buffer} source */
function parseIndexEntries(source) {
  /** @type {GitIndexEntry[]} */
  const entries = [];
  for (const record of nullRecords(source)) {
    const tab = record.indexOf("\t");
    const header = tab === -1 ? "" : record.slice(0, tab);
    const filePath = tab === -1 ? "" : record.slice(tab + 1);
    const match = /^(\d+) ([0-9a-f]+) (\d)$/.exec(header);
    if (match === null || match[3] !== "0" || filePath.length === 0) {
      throw new RootOutputPathError(
        "The Git index shape is unsupported.",
        "root_git_unsupported",
      );
    }
    entries.push({
      mode: match[1] ?? "",
      object: match[2] ?? "",
      path: filePath,
    });
  }
  return entries;
}

/** @param {Buffer} source */
function parseIgnoredPaths(source) {
  const ignored = [];
  for (const record of nullRecords(source)) {
    if (!record.startsWith("!! ")) continue;
    const candidate = normalizeGitPath(record.slice(3));
    if (candidate !== "") ignored.push(candidate);
  }
  return [...new Set(ignored)].sort(compareStrings);
}

/** @param {RootOutputTarget} target */
function assertIgnoreProtection(target) {
  if (target.git === null || target.git.ignoredPaths.length === 0) return;
  const previewRoot = path.join(target.transactionPath, PREVIEW_NAME);
  const previewWorktree = path.join(previewRoot, "worktree");
  mkdirSync(previewWorktree, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  try {
    for (const ignoredPath of target.git.ignoredPaths) {
      copyApplicableIgnoreFiles(target.path, previewWorktree, ignoredPath);
      createPreviewEntry(target.path, previewWorktree, ignoredPath);
    }

    const expected = target.git.ignoredPaths.map(
      (candidate) => `${ROOT_DESIGN_PATH}/${candidate}`,
    );
    const result = invokeGit(
      target.path,
      ["check-ignore", "--no-index", "-z", "--stdin"],
      {
        input: Buffer.from(`${expected.join("\0")}\0`),
        gitDirectory: target.git.gitDirectory,
        workTree: previewWorktree,
      },
    );
    if (result.status !== 0 && result.status !== 1) {
      throw new RootOutputPathError(
        "Git ignore protection could not be previewed.",
        "root_git_unavailable",
      );
    }
    const actual = new Set(nullRecords(result.stdout).map(normalizeGitPath));
    if (!expected.every((candidate) => actual.has(candidate))) {
      throw new RootOutputPathError(
        "A currently ignored path would become visible after root adoption.",
        "root_ignore_not_preserved",
      );
    }
  } finally {
    rmSync(previewRoot, { recursive: true, force: true });
  }
}

/** @param {string} root @param {string} previewWorktree @param {string} ignoredPath */
function copyApplicableIgnoreFiles(root, previewWorktree, ignoredPath) {
  const components = ignoredPath.split("/");
  for (let depth = 0; depth < components.length; depth += 1) {
    const ancestor = components.slice(0, depth);
    const source = path.join(root, ...ancestor, ".gitignore");
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;

    const destination = path.join(
      previewWorktree,
      ROOT_DESIGN_PATH,
      ...ancestor,
      ".gitignore",
    );
    mkdirSync(path.dirname(destination), {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    if (!pathExists(destination))
      writeFileSync(destination, readFileSync(source));
  }
}

/** @param {string} root @param {string} previewWorktree @param {string} ignoredPath */
function createPreviewEntry(root, previewWorktree, ignoredPath) {
  const source = path.join(root, ...ignoredPath.split("/"));
  const destination = path.join(
    previewWorktree,
    ROOT_DESIGN_PATH,
    ...ignoredPath.split("/"),
  );
  let stat;
  try {
    stat = lstatSync(source);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw new RootOutputPathError(
      "A currently ignored path changed during root output preflight.",
      "root_ignore_not_preserved",
      { cause: error },
    );
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: DIRECTORY_MODE });
  } else {
    mkdirSync(path.dirname(destination), {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    if (!pathExists(destination)) writeFileSync(destination, Buffer.alloc(0));
  }
}

/** @param {RootOutputTarget} target @param {Array<{path: string, mode: 420 | 493}>} files */
function prepareGitIndex(target, files) {
  const git = /** @type {RootGitContext} */ (target.git);
  const preparedPath = path.join(target.transactionPath, PREPARED_INDEX_NAME);
  const originalPath = path.join(target.transactionPath, ORIGINAL_INDEX_NAME);

  requiredGit(target.path, ["read-tree", "--empty"], {
    indexFile: preparedPath,
  });

  const indexRecords = [];
  for (const entry of git.indexEntries) {
    indexRecords.push(
      Buffer.from(
        `${entry.mode} ${entry.object} 0\t${ROOT_DESIGN_PATH}/${entry.path}\0`,
      ),
    );
  }

  const artifactStage = path.join(target.transactionPath, ARTIFACT_STAGE_NAME);
  for (const file of files) {
    const source = path.join(artifactStage, ...file.path.split("/"));
    const hashed = requiredGit(target.path, [
      "hash-object",
      "-w",
      "--no-filters",
      source,
    ])
      .stdout.toString("utf8")
      .trim();
    if (!GIT_HASH_PATTERN.test(hashed)) {
      throw new RootOutputMaterializationError(
        "Git did not return a valid artifact object identity.",
        "root_transaction_failed",
      );
    }
    const mode = file.mode === 0o755 ? "100755" : "100644";
    indexRecords.push(Buffer.from(`${mode} ${hashed} 0\t${file.path}\0`));
  }

  requiredGit(target.path, ["update-index", "-z", "--index-info"], {
    indexFile: preparedPath,
    input: Buffer.concat(indexRecords),
  });

  const preparedSource = readFileSync(preparedPath);
  const originalExists = pathExists(git.indexPath);
  const originalSource = originalExists ? readFileSync(git.indexPath) : null;
  const originalMode = originalExists
    ? lstatSync(git.indexPath).mode & 0o777
    : 0o644;
  if (originalSource !== null) {
    writeFileSync(originalPath, originalSource, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(originalPath, PRIVATE_FILE_MODE);
  }

  target.journal.index = {
    path: git.indexPath,
    lock_path: git.indexLockPath,
    original_exists: originalExists,
    original_mode: originalMode,
    original_sha256: originalSource === null ? null : sha256(originalSource),
    prepared_sha256: sha256(preparedSource),
    installed: false,
  };
  writeJournal(target);
}

/** @param {RootOutputTarget} target */
function installPreparedIndex(target) {
  const git = /** @type {RootGitContext} */ (target.git);
  const preparedSource = readFileSync(
    path.join(target.transactionPath, PREPARED_INDEX_NAME),
  );
  const indexJournal = /** @type {Record<string, unknown>} */ (
    target.journal.index
  );
  startIrreversibleStep(target, {
    kind: "install_git_index",
    source: path.join(target.transactionPath, PREPARED_INDEX_NAME),
    destination: git.indexPath,
  });
  writeLockedIndex(
    git.indexPath,
    git.indexLockPath,
    preparedSource,
    Number(indexJournal.original_mode ?? 0o644),
  );
  indexJournal.installed = true;
  finishIrreversibleStep(target, "index_installed");
}

/** @param {RootOutputTarget} target */
function refreshPreparedIndex(target) {
  const preparedPath = path.join(target.transactionPath, PREPARED_INDEX_NAME);
  requiredGit(target.path, ["update-index", "--refresh"], {
    indexFile: preparedPath,
  });
  const indexJournal = /** @type {Record<string, unknown>} */ (
    target.journal.index
  );
  indexJournal.prepared_sha256 = sha256(readFileSync(preparedPath));
  writeJournal(target);
}

/** @param {string} indexPath @param {string} lockPath @param {Buffer} source @param {number} mode */
function writeLockedIndex(indexPath, lockPath, source, mode) {
  let descriptor = null;
  let ownsLock = false;
  try {
    descriptor = openSync(lockPath, "wx", mode);
    ownsLock = true;
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(lockPath, indexPath);
    ownsLock = false;
    chmodSync(indexPath, mode);
    fsyncDirectory(path.dirname(indexPath));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (ownsLock) removePathIfPresent(lockPath);
  }
}

/** @param {RootOutputTarget} target */
function assertInstalledIndex(target) {
  const git = /** @type {RootGitContext} */ (target.git);
  const indexJournal = /** @type {Record<string, unknown>} */ (
    target.journal.index
  );
  if (
    indexJournal.installed !== true ||
    !pathExists(git.indexPath) ||
    sha256(readFileSync(git.indexPath)) !== indexJournal.prepared_sha256
  ) {
    throw new RootOutputMaterializationError(
      "The prepared Git index was not installed exactly.",
      "root_transaction_failed",
    );
  }
}

/** @param {RootOutputTarget} target */
function rollbackIndex(target) {
  if (target.git === null || target.journal.index === null) return true;
  const git = target.git;
  const indexJournal = /** @type {Record<string, unknown>} */ (
    target.journal.index
  );
  const pending = /** @type {Record<string, unknown> | null} */ (
    target.journal.pending
  );
  const installationAttempted =
    indexJournal.installed === true ||
    target.journal.phase === "index_installed" ||
    pending?.kind === "install_git_index";
  if (!installationAttempted) return true;

  try {
    const indexExists = pathExists(git.indexPath);
    const currentDigest = indexExists
      ? sha256(readFileSync(git.indexPath))
      : null;
    const originalStatePresent =
      indexJournal.original_exists === true
        ? currentDigest === indexJournal.original_sha256
        : !indexExists;
    if (originalStatePresent) {
      indexJournal.installed = false;
      return true;
    }
    if (currentDigest !== indexJournal.prepared_sha256) return false;

    if (indexJournal.original_exists === true) {
      const source = readFileSync(
        path.join(target.transactionPath, ORIGINAL_INDEX_NAME),
      );
      if (sha256(source) !== indexJournal.original_sha256) return false;
      writeLockedIndex(
        git.indexPath,
        git.indexLockPath,
        source,
        Number(indexJournal.original_mode),
      );
    } else {
      const descriptor = openSync(git.indexLockPath, "wx", PRIVATE_FILE_MODE);
      closeSync(descriptor);
      unlinkSync(git.indexPath);
      unlinkSync(git.indexLockPath);
      fsyncDirectory(path.dirname(git.indexPath));
    }
    indexJournal.installed = false;
    return true;
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    return false;
  }
}

/** @param {RootOutputTarget} target */
function assertMovedIgnoreProtection(target) {
  if (target.git === null || target.git.ignoredPaths.length === 0) return;
  const expected = target.git.ignoredPaths.map(
    (candidate) => `${ROOT_DESIGN_PATH}/${candidate}`,
  );
  const result = invokeGit(
    target.path,
    ["check-ignore", "--no-index", "-z", "--stdin"],
    { input: Buffer.from(`${expected.join("\0")}\0`) },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new RootOutputMaterializationError(
      "Git ignore protection could not be rechecked.",
      "root_transaction_failed",
    );
  }
  const actual = new Set(nullRecords(result.stdout).map(normalizeGitPath));
  if (!expected.every((candidate) => actual.has(candidate))) {
    throw new RootOutputMaterializationError(
      "A previously ignored path is no longer ignored.",
      "root_ignore_changed",
    );
  }
}

/**
 * @param {string} root
 * @param {string[]} arguments_
 * @param {{input?: Buffer, indexFile?: string, gitDirectory?: string, workTree?: string}} [options]
 */
function requiredGit(root, arguments_, options = {}) {
  const result = invokeGit(root, arguments_, options);
  if (result.status !== 0) {
    throw new RootOutputMaterializationError(
      "The required Git operation failed.",
      "root_transaction_failed",
    );
  }
  return result;
}

/**
 * @param {string} root
 * @param {string[]} arguments_
 * @param {{input?: Buffer, indexFile?: string, gitDirectory?: string, workTree?: string}} [options]
 */
function invokeGit(root, arguments_, options = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    LANGUAGE: "",
  };
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_INDEX_FILE;
  if (options.gitDirectory !== undefined) {
    environment.GIT_DIR = options.gitDirectory;
  }
  if (options.workTree !== undefined)
    environment.GIT_WORK_TREE = options.workTree;
  if (options.indexFile !== undefined)
    environment.GIT_INDEX_FILE = options.indexFile;

  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-C", root, ...arguments_],
    {
      env: environment,
      input: options.input,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  if (result.error !== undefined || result.status === null) {
    throw new RootOutputPathError(
      "The Git executable is unavailable.",
      "root_git_unavailable",
      { cause: result.error },
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

/** @param {Buffer} source */
function nullRecords(source) {
  const records = source.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

/** @param {string} candidate */
function normalizeGitPath(candidate) {
  return candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
}

/** @param {string} candidate */
function pathExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** @param {string} candidate @param {RootEntryIdentity} expected */
function sameIdentity(candidate, expected) {
  try {
    const stat = lstatSync(candidate, { bigint: true });
    const kind = stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : null;
    return (
      kind === expected.kind &&
      String(stat.dev) === expected.device &&
      String(stat.ino) === expected.inode
    );
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    return false;
  }
}

/** @param {string} candidate */
function isAbsent(candidate) {
  try {
    lstatSync(candidate);
    return false;
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

/** @param {string} candidate */
function removePathIfPresent(candidate) {
  try {
    unlinkSync(candidate);
  } catch (error) {
    if (!isFileSystemError(error) || error.code !== "ENOENT") throw error;
  }
}

/** @param {string} left @param {string} right */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {Set<string>} left @param {Set<string>} right */
function setsEqual(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

/** @param {Buffer | string} source */
function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}
