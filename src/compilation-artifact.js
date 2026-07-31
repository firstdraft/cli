import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isFileSystemError } from "./file-system.js";
import { isUuidV7 } from "./plan-state.js";

export const ARTIFACT_MEDIA_TYPE =
  "application/vnd.firstdraft.compilation-artifact+json";
export const ARTIFACT_FORMAT = "firstdraft.compilation-artifact/1";
export const FOUNDATION_PLAN_FORMAT = "firstdraft.foundation-plan.sketch/0.19";
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const ARTIFACT_KEYS = ["format", "provenance", "manifest_sha256", "files"];
const PROVENANCE_KEYS = [
  "compilation_id",
  "project_id",
  "graph_version",
  "head_source_sha256",
  "foundation_plan",
  "analysis",
  "compiler_release",
  "target",
  "core",
];
const FOUNDATION_PLAN_KEYS = ["format", "sha256"];
const ANALYSIS_KEYS = ["id", "release"];
const TARGET_KEYS = ["id", "profile"];
const CORE_KEYS = ["repository", "revision", "sha256"];
const FILE_KEYS = [
  "path",
  "sha256",
  "mode",
  "owner",
  "source_subject_uuids",
  "contents_base64",
];
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OWNER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const COMPONENT_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const STRICT_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_PATH_BYTES = 1_024;
const MAX_COMPONENT_BYTES = 255;
const MAX_IDENTIFIER_BYTES = 256;
const DIRECTORY_MODE = 0o755;
const POSIX_MODE_BITS_SUPPORTED = process.platform !== "win32";

export class CompilationArtifactInvalidError extends Error {}
export class CompilationMaterializationError extends Error {}
export class CompilationOutputPathError extends Error {}

/**
 * @typedef {object} CompilationArtifactExpectations
 * @property {string} projectId
 * @property {string} compilationId
 * @property {number} graphVersion
 * @property {string} headSourceSha256
 * @property {string} analysisRunId
 * @property {string} compilerRelease
 * @property {{id: string, profile: string}} target
 */

/**
 * @typedef {object} ValidatedArtifactFile
 * @property {string} path
 * @property {string} sha256
 * @property {420 | 493} mode
 * @property {string} owner
 * @property {string[]} source_subject_uuids
 * @property {Buffer} contents
 */

/**
 * @typedef {object} ValidatedCompilationArtifact
 * @property {string} manifest_sha256
 * @property {Record<string, unknown>} provenance
 * @property {ValidatedArtifactFile[]} files
 */

/**
 * @param {Buffer} source
 * @param {CompilationArtifactExpectations} expected
 * @returns {ValidatedCompilationArtifact}
 */
export function parseCompilationArtifact(source, expected) {
  let text;
  let parsed;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) {
      throw error;
    }

    throw new CompilationArtifactInvalidError(
      "The compilation artifact is not valid UTF-8 JSON.",
      { cause: error },
    );
  }

  if (
    !Buffer.from(JSON.stringify(parsed), "utf8").equals(source) ||
    !hasExactKeys(parsed, ARTIFACT_KEYS) ||
    parsed.format !== ARTIFACT_FORMAT ||
    typeof parsed.manifest_sha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.manifest_sha256) ||
    !Array.isArray(parsed.files)
  ) {
    throw new CompilationArtifactInvalidError(
      "The compilation artifact envelope is invalid.",
    );
  }

  const manifestSha256 = /** @type {string} */ (parsed.manifest_sha256);
  const provenance = parseProvenance(parsed.provenance, expected);
  const files = parsed.files.map(parseArtifactFile);
  validateManifest(files, manifestSha256);

  return {
    manifest_sha256: manifestSha256,
    provenance,
    files,
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.output
 */
export function resolveOutputTarget({ cwd, output }) {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    output.includes("\0")
  ) {
    throw new CompilationOutputPathError(
      "The compilation output path is invalid.",
    );
  }

  const target = path.resolve(cwd, output);
  const parent = path.dirname(target);
  if (
    target === parent ||
    path.basename(target).length === 0 ||
    !isInitiallyAbsent(target)
  ) {
    throw new CompilationOutputPathError(
      "The compilation output path must be absent.",
    );
  }

  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;

    throw new CompilationOutputPathError(
      "The compilation output parent could not be read.",
      { cause: error },
    );
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new CompilationOutputPathError(
      "The compilation output parent must be a real directory.",
    );
  }

  return target;
}

/**
 * @param {ValidatedCompilationArtifact} artifact
 * @param {string} target
 */
export function materializeCompilationArtifact(artifact, target) {
  const parent = path.dirname(target);
  const prefix = path.join(parent, `.firstdraft-${path.basename(target)}-`);
  let temporaryDirectory = null;

  try {
    assertTargetStillAvailable(target, parent);
    temporaryDirectory = mkdtempSync(prefix);
    assertOwnedTemporaryDirectory(temporaryDirectory, parent, prefix);

    writeArtifactTree(artifact.files, temporaryDirectory);
    applyMode(temporaryDirectory, DIRECTORY_MODE);
    verifyArtifactTree(artifact.files, temporaryDirectory);
    assertTargetStillAvailable(target, parent);
    renameSync(temporaryDirectory, target);
    temporaryDirectory = null;
  } catch (error) {
    if (
      error instanceof CompilationMaterializationError ||
      isFileSystemError(error)
    ) {
      throw new CompilationMaterializationError(
        "The compilation artifact could not be materialized.",
        { cause: error },
      );
    }

    throw error;
  } finally {
    if (temporaryDirectory !== null) {
      removeOwnedTemporaryDirectory(temporaryDirectory, parent, prefix);
    }
  }

  return {
    path: target,
    file_count: artifact.files.length,
    manifest_sha256: artifact.manifest_sha256,
  };
}

/**
 * @param {unknown} value
 * @param {CompilationArtifactExpectations} expected
 */
function parseProvenance(value, expected) {
  if (
    !hasExactKeys(value, PROVENANCE_KEYS) ||
    value.compilation_id !== expected.compilationId ||
    value.project_id !== expected.projectId ||
    value.graph_version !== expected.graphVersion ||
    value.head_source_sha256 !== expected.headSourceSha256 ||
    !hasExactKeys(value.foundation_plan, FOUNDATION_PLAN_KEYS) ||
    value.foundation_plan.format !== FOUNDATION_PLAN_FORMAT ||
    typeof value.foundation_plan.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.foundation_plan.sha256) ||
    !hasExactKeys(value.analysis, ANALYSIS_KEYS) ||
    value.analysis.id !== expected.analysisRunId ||
    !isRelease(value.analysis.release) ||
    value.compiler_release !== expected.compilerRelease ||
    !hasExactKeys(value.target, TARGET_KEYS) ||
    value.target.id !== expected.target.id ||
    value.target.profile !== expected.target.profile ||
    !hasExactKeys(value.core, CORE_KEYS) ||
    !isRepository(value.core.repository) ||
    typeof value.core.revision !== "string" ||
    !SHA1_PATTERN.test(value.core.revision) ||
    typeof value.core.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.core.sha256)
  ) {
    throw new CompilationArtifactInvalidError(
      "The compilation artifact provenance is invalid.",
    );
  }

  return {
    compilation_id: /** @type {string} */ (value.compilation_id),
    project_id: /** @type {string} */ (value.project_id),
    graph_version: /** @type {number} */ (value.graph_version),
    head_source_sha256: /** @type {string} */ (value.head_source_sha256),
    foundation_plan: {
      format: /** @type {string} */ (value.foundation_plan.format),
      sha256: /** @type {string} */ (value.foundation_plan.sha256),
    },
    analysis: {
      id: /** @type {string} */ (value.analysis.id),
      release: /** @type {string} */ (value.analysis.release),
    },
    compiler_release: /** @type {string} */ (value.compiler_release),
    target: {
      id: /** @type {string} */ (value.target.id),
      profile: /** @type {string} */ (value.target.profile),
    },
    core: {
      repository: /** @type {string} */ (value.core.repository),
      revision: /** @type {string} */ (value.core.revision),
      sha256: /** @type {string} */ (value.core.sha256),
    },
  };
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {ValidatedArtifactFile}
 */
function parseArtifactFile(value, index) {
  if (
    !hasExactKeys(value, FILE_KEYS) ||
    !isArtifactPath(value.path) ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    (value.mode !== 0o644 && value.mode !== 0o755) ||
    !isOwner(value.owner) ||
    !isSourceSubjectUuids(value.source_subject_uuids) ||
    typeof value.contents_base64 !== "string" ||
    !STRICT_BASE64_PATTERN.test(value.contents_base64)
  ) {
    throw new CompilationArtifactInvalidError(
      `Compilation artifact file ${index} is invalid.`,
    );
  }

  const pathValue = /** @type {string} */ (value.path);
  const digest = /** @type {string} */ (value.sha256);
  const mode = /** @type {420 | 493} */ (value.mode);
  const owner = /** @type {string} */ (value.owner);
  const sourceSubjectUuids = /** @type {string[]} */ (
    value.source_subject_uuids
  );
  const contentsBase64 = /** @type {string} */ (value.contents_base64);
  const contents = Buffer.from(contentsBase64, "base64");
  if (
    contents.toString("base64") !== contentsBase64 ||
    sha256(contents) !== digest
  ) {
    throw new CompilationArtifactInvalidError(
      `Compilation artifact file ${index} has invalid contents.`,
    );
  }

  return {
    path: pathValue,
    sha256: digest,
    mode,
    owner,
    source_subject_uuids: [...sourceSubjectUuids],
    contents,
  };
}

/**
 * @param {ValidatedArtifactFile[]} files
 * @param {string} expectedManifestSha256
 */
function validateManifest(files, expectedManifestSha256) {
  const claims = new Map();
  let previousPath = null;

  for (const file of files) {
    if (previousPath !== null && file.path <= previousPath) {
      throw new CompilationArtifactInvalidError(
        "Compilation artifact files are not in manifest order.",
      );
    }
    previousPath = file.path;

    const components = file.path.split("/");
    for (let index = 0; index < components.length; index += 1) {
      const spelling = components.slice(0, index + 1).join("/");
      const collisionKey = spelling.toLowerCase();
      const kind = index === components.length - 1 ? "file" : "directory";
      const existing = claims.get(collisionKey);
      if (
        existing !== undefined &&
        (existing.kind === "file" ||
          kind === "file" ||
          existing.spelling !== spelling)
      ) {
        throw new CompilationArtifactInvalidError(
          "Compilation artifact paths conflict.",
        );
      }
      claims.set(collisionKey, { spelling, kind });
    }
  }

  const metadata = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    mode: file.mode,
    owner: file.owner,
    source_subject_uuids: file.source_subject_uuids,
  }));
  const manifestSha256 = sha256(
    Buffer.from(JSON.stringify({ files: metadata }), "utf8"),
  );
  if (manifestSha256 !== expectedManifestSha256) {
    throw new CompilationArtifactInvalidError(
      "The compilation artifact manifest digest is invalid.",
    );
  }
}

/** @param {unknown} value @returns {value is string} */
function isArtifactPath(value) {
  if (
    typeof value !== "string" ||
    !isAscii(value) ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES
  ) {
    return false;
  }

  const components = value.split("/");
  return components.every((component) => {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      Buffer.byteLength(component) > MAX_COMPONENT_BYTES ||
      !COMPONENT_PATTERN.test(component) ||
      component.endsWith(".") ||
      component.toLowerCase() === ".git"
    ) {
      return false;
    }

    return !WINDOWS_DEVICE_PATTERN.test(component.split(".", 1)[0] ?? "");
  });
}

/** @param {unknown} value */
function isOwner(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES &&
    OWNER_PATTERN.test(value)
  );
}

/** @param {unknown} value */
function isSourceSubjectUuids(value) {
  if (!Array.isArray(value) || !value.every(isUuidV7)) return false;

  const canonical = [...new Set(value)].sort();
  return arraysEqual(value, canonical);
}

/** @param {unknown} value */
function isRelease(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES &&
    RELEASE_PATTERN.test(value)
  );
}

/** @param {unknown} value */
function isRepository(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES &&
    REPOSITORY_PATTERN.test(value)
  );
}

/** @param {ValidatedArtifactFile[]} files @param {string} root */
function writeArtifactTree(files, root) {
  const createdDirectories = new Set([""]);

  for (const file of files) {
    const components = file.path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const relativeDirectory = components.slice(0, index).join("/");
      if (createdDirectories.has(relativeDirectory)) continue;

      mkdirSync(path.join(root, ...components.slice(0, index)), {
        mode: DIRECTORY_MODE,
      });
      applyMode(path.join(root, ...components.slice(0, index)), DIRECTORY_MODE);
      createdDirectories.add(relativeDirectory);
    }

    const destination = path.join(root, ...components);
    writeFileSync(destination, file.contents, {
      flag: "wx",
      mode: file.mode,
    });
    applyMode(destination, file.mode);
  }
}

/** @param {ValidatedArtifactFile[]} files @param {string} root */
function verifyArtifactTree(files, root) {
  const expectedFiles = new Map(files.map((file) => [file.path, file]));
  const expectedDirectories = new Set();
  for (const file of files) {
    const components = file.path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      expectedDirectories.add(components.slice(0, index).join("/"));
    }
  }

  const actualFiles = new Set();
  const actualDirectories = new Set();
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !hasExpectedMode(rootStat.mode, DIRECTORY_MODE)
  ) {
    throw new CompilationMaterializationError(
      "The materialized compilation root is invalid.",
    );
  }
  walkTree(root, "", actualFiles, actualDirectories);
  if (
    !setsEqual(actualFiles, new Set(expectedFiles.keys())) ||
    !setsEqual(actualDirectories, expectedDirectories)
  ) {
    throw new CompilationMaterializationError(
      "The materialized compilation tree is invalid.",
    );
  }

  for (const relativePath of expectedDirectories) {
    const stat = lstatSync(path.join(root, ...relativePath.split("/")));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !hasExpectedMode(stat.mode, DIRECTORY_MODE)
    ) {
      throw new CompilationMaterializationError(
        "A materialized compilation directory is invalid.",
      );
    }
  }

  for (const [relativePath, expected] of expectedFiles) {
    const fullPath = path.join(root, ...relativePath.split("/"));
    const stat = lstatSync(fullPath);
    const contents = readFileSync(fullPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !hasExpectedMode(stat.mode, expected.mode) ||
      !contents.equals(expected.contents) ||
      sha256(contents) !== expected.sha256
    ) {
      throw new CompilationMaterializationError(
        "A materialized compilation file is invalid.",
      );
    }
  }
}

/** @param {string} target @param {number} mode */
function applyMode(target, mode) {
  if (POSIX_MODE_BITS_SUPPORTED) chmodSync(target, mode);
}

/** @param {number} actual @param {number} expected */
function hasExpectedMode(actual, expected) {
  return !POSIX_MODE_BITS_SUPPORTED || (actual & 0o777) === expected;
}

/**
 * @param {string} root
 * @param {string} relative
 * @param {Set<string>} files
 * @param {Set<string>} directories
 */
function walkTree(root, relative, files, directories) {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      directories.add(entryRelative);
      walkTree(root, entryRelative, files, directories);
    } else if (entry.isFile()) {
      files.add(entryRelative);
    } else {
      throw new CompilationMaterializationError(
        "The materialized compilation tree contains a special file.",
      );
    }
  }
}

/** @param {string} target @param {string} parent */
function assertTargetStillAvailable(target, parent) {
  if (!isAbsent(target)) {
    throw new CompilationMaterializationError(
      "The compilation output path is no longer absent.",
    );
  }

  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new CompilationMaterializationError(
      "The compilation output parent is no longer a real directory.",
    );
  }
}

/** @param {string} temporaryDirectory @param {string} parent @param {string} prefix */
function assertOwnedTemporaryDirectory(temporaryDirectory, parent, prefix) {
  const stat = lstatSync(temporaryDirectory);
  if (
    path.dirname(temporaryDirectory) !== parent ||
    !temporaryDirectory.startsWith(prefix) ||
    temporaryDirectory === prefix ||
    !stat.isDirectory() ||
    stat.isSymbolicLink()
  ) {
    throw new CompilationMaterializationError(
      "The compilation temporary directory is invalid.",
    );
  }
}

/** @param {string} temporaryDirectory @param {string} parent @param {string} prefix */
function removeOwnedTemporaryDirectory(temporaryDirectory, parent, prefix) {
  try {
    assertOwnedTemporaryDirectory(temporaryDirectory, parent, prefix);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
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

    throw new CompilationMaterializationError(
      "The compilation output path could not be inspected.",
      { cause: error },
    );
  }
}

/** @param {string} candidate */
function isInitiallyAbsent(candidate) {
  try {
    lstatSync(candidate);
    return false;
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    if (error.code === "ENOENT") return true;

    throw new CompilationOutputPathError(
      "The compilation output path could not be inspected.",
      { cause: error },
    );
  }
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} value */
function isAscii(value) {
  return [...value].every(
    (character) => (character.codePointAt(0) ?? 0) <= 0x7f,
  );
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function hasExactKeys(value, keys) {
  return isRecord(value) && arraysEqual(Object.keys(value), keys);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown[]} left @param {unknown[]} right */
function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** @param {Set<string>} left @param {Set<string>} right */
function setsEqual(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}
