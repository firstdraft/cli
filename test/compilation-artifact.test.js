import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CompilationArtifactInvalidError,
  CompilationOutputPathError,
  FOUNDATION_PLAN_FORMAT,
  MAX_ARTIFACT_BYTES,
  materializeCompilationArtifact,
  parseCompilationArtifact,
  resolveOutputTarget,
} from "../src/compilation-artifact.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000000801";
const COMPILATION_ID = "01900000-0000-7000-8000-000000000802";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000803";
const SUBJECT_ID = "01900000-0000-7000-8000-000000000804";
const HEAD_SHA256 = "1".repeat(64);
const FOUNDATION_PLAN_SHA256 = "5".repeat(64);
const COMPILER_RELEASE = "foundation-plan-rails/compiler-scalar-2026-08";
const TARGET = { id: "rails", profile: "rails-sketch/2026-08" };
const EXPECTED = {
  projectId: PROJECT_ID,
  compilationId: COMPILATION_ID,
  graphVersion: 7,
  headSourceSha256: HEAD_SHA256,
  analysisRunId: ANALYSIS_ID,
  compilerRelease: COMPILER_RELEASE,
  target: TARGET,
};

test("parses canonical binary-safe artifact bytes and materializes an exact tree", (context) => {
  assert.equal(MAX_ARTIFACT_BYTES, 128 * 1024 * 1024);
  const fixture = artifactFixture();
  const artifact = parseCompilationArtifact(fixture.source, EXPECTED);
  assert.equal(artifact.provenance.head_source_sha256, HEAD_SHA256);
  assert.equal(
    artifact.provenance.foundation_plan.sha256,
    FOUNDATION_PLAN_SHA256,
  );
  assert.notEqual(
    artifact.provenance.head_source_sha256,
    artifact.provenance.foundation_plan.sha256,
  );
  const parent = temporaryDirectory(context);
  const target = resolveOutputTarget({
    cwd: parent,
    output: "generated",
  });
  const result = materializeCompilationArtifact(artifact, target);

  assert.deepEqual(result, {
    path: target,
    file_count: 2,
    manifest_sha256: fixture.manifestSha256,
  });
  assert.equal(
    readFileSync(path.join(target, "app/models/movie.rb"), "utf8"),
    "class Movie < ApplicationRecord\nend\n",
  );
  assert.deepEqual(
    readFileSync(path.join(target, "bin/setup")),
    Buffer.from([0, 255]),
  );
  assert.equal(
    [...lstatDirectories(parent)].some((name) =>
      name.startsWith(".firstdraft-generated-"),
    ),
    false,
  );
});

test("materialization enforces supported permission bits independently of umask", (context) => {
  const previousUmask =
    process.platform === "win32" ? null : process.umask(0o077);

  try {
    const fixture = artifactFixture();
    const artifact = parseCompilationArtifact(fixture.source, EXPECTED);
    const parent = temporaryDirectory(context);
    const target = resolveOutputTarget({
      cwd: parent,
      output: "generated",
    });
    materializeCompilationArtifact(artifact, target);

    const entries = [
      [target, 0o755, "directory"],
      [path.join(target, "app"), 0o755, "directory"],
      [path.join(target, "app/models"), 0o755, "directory"],
      [path.join(target, "app/models/movie.rb"), 0o644, "file"],
      [path.join(target, "bin/setup"), 0o755, "file"],
    ];

    for (const [entryPath, expectedMode, type] of entries) {
      const stat = lstatSync(String(entryPath));
      assert.equal(
        type === "directory" ? stat.isDirectory() : stat.isFile(),
        true,
      );
      if (process.platform !== "win32") {
        assert.equal(stat.mode & 0o777, expectedMode);
      }
    }
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
  }
});

test("rejects noncanonical, duplicate-key, additive, and non-UTF-8 envelopes", () => {
  const fixture = artifactFixture();
  const additive = { ...fixture.body, canary: "secret" };
  const duplicate = Buffer.from(
    fixture.source
      .toString("utf8")
      .replace(
        '{"format":"firstdraft.compilation-artifact/1"',
        '{"format":"firstdraft.compilation-artifact/1","format":"firstdraft.compilation-artifact/1"',
      ),
  );

  for (const source of [
    Buffer.from(`${fixture.source.toString("utf8")}\n`),
    Buffer.from(JSON.stringify(additive)),
    duplicate,
    Buffer.from([0xff]),
  ]) {
    assert.throws(
      () => parseCompilationArtifact(source, EXPECTED),
      CompilationArtifactInvalidError,
    );
  }
});

test("pins external provenance identities and validates nested metadata", () => {
  /** @type {[string, string | number][]} */
  const cases = [
    ["compilation_id", "01900000-0000-7000-8000-000000000899"],
    ["project_id", "01900000-0000-7000-8000-000000000899"],
    ["graph_version", 8],
    ["head_source_sha256", "9".repeat(64)],
    ["compiler_release", "other/release"],
  ];

  for (const [key, value] of cases) {
    const fixture = artifactFixture({
      provenance: { [key]: value },
    });
    assert.throws(
      () => parseCompilationArtifact(fixture.source, EXPECTED),
      CompilationArtifactInvalidError,
    );
  }

  for (const fixture of [
    artifactFixture({
      provenance: {
        foundation_plan: {
          format: "firstdraft.foundation-plan.sketch/0.18",
          sha256: FOUNDATION_PLAN_SHA256,
        },
      },
    }),
    artifactFixture({
      provenance: {
        foundation_plan: {
          format: FOUNDATION_PLAN_FORMAT,
          sha256: "not-a-sha256",
        },
      },
    }),
    artifactFixture({
      provenance: {
        analysis: {
          id: "01900000-0000-7000-8000-000000000899",
          release: "foundation-plan-rails/scalar-2026-08",
        },
      },
    }),
    artifactFixture({
      provenance: { target: { id: "other", profile: TARGET.profile } },
    }),
    artifactFixture({
      provenance: {
        core: {
          repository: "not-a-repository",
          revision: "3".repeat(40),
          sha256: "4".repeat(64),
        },
      },
    }),
  ]) {
    assert.throws(
      () => parseCompilationArtifact(fixture.source, EXPECTED),
      CompilationArtifactInvalidError,
    );
  }
});

test("requires strict Base64, exact file digests, and the metadata-only manifest digest", () => {
  const valid = artifactFixture();
  const malformedBase64 = structuredClone(valid.body);
  assert(malformedBase64.files[0]);
  malformedBase64.files[0].contents_base64 = "YQ";
  const wrongFileDigest = structuredClone(valid.body);
  assert(wrongFileDigest.files[0]);
  wrongFileDigest.files[0].sha256 = "0".repeat(64);
  const wrongManifestDigest = structuredClone(valid.body);
  wrongManifestDigest.manifest_sha256 = "0".repeat(64);

  for (const body of [malformedBase64, wrongFileDigest, wrongManifestDigest]) {
    assert.throws(
      () =>
        parseCompilationArtifact(Buffer.from(JSON.stringify(body)), EXPECTED),
      CompilationArtifactInvalidError,
    );
  }
});

test("rejects nonportable paths, unsupported metadata, and noncanonical UUID lists", () => {
  const invalidPaths = [
    "",
    "/absolute",
    "back\\slash",
    "empty//component",
    "./dot",
    "parent/../escape",
    "trailing.",
    ".git/config",
    "NUL.txt",
    "white space",
    "é.rb",
  ];
  for (const filePath of invalidPaths) {
    const fixture = artifactFixture({
      files: [fileFixture(filePath, "contents")],
    });
    assert.throws(
      () => parseCompilationArtifact(fixture.source, EXPECTED),
      CompilationArtifactInvalidError,
      filePath,
    );
  }

  for (const file of [
    fileFixture("valid", "contents", { mode: 0o600 }),
    fileFixture("valid", "contents", { owner: "invalid owner" }),
    fileFixture("valid", "contents", {
      source_subject_uuids: [SUBJECT_ID, SUBJECT_ID],
    }),
    fileFixture("valid", "contents", {
      source_subject_uuids: [
        "01900000-0000-7000-8000-000000000899",
        SUBJECT_ID,
      ],
    }),
  ]) {
    const fixture = artifactFixture({ files: [file] });
    assert.throws(
      () => parseCompilationArtifact(fixture.source, EXPECTED),
      CompilationArtifactInvalidError,
    );
  }
});

test("rejects duplicate, case-folded, and file-directory prefix conflicts", () => {
  const cases = [
    [fileFixture("app/model.rb", "one"), fileFixture("app/model.rb", "two")],
    [fileFixture("app/model.rb", "one"), fileFixture("APP/MODEL.RB", "two")],
    [fileFixture("app", "one"), fileFixture("app/model.rb", "two")],
    [fileFixture("App/one.rb", "one"), fileFixture("app/two.rb", "two")],
  ];

  for (const files of cases) {
    const fixture = artifactFixture({ files, preserveOrder: true });
    assert.throws(
      () => parseCompilationArtifact(fixture.source, EXPECTED),
      CompilationArtifactInvalidError,
    );
  }
});

test("requires strict manifest byte order", () => {
  const fixture = artifactFixture({
    files: [fileFixture("z-last", "last"), fileFixture("a-first", "first")],
    preserveOrder: true,
  });

  assert.throws(
    () => parseCompilationArtifact(fixture.source, EXPECTED),
    CompilationArtifactInvalidError,
  );
});

test("preflight never follows an output-parent symlink or accepts an existing target", (context) => {
  const root = temporaryDirectory(context);
  const realParent = path.join(root, "real");
  const linkedParent = path.join(root, "linked");
  mkdirSync(realParent);
  symlinkSync(realParent, linkedParent);

  assert.throws(
    () =>
      resolveOutputTarget({
        cwd: root,
        output: "linked/generated",
      }),
    CompilationOutputPathError,
  );

  mkdirSync(path.join(realParent, "existing"));
  assert.throws(
    () =>
      resolveOutputTarget({
        cwd: root,
        output: "real/existing",
      }),
    CompilationOutputPathError,
  );
  assert.deepEqual([...lstatDirectories(realParent)], ["existing"]);
});

/**
 * @param {{provenance?: Record<string, unknown>, files?: Record<string, unknown>[], preserveOrder?: boolean}} [changes]
 */
function artifactFixture(changes = {}) {
  const defaultFiles = [
    fileFixture(
      "app/models/movie.rb",
      "class Movie < ApplicationRecord\nend\n",
      { owner: "renderer:model", source_subject_uuids: [SUBJECT_ID] },
    ),
    fileFixture("bin/setup", Buffer.from([0, 255]), {
      mode: 0o755,
      owner: "core:foundation-rails-core",
    }),
  ];
  const files = [...(changes.files ?? defaultFiles)];
  if (!changes.preserveOrder) {
    files.sort((left, right) =>
      String(left.path).localeCompare(String(right.path), "en", {
        sensitivity: "variant",
      }),
    );
  }
  const metadata = files.map(
    ({ path: filePath, sha256, mode, owner, source_subject_uuids }) => ({
      path: filePath,
      sha256,
      mode,
      owner,
      source_subject_uuids,
    }),
  );
  const manifestSha256 = sha256(
    Buffer.from(JSON.stringify({ files: metadata })),
  );
  const baseProvenance = {
    compilation_id: COMPILATION_ID,
    project_id: PROJECT_ID,
    graph_version: 7,
    head_source_sha256: HEAD_SHA256,
    foundation_plan: {
      format: FOUNDATION_PLAN_FORMAT,
      sha256: FOUNDATION_PLAN_SHA256,
    },
    analysis: {
      id: ANALYSIS_ID,
      release: "foundation-plan-rails/scalar-2026-08",
    },
    compiler_release: COMPILER_RELEASE,
    target: TARGET,
    core: {
      repository: "firstdraft/foundation-rails-core",
      revision: "3".repeat(40),
      sha256: "4".repeat(64),
    },
  };
  const body = {
    format: "firstdraft.compilation-artifact/1",
    provenance: { ...baseProvenance, ...changes.provenance },
    manifest_sha256: manifestSha256,
    files,
  };
  const source = Buffer.from(JSON.stringify(body));
  return { body, source, manifestSha256 };
}

/**
 * @param {string} filePath
 * @param {string | Buffer} contents
 * @param {{mode?: number, owner?: string, source_subject_uuids?: string[]}} [attributes]
 */
function fileFixture(filePath, contents, attributes = {}) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return {
    path: filePath,
    sha256: sha256(bytes),
    mode: attributes.mode ?? 0o644,
    owner: attributes.owner ?? "renderer:test",
    source_subject_uuids: attributes.source_subject_uuids ?? [],
    contents_base64: bytes.toString("base64"),
  };
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-artifact-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {string} directory */
function lstatDirectories(directory) {
  return new Set(readdirSync(directory).sort());
}
