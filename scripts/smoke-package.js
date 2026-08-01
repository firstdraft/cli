import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const npmCli = requiredEnvironmentVariable("npm_execpath");
const apiToken = `fd_${"a".repeat(43)}`;

/** @type {{name: string, version: string}} */
const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "firstdraft-cli-"));
const installationDirectory = path.join(temporaryDirectory, "installation");
const packedExecutable = path.join(
  installationDirectory,
  "node_modules",
  ...packageMetadata.name.split("/"),
  "bin",
  "firstdraft.js",
);

try {
  const packResult = runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryDirectory,
  ]);
  /** @type {{filename: string}[]} */
  const packedManifests = JSON.parse(packResult.stdout);
  const [packed] = packedManifests;
  assert(packed, "npm pack did not return a manifest");
  const tarball = path.join(temporaryDirectory, packed.filename);

  mkdirSync(installationDirectory);
  writeFileSync(
    path.join(installationDirectory, "package.json"),
    '{"name":"firstdraft-smoke","private":true}\n',
  );

  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--no-save",
      tarball,
    ],
    installationDirectory,
  );
  const execution = runNpm(
    ["exec", "--offline", "--", "firstdraft", "--version"],
    installationDirectory,
  );

  assert.equal(execution.stdout, `${packageMetadata.version}\n`);
  assert.equal(execution.stderr, "");

  const subjectId = runNpm(
    ["exec", "--offline", "--", "firstdraft", "plan", "subject-id"],
    installationDirectory,
  );

  assert.match(
    subjectId.stdout,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/,
  );
  assert.equal(subjectId.stderr, "");

  const invalidSubjectId = spawnPackedCli(
    ["plan", "subject-id", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidSubjectId, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft plan subject-id --help' for usage.",
  });

  const invalidInit = spawnPackedCli(
    ["plan", "init", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidInit, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan init --help' for usage.",
  });

  const projectDirectory = path.join(temporaryDirectory, "project");
  mkdirSync(projectDirectory);
  const initialized = spawnPackedCli(
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    projectDirectory,
  );
  assert.deepEqual(
    {
      status: initialized.status,
      stdout: initialized.stdout,
      stderr: initialized.stderr,
    },
    {
      status: 0,
      stdout: "Initialized .firstdraft/foundation-plan.json.\n",
      stderr: "",
    },
  );

  const repeatedInit = spawnPackedCli(
    [
      "plan",
      "init",
      "--application-key",
      "other_application",
      "--name",
      "canary-secret-name",
    ],
    projectDirectory,
  );
  assertHandledFailure(repeatedInit, 1, {
    error: "local_initialization_failed",
    detail:
      "Could not initialize .firstdraft. The directory may be incomplete; no existing files were overwritten.",
  });

  const invalidPush = spawnPackedCli(
    ["plan", "push", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidPush, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan push --help' for usage.",
  });

  const localPush = spawnPackedCli(["plan", "push"], installationDirectory);
  assertHandledFailure(localPush, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.",
  });

  const invalidStatus = spawnPackedCli(
    ["plan", "status", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidStatus, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan status --help' for usage.",
  });

  const localStatus = spawnPackedCli(["plan", "status"], installationDirectory);
  assertHandledFailure(localStatus, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read valid local First Draft state. No network request was made. Run 'firstdraft plan init' if this directory is not initialized; otherwise repair the private state before retrying.",
  });

  const invalidCompile = spawnPackedCli(
    ["plan", "compile", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidCompile, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft plan compile --help' for usage.",
  });

  const invalidPublish = spawnPackedCli(
    ["plan", "publish", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidPublish, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft plan publish --help' for usage.",
  });

  const localPublish = spawnPackedCli(
    ["plan", "publish"],
    installationDirectory,
  );
  assertHandledFailure(localPublish, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read valid local First Draft state or Plan bytes. No network request was made. Run 'firstdraft plan push' before publishing.",
  });

  await exercisePackedCompilation(projectDirectory);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function runNpm(arguments_, cwd = process.cwd()) {
  const result = spawnNpm(arguments_, cwd);

  assert.equal(
    result.status,
    0,
    `npm ${arguments_.join(" ")} failed\n${result.stdout}${result.stderr}`,
  );

  return result;
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function spawnNpm(arguments_, cwd = process.cwd()) {
  return spawnSync(process.execPath, [npmCli, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function spawnPackedCli(arguments_, cwd = process.cwd()) {
  return spawnSync(process.execPath, [packedExecutable, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FIRSTDRAFT_API_TOKEN: apiToken },
  });
}

/**
 * @param {string[]} arguments_
 * @param {string} cwd
 */
async function spawnPackedCliAsync(arguments_, cwd) {
  const child = spawn(process.execPath, [packedExecutable, ...arguments_], {
    cwd,
    env: { ...process.env, FIRSTDRAFT_API_TOKEN: apiToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status, signal] = await once(child, "close");
  assert.equal(signal, null);
  return { status, stdout, stderr };
}

/** @param {string} projectDirectory */
async function exercisePackedCompilation(projectDirectory) {
  const projectId = "01900000-0000-7000-8000-000000000901";
  const compilationId = "01900000-0000-7000-8000-000000000902";
  const analysisId = "01900000-0000-7000-8000-000000000903";
  const publicationId = "01900000-0000-7000-8000-000000000904";
  const headSha256 = sha256(
    readFileSync(
      path.join(projectDirectory, ".firstdraft", "foundation-plan.json"),
    ),
  );
  const statusPath = `/v1/projects/${projectId}/compilations/${compilationId}`;
  const artifactPath = `${statusPath}/artifact`;
  const compilerRelease = "foundation-plan-rails/compiler-scalar-2026-08";
  const target = { id: "rails", profile: "rails-sketch/2026-08" };
  const contents = Buffer.from("class Movie < ApplicationRecord\nend\n");
  const file = {
    path: "app/models/movie.rb",
    sha256: sha256(contents),
    mode: 0o644,
    owner: "renderer:model",
    source_subject_uuids: [],
    contents_base64: contents.toString("base64"),
  };
  const metadata = {
    path: file.path,
    sha256: file.sha256,
    mode: file.mode,
    owner: file.owner,
    source_subject_uuids: file.source_subject_uuids,
  };
  const manifestSha256 = sha256(
    Buffer.from(JSON.stringify({ files: [metadata] })),
  );
  const artifact = Buffer.from(
    JSON.stringify({
      format: "firstdraft.compilation-artifact/1",
      provenance: {
        compilation_id: compilationId,
        project_id: projectId,
        graph_version: 1,
        head_source_sha256: headSha256,
        foundation_plan: {
          format: "firstdraft.foundation-plan.sketch/0.19",
          sha256: "2".repeat(64),
        },
        analysis: {
          id: analysisId,
          release: "foundation-plan-rails/scalar-2026-08",
        },
        compiler_release: compilerRelease,
        target,
        core: {
          repository: "firstdraft/foundation-rails-core",
          revision: "3".repeat(40),
          sha256: "4".repeat(64),
        },
      },
      manifest_sha256: manifestSha256,
      files: [file],
    }),
  );
  const artifactSha256 = sha256(artifact);
  const compilation = {
    project: { id: projectId, graph_version: 1 },
    compilation: {
      id: compilationId,
      analysis_run_id: analysisId,
      graph_version: 1,
      status: "succeeded",
      compiler_release: compilerRelease,
      target,
      status_path: statusPath,
      cancel_path: `${statusPath}/cancel`,
      artifact: {
        path: artifactPath,
        sha256: artifactSha256,
        media_type: "application/vnd.firstdraft.compilation-artifact+json",
        byte_size: artifact.byteLength,
      },
      failure: null,
      created_at: "2026-07-30T12:00:00.000Z",
      started_at: "2026-07-30T12:00:01.000Z",
      completed_at: "2026-07-30T12:00:02.000Z",
    },
  };
  const repositoryUrl = "https://github.com/octocat/oscar-party";
  const publication = {
    project: {
      id: projectId,
      graph_version: 1,
      head_source_sha256: headSha256,
    },
    compilation: {
      id: compilationId,
      analysis_run_id: analysisId,
      graph_version: 1,
      head_source_sha256: headSha256,
      status: "succeeded",
      compiler_release: compilerRelease,
      target,
      artifact: {
        sha256: artifactSha256,
        manifest_sha256: manifestSha256,
        file_count: 1,
      },
    },
    publication: {
      id: publicationId,
      status: "succeeded",
      repository: {
        id: 1_234_567,
        private: true,
        owner: { id: 7_654_321, login: "octocat", type: "User" },
        full_name: "octocat/oscar-party",
        default_branch: "main",
        html_url: repositoryUrl,
        tree_sha: "5".repeat(40),
        commit_sha: "6".repeat(40),
      },
      failure: null,
      created_at: "2026-07-30T12:00:00.000Z",
      started_at: "2026-07-30T12:00:01.000Z",
      completed_at: "2026-07-30T12:00:02.000Z",
    },
  };
  let startRequestSeen = false;
  let artifactRequestSeen = false;
  let publicationRequestSeen = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBody = Buffer.concat(chunks);

    if (
      request.method === "POST" &&
      request.url === `/v1/projects/${projectId}/compilations`
    ) {
      assert.equal(request.headers.authorization, `Bearer ${apiToken}`);
      assert.equal(request.headers["if-match"], `"sha256:${headSha256}"`);
      assert.equal(requestBody.byteLength, 0);
      startRequestSeen = true;
      respondJson(response, 202, compilation, { Location: statusPath });
      return;
    }
    if (request.method === "GET" && request.url === artifactPath) {
      assert.equal(request.headers.authorization, `Bearer ${apiToken}`);
      artifactRequestSeen = true;
      response.writeHead(200, {
        "Content-Type": "application/vnd.firstdraft.compilation-artifact+json",
        "Content-Length": artifact.byteLength,
        ETag: `"sha256:${artifactSha256}"`,
      });
      response.end(artifact);
      return;
    }
    if (
      request.method === "PUT" &&
      request.url === `/v1/projects/${projectId}/github-publication`
    ) {
      assert.equal(request.headers.authorization, `Bearer ${apiToken}`);
      assert.equal(request.headers["if-match"], `"sha256:${headSha256}"`);
      assert.equal(requestBody.byteLength, 0);
      publicationRequestSeen = true;
      respondJson(response, 201, publication);
      return;
    }

    response.writeHead(404).end();
  });

  try {
    await new Promise((/** @type {(value?: void) => void} */ resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address === "object");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      path.join(projectDirectory, ".firstdraft", "state.json"),
      `${JSON.stringify(
        {
          format: "firstdraft.cli-state/1",
          project_id: projectId,
          api_url: apiUrl,
          foundation_plan_etag: `"sha256:${headSha256}"`,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const output = path.join(projectDirectory, "generated");
    const execution = await spawnPackedCliAsync(
      ["plan", "compile", "--output", output],
      projectDirectory,
    );

    assert.equal(execution.status, 0);
    assert.equal(execution.stderr, "");
    assert.equal(JSON.parse(execution.stdout).output.path, output);
    assert.equal(
      readFileSync(path.join(output, "app/models/movie.rb"), "utf8"),
      contents.toString("utf8"),
    );
    if (process.platform !== "win32") {
      assert.equal(
        lstatSync(path.join(output, "app/models/movie.rb")).mode & 0o777,
        0o644,
      );
    }
    assert.equal(startRequestSeen, true);
    assert.equal(artifactRequestSeen, true);

    const published = await spawnPackedCliAsync(
      ["plan", "publish"],
      projectDirectory,
    );
    assert.deepEqual(published, {
      status: 0,
      stdout: `${repositoryUrl}\n`,
      stderr: "",
    });
    assert.equal(publicationRequestSeen, true);
  } finally {
    await new Promise(
      (
        /** @type {(value?: void) => void} */ resolve,
        /** @type {(error: Error) => void} */ reject,
      ) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      },
    );
  }
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function respondJson(response, status, body, headers = {}) {
  const source = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": source.byteLength,
    ...headers,
  });
  response.end(source);
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {ReturnType<typeof spawnPackedCli>} execution
 * @param {number} status
 * @param {Record<string, unknown>} error
 */
function assertHandledFailure(execution, status, error) {
  assert.equal(execution.status, status);
  assert.equal(execution.stdout, "");
  assert.equal(execution.stderr, `${JSON.stringify(error, null, 2)}\n`);
  assert.doesNotMatch(execution.stderr, /canary-secret/);
}

/** @param {string} name */
function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  assert(value, `${name} is required; run this check through npm`);
  return value;
}
